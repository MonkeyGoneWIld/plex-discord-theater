import type { QueueItem } from "../hooks/useSync";
import { getSessionToken } from "../lib/api";

interface QueuePanelProps {
  queue: QueueItem[];
  onRemove: (ratingKey: string) => void;
  onClear: () => void;
  onReorder: (queue: QueueItem[]) => void;
  onClose: () => void;
}

function authUrl(url: string | null): string {
  if (!url) return "";
  const token = getSessionToken();
  if (!token) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

function moveItem(arr: QueueItem[], from: number, to: number): QueueItem[] {
  const copy = [...arr];
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

export function QueuePanel({ queue, onRemove, onClear, onReorder, onClose }: QueuePanelProps) {
  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <h3 style={styles.title}>Queue ({queue.length})</h3>
          <button className="btn" onClick={onClose} style={styles.closeBtn}>&times;</button>
        </div>
        {queue.length === 0 ? (
          <p style={styles.empty}>Queue is empty</p>
        ) : (
          <div style={styles.list}>
            {queue.map((item, i) => (
              <div key={item.ratingKey} style={styles.item}>
                <div style={styles.thumb}>
                  {item.thumb && <img src={authUrl(item.thumb)} alt="" style={styles.thumbImg} />}
                </div>
                <div style={styles.info}>
                  <div style={styles.itemTitle}>
                    {item.parentTitle
                      ? `${item.parentTitle} \u2014 S${item.parentIndex ?? "?"}E${item.index ?? "?"}`
                      : item.title}
                  </div>
                  {item.parentTitle && <div style={styles.itemSub}>{item.title}</div>}
                </div>
                <div style={styles.actions}>
                  {i > 0 && (
                    <button className="btn" onClick={() => onReorder(moveItem(queue, i, i - 1))} style={styles.moveBtn} title="Move up">&uarr;</button>
                  )}
                  {i < queue.length - 1 && (
                    <button className="btn" onClick={() => onReorder(moveItem(queue, i, i + 1))} style={styles.moveBtn} title="Move down">&darr;</button>
                  )}
                  <button className="btn" onClick={() => onRemove(item.ratingKey)} style={styles.removeBtn} title="Remove">&times;</button>
                </div>
              </div>
            ))}
          </div>
        )}
        {queue.length > 0 && (
          <button className="btn" onClick={onClear} style={styles.clearBtn}>Clear Queue</button>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 100, display: "flex", justifyContent: "flex-end" },
  panel: { width: "320px", maxWidth: "80vw", height: "100%", background: "#1a1a1a", borderLeft: "1px solid rgba(255,255,255,0.1)", display: "flex", flexDirection: "column", overflow: "hidden" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px", borderBottom: "1px solid rgba(255,255,255,0.06)" },
  title: { color: "#f0f0f0", fontSize: "16px", fontWeight: 600 },
  closeBtn: { background: "none", border: "none", color: "#888", fontSize: "20px", cursor: "pointer", fontFamily: "inherit" },
  empty: { color: "#666", fontSize: "14px", textAlign: "center", padding: "32px" },
  list: { flex: 1, overflowY: "auto", padding: "8px" },
  item: { display: "flex", alignItems: "center", gap: "10px", padding: "8px", borderRadius: "8px", background: "rgba(255,255,255,0.03)", marginBottom: "4px" },
  thumb: { width: "48px", height: "32px", borderRadius: "4px", overflow: "hidden", background: "rgba(255,255,255,0.05)", flexShrink: 0 },
  thumbImg: { width: "100%", height: "100%", objectFit: "cover" },
  info: { flex: 1, minWidth: 0 },
  itemTitle: { color: "#f0f0f0", fontSize: "12px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  itemSub: { color: "#888", fontSize: "11px", marginTop: "2px" },
  actions: { display: "flex", gap: "4px", flexShrink: 0 },
  moveBtn: { background: "none", border: "none", color: "#888", fontSize: "14px", cursor: "pointer", padding: "2px 4px", fontFamily: "inherit" },
  removeBtn: { background: "none", border: "none", color: "#666", fontSize: "16px", cursor: "pointer", padding: "2px 4px", fontFamily: "inherit" },
  clearBtn: { margin: "12px 16px 16px", padding: "8px", borderRadius: "6px", border: "1px solid rgba(255,255,255,0.1)", background: "transparent", color: "#888", fontSize: "12px", cursor: "pointer", fontFamily: "inherit" },
};
