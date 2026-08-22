import { useEffect, useRef, useState } from "react";
import { fetchSubtitleCues, type SubtitleCue } from "../lib/api";
import { logEvent, logWarn } from "../lib/log";

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
 * exactly the kind of stale global setting worth not building.
 */

/** Cue text as a share of the picture's height, matching a burned-in subtitle. */
const FONT_SCALE = 0.043;
/** And how far it sits above the bottom of the picture, in the same units. */
const BOTTOM_SCALE = 0.055;
/** Bounds for absurd geometry — a sliver of a window, or a wall-sized display. */
const MIN_FONT_PX = 13;
const MAX_FONT_PX = 56;

/**
 * Where the picture actually is inside the video element.
 *
 * The element fills the player, but `object-fit: contain` letterboxes the image
 * inside it, so the element's own box says nothing about where the picture
 * ends. Burned-in subtitles are part of the picture; sitting where they sit
 * means working out the same rectangle.
 */
function usePictureBox(videoRef: React.RefObject<HTMLVideoElement | null>) {
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
 * Which cue belongs on screen.
 *
 * `timeupdate` fires about four times a second, which is enough to be a quarter
 * of a second late putting a line up — visible, and the wrong thing to be
 * imprecise about in a component whose entire job is timing. An animation frame
 * is nearly free when nothing changes, because the work is a comparison and
 * React is only touched when the answer differs.
 */
function useActiveCue(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  cues: SubtitleCue[],
  offsetMs: number,
): SubtitleCue | null {
  const [active, setActive] = useState<SubtitleCue | null>(null);
  // Read inside the frame loop, which is started once and would otherwise close
  // over the first value of each forever.
  const cuesRef = useRef(cues);
  cuesRef.current = cues;
  const offsetRef = useRef(offsetMs);
  offsetRef.current = offsetMs;
  // What is on screen, so the common case — the same cue still showing — costs
  // one comparison and no React work at all.
  const shownRef = useRef<SubtitleCue | null>(null);
  // Index of the last cue found, so a scan starts from where it left off rather
  // than from the beginning of a two-thousand-line file every frame.
  const hintRef = useRef(0);
  // Nothing loaded means nothing to time, and a frame loop that wakes up sixty
  // times a second to decide it has no work is worth not starting.
  const hasCues = cues.length > 0;

  useEffect(() => {
    if (!hasCues) return;
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const video = videoRef.current;
      const list = cuesRef.current;
      if (!video || list.length === 0) {
        if (shownRef.current !== null) { shownRef.current = null; setActive(null); }
        return;
      }
      // A positive offset means "show the text later", which is the direction
      // Plex's own control moves in: +100ms delays the subtitle.
      const at = video.currentTime - offsetRef.current / 1000;

      // Walk from the hint. Playback moves forward a frame at a time, so this is
      // one step in the ordinary case; a seek is the only thing that makes it
      // long, and even then it is bounded by the file.
      let i = Math.min(hintRef.current, list.length - 1);
      while (i > 0 && list[i].start > at) i--;
      while (i < list.length - 1 && list[i].end < at) i++;
      hintRef.current = i;

      const cue = list[i] && at >= list[i].start && at <= list[i].end ? list[i] : null;
      if (cue !== shownRef.current) {
        shownRef.current = cue;
        setActive(cue);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [videoRef, hasCues]);

  return active;
}

interface SubtitleLayerProps {
  /** The sidecar to draw, or null when subtitles are off or Plex is burning
   *  them in. Changing it loads the new one and clears what was on screen. */
  streamId: number | null;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Milliseconds. Positive shows the text later than the file says. */
  offsetMs: number;
  /** Told when a sidecar can't be read, so the player can say so rather than
   *  leaving somebody staring at a film with no subtitles and no explanation. */
  onUnavailable?: () => void;
}

export function SubtitleLayer({ streamId, videoRef, offsetMs, onUnavailable }: SubtitleLayerProps) {
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;

  useEffect(() => {
    setCues([]);
    if (streamId == null) return;
    let cancelled = false;
    fetchSubtitleCues(streamId)
      .then((r) => {
        if (cancelled) return;
        setCues(r.cues);
        logEvent("Subtitles", "drawing a sidecar here rather than burning it in", {
          streamId, cues: r.cues.length,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        // The stream is already running without burned-in subtitles, so there
        // is nothing to fall back to in place — say so instead of showing a
        // film that silently has no subtitles.
        logWarn("Subtitles", "sidecar could not be loaded", {
          streamId, error: String(err),
        });
        onUnavailableRef.current?.();
      });
    return () => { cancelled = true; };
  }, [streamId]);

  const cue = useActiveCue(videoRef, cues, offsetMs);
  const box = usePictureBox(videoRef);
  if (!cue) return null;

  // Before the intrinsic size is known there is no picture to measure against.
  // The fallbacks say the same thing about the player instead, so a cue landing
  // in that window is approximately placed rather than missing.
  const fontSize = box
    ? Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, box.height * FONT_SCALE))
    : `clamp(${MIN_FONT_PX}px, 4.3vh, ${MAX_FONT_PX}px)`;
  const bottom = box ? box.bottomInset + box.height * BOTTOM_SCALE : "5.5%";

  return (
    <div style={{ ...styles.layer, bottom }} aria-live="off">
      <div style={{ ...styles.cue, fontSize }}>
        {cue.text.split("\n").map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </div>
    </div>
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
    lineHeight: 1.25,
    // Burned-in subtitles are rendered at a normal weight. Anything heavier
    // reads as a different track rather than the same one delivered differently.
    fontWeight: 400,
    color: "#fff",
    // An outline rather than a plate: it reads on white and on black alike, and
    // it is close to what the burned ones carry, so the two match.
    textShadow:
      "0 0 3px rgba(0,0,0,0.85), 0 1px 2px rgba(0,0,0,0.95), 0 0 10px rgba(0,0,0,0.5)",
    whiteSpace: "pre-wrap",
    textWrap: "balance",
  },
};
