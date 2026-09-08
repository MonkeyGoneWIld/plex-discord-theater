import type { ZoomMode } from "../lib/videoZoom";

interface ZoomPanelProps {
  mode: ZoomMode;
  zoom: number;
  onChangeMode: (mode: ZoomMode) => void;
  onChangeZoom: (zoom: number) => void;
  onClose: () => void;
}

export function ZoomPanel({ mode, zoom, onChangeMode, onChangeZoom, onClose }: ZoomPanelProps) {
  return (
    <div style={styles.panel} role="group" aria-label="Video zoom">
      <button className="btn" style={styles.close} onClick={onClose} title="Close" aria-label="Close video zoom">✕</button>
      <div style={styles.heading}>Video zoom</div>
      <select value={mode} onChange={(e) => onChangeMode(e.target.value as ZoomMode)} style={styles.select}>
        <option value="normal">Normal</option>
        <option value="fill">Fill Screen</option>
        <option value="16:9">Fill 16:9</option>
        <option value="21:9">Fill 21:9</option>
        <option value="manual">Manual Zoom</option>
      </select>
      {mode === "manual" && (
        <label style={styles.sliderLabel}>
          <span>Zoom: <strong>{zoom}%</strong></span>
          <input type="range" min="100" max="200" step="5" value={zoom} onChange={(e) => onChangeZoom(Number(e.target.value))} />
          <span style={styles.hint}>Ctrl + mouse wheel or pinch to adjust</span>
        </label>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: { position: "absolute", right: "calc(20px + var(--sair, 0px))", bottom: "calc(94px + var(--saib, 0px))", display: "flex", flexDirection: "column", gap: 10, padding: "16px 22px 14px", borderRadius: 14, background: "rgba(18,18,18,0.94)", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 10px 34px rgba(0,0,0,0.55)", backdropFilter: "blur(10px)", zIndex: 30, minWidth: 220 },
  close: { position: "absolute", top: 6, right: 8, background: "none", border: "none", color: "rgba(255,255,255,0.55)", fontSize: 14, padding: 4, cursor: "pointer" },
  heading: { color: "rgba(255,255,255,0.75)", fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", paddingRight: 18 },
  select: { color: "#f0f0f0", background: "#252525", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 7, padding: "8px 10px", fontSize: 13 },
  sliderLabel: { display: "flex", flexDirection: "column", gap: 8, color: "#ddd", fontSize: 13 },
  hint: { color: "#888", fontSize: 11 },
};
