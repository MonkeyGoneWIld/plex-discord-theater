import {
  DEFAULT_SUBTITLE_STYLE,
  SUBTITLE_COLORS,
  SUBTITLE_FONTS,
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
 * The controls for how subtitles look — size, position, colour, background,
 * font and style — wherever they are offered: the subtitle panel over a
 * playing stream, where the change shows on the picture at once, and Settings
 * on the home page, beside a sample line. One component, so the two can never
 * offer different choices. Every change is saved as it is made (see
 * lib/subtitleStyle.ts).
 */
export function SubtitleLookControls() {
  const look = useSubtitleStyle();
  const choice = (on: boolean): React.CSSProperties => ({ ...styles.choice, ...(on ? styles.choiceOn : {}) });

  return (
    <>
      <div style={styles.grid}>
        <span style={styles.label}>Size</span>
        <div style={styles.inline}>
          <button className="btn" type="button" style={choice(false)} aria-label="Smaller subtitles"
            disabled={look.size <= SUBTITLE_SIZE.min}
            // From the value now rather than the render's, so presses quicker
            // than a render each count.
            onClick={() => setSubtitleStyle((s) => ({ size: s.size - SUBTITLE_SIZE.step }))}>{"A−"}</button>
          <span style={styles.reading}>{look.size}%</span>
          <button className="btn" type="button" style={choice(false)} aria-label="Larger subtitles"
            disabled={look.size >= SUBTITLE_SIZE.max}
            onClick={() => setSubtitleStyle((s) => ({ size: s.size + SUBTITLE_SIZE.step }))}>{"A+"}</button>
        </div>

        <span style={styles.label}>Position</span>
        <div style={styles.inline}>
          <button className="btn" type="button" style={choice(false)} aria-label="Move subtitles down"
            disabled={look.raise <= SUBTITLE_RAISE.min}
            onClick={() => setSubtitleStyle((s) => ({ raise: s.raise - SUBTITLE_RAISE.step }))}>{"Lower"}</button>
          <span style={styles.reading}>{look.raise > 0 ? "+" : ""}{look.raise}%</span>
          <button className="btn" type="button" style={choice(false)} aria-label="Move subtitles up"
            disabled={look.raise >= SUBTITLE_RAISE.max}
            onClick={() => setSubtitleStyle((s) => ({ raise: s.raise + SUBTITLE_RAISE.step }))}>{"Raise"}</button>
        </div>

        <span style={styles.label}>Colour</span>
        <div style={styles.inline} role="radiogroup" aria-label="Subtitle colour">
          {(Object.keys(SUBTITLE_COLORS) as SubtitleColor[]).map((c) => (
            <button key={c} className="btn" type="button" role="radio" aria-checked={look.color === c}
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
            <button key={b} className="btn" type="button" role="radio" aria-checked={look.background === b}
              style={choice(look.background === b)} onClick={() => setSubtitleStyle({ background: b })}>{label}</button>
          ))}
        </div>

        <span style={styles.label}>Font</span>
        <div style={styles.inline} role="radiogroup" aria-label="Subtitle font">
          {(Object.keys(SUBTITLE_FONTS) as SubtitleFont[]).map((f) => (
            <button key={f} className="btn" type="button" role="radio" aria-checked={look.font === f}
              style={{ ...choice(look.font === f), fontFamily: SUBTITLE_FONTS[f].css ?? "inherit" }}
              onClick={() => setSubtitleStyle({ font: f })}>{SUBTITLE_FONTS[f].label}</button>
          ))}
        </div>

        <span style={styles.label}>Style</span>
        <div style={styles.inline}>
          <button className="btn" type="button" aria-pressed={look.bold} style={{ ...choice(look.bold), fontWeight: 800 }}
            onClick={() => setSubtitleStyle((s) => ({ bold: !s.bold }))}>Bold</button>
          <button className="btn" type="button" aria-pressed={look.italic} style={{ ...choice(look.italic), fontStyle: "italic" }}
            onClick={() => setSubtitleStyle((s) => ({ italic: !s.italic }))}>Italic</button>
        </div>
      </div>

      <button
        className="btn"
        type="button"
        style={{ ...styles.resetLook, ...(isDefaultSubtitleStyle(look) ? styles.disabled : {}) }}
        disabled={isDefaultSubtitleStyle(look)}
        onClick={() => setSubtitleStyle(DEFAULT_SUBTITLE_STYLE)}
        title="Back to the default look"
      >
        Reset look
      </button>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
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
    alignSelf: "center",
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
  disabled: { opacity: 0.4, cursor: "default" },
};
