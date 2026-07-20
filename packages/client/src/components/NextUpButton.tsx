import { formatMediaTitle, type TitleParts } from "../lib/format";

interface NextUpButtonProps {
  /** Structural, so it accepts a QueueItem or a server-mapped PlexItem alike. */
  item: TitleParts;
  /** "queue" = the host queued this deliberately; "series" = auto-resolved sibling. */
  source: "queue" | "series";
  onPlay: () => void;
  onDismiss: () => void;
}

/**
 * "Next Episode" / "Up Next" card, shown during a credits marker or near the end
 * of an item.
 *
 * Stateless and untimed by design — it replaced a version that owned a 15s
 * countdown and auto-advanced. Nothing here advances on its own; the parent
 * decides visibility and the user decides when to move on. Carries no
 * positioning either: Player's bottom-right stack owns placement so this can sit
 * alongside the skip button without either knowing about the other.
 */
export function NextUpButton({ item, source, onPlay, onDismiss }: NextUpButtonProps) {
  return (
    <div style={styles.container}>
      <div style={styles.label}>{source === "series" ? "Next Episode" : "Up Next"}</div>
      <div style={styles.title}>{formatMediaTitle(item)}</div>
      <div style={styles.buttons}>
        <button onClick={onPlay} style={styles.playBtn}>
          {source === "series" ? "Play Next" : "Play Now"}
        </button>
        <button onClick={onDismiss} style={styles.dismissBtn}>Dismiss</button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { background: "rgba(0,0,0,0.85)", backdropFilter: "blur(12px)", borderRadius: "12px", padding: "16px 20px", maxWidth: "280px", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 2px 12px rgba(0,0,0,0.5)" },
  label: { color: "#e5a00d", fontSize: "10px", fontWeight: 700, letterSpacing: "1px", textTransform: "uppercase", marginBottom: "6px" },
  title: { color: "#f0f0f0", fontSize: "14px", fontWeight: 600, marginBottom: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  buttons: { display: "flex", gap: "8px" },
  playBtn: { flex: 1, padding: "8px", borderRadius: "6px", border: "none", background: "#e5a00d", color: "#000", fontSize: "12px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" },
  dismissBtn: { flex: 1, padding: "8px", borderRadius: "6px", border: "1px solid rgba(255,255,255,0.15)", background: "transparent", color: "#888", fontSize: "12px", cursor: "pointer", fontFamily: "inherit" },
};
