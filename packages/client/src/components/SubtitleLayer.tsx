import { useEffect, useRef, useState } from "react";
import { fetchSubtitleCues, type SubtitleCue } from "../lib/api";
import { logEvent, logWarn } from "../lib/log";
import { activeCues, longestCue, sameCues } from "../lib/subtitleCues";
import { SUBTITLE_COLORS, SUBTITLE_FONTS, useSubtitleStyle, type SubtitleStyle } from "../lib/subtitleStyle";

/**
 * Subtitles this client draws itself, from a sidecar file.
 *
 * Everything else in this player is burned into the picture by Plex on the way
 * out. That is fine until somebody needs to re-time it: burned subtitles are
 * pixels in the video frames by the time they arrive, and no adjustment reaches
 * them. A sidecar is still text, so the server hands over the cues and they are
 * drawn here — where an offset is a number added to two other numbers.
 *
 * These have to be indistinguishable from the burned ones. Nobody picks a
 * subtitle track by how it is delivered, so switching between an embedded track
 * and a sidecar should show the same thing, the same size, in the same place —
 * which is why everything below is measured against the picture rather than
 * against the window.
 *
 * The offset itself is per viewer and lives only as long as the player does. It
 * is a property of one badly-timed release rather than of the person watching,
 * and a remembered offset silently applying to a different show later is
 * exactly the kind of stale global setting worth not building. How the text
 * looks — size, colour, a box behind it, how high it sits — is the opposite, a
 * property of the person, and is saved: see lib/subtitleStyle.ts.
 *
 * Several cues can be up at once (see lib/subtitleCues.ts): overlapping
 * dialogue at the bottom, and the signs a typeset release places at the top.
 */

/**
 * Cue text as a share of the picture's height: Plex's own player at its
 * default size, measured side by side on the same frame. This used to match a
 * subtitle Plex burns in, which is drawn smaller — about two thirds the size —
 * and next to Plex's own app it read as small and thin.
 */
const FONT_SCALE = 0.062;
/** And how far it sits above the bottom of the picture, in the same units. */
const BOTTOM_SCALE = 0.055;
/** How often to ask again for a subtitle Plex is still reading out of the file. */
const STILL_READING_POLL_MS = 4_000;
/** Bounds for absurd geometry — a sliver of a window, or a wall-sized display. */
const MIN_FONT_PX = 13;
const MAX_FONT_PX = 80;
/** More than this many lines at one end of the picture is a typesetting effect
 *  this renderer can't draw, not something to read; the earliest are kept. */
const MAX_CUES_PER_EDGE = 4;

/**
 * Where the picture actually is inside the video element.
 *
 * The element fills the player, but `object-fit: contain` letterboxes the image
 * inside it, so the element's own box says nothing about where the picture
 * ends. Burned-in subtitles are part of the picture; sitting where they sit
 * means working out the same rectangle.
 */
function usePictureBox(videoRef: React.RefObject<HTMLVideoElement | null>) {
  // Letterboxing is symmetrical, so the inset at the bottom is the inset at the
  // top as well.
  const [box, setBox] = useState<{ bottomInset: number; height: number } | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const measure = () => {
      const v = videoRef.current;
      if (!v || !v.videoWidth || !v.videoHeight || !v.clientHeight) return;
      const scale = Math.min(v.clientWidth / v.videoWidth, v.clientHeight / v.videoHeight);
      const height = v.videoHeight * scale;
      setBox((prev) =>
        prev && Math.abs(prev.height - height) < 0.5 ? prev : {
          // Contain centres what it letterboxes, so the bar below the picture is
          // half of what was left over.
          bottomInset: (v.clientHeight - height) / 2,
          height,
        });
    };

    measure();
    // The three things that change the answer: the window resizing, and the two
    // moments the intrinsic size becomes known or changes — a stream starting,
    // and the next episode replacing it.
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

/**
 * Which cues belong on screen.
 *
 * `timeupdate` fires about four times a second, which is enough to be a quarter
 * of a second late putting a line up — visible, and the wrong thing to be
 * imprecise about in a component whose entire job is timing. An animation frame
 * is nearly free when nothing changes, because the work is a binary search and
 * a comparison, and React is only touched when the answer differs.
 */
const NONE: SubtitleCue[] = [];

function useActiveCues(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  cues: SubtitleCue[],
  offsetMs: number,
): SubtitleCue[] {
  const [active, setActive] = useState<SubtitleCue[]>(NONE);
  // Read inside the frame loop, which is started once and would otherwise close
  // over the first value of each forever.
  const cuesRef = useRef(cues);
  cuesRef.current = cues;
  const offsetRef = useRef(offsetMs);
  offsetRef.current = offsetMs;
  // How far back a cue still showing can have started — per list, not per frame.
  const longest = useRef({ list: cues, s: longestCue(cues) });
  if (longest.current.list !== cues) longest.current = { list: cues, s: longestCue(cues) };
  // What is on screen, so the common case — the same cues still showing — costs
  // a comparison and no React work at all.
  const shownRef = useRef<SubtitleCue[]>(NONE);
  // Nothing loaded means nothing to time, and a frame loop that wakes up sixty
  // times a second to decide it has no work is worth not starting.
  const hasCues = cues.length > 0;

  useEffect(() => {
    if (!hasCues) {
      // Switching a sidecar track to None empties the cue list. Clear what was
      // showing as part of that transition; otherwise the old React state
      // remains rendered for the rest of playback because there is no
      // animation frame left to discover that the list is empty.
      shownRef.current = NONE;
      setActive(NONE);
      return;
    }
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const video = videoRef.current;
      const list = cuesRef.current;
      // A positive offset means "show the text later", which is the direction
      // Plex's own control moves in: +100ms delays the subtitle.
      const now = video && list.length > 0
        ? activeCues(list, video.currentTime - offsetRef.current / 1000, longest.current.s) as SubtitleCue[]
        : NONE;
      if (!sameCues(now, shownRef.current)) {
        shownRef.current = now.length ? now : NONE;
        setActive(shownRef.current);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [videoRef, hasCues]);

  return active;
}

/**
 * A solid black outline, the way Plex's player draws one: a ring of shadows
 * all the way round each letter, about a sixteenth of the letter's size, with
 * a soft edge outside it. In em, so it grows with the text.
 *
 * A ring of shadows rather than -webkit-text-stroke: a stroke is drawn over the
 * letter's own edge and eats into it unless paint-order puts it behind, which
 * not every webview Discord runs in honours for HTML text. Shadows are drawn
 * behind the text everywhere.
 */
const OUTLINE_SHADOW = (() => {
  const ring = (radius: number, steps: number) => Array.from({ length: steps }, (_, i) => {
    const a = (i / steps) * Math.PI * 2;
    return `${(Math.cos(a) * radius).toFixed(3)}em ${(Math.sin(a) * radius).toFixed(3)}em 0 #000`;
  });
  return [...ring(0.06, 16), ...ring(0.03, 8), "0 0 0.14em rgba(0,0,0,0.55)"].join(", ");
})();

/** The text's own look, from the viewer's style — also what Settings shows as
 *  its sample line. */
export function subtitleTextStyle(style: SubtitleStyle, fontSize: number | string): React.CSSProperties {
  const color = SUBTITLE_COLORS[style.color].css;
  const scaled = typeof fontSize === "number"
    ? fontSize * style.size / 100
    : `calc(${fontSize} * ${style.size / 100})`;
  return {
    fontSize: scaled,
    color,
    fontWeight: style.bold ? 700 : 500,
    fontStyle: style.italic ? "italic" : undefined,
    fontFamily: SUBTITLE_FONTS[style.font].css,
    textShadow: style.background === "outline"
      ? OUTLINE_SHADOW
      : style.background === "shadow"
        ? "0.06em 0.08em 0.12em rgba(0,0,0,0.95), 0 0 0.3em rgba(0,0,0,0.45)"
        : "none",
  };
}

interface SubtitleLayerProps {
  /** The sidecar to draw, or null when subtitles are off or Plex is burning
   *  them in. Changing it loads the new one and clears what was on screen. */
  streamId: number | null;
  /** The title and version it belongs to, so a subtitle stored inside the
   *  media file can be read out of it rather than burned in. */
  ratingKey?: string;
  mediaIndex?: number;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Milliseconds. Positive shows the text later than the file says. */
  offsetMs: number;
  /** Told when a sidecar can't be read, so the player can say so rather than
   *  leaving somebody staring at a film with no subtitles and no explanation. */
  onUnavailable?: () => void;
}

export function SubtitleLayer({ streamId, ratingKey, mediaIndex, videoRef, offsetMs, onUnavailable }: SubtitleLayerProps) {
  const style = useSubtitleStyle();
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  // Plex is still reading this one out of the media file: cues so far are
  // drawn, and the rest is asked for again shortly.
  const [stillReading, setStillReading] = useState(false);
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;

  useEffect(() => {
    setCues([]);
    setStillReading(false);
    if (streamId == null) return;
    let cancelled = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    const load = (fresh: boolean) => {
      fetchSubtitleCues(streamId, ratingKey, mediaIndex, fresh)
        .then((r) => {
          if (cancelled) return;
          setCues(r.cues);
          if (r.complete === false) {
            setStillReading(true);
            poll = setTimeout(() => load(true), STILL_READING_POLL_MS);
            return;
          }
          setStillReading(false);
          logEvent("Subtitles", "drawing a sidecar here rather than burning it in", {
            streamId, cues: r.cues.length,
            ...(fresh ? { waitedMs: Date.now() - startedAt } : {}),
          });
        })
        .catch((err) => {
          if (cancelled) return;
          setStillReading(false);
          // The stream is already running without burned-in subtitles, so there
          // is nothing to fall back to in place — say so instead of showing a
          // film that silently has no subtitles. (A subtitle inside the file
          // that Plex fails to read out has the server restart the stream with
          // it burned in.)
          logWarn("Subtitles", "sidecar could not be loaded", {
            streamId, error: String(err),
          });
          onUnavailableRef.current?.();
        });
    };
    load(false);
    return () => { cancelled = true; clearTimeout(poll); };
  }, [streamId]);

  const shown = useActiveCues(videoRef, cues, offsetMs);
  const box = usePictureBox(videoRef);
  // While Plex is still reading it out, say so wherever there is no line yet —
  // a film that starts with no subtitles otherwise looks like a broken track.
  const lastEnd = cues.length > 0 ? cues[cues.length - 1].end : -1;
  const waiting = stillReading && shown.length === 0 && (videoRef.current?.currentTime ?? 0) >= lastEnd;
  if (shown.length === 0 && !waiting) return null;

  // Before the intrinsic size is known there is no picture to measure against.
  // The fallbacks say the same thing about the player instead, so a cue landing
  // in that window is approximately placed rather than missing.
  const fontSize = box
    ? Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, box.height * FONT_SCALE))
    : `clamp(${MIN_FONT_PX}px, ${(FONT_SCALE * 100).toFixed(1)}vh, ${MAX_FONT_PX}px)`;
  const edge = (raise: number) => box
    ? box.bottomInset + box.height * (BOTTOM_SCALE + raise / 100)
    : `${(BOTTOM_SCALE * 100 + raise).toFixed(1)}%`;
  const bottom = edge(style.raise);

  if (shown.length === 0) {
    return (
      <div style={{ ...styles.layer, bottom }} aria-live="polite">
        <div style={{ ...styles.cue, ...styles.waiting }}>Loading subtitles…</div>
      </div>
    );
  }

  const text = subtitleTextStyle(style, fontSize);
  const boxed = style.background === "box";
  const draw = (list: SubtitleCue[]) => (
    <div style={{ ...styles.cue, ...text }}>
      {list.slice(0, MAX_CUES_PER_EDGE).map((cue, n) => (
        <div key={n} style={cue.italic ? styles.italic : undefined}>
          {cue.text.split("\n").map((line, i) => (
            <div key={i}>
              {boxed ? <span style={styles.box}>{line}</span> : line}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
  const low = shown.filter((c) => !c.top);
  const high = shown.filter((c) => c.top);

  return (
    <>
      {low.length > 0 && (
        <div style={{ ...styles.layer, bottom }} aria-live="off">{draw(low)}</div>
      )}
      {/* Signs and notes the subtitle places up top. The viewer's raise is for
          the dialogue; these keep to the edge they were put at. */}
      {high.length > 0 && (
        <div style={{ ...styles.layer, top: edge(0) }} aria-live="off">{draw(high)}</div>
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  /**
   * Sits above the picture and below the controls.
   *
   * Deliberately does NOT move when the control bar appears. It used to, on the
   * reasoning that text behind the bar is unreadable — but a burned-in subtitle
   * does not move either, and the difference was the whole complaint: subtitles
   * that shift every time the window takes focus read as broken in a way that
   * three seconds of overlap does not.
   */
  layer: {
    position: "absolute",
    left: 0,
    right: 0,
    display: "flex",
    justifyContent: "center",
    padding: "0 8%",
    pointerEvents: "none",
    zIndex: 9,
  },
  cue: {
    textAlign: "center",
    lineHeight: 1.22,
    color: "#fff",
    whiteSpace: "pre-wrap",
    textWrap: "balance",
  },
  /** Small and faint: a note about the track, not a line of it. */
  waiting: {
    fontSize: 13,
    opacity: 0.7,
  },
  italic: { fontStyle: "italic" },
  /** A plate behind each line, for a viewer who finds an outline hard to read. */
  box: {
    background: "rgba(0,0,0,0.72)",
    padding: "0.05em 0.35em",
    borderRadius: "0.15em",
    boxDecorationBreak: "clone",
    WebkitBoxDecorationBreak: "clone",
  },
};
