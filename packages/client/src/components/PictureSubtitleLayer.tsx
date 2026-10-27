import { useEffect, useRef, useState } from "react";
import { cachedPgsBytes, fetchPgsBytes, fetchPgsStatus, type PgsStatus } from "../lib/api";
import { pgsKey, sideShare } from "../lib/sideShare";
import { logEvent, logWarn } from "../lib/log";
import { PgsReader, decodeRle, displayAt, mergeDisplays, type PgsDisplay, type PgsObject } from "../lib/pgs";
import type { CoveredSpan } from "../lib/subtitleCues";
import { mergedSpans, type SubtitleLoadStatus } from "../lib/subtitleStatus";

/**
 * PGS subtitles (a Blu-ray's) this client draws itself, from the pictures the
 * server cuts out of the film (the /pgs route), rather than having them
 * burned into a re-encode of it — so a viewer with one on shares the room's
 * copy, and can re-time it like a text subtitle.
 *
 * They are pictures made for the film's frame, so they are drawn as a burned
 * one would be: the subtitle's canvas over the picture, scaled with it, its
 * colours as ffmpeg's decoder has them (lib/pgs.ts). A picture cropped of its
 * black bars still has its subtitles where the full frame puts them, in the
 * bars when there is room.
 *
 * The server cuts it as the player asks: from a little before where the
 * picture is to the end, then what is before. A skip past where that has read
 * to has it stopped and cut again from there (run 23: a skip through Project
 * Hail Mary waited on a cut reading from the start). A piece being cut says
 * how far into the film it has read: with all it had written read here,
 * every line before that is here, so a quiet stretch is quiet rather than
 * "Loading subtitles…", which is only for where the cut hasn't been yet. One
 * that can't be cut has the player ask for a stream with it burned in instead
 * (onUnavailable).
 *
 * One made before comes in pieces of about a megabyte: the one where the
 * picture is first, then the next couple of minutes', then — while the video
 * has picture in hand to spare — the rest, nearest first. Asked for by the
 * subtitle's `v`, they are kept by the browser for the next time it is on,
 * and then all of them that it kept are read at once, from it: they take
 * nothing from the video. On 24 October The 'Burbs, opened again, read them
 * as the video had picture to spare, as if they were coming from the bot,
 * and took 10.6 s to have all of it.
 *
 * It asks where the picture will be as soon as the player has said — the
 * place it starts at or joins the room at — rather than once there is
 * picture: on 24 October a joiner's first lines came 8 s after it started,
 * 2 s after its picture.
 */

/** How often to ask how far the cut has got, while it goes on. */
const ASK_MS = 1_000;
/** Pieces starting within this of the picture are read whatever the video has in hand. */
const NEAR_S = 120;
/** Further ones only with this much picture in hand. */
const SPARE_S = 20;
/** How long to wait for the picture's place before asking from the start. */
const PLACE_WAIT_MS = 15_000;
/** How often "Loading subtitles…" is looked at. */
const WATCH_PLACE_MS = 400;
/** Pieces read at once: a made one's, after a skip, three nearest first. */
const AT_ONCE = 3;

interface PictureSubtitleLayerProps {
  /** The PGS subtitle to draw, or null for none. */
  streamId: number | null;
  ratingKey: string;
  mediaIndex?: number;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Milliseconds. Positive shows it later than the film has it. */
  offsetMs: number;
  /** Told when it can't be had, for the player to burn it in instead. */
  onUnavailable?: () => void;
  /** Draw nothing for now: over the loading screen. */
  hidden?: boolean;
  /** Kept up to date with how far it has loaded, for Stats for nerds. */
  statusRef?: React.MutableRefObject<SubtitleLoadStatus | null>;
}

/** Where the picture is inside the video element, which letterboxes it. */
function usePicture(videoRef: React.RefObject<HTMLVideoElement | null>) {
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number; outerW: number; outerH: number } | null>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const measure = () => {
      const v = videoRef.current;
      if (!v || !v.videoWidth || !v.videoHeight || !v.clientHeight) return;
      const scale = Math.min(v.clientWidth / v.videoWidth, v.clientHeight / v.videoHeight);
      const width = v.videoWidth * scale;
      const height = v.videoHeight * scale;
      const next = {
        left: v.offsetLeft + (v.clientWidth - width) / 2, top: v.offsetTop + (v.clientHeight - height) / 2,
        width, height, outerW: v.clientWidth, outerH: v.clientHeight,
      };
      setBox((prev) => prev && Math.abs(prev.width - width) < 0.5 && Math.abs(prev.height - height) < 0.5 &&
        Math.abs(prev.left - next.left) < 0.5 && Math.abs(prev.top - next.top) < 0.5 ? prev : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(video);
    video.addEventListener("loadedmetadata", measure);
    video.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      video.removeEventListener("loadedmetadata", measure);
      video.removeEventListener("resize", measure);
    };
  }, [videoRef]);
  return box;
}

/** Each object as a picture, made when it is first up. */
const pictures = new WeakMap<PgsObject, ImageData | null>();
function pictureOf(o: PgsObject): ImageData | null {
  let p = pictures.get(o);
  if (p === undefined) {
    p = o.width > 0 && o.height > 0 ? new ImageData(decodeRle(o), o.width, o.height) : null;
    pictures.set(o, p);
  }
  return p;
}

export function PictureSubtitleLayer({
  streamId, ratingKey, mediaIndex, videoRef, offsetMs, onUnavailable, hidden = false, statusRef,
}: PictureSubtitleLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const listRef = useRef<PgsDisplay[]>([]);
  const offsetRef = useRef(offsetMs);
  offsetRef.current = offsetMs;
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;
  /** The subtitle's canvas, as the set on screen has it; null when nothing is up. */
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number } | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [hasLines, setHasLines] = useState(false);

  // Fetching: the cut's pieces, each read on from where it was left.
  useEffect(() => {
    listRef.current = [];
    setHasLines(false);
    setWaiting(false);
    if (streamId == null) return;
    let cancelled = false;
    let next: ReturnType<typeof setTimeout> | undefined;
    let watch: ReturnType<typeof setInterval> | undefined;
    const startedAt = Date.now();
    const status: SubtitleLoadStatus = {
      streamId, state: "loading", lines: 0, covered: null, startedAt, firstLinesMs: null, completeMs: null,
    };
    if (statusRef) statusRef.current = status;
    const readers = new Map<string, { reader: PgsReader; lastPts: number }>();
    /** Pieces being read now. */
    const reading = new Set<string>();
    /** Where every line has come, by piece: a cut's stay once the made one's
     *  pieces replace them, so those aren't read twice. */
    const pieceSpans = new Map<string, CoveredSpan>();
    /** pieceSpans, joined where they meet. */
    let spans: CoveredSpan[] = [];
    let done = false;
    /** The last word on its pieces; reading them, one at a time. */
    let latest: PgsStatus | null = null;
    let busy = false;
    const where = () => Math.max(0, (videoRef.current?.currentTime ?? 0) - offsetRef.current / 1000);
    const covers = (t: number) => spans.some(([a, b]) => t >= a && (b === null || t < b));
    type Piece = PgsStatus["pieces"][number];
    const keyOf = (p: Piece) => `${p.id}:${p.fromS}`;
    const readOf = (p: Piece) => readers.get(keyOf(p))?.reader.read ?? 0;
    /** All of it had already, from another piece. */
    const had = (p: Piece) => spans.some(([a, b]) => a <= p.fromS && (b === null || (p.toS !== null && p.toS <= b)));
    const spare = () => {
      const v = videoRef.current;
      if (!v) return true;
      const t = v.currentTime;
      for (let i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) <= t + 0.5 && v.buffered.end(i) > t) return v.buffered.end(i) - t >= SPARE_S;
      }
      return false;
    };
    /** The piece to read next: where the picture is, then ahead of it, then before. */
    const nextPiece = (): Piece | null => {
      if (!latest) return null;
      const t = where();
      const open = latest.pieces.filter((p) => p.bytes > readOf(p) && !had(p) && !reading.has(keyOf(p)));
      const here = open.filter((p) => p.fromS <= t && (p.toS === null || t < p.toS))
        .sort((a, b) => b.fromS - a.fromS)[0];
      if (here) return here;
      const ahead = open.filter((p) => p.fromS > t).sort((a, b) => a.fromS - b.fromS)[0];
      if (ahead && (ahead.fromS <= t + NEAR_S || spare())) return ahead;
      if (!spare()) return null;
      return open.filter((p) => p.fromS <= t).sort((a, b) => b.fromS - a.fromS)[0] ?? null;
    };

    const fail = (why: string) => {
      if (cancelled) return;
      cancelled = true;
      clearTimeout(next);
      clearInterval(watch);
      status.state = "failed";
      setWaiting(false);
      logWarn("Subtitles", "a picture subtitle couldn't be drawn here; asking for it burned in", { streamId, why });
      onUnavailableRef.current?.();
    };

    /** Whether the pieces the browser kept from before have been looked for. */
    let lookedInCache = false;
    /** Every piece of a made subtitle the browser kept, nearest first. */
    const readCached = async () => {
      const s = latest;
      if (lookedInCache || !s?.done || !s.v) return;
      lookedInCache = true;
      const t = where();
      const order = [...s.pieces].sort((a, b) =>
        (a.fromS <= t ? t - a.fromS : a.fromS - t + NEAR_S) - (b.fromS <= t ? t - b.fromS : b.fromS - t + NEAR_S));
      for (const p of order) {
        if (!p.done || readOf(p) > 0 || had(p)) continue;
        const bytes = sideShare.peek(pgsKey(streamId, s.v, p.id)) ??
          await cachedPgsBytes(streamId, ratingKey, mediaIndex, p.id, s.v);
        if (cancelled) return;
        if (!bytes) continue;
        // For the other players on the title to have from here.
        sideShare.put(pgsKey(streamId, s.v, p.id), bytes);
        take(p, bytes, true);
      }
    };

    /** Read pieces, nearest first, AT_ONCE at a time, while there are any
     *  worth reading now. */
    const read = async () => {
      await readCached();
      const one = async () => {
        for (let p = nextPiece(); p && latest; p = nextPiece()) {
          if (cancelled) return;
          const k = keyOf(p);
          const from = readOf(p);
          const whole = p.done && from === 0 ? latest.v ?? null : null;
          reading.add(k);
          let bytes: Uint8Array;
          try {
            // All of a made one's piece: from another player that has it when
            // one does (lib/sideShare), the bot as well for the one the
            // picture is in. Pieces still being cut grow: from the bot.
            const t = where();
            bytes = whole
              ? await sideShare.get(pgsKey(streamId, whole, p.id), {
                bytes: p.bytes,
                urgent: p.fromS <= t + NEAR_S && (p.toS === null || t < p.toS),
                http: (signal) => fetchPgsBytes(streamId, ratingKey, mediaIndex, p.id, 0, whole, signal),
              })
              : await fetchPgsBytes(streamId, ratingKey, mediaIndex, p.id, from, whole);
          } finally {
            reading.delete(k);
          }
          if (cancelled) return;
          take(p, bytes);
          // Nothing more of it written yet.
          if (bytes.length === 0) return;
        }
      };
      await Promise.all(Array.from({ length: AT_ONCE }, one));
    };

    /**
     * Where every line of a piece has come: to its end once all of it is
     * here; with all it had written read, to where its cut had read the film
     * to; else to its last line so far.
     */
    const spanOf = (p: Piece) => {
      const r = readers.get(keyOf(p));
      const all = (r?.reader.read ?? 0) >= p.bytes;
      let to: number | null;
      if (all && p.done) to = p.toS;
      else if (all && p.reachedS != null) to = Math.max(r?.lastPts ?? p.fromS, p.reachedS);
      else if (r) to = r.lastPts;
      else return;
      pieceSpans.set(keyOf(p), [p.fromS, to]);
    };
    const respan = (pieces: Piece[]) => {
      for (const p of pieces) spanOf(p);
      spans = mergedSpans([...pieceSpans.values()]);
      status.covered = spans;
    };

    /** A piece's bytes, read on from where it was left; `kept`, from the browser. */
    const take = (p: Piece, bytes: Uint8Array, kept = false) => {
      const k = keyOf(p);
      let r = readers.get(k);
      if (!r) readers.set(k, r = { reader: new PgsReader(), lastPts: p.fromS });
      const shown = r.reader.push(bytes);
      if (shown.length) {
        r.lastPts = Math.max(r.lastPts, shown[shown.length - 1].pts);
        listRef.current = mergeDisplays(listRef.current, shown);
      }
      respan([p]);
      status.lines = listRef.current.filter((d) => d.objects.length).length;
      const lines = status.lines;
      if (lines) setHasLines(true);
      if (status.firstLinesMs === null && covers(where())) {
        status.firstLinesMs = Date.now() - startedAt;
        logEvent("Subtitles", "picture subtitle lines for here", {
          streamId, at: Math.round(where()), ms: status.firstLinesMs, made: latest?.v != null, piece: p.id,
          ...(kept ? { kept: true } : {}),
        });
      }
    };

    /** Read what is worth reading now; done once all of it is cut and had. */
    const pump = async () => {
      if (busy || cancelled || done || !latest) return;
      busy = true;
      try {
        await read();
      } catch (err) {
        fail(String(err));
        return;
      } finally {
        busy = false;
      }
      const s = latest;
      if (cancelled || !s?.done || !s.pieces.every((p) => p.bytes <= readOf(p) || had(p))) return;
      done = true;
      clearInterval(watch);
      setWaiting(false);
      Object.assign(status, { state: "complete", covered: null, completeMs: Date.now() - startedAt });
      const shared = sideShare.statsFor("pgs");
      logEvent("Subtitles", "drawing a picture subtitle here rather than burning it in", {
        streamId, lines: status.lines, ms: Date.now() - startedAt, made: s.v !== null,
        fromPlayersMB: (shared.fromPlayers / 1e6).toFixed(1), fromBotMB: (shared.fromBot / 1e6).toFixed(1),
      });
    };

    // Asked until all of it is cut; after that its pieces are known, and are
    // read as the picture goes (watch, below).
    const ask = () => {
      fetchPgsStatus(streamId, ratingKey, mediaIndex, where())
        .then(async (s) => {
          if (cancelled) return;
          if (s.failed) {
            fail(s.failed);
            return;
          }
          latest = s;
          // How far each cut has read, though nothing new was written.
          if (!done) respan(s.pieces);
          if (!done) status.state = "reading";
          await pump();
          if (!cancelled && !s.done) next = setTimeout(ask, ASK_MS);
        })
        .catch((err) => fail(String(err)));
    };

    // The first ask starts the cut from where the picture is, so it waits
    // for there to be a picture: a stream resumed an hour in is at 0 until
    // then — or for the player to have said where it will be, which it does
    // when it starts a stream part-way in, or joins a room, before any picture.
    const asked = Date.now();
    const whenPlaced = () => {
      if (cancelled) return;
      const v = videoRef.current;
      if ((v && (v.readyState >= 2 || v.currentTime > 0)) || Date.now() - asked > PLACE_WAIT_MS) ask();
      else next = setTimeout(whenPlaced, 250);
    };
    whenPlaced();
    watch = setInterval(() => {
      if (done) return;
      setWaiting(!covers(where()));
      if (latest?.done) void pump();
    }, WATCH_PLACE_MS);
    return () => {
      cancelled = true;
      clearTimeout(next);
      clearInterval(watch);
      if (statusRef && statusRef.current === status) statusRef.current = null;
    };
  }, [streamId, ratingKey, mediaIndex]);

  // Drawing: the set up now, each animation frame, redrawn when it changes.
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  useEffect(() => {
    if (streamId == null || !hasLines) {
      setCanvasSize(null);
      return;
    }
    let frame = 0;
    let shown: PgsDisplay | null = null;
    // The canvas it was drawn on: one mounted since (after the layer was
    // hidden) is drawn on afresh.
    let drawnOn: HTMLCanvasElement | null = null;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const v = videoRef.current;
      const now = v && !hiddenRef.current ? displayAt(listRef.current, v.currentTime - offsetRef.current / 1000) : null;
      const canvas = canvasRef.current;
      if (now === shown && canvas === drawnOn) return;
      shown = now;
      if (!now) {
        setCanvasSize(null);
        return;
      }
      setCanvasSize((prev) => prev && prev.width === now.width && prev.height === now.height ? prev : { width: now.width, height: now.height });
      drawnOn = canvas;
      if (!canvas) return;
      if (canvas.width !== now.width) canvas.width = now.width;
      if (canvas.height !== now.height) canvas.height = now.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const o of now.objects) {
        const picture = pictureOf(o);
        if (!picture) continue;
        if (o.crop) ctx.putImageData(picture, o.x - o.crop.x, o.y - o.crop.y, o.crop.x, o.crop.y, o.crop.width, o.crop.height);
        else ctx.putImageData(picture, o.x, o.y);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [streamId, hasLines, videoRef]);

  const box = usePicture(videoRef);
  if (streamId == null || hidden || !box) return null;

  // The subtitle's canvas over the picture, as large as fits it either way —
  // into the bars of a picture cropped of them — but no larger than the player.
  let placed: React.CSSProperties = { ...styles.layer, display: "none" };
  if (canvasSize) {
    const scale = Math.min(
      Math.max(box.width / canvasSize.width, box.height / canvasSize.height),
      box.outerW / canvasSize.width, box.outerH / canvasSize.height,
    );
    const width = canvasSize.width * scale;
    const height = canvasSize.height * scale;
    placed = {
      ...styles.layer,
      left: box.left + (box.width - width) / 2,
      top: box.top + (box.height - height) / 2,
      width, height,
    };
  }
  return (
    <>
      <canvas ref={canvasRef} style={placed} />
      {waiting && !canvasSize && (
        <div style={{ ...styles.waitingRow, bottom: box.top + box.height * 0.055 }} aria-live="polite">
          <div style={styles.waiting}>Loading subtitles…</div>
        </div>
      )}
    </>
  );
}
const styles: Record<string, React.CSSProperties> = {
  /** Above the picture, below the controls, as SubtitleLayer's. */
  layer: {
    position: "absolute",
    pointerEvents: "none",
    zIndex: 9,
  },
  waitingRow: {
    position: "absolute",
    left: 0,
    right: 0,
    display: "flex",
    justifyContent: "center",
    pointerEvents: "none",
    zIndex: 9,
  },
  waiting: {
    fontSize: 13,
    opacity: 0.7,
    color: "#fff",
  },
};
