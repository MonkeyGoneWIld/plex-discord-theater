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
 * The offset is per viewer and lives only as long as the player does. It is a
 * property of one badly-timed release rather than of the person watching, and a
 * remembered offset silently applying to a different show later is exactly the
 * kind of stale global setting worth not building.
 */

/**
 * How often the cue on screen is re-checked.
 *
 * `timeupdate` fires about four times a second, which is enough to be a quarter
 * of a second late putting a line up — visible, and the wrong thing to be
 * imprecise about in a component whose entire job is timing. An animation frame
 * is free when nothing changes, because the work is a comparison and the state
 * is only written when the answer differs.
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
  // Where the last answer came from, so the common case — the same cue still
  // showing — costs one comparison and no React work at all.
  const shownRef = useRef<SubtitleCue | null>(null);
  // Index of the last cue found, so a linear scan starts from where it left off
  // rather than from the beginning of a two-thousand-line file every frame.
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
  /** Whether the control bar is up, and so whether the text has to move above
   *  it. See the `layer` style. */
  controlsVisible?: boolean;
}

export function SubtitleLayer({
  streamId,
  videoRef,
  offsetMs,
  onUnavailable,
  controlsVisible = false,
}: SubtitleLayerProps) {
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
  if (!cue) return null;

  return (
    <div
      style={{
        ...styles.layer,
        // Up and out of the way of the control bar, and back down when it goes.
        bottom: controlsVisible ? "22%" : "9%",
      }}
      aria-live="off"
    >
      <div style={styles.cue}>
        {cue.text.split("\n").map((line, i) => (
          <div key={i} style={styles.line}>{line}</div>
        ))}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  /**
   * Sits above the picture and below the controls.
   *
   * Anchored to the bottom of the player rather than to the bottom of the
   * rendered picture: on letterboxed content that puts the text in the black
   * bar, which is where most players put it and where it is easiest to read.
   *
   * Lifted while the control bar is up, because the bar is well over a fifth of
   * the height of a phone in landscape and text left at 9% is behind it. Every
   * other player does this for the same reason. The rise is animated rather
   * than instant so it reads as making room rather than as the subtitle
   * jumping — and it goes back down as soon as the bar does.
   */
  layer: {
    position: "absolute",
    left: 0,
    right: 0,
    transition: "bottom 220ms cubic-bezier(0.2, 0, 0, 1)",
    display: "flex",
    justifyContent: "center",
    padding: "0 8%",
    pointerEvents: "none",
    zIndex: 9,
  },
  cue: {
    textAlign: "center",
    // Tracks the player rather than the page: the same subtitle has to be
    // readable on a phone in Discord's picture-in-picture and on a television.
    fontSize: "clamp(15px, 2.6vw, 30px)",
    lineHeight: 1.3,
    fontWeight: 500,
    color: "#fff",
    // An outline rather than a box. A background plate is the safer choice for
    // legibility, but it also covers the picture even when nothing needs
    // covering; the shadow reads on white and on black alike.
    textShadow:
      "0 0 4px rgba(0,0,0,0.9), 0 1px 2px rgba(0,0,0,0.95), 0 0 12px rgba(0,0,0,0.6)",
    whiteSpace: "pre-wrap",
    textWrap: "balance",
  },
  line: { margin: 0 },
};
