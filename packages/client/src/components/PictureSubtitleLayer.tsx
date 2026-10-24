import { useEffect, useRef, useState } from "react";
import { fetchPgsBytes, fetchPgsStatus, type PgsStatus } from "../lib/api";
import { logEvent, logWarn } from "../lib/log";
import { PgsReader, decodeRle, displayAt, mergeDisplays, type PgsDisplay, type PgsObject } from "../lib/pgs";
import type { CoveredSpan } from "../lib/subtitleCues";
import type { SubtitleLoadStatus } from "../lib/subtitleStatus";

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
 * picture is, then the start. Lines come as it goes, and "Loading subtitles…"
 * says so where none have yet. One that can't be cut has the player ask for
 * a stream with it burned in instead (onUnavailable).
 */

/** How often to ask how far the cut has got, while it goes on. */
const ASK_MS = 1_000;
/** How long to wait for the picture's place before asking from the start. */
const PLACE_WAIT_MS = 15_000;
/** How often "Loading subtitles…" is looked at. */
const WATCH_PLACE_MS = 400;

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
    let spans: CoveredSpan[] = [];
    let done = false;
    const where = () => Math.max(0, (videoRef.current?.currentTime ?? 0) - offsetRef.current / 1000);
    const covers = (t: number) => spans.some(([a, b]) => t >= a && (b === null || t < b));

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

    const read = async (s: PgsStatus) => {
      for (const p of s.pieces) {
        const id = `${p.id}:${p.fromS}`;
        let r = readers.get(id);
        if (!r) readers.set(id, r = { reader: new PgsReader(), lastPts: p.fromS });
        if (p.bytes <= r.reader.read) continue;
        const bytes = await fetchPgsBytes(streamId, ratingKey, mediaIndex, p.id, r.reader.read);
        if (cancelled) return;
        const shown = r.reader.push(bytes);
        if (shown.length) {
          r.lastPts = Math.max(r.lastPts, shown[shown.length - 1].pts);
          listRef.current = mergeDisplays(listRef.current, shown);
        }
      }
      // Where every line has come: each piece from where it starts, to its end
      // once it is done, else to its last line so far.
      spans = s.pieces.map((p) => [p.fromS, p.done ? p.toS : readers.get(`${p.id}:${p.fromS}`)?.lastPts ?? p.fromS]);
      const lines = listRef.current.filter((d) => d.objects.length).length;
      Object.assign(status, { lines, covered: s.done ? null : spans });
      if (lines) setHasLines(true);
      if (status.firstLinesMs === null && covers(where())) status.firstLinesMs = Date.now() - startedAt;
    };

    const ask = () => {
      fetchPgsStatus(streamId, ratingKey, mediaIndex, where())
        .then(async (s) => {
          if (cancelled) return;
          if (s.failed) {
            fail(s.failed);
            return;
          }
          await read(s);
          if (cancelled) return;
          // Done once all of it is cut and all of that read.
          if (s.done && s.pieces.every((p) => p.bytes <= (readers.get(`${p.id}:${p.fromS}`)?.reader.read ?? 0))) {
            done = true;
            clearInterval(watch);
            setWaiting(false);
            Object.assign(status, { state: "complete", covered: null, completeMs: Date.now() - startedAt });
            logEvent("Subtitles", "drawing a picture subtitle here rather than burning it in", {
              streamId, lines: status.lines, ms: Date.now() - startedAt,
            });
            return;
          }
          status.state = "reading";
          next = setTimeout(ask, ASK_MS);
        })
        .catch((err) => fail(String(err)));
    };

    // The first ask starts the cut from where the picture is, so it waits
    // for there to be a picture: a stream resumed an hour in is at 0 until then.
    const asked = Date.now();
    const whenPlaced = () => {
      if (cancelled) return;
      const v = videoRef.current;
      if ((v && v.readyState >= 2) || Date.now() - asked > PLACE_WAIT_MS) ask();
      else next = setTimeout(whenPlaced, 250);
    };
    whenPlaced();
    watch = setInterval(() => {
      if (!done) setWaiting(!covers(where()));
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
