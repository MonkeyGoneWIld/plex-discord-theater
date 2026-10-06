import {
  DEFAULT_SUBTITLE_STYLE,
  SUBTITLE_COLORS,
  SUBTITLE_RAISE,
  SUBTITLE_SIZE,
  isDefaultSubtitleStyle,
  setSubtitleStyle,
  useSubtitleStyle,
  type SubtitleBackground,
  type SubtitleColor,
  type SubtitleFont,
} from "../lib/subtitleStyle";

/**
 * Everything about the subtitles this client draws itself, in one panel: their
 * timing against the audio, and how they look.
 *
 * Only reachable for those — see SubtitleLayer. A burned-in subtitle is pixels
 * in the video frames by the time it arrives, so there is nothing here that
 * could move or restyle it, and offering the controls anyway would be offering
 * buttons that do nothing.
 *
 * Timing steps are 50ms, matching Plex's own control. Small enough that a press
 * is a correction rather than a guess, large enough to be worth pressing: below
 * about 40ms the change is under one frame at 24fps and nobody can see it.
 *
 * Not a modal: lining subtitles up, or judging a size, means watching them
 * while you press, so the picture stays visible and playing underneath and
 * every change shows at once. The look is saved for every title on this device
 * (lib/subtitleStyle.ts); the timing is not.
 */

/** One press. Plex uses the same step, and people arrive here expecting it. */
const STEP_MS = 50;

interface SubtitleSettingsProps {
  offsetMs: number;
  onChange: (ms: number) => void;
  onClose: () => void;
}

export function SubtitleSettings({ offsetMs, onChange, onClose }: SubtitleSettingsProps) {
  const look = useSubtitleStyle();
  // Deliberately unbounded. A cap would be guessing at how badly out of sync
  // somebody's file is, and the only person who knows that is watching it.
  const step = (delta: number) => onChange(offsetMs + delta);
  const choice = (on: boolean): React.CSSProperties => ({ ...styles.choice, ...(on ? styles.choiceOn : {}) });

  return (
    <div style={{ ...styles.panel, ...styles.settingsPanel }} role="group" aria-label="Subtitle settings">
      <button
        className="btn"
        style={styles.close}
        onClick={onClose}
        title="Close"
        aria-label="Close subtitle settings"
      >
        {"✕"}
      </button>

      <div style={styles.heading}>
        Subtitle timing:{" "}
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
          title="Restore the original timing"
        >
          Reset
        </button>
      </div>

      {/* Says which way the offset has moved things, in the words somebody
          would use to describe the problem they are here to fix. The heading
          above already carries the number, so this does not repeat it. */}
      <div style={styles.hint}>
        {offsetMs === 0
          ? "Subtitles are using their original timing."
          : offsetMs > 0
            ? "Subtitles now appear later."
            : "Subtitles now appear earlier."}
      </div>

      <div style={styles.divider} />

      <div style={styles.grid}>
        <span style={styles.label}>Size</span>
        <div style={styles.inline}>
          <button className="btn" style={choice(false)} aria-label="Smaller subtitles"
            disabled={look.size <= SUBTITLE_SIZE.min}
            onClick={() => setSubtitleStyle((s) => ({ size: s.size - SUBTITLE_SIZE.step }))}>{"A−"}</button>
          <span style={styles.reading}>{look.size}%</span>
          <button className="btn" style={choice(false)} aria-label="Larger subtitles"
            disabled={look.size >= SUBTITLE_SIZE.max}
            onClick={() => setSubtitleStyle((s) => ({ size: s.size + SUBTITLE_SIZE.step }))}>{"A+"}</button>
        </div>

        <span style={styles.label}>Position</span>
        <div style={styles.inline}>
          <button className="btn" style={choice(false)} aria-label="Move subtitles down"
            disabled={look.raise <= SUBTITLE_RAISE.min}
            onClick={() => setSubtitleStyle((s) => ({ raise: s.raise - SUBTITLE_RAISE.step }))}>{"Lower"}</button>
          <span style={styles.reading}>{look.raise > 0 ? "+" : ""}{look.raise}%</span>
          <button className="btn" style={choice(false)} aria-label="Move subtitles up"
            disabled={look.raise >= SUBTITLE_RAISE.max}
            onClick={() => setSubtitleStyle((s) => ({ raise: s.raise + SUBTITLE_RAISE.step }))}>{"Raise"}</button>
        </div>

        <span style={styles.label}>Colour</span>
        <div style={styles.inline} role="radiogroup" aria-label="Subtitle colour">
          {(Object.keys(SUBTITLE_COLORS) as SubtitleColor[]).map((c) => (
            <button key={c} className="btn" role="radio" aria-checked={look.color === c}
              title={SUBTITLE_COLORS[c].label} aria-label={SUBTITLE_COLORS[c].label}
              onClick={() => setSubtitleStyle({ color: c })}
              style={{
                ...styles.swatch,
                background: SUBTITLE_COLORS[c].css,
                ...(look.color === c ? styles.swatchOn : {}),
              }} />
          ))}
        </div>

        <span style={styles.label}>Background</span>
        <div style={styles.inline} role="radiogroup" aria-label="Subtitle background">
          {([["outline", "Outline"], ["shadow", "Shadow"], ["box", "Box"]] as Array<[SubtitleBackground, string]>).map(([b, label]) => (
            <button key={b} className="btn" role="radio" aria-checked={look.background === b}
              style={choice(look.background === b)} onClick={() => setSubtitleStyle({ background: b })}>{label}</button>
          ))}
        </div>

        <span style={styles.label}>Font</span>
        <div style={styles.inline}>
          {([["sans", "Sans"], ["serif", "Serif"]] as Array<[SubtitleFont, string]>).map(([f, label]) => (
            <button key={f} className="btn" role="radio" aria-checked={look.font === f}
              style={{ ...choice(look.font === f), ...(f === "serif" ? styles.serif : {}) }}
              onClick={() => setSubtitleStyle({ font: f })}>{label}</button>
          ))}
          <button className="btn" aria-pressed={look.bold} style={{ ...choice(look.bold), fontWeight: 800 }}
            onClick={() => setSubtitleStyle((s) => ({ bold: !s.bold }))}>Bold</button>
        </div>
      </div>

      <button
        className="btn"
        style={{ ...styles.resetLook, ...(isDefaultSubtitleStyle(look) ? styles.stepDisabled : {}) }}
        disabled={isDefaultSubtitleStyle(look)}
        onClick={() => setSubtitleStyle(DEFAULT_SUBTITLE_STYLE)}
        title="Back to the default look"
      >
        Reset look
      </button>
      <div style={styles.hint}>The look is saved for everything you watch here.</div>
    </div>
  );
}

export const adjustmentStyles: Record<string, React.CSSProperties> = {
  /**
   * Above the button that opened it, at the right-hand end of the control bar.
   *
   * Deliberately not a modal: lining subtitles up means watching the subtitles
   * while you press, so the picture has to stay visible and playing underneath
   * — and off to one side, so the panel is not sitting on top of the text it is
   * adjusting.
   */
  panel: {
    position: "relative",
    // Lined up with the control bar's own right padding, so the panel and the
    // button that opens it share an edge.
    flexShrink: 0,
    /**
     * Just above the bar, in pixels rather than a percentage.
     *
     * The bar is a fixed stack — 16px of padding, a 32px row of buttons and a
     * 25px scrub row — so it is about 73px tall on a desktop and 81px on a
     * phone, whatever size the picture is. A percentage tracked the height of
     * the player instead and left the panel floating a long way above the icon
     * on anything tall.
     */
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

/** The subtitle panel's own additions to the shared adjustment panel. */
const settingsStyles: Record<string, React.CSSProperties> = {
  /** Taller than the others: it scrolls rather than run off a short window. */
  settingsPanel: {
    maxHeight: "min(70vh, 520px)",
    overflowY: "auto",
    overscrollBehavior: "contain",
    scrollbarWidth: "thin",
  },
  divider: { alignSelf: "stretch", height: "1px", background: "rgba(255,255,255,0.08)", margin: "2px 0" },
  grid: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    alignItems: "center",
    columnGap: "14px",
    rowGap: "10px",
    alignSelf: "stretch",
  },
  label: {
    fontSize: "11px",
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "rgba(255,255,255,0.55)",
  },
  inline: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" },
  reading: {
    minWidth: "44px",
    textAlign: "center",
    fontSize: "13px",
    fontWeight: 700,
    color: "#fff",
    fontVariantNumeric: "tabular-nums",
  },
  choice: {
    background: "rgba(255,255,255,0.08)",
    color: "#ddd",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: "7px",
    padding: "5px 10px",
    fontSize: "12px",
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
    fontFamily: "inherit",
  },
  choiceOn: {
    background: "rgba(229,160,13,0.18)",
    border: "1px solid rgba(229,160,13,0.6)",
    color: "#e5a00d",
  },
  serif: { fontFamily: 'Georgia, "Times New Roman", serif' },
  swatch: {
    width: "22px",
    height: "22px",
    borderRadius: "50%",
    border: "2px solid rgba(0,0,0,0.5)",
    padding: 0,
    cursor: "pointer",
    boxShadow: "0 0 0 1px rgba(255,255,255,0.25)",
  },
  swatchOn: { boxShadow: "0 0 0 2px #e5a00d" },
  resetLook: {
    background: "transparent",
    color: "#e5a00d",
    border: "1px solid rgba(229,160,13,0.5)",
    borderRadius: "8px",
    padding: "6px 14px",
    fontSize: "12px",
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
  },
};
const styles = { ...adjustmentStyles, ...settingsStyles };
