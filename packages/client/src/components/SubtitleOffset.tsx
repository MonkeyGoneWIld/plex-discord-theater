/**
 * Nudging a sidecar subtitle into time with the audio.
 *
 * Only reachable for subtitles this client draws itself — see SubtitleLayer. A
 * burned-in subtitle is pixels in the video frames by the time it arrives, so
 * there is nothing here that could move it, and offering the control anyway
 * would be offering a button that does nothing.
 *
 * Steps of 50ms, matching Plex's own control. Small enough that a press is a
 * correction rather than a guess, large enough to be worth pressing: below
 * about 40ms the change is under one frame at 24fps and nobody can see it.
 */

/** One press. Plex uses the same step, and people arrive here expecting it. */
const STEP_MS = 50;
/**
 * As far as this will go in either direction.
 *
 * Two seconds covers a subtitle cut for a different release of the same film —
 * the ordinary reason for a mismatch. Past that the file is for a different cut
 * entirely and no amount of nudging will line it up, so the limit is also a
 * hint to stop trying and pick a different subtitle.
 */
const LIMIT_MS = 2_000;

export function clampOffset(ms: number): number {
  return Math.max(-LIMIT_MS, Math.min(LIMIT_MS, Math.round(ms)));
}

interface SubtitleOffsetProps {
  offsetMs: number;
  onChange: (ms: number) => void;
  onClose: () => void;
}

export function SubtitleOffset({ offsetMs, onChange, onClose }: SubtitleOffsetProps) {
  const step = (delta: number) => onChange(clampOffset(offsetMs + delta));
  const atMin = offsetMs <= -LIMIT_MS;
  const atMax = offsetMs >= LIMIT_MS;

  return (
    <div style={styles.panel} role="group" aria-label="Subtitle offset">
      <button
        className="btn"
        style={styles.close}
        onClick={onClose}
        title="Close"
        aria-label="Close subtitle offset"
      >
        {"✕"}
      </button>

      <div style={styles.heading}>
        Subtitle offset:{" "}
        <span style={styles.value}>
          {/* The sign is carried explicitly. "+100 ms" and "-100 ms" are
              opposite instructions and a bare number says neither. */}
          {offsetMs > 0 ? "+" : ""}{offsetMs} ms
        </span>
      </div>

      <div style={styles.row}>
        <button
          className="btn"
          style={{ ...styles.step, ...(atMin ? styles.stepDisabled : {}) }}
          onClick={() => step(-STEP_MS)}
          disabled={atMin}
          title="Show subtitles earlier"
        >
          {"−"}{STEP_MS} ms
        </button>
        <button
          className="btn"
          style={{ ...styles.step, ...(atMax ? styles.stepDisabled : {}) }}
          onClick={() => step(STEP_MS)}
          disabled={atMax}
          title="Show subtitles later"
        >
          +{STEP_MS} ms
        </button>
        <button
          className="btn"
          style={{ ...styles.step, ...(offsetMs === 0 ? styles.stepDisabled : {}) }}
          onClick={() => onChange(0)}
          disabled={offsetMs === 0}
          title="Back to the file's own timing"
        >
          Reset
        </button>
      </div>

      <div style={styles.hint}>
        {offsetMs === 0
          ? "Subtitles are using the file's own timing."
          : offsetMs > 0
            ? "Subtitles appear later than the file says."
            : "Subtitles appear earlier than the file says."}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  /**
   * Upper middle, clear of both the title bar and the subtitles.
   *
   * Deliberately not a modal: lining subtitles up means watching them while you
   * press, so the picture has to stay visible and playing underneath.
   *
   * And deliberately not at the bottom, which is where a panel like this
   * naturally wants to sit. Subtitles live at the bottom, a two-line cue
   * reaches up into where the panel would be, and the one thing this control
   * must never do is cover the text it is adjusting.
   */
  panel: {
    position: "absolute",
    left: "50%",
    transform: "translateX(-50%)",
    top: "17%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "10px",
    padding: "16px 22px 14px",
    borderRadius: "14px",
    background: "rgba(18,18,18,0.94)",
    border: "1px solid rgba(255,255,255,0.10)",
    boxShadow: "0 10px 34px rgba(0,0,0,0.55)",
    backdropFilter: "blur(10px)",
    zIndex: 30,
    maxWidth: "min(92vw, 420px)",
  },
  close: {
    position: "absolute",
    top: "6px",
    right: "8px",
    background: "none",
    border: "none",
    color: "rgba(255,255,255,0.55)",
    fontSize: "14px",
    lineHeight: 1,
    padding: "4px",
    cursor: "pointer",
  },
  heading: {
    fontSize: "12px",
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "rgba(255,255,255,0.62)",
    paddingRight: "18px",
  },
  value: {
    color: "#fff",
    // Tabular, so the panel doesn't twitch sideways as the number changes width
    // — which it would do on every single press otherwise.
    fontVariantNumeric: "tabular-nums",
  },
  row: { display: "flex", gap: "8px" },
  step: {
    background: "#e5a00d",
    color: "#1a1a1a",
    border: "none",
    borderRadius: "8px",
    padding: "8px 14px",
    fontSize: "13px",
    fontWeight: 700,
    cursor: "pointer",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  stepDisabled: { opacity: 0.4, cursor: "default" },
  hint: {
    fontSize: "11px",
    color: "rgba(255,255,255,0.45)",
    textAlign: "center",
  },
};
