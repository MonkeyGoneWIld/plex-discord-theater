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

interface SubtitleOffsetProps {
  offsetMs: number;
  onChange: (ms: number) => void;
  onClose: () => void;
}

export function SubtitleOffset({ offsetMs, onChange, onClose }: SubtitleOffsetProps) {
  // Deliberately unbounded. A cap would be guessing at how badly out of sync
  // somebody's file is, and the only person who knows that is watching it.
  const step = (delta: number) => onChange(offsetMs + delta);

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
          style={styles.step}
          onClick={() => step(-STEP_MS)}
          title="Show subtitles earlier"
        >
          {"−"}{STEP_MS} ms
        </button>
        <button
          className="btn"
          style={styles.step}
          onClick={() => step(STEP_MS)}
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
   * Above the button that opened it, at the right-hand end of the control bar.
   *
   * Deliberately not a modal: lining subtitles up means watching the subtitles
   * while you press, so the picture has to stay visible and playing underneath
   * — and off to one side, so the panel is not sitting on top of the text it is
   * adjusting.
   */
  panel: {
    position: "absolute",
    // Lined up with the control bar's own right padding, so the panel and the
    // button that opens it share an edge.
    right: "calc(20px + var(--sair, 0px))",
    /**
     * Just above the bar, in pixels rather than a percentage.
     *
     * The bar is a fixed stack — 16px of padding, a 32px row of buttons and a
     * 25px scrub row — so it is about 73px tall on a desktop and 81px on a
     * phone, whatever size the picture is. A percentage tracked the height of
     * the player instead and left the panel floating a long way above the icon
     * on anything tall.
     */
    bottom: "calc(94px + var(--saib, 0px))",
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
