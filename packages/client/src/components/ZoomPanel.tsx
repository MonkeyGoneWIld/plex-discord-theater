import { adjustmentStyles as styles } from "./SubtitleOffset";

export function ZoomPanel({ zoom, onChangeZoom, onClose }: {
  zoom: number; onChangeZoom: (zoom: number) => void; onClose: () => void;
}) {
  const change = (value: number) => onChangeZoom(Math.max(50, Math.min(200, value)));
  return (
    <div style={styles.panel} role="group" aria-label="Manual zoom">
      <button className="btn" style={styles.close} onClick={onClose} aria-label="Close manual zoom">✕</button>
      <div style={styles.heading}>Manual zoom: <span style={styles.value}>{zoom}%</span></div>
      <div style={styles.row}>
        <button className="btn" style={{ ...styles.step, ...(zoom === 50 ? styles.stepDisabled : {}) }} disabled={zoom === 50} onClick={() => change(zoom - 5)}>−5%</button>
        <button className="btn" style={{ ...styles.step, ...(zoom === 200 ? styles.stepDisabled : {}) }} disabled={zoom === 200} onClick={() => change(zoom + 5)}>+5%</button>
        <button className="btn" style={{ ...styles.step, ...(zoom === 100 ? styles.stepDisabled : {}) }} disabled={zoom === 100} onClick={() => change(100)}>Reset</button>
      </div>
      <input aria-label="Manual zoom percentage" type="range" min="50" max="200" step="5" value={zoom}
        onChange={(e) => change(Number(e.target.value))}
        style={{ width: "100%", accentColor: "#e5a00d", cursor: "pointer", height: 18 }} />
      <div style={styles.hint}>Ctrl + mouse wheel to adjust</div>
    </div>
  );
}
