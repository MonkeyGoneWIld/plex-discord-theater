import { useEffect, useRef, useState } from "react";
import type JASSUB from "jassub";
import {
  cachedAssScript, cachedSubtitleFont, fetchAssScript, fetchAssStatus, fetchSubtitleFont, type AssStatus,
} from "../lib/api";
import { logEvent, logWarn } from "../lib/log";
import { assKey, fontKey, sha1Hex, sideShare } from "../lib/sideShare";
import { nextFont, SPARE_S, wantedNow } from "../lib/subtitleFonts";
import type { SubtitleLoadStatus } from "../lib/subtitleStatus";

/**
 * An ASS or SSA subtitle drawn as its script has it — its fonts, colours,
 * positions, moves, fades, karaoke and drawings — by libass, in a worker
 * (JASSUB), on a canvas over the picture, as Plex draws them. The /subtitles
 * route makes plain lines of it, drawn in the viewer's own look
 * (SubtitleLayer). Your Lie in April's signs and songs lost every move, fade
 * and font they had as plain lines.
 *
 * Until the server says it can be had (the /ass route), and whenever the
 * script can't be drawn here — no WebAssembly, a worker that won't start — the
 * plain lines are drawn (onLook). Only a styled one's timing can change: its
 * look is the script's.
 *
 * Of its fonts, only those the picture's next minute is drawn in are fetched
 * beside the picture, and it is drawn with those; the rest come as the
 * picture has some to spare (lib/subtitleFonts).
 */

/** How often to ask again while the subtitle is still being read out of the film. */
const ASK_MS = 2_000;
/** How often the fonts still to come are looked at. */
const FONT_LOOK_MS = 1_000;
/** How long libass gets to start before the plain lines are drawn instead. */
const START_WAIT_MS = 20_000;
/** How long the plain lines wait, unshown, for the server's answer or libass:
 *  then they show meanwhile, and a styled drawing takes over when it starts. */
const PENDING_MS = 4_000;
/**
 * The most lines libass draws at, scaled up from there. It draws every frame
 * a line changes, at the canvas's size on screen times the screen's pixel
 * ratio, unlimited: 1440 lines on a 1440p screen. Your Lie in April's opening
 * karaoke dropped a tenth of its frames in the Discord app on one on 24
 * October. 1080 is the film's own size.
 */
const MAX_RENDER_HEIGHT = 1080;

interface StyledSubtitleLayerProps {
  /** The ASS subtitle drawn, or null for none. */
  streamId: number | null;
  ratingKey: string;
  mediaIndex?: number;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Milliseconds. Positive shows it later than the film has it. */
  offsetMs: number;
  /** Draw nothing for now: over the loading screen. */
  hidden?: boolean;
  /** How this subtitle is drawn: as plain lines, or as its script has it. */
  onLook: (streamId: number, look: "text" | "styled") => void;
  /** Where it has got to, for Stats for nerds, while it is drawn styled: the
   *  plain lines' layer keeps it otherwise. */
  statusRef?: React.MutableRefObject<SubtitleLoadStatus | null>;
  /** Seconds of picture downloaded ahead of the playhead, the P2P engine's
   *  too; the video's own buffer without it. */
  pictureAheadS?: () => number;
}

interface Jassub {
  JASSUB: typeof JASSUB;
  workerUrl: string;
  wasmUrl: string;
  modernWasmUrl: string;
  fontUrl: string;
}

/** JASSUB and the files its worker needs, loaded the first time one is drawn. */
let loading: Promise<Jassub> | null = null;
function loadJassub(): Promise<Jassub> {
  loading ??= Promise.all([
    import("jassub"),
    import("jassub/dist/worker/worker.js?worker&url"),
    import("jassub/dist/wasm/jassub-worker.wasm?url"),
    import("jassub/dist/wasm/jassub-worker-modern.wasm?url"),
    import("jassub/dist/default.woff2?url"),
  ]).then(([lib, worker, wasm, modern, font]) => ({
    JASSUB: lib.default, workerUrl: worker.default, wasmUrl: wasm.default, modernWasmUrl: modern.default, fontUrl: font.default,
  }));
  loading.catch(() => { loading = null; });
  return loading;
}

/** A script or a font: by the hash it is named by, from wherever it can be had. */
interface Shared {
  key: string;
  /** Whether bytes with this SHA-1 are it. */
  named: (sha1: string) => boolean;
  /** The browser's own copy from before, or null. */
  kept: () => Promise<Uint8Array | null>;
  http: (signal: AbortSignal) => Promise<Uint8Array>;
}

/** Kept here or by the browser from before: nothing to fetch. Null when it isn't. */
async function keptShared(item: Shared): Promise<Uint8Array | null> {
  const had = sideShare.peek(item.key) ?? await item.kept();
  // For the other players on the title to have from here.
  if (had) sideShare.put(item.key, had);
  return had;
}

/**
 * Kept here or by the browser from before; else from another player on the
 * title that has it (lib/sideShare), checked against its hash; else from the
 * bot — each player fetching its share of what players starting together all
 * need (awaitTurn), the plain lines showing meanwhile. One not `urgent` is
 * had from a player that has it, without the bot asked beside it.
 */
async function fetchShared(item: Shared, stop: AbortSignal, urgent = true): Promise<Uint8Array> {
  const had = await keptShared(item);
  if (had) return had;
  sideShare.need([item.key]);
  await sideShare.awaitTurn(item.key, stop);
  if (stop.aborted) throw new Error("stopped");
  return sideShare.get(item.key, { urgent, check: async (b) => item.named(await sha1Hex(b)), http: item.http });
}

const utf8 = (text: string) => new TextEncoder().encode(text);

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} took over ${ms / 1000} s`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

export function StyledSubtitleLayer({
  streamId, ratingKey, mediaIndex, videoRef, offsetMs, hidden = false, onLook, statusRef, pictureAheadS,
}: StyledSubtitleLayerProps) {
  const offsetRef = useRef(offsetMs);
  offsetRef.current = offsetMs;
  const aheadRef = useRef(pictureAheadS);
  aheadRef.current = pictureAheadS;
  const onLookRef = useRef(onLook);
  onLookRef.current = onLook;
  const [drawing, setDrawing] = useState<JASSUB | null>(null);

  useEffect(() => {
    if (streamId === null) return;
    const id = streamId;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let instance: JASSUB | null = null;
    let fontTimer: ReturnType<typeof setInterval> | null = null;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let loaded: SubtitleLoadStatus | null = null;
    const quit = new AbortController();
    const askedAt = Date.now();
    const look = (l: "text" | "styled") => {
      if (pending) clearTimeout(pending);
      pending = null;
      if (!stopped) onLookRef.current(id, l);
    };
    pending = setTimeout(() => look("text"), PENDING_MS);

    /** Where in the script the picture is. */
    const where = () => Math.max(0, (videoRef.current?.currentTime ?? 0) - offsetRef.current / 1000);
    /** Whether the picture has some to spare for fonts not drawn with soon. */
    const spare = () => {
      const v = videoRef.current;
      if (!v) return false;
      let ahead = aheadRef.current?.() ?? 0;
      for (let i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) <= v.currentTime + 0.5 && v.buffered.end(i) > v.currentTime) {
          ahead = Math.max(ahead, v.buffered.end(i) - v.currentTime);
          // To the end of the film: there is no more to have.
          if (Number.isFinite(v.duration) && v.duration - v.buffered.end(i) < 1) return true;
        }
      }
      return ahead >= SPARE_S;
    };
    type Font = Extract<AssStatus, { state: "styled" }>["fonts"][number];
    // A font's id is the SHA-1 of its bytes (the server's styled-subtitles.ts).
    const fontItem = (f: Font): Shared => ({
      key: fontKey(f.id),
      named: (sha1) => sha1 === f.id.slice(0, 40),
      kept: () => cachedSubtitleFont(f.id),
      http: (signal) => fetchSubtitleFont(f.id, signal),
    });

    /**
     * The fonts not fetched beside the picture: one at a time, as
     * lib/subtitleFonts has them, each handed to libass as it comes.
     */
    const fetchRest = (rest: Font[], drawn: JASSUB, had: number, missedBefore: number) => {
      const fromMs = Date.now();
      let added = 0;
      let missed = missedBefore;
      let fetching = false;
      const lookAgain = () => {
        if (stopped || fetching) return;
        const t = where();
        const f = nextFont(rest, t, spare());
        if (!f) {
          if (rest.length) return;
          if (fontTimer) clearInterval(fontTimer);
          fontTimer = null;
          const shared = sideShare.statsFor("styled");
          logEvent("Subtitles", "every font of an ASS subtitle in", {
            streamId: id, fonts: had + added, fontsMissed: missed, laterMs: Date.now() - fromMs,
            fromPlayersMB: (shared.fromPlayers / 1e6).toFixed(1), fromBotMB: (shared.fromBot / 1e6).toFixed(1),
          });
          return;
        }
        rest.splice(rest.indexOf(f), 1);
        fetching = true;
        void fetchShared(fontItem(f), quit.signal, wantedNow(f, t))
          .then(async (bytes) => {
            if (stopped) return;
            await drawn.renderer.addFonts([bytes]);
            added++;
            // The lines on screen drawn again, in it.
            if (!stopped) void drawn.resize(true).catch(() => {});
          })
          .catch(() => { missed++; })
          .finally(() => {
            fetching = false;
            lookAgain();
          });
      };
      fontTimer = setInterval(lookAgain, FONT_LOOK_MS);
      lookAgain();
    };

    const draw = async (status: Extract<AssStatus, { state: "styled" }>) => {
      const startedAt = performance.now();
      try {
        // Those kept from before are in hand at once; of the rest, those the
        // picture's next minute is drawn in come beside it, and the others
        // as it has picture to spare (fetchRest).
        const kept = await Promise.all(status.fonts.map((f) => keptShared(fontItem(f)).catch(() => null)));
        const t0 = where();
        const first = status.fonts.filter((f, i) => !kept[i] && wantedNow(f, t0));
        const rest = status.fonts.filter((f, i) => !kept[i] && !wantedNow(f, t0));
        // The script's `v` is the start of the SHA-1 of its text.
        const [scriptBytes, fonts, lib] = await Promise.all([
          fetchShared({
            key: assKey(id, status.v),
            named: (sha1) => sha1.slice(0, 16) === status.v,
            kept: async () => {
              const text = await cachedAssScript(id, ratingKey, mediaIndex, status.v);
              return text === null ? null : utf8(text);
            },
            http: async (signal) => utf8(await fetchAssScript(id, ratingKey, mediaIndex, status.v, signal)),
          }, quit.signal),
          Promise.all(first.map((f) => fetchShared(fontItem(f), quit.signal).catch(() => null))),
          loadJassub(),
        ]);
        const script = new TextDecoder().decode(scriptBytes);
        const video = videoRef.current;
        if (stopped) return;
        if (!video) throw new Error("no video to draw over");
        const had = [...kept, ...fonts].filter((f): f is Uint8Array => f !== null);
        instance = new lib.JASSUB({
          video,
          subContent: script,
          fonts: had,
          workerUrl: lib.workerUrl,
          wasmUrl: lib.wasmUrl,
          modernWasmUrl: lib.modernWasmUrl,
          availableFonts: { "liberation sans": lib.fontUrl },
          // Only the film's fonts and libass's own: asking for the viewer's
          // means a permission prompt, and Google's, a third party.
          queryFonts: false,
          maxRenderHeight: MAX_RENDER_HEIGHT,
          timeOffset: -offsetRef.current / 1000,
        });
        // Over the picture with the other subtitles, under the controls.
        instance._canvas.style.zIndex = "9";
        await within(instance.ready, START_WAIT_MS, "libass starting");
        if (stopped) return;
        setDrawing(instance);
        // All of it is in hand, before the plain lines' layer, which this
        // takes over from, lets its own go.
        const tookMs = Date.now() - askedAt;
        loaded = {
          streamId: id, state: "complete", lines: script.match(/^Dialogue:/gm)?.length ?? 0, covered: null,
          startedAt: askedAt, firstLinesMs: tookMs, completeMs: tookMs, styled: true,
        };
        if (statusRef) statusRef.current = loaded;
        look("styled");
        const shared = sideShare.statsFor("styled");
        const missed = fonts.filter((f) => f === null).length;
        logEvent("Subtitles", "drawing an ASS subtitle as its script has it", {
          streamId: id, bytes: status.bytes, fonts: had.length, fontsMissed: missed, fontsLater: rest.length,
          ...(rest.length ? { laterMB: (rest.reduce((n, f) => n + f.bytes, 0) / 1e6).toFixed(1) } : {}),
          ms: Math.round(performance.now() - startedAt),
          fromPlayersMB: (shared.fromPlayers / 1e6).toFixed(1), fromBotMB: (shared.fromBot / 1e6).toFixed(1),
        });
        if (rest.length) fetchRest(rest, instance, had.length, missed);
      } catch (err) {
        logWarn("Subtitles", "couldn't draw an ASS subtitle as its script has it, drawing its lines plainly", {
          streamId: id, error: err instanceof Error ? err.message : String(err),
        });
        void instance?.destroy().catch(() => {});
        instance = null;
        look("text");
      }
    };

    const ask = async () => {
      let status: AssStatus;
      try {
        status = await fetchAssStatus(id, ratingKey, mediaIndex);
      } catch {
        look("text");
        return;
      }
      if (stopped) return;
      if (status.state === "styled") {
        await draw(status);
        return;
      }
      // Plain lines meanwhile, or for good.
      look("text");
      if (status.state === "reading") timer = setTimeout(() => void ask(), ASK_MS);
    };
    void ask();

    return () => {
      stopped = true;
      quit.abort();
      if (timer) clearTimeout(timer);
      if (fontTimer) clearInterval(fontTimer);
      if (pending) clearTimeout(pending);
      if (statusRef && loaded && statusRef.current === loaded) statusRef.current = null;
      setDrawing(null);
      void instance?.destroy().catch(() => {});
    };
  }, [streamId, ratingKey, mediaIndex, videoRef, statusRef]);

  // A new offset shows at once, paused too.
  useEffect(() => {
    if (!drawing) return;
    drawing.timeOffset = -offsetMs / 1000;
    void drawing.resize(true).catch(() => {});
  }, [drawing, offsetMs]);

  useEffect(() => {
    if (drawing) drawing._canvas.style.visibility = hidden ? "hidden" : "";
  }, [drawing, hidden]);

  return null;
}
