import { posterThumbUrl } from "../lib/api";

/** Only what this card draws. Structural on purpose: what comes next is a
 *  QueueItem when the host queued it and a PlexItem when it was resolved from
 *  the series, and neither is assignable to the other. */
interface NextItem {
  ratingKey: string;
  title: string;
  thumb: string | null;
  parentTitle?: string;
  showTitle?: string;
  parentIndex?: number;
  index?: number;
}

interface EndCardProps {
  /** The episode offered next. */
  item: NextItem;
  /** "queue" = the host queued this deliberately; "series" = the next episode. */
  source: "queue" | "series";
  /** Start it. Absent for a plain viewer, who can't drive the room. */
  onPlay?: () => void;
  /** Leave the player — back to the title this came from. */
  onExit: () => void;
}

/**
 * What fills the screen when an episode finishes.
 *
 * Playback used to end on black with nothing on it: the small corner "Up Next"
 * card only ever appeared for the host, so viewers were left staring at an empty
 * player with no indication anything had happened, or what came next.
 *
 * Nothing here starts on its own. There is no countdown and no autoplay — the
 * room moves on when someone decides to, which is the same rule the rest of the
 * player follows.
 *
 * Deliberately no synopsis. The next episode's description is a spoiler for the
 * one that just finished, and this card exists to identify what's next, not to
 * sell it.
 */
export function EndCard({ item, source, onPlay, onExit }: EndCardProps) {
  const still = item.thumb ? posterThumbUrl(item.thumb) : null;
  const show = item.showTitle ?? item.parentTitle ?? null;
  const numbering =
    item.parentIndex != null && item.index != null
      ? `Season ${item.parentIndex}, Episode ${item.index}`
      : item.index != null
        ? `Episode ${item.index}`
        : null;

  return (
    <div style={styles.backdrop}>
      <div style={styles.panel}>
        <div style={styles.eyebrow}>{source === "series" ? "Next episode" : "Up next"}</div>

        <div style={styles.body}>
          {still ? (
            <img src={still} alt="" style={styles.still} />
          ) : (
            <div style={{ ...styles.still, ...styles.stillEmpty }} />
          )}

          <div style={styles.meta}>
            {show && <div style={styles.show}>{show}</div>}
            <div style={styles.title}>{item.title}</div>
            {numbering && <div style={styles.numbering}>{numbering}</div>}
          </div>
        </div>

        <div style={styles.actions}>
          {onPlay && (
            <button type="button" onClick={onPlay} style={styles.playBtn}>
              <svg width="18" height="18" viewBox="0 0 22 22" fill="none" style={{ marginRight: 8 }}>
                <path d="M5 3.5L18 11L5 18.5V3.5Z" fill="currentColor" />
              </svg>
              {source === "series" ? "Play next episode" : "Play now"}
            </button>
          )}
          <button type="button" onClick={onExit} style={styles.exitBtn}>
            {onPlay ? "Back to show" : "Back"}
          </button>
        </div>

        {!onPlay && (
          <div style={styles.viewerNote}>Waiting for the host to choose what's next</div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "absolute",
    inset: 0,
    // Opaque: the frame underneath is the last frame of the credits, and
    // leaving it showing behind this reads as though playback is still running.
    background: "#0b0b0b",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    zIndex: 40,
  },
  panel: {
    width: "100%",
    maxWidth: "620px",
    display: "flex",
    flexDirection: "column",
    gap: "18px",
  },
  eyebrow: {
    color: "#e5a00d",
    fontSize: "11px",
    fontWeight: 700,
    letterSpacing: "1.4px",
    textTransform: "uppercase",
  },
  body: {
    display: "flex",
    gap: "20px",
    alignItems: "center",
  },
  still: {
    width: "232px",
    flex: "none",
    aspectRatio: "16 / 9",
    objectFit: "cover",
    borderRadius: "10px",
    background: "#1a1a1a",
    border: "1px solid rgba(255,255,255,0.08)",
  },
  stillEmpty: {
    display: "block",
  },
  meta: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  },
  show: {
    color: "#9a9a9a",
    fontSize: "13px",
    fontWeight: 600,
  },
  title: {
    color: "#f2f2f2",
    fontSize: "24px",
    fontWeight: 700,
    lineHeight: 1.2,
    letterSpacing: "-0.01em",
  },
  numbering: {
    color: "#8a8a8a",
    fontSize: "14px",
  },
  actions: {
    display: "flex",
    gap: "10px",
    flexWrap: "wrap",
  },
  playBtn: {
    display: "inline-flex",
    alignItems: "center",
    padding: "12px 22px",
    borderRadius: "8px",
    border: "none",
    background: "#e5a00d",
    color: "#241900",
    fontSize: "15px",
    fontWeight: 700,
    fontFamily: "inherit",
    cursor: "pointer",
  },
  exitBtn: {
    padding: "12px 22px",
    borderRadius: "8px",
    border: "1px solid rgba(255,255,255,0.16)",
    background: "rgba(255,255,255,0.06)",
    color: "#ddd",
    fontSize: "15px",
    fontWeight: 600,
    fontFamily: "inherit",
    cursor: "pointer",
  },
  viewerNote: {
    color: "#7d7d7d",
    fontSize: "13px",
  },
};
