import { useEffect, useRef, useState } from "react";
import type JASSUB from "jassub";
import {
  cachedAssScript, cachedSubtitleFont, fetchAssScript, fetchAssStatus, fetchSubtitleFont, type AssStatus,
} from "../lib/api";
import { logEvent, logWarn } from "../lib/log";
import { assKey, fontKey, sha1Hex, sideShare } from "../lib/sideShare";
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
 */

/** How often to ask again while the subtitle is still being read out of the film. */
const ASK_MS = 2_000;
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

/**
 * Kept here or by the browser from before; else from another player on the
 * title that has it (lib/sideShare), checked against its hash; else from the
 * bot — each player fetching its share of what players starting together all
 * need (awaitTurn), the plain lines showing meanwhile.
 */
async function fetchShared(item: Shared, stop: AbortSignal): Promise<Uint8Array> {
  const had = sideShare.peek(item.key) ?? await item.kept();
  if (had) {
    // For the other players on the title to have from here.
    sideShare.put(item.key, had);
    return had;
  }
  sideShare.need([item.key]);
  await sideShare.awaitTurn(item.key, stop);
  if (stop.aborted) throw new Error("stopped");
  return sideShare.get(item.key, { urgent: true, check: async (b) => item.named(await sha1Hex(b)), http: item.http });
}

const utf8 = (text: string) => new TextEncoder().encode(text);

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} took over ${ms / 1000} s`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

export function StyledSubtitleLayer({
  streamId, ratingKey, mediaIndex, videoRef, offsetMs, hidden = false, onLook, statusRef,
}: StyledSubtitleLayerProps) {
  const offsetRef = useRef(offsetMs);
  offsetRef.current = offsetMs;
  const onLookRef = useRef(onLook);
  onLookRef.current = onLook;
  const [drawing, setDrawing] = useState<JASSUB | null>(null);

  useEffect(() => {
    if (streamId === null) return;
    const id = streamId;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let instance: JASSUB | null = null;
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

    const draw = async (status: Extract<AssStatus, { state: "styled" }>) => {
      const startedAt = performance.now();
      try {
        // The script's `v` is the start of the SHA-1 of its text, a font's id
        // the SHA-1 of its bytes (the server's styled-subtitles.ts).
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
          Promise.all(status.fonts.map((f) => fetchShared({
            key: fontKey(f.id),
            named: (sha1) => sha1 === f.id.slice(0, 40),
            kept: () => cachedSubtitleFont(f.id),
            http: (signal) => fetchSubtitleFont(f.id, signal),
          }, quit.signal).catch(() => null))),
          loadJassub(),
        ]);
        const script = new TextDecoder().decode(scriptBytes);
        const video = videoRef.current;
        if (stopped) return;
        if (!video) throw new Error("no video to draw over");
        const had = fonts.filter((f): f is Uint8Array => f !== null);
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
        logEvent("Subtitles", "drawing an ASS subtitle as its script has it", {
          streamId: id, bytes: status.bytes, fonts: had.length, fontsMissed: fonts.length - had.length,
          ms: Math.round(performance.now() - startedAt),
          fromPlayersMB: (shared.fromPlayers / 1e6).toFixed(1), fromBotMB: (shared.fromBot / 1e6).toFixed(1),
        });
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
