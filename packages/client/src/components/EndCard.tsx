import { stillThumbUrl } from "../lib/api";
import { QUIET_SURFACE } from "../lib/surface";

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
  /** The same end-of-item decision, fitted into the in-activity PiP surface. */
  compact?: boolean;
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
export function EndCard({ item, source, onPlay, onExit, compact = false }: EndCardProps) {
  const still = item.thumb ? stillThumbUrl(item.thumb) : null;
  const show = item.showTitle ?? item.parentTitle ?? null;
  const numbering =
    item.parentIndex != null && item.index != null
      ? `Season ${item.parentIndex}, Episode ${item.index}`
      : item.index != null
        ? `Episode ${item.index}`
        : null;

  return (
    <div style={{ ...styles.backdrop, ...(compact ? styles.backdropCompact : {}) }}>
      <div style={{ ...styles.panel, ...(compact ? styles.panelCompact : {}) }}>
        <div style={{ ...styles.eyebrow, ...(compact ? styles.eyebrowCompact : {}) }}>{source === "series" ? "Next episode" : "Up next"}</div>

        <div style={{ ...styles.body, ...(compact ? styles.bodyCompact : {}) }}>
          {still ? (
            <img src={still} alt="" style={{ ...styles.still, ...(compact ? styles.stillCompact : {}) }} />
          ) : (
            <div style={{ ...styles.still, ...styles.stillEmpty, ...(compact ? styles.stillCompact : {}) }} />
          )}

          <div style={{ ...styles.meta, ...(compact ? styles.metaCompact : {}) }}>
            {show && <div style={{ ...styles.show, ...(compact ? styles.showCompact : {}) }}>{show}</div>}
            <div style={{ ...styles.title, ...(compact ? styles.titleCompact : {}) }}>{item.title}</div>
            {numbering && <div style={{ ...styles.numbering, ...(compact ? styles.numberingCompact : {}) }}>{numbering}</div>}
          </div>
        </div>

        <div style={{ ...styles.actions, ...(compact ? styles.actionsCompact : {}) }}>
          {onPlay && (
            <button type="button" onClick={onPlay} className="btn" style={{ ...styles.playBtn, ...(compact ? styles.actionBtnCompact : {}) }}>
              <svg width={compact ? 14 : 20} height={compact ? 14 : 20} viewBox="0 0 22 22" fill="none" style={{ marginRight: compact ? 5 : 10 }}>
                <path d="M5 3.5L18 11L5 18.5V3.5Z" fill="currentColor" />
              </svg>
              {source === "series" ? "Play next episode" : "Play now"}
            </button>
          )}
          <button type="button" onClick={onExit} className="btn" style={{ ...styles.exitBtn, ...(compact ? styles.actionBtnCompact : {}) }}>
            {/* Keyed to where it goes, not to who is pressing it: this leaves
                for the show whenever there is one, host or viewer alike. */}
            {show ? "Back to show" : "Back"}
          </button>
        </div>

        {!onPlay && (
          <div style={{ ...styles.viewerNote, ...(compact ? styles.viewerNoteCompact : {}) }}>Waiting for the host to choose what's next</div>
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
  backdropCompact: { padding: "10px" },
  panel: {
    width: "100%",
    maxWidth: "900px",
    display: "flex",
    flexDirection: "column",
    gap: "24px",
  },
  panelCompact: { maxWidth: "none", gap: "8px" },
  eyebrow: {
    color: "#e5a00d",
    fontSize: "13px",
    fontWeight: 700,
    letterSpacing: "1.6px",
    textTransform: "uppercase",
  },
  eyebrowCompact: { fontSize: "9px", letterSpacing: "1px" },
  body: {
    display: "flex",
    gap: "28px",
    alignItems: "center",
    // Wraps rather than crushing the still: the player can be a narrow pane in
    // a Discord sidebar as easily as a full window.
    flexWrap: "wrap",
  },
  bodyCompact: { gap: "10px", flexWrap: "nowrap" },
  still: {
    // Fluid between a floor that stays legible and a cap that stops it
    // dominating a wide screen.
    width: "clamp(280px, 42%, 440px)",
    flex: "none",
    aspectRatio: "16 / 9",
    objectFit: "cover",
    borderRadius: "12px",
    background: "#1a1a1a",
    border: "1px solid rgba(255,255,255,0.08)",
  },
  stillCompact: { width: "38%", minWidth: 0, borderRadius: "7px" },
  stillEmpty: {
    display: "block",
  },
  meta: {
    // Takes the rest of the row, and a floor low enough that it drops below the
    // still instead of squeezing the title into single words.
    flex: "1 1 260px",
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  metaCompact: { flexBasis: 0, gap: "2px" },
  show: {
    color: "#9a9a9a",
    fontSize: "16px",
    fontWeight: 600,
  },
  showCompact: { fontSize: "9px" },
  title: {
    color: "#f2f2f2",
    fontSize: "clamp(26px, 3.4vw, 36px)",
    fontWeight: 700,
    lineHeight: 1.15,
    letterSpacing: "-0.015em",
  },
  titleCompact: { fontSize: "13px", lineHeight: 1.1 },
  numbering: {
    color: "#8a8a8a",
    fontSize: "17px",
  },
  numberingCompact: { fontSize: "9px" },
  actions: {
    display: "flex",
    gap: "12px",
    flexWrap: "wrap",
  },
  actionsCompact: { gap: "6px" },
  actionBtnCompact: { padding: "7px 9px", borderRadius: "6px", fontSize: "9px" },
  playBtn: {
    display: "inline-flex",
    alignItems: "center",
    padding: "15px 30px",
    borderRadius: "9px",
    border: "none",
    background: "#e5a00d",
    color: "#241900",
    fontSize: "17px",
    fontWeight: 700,
    fontFamily: "inherit",
    cursor: "pointer",
  },
  exitBtn: {
    ...QUIET_SURFACE,
    padding: "15px 30px",
    borderRadius: "9px",
    color: "#ddd",
    fontSize: "17px",
    fontWeight: 600,
    fontFamily: "inherit",
    cursor: "pointer",
  },
  viewerNote: {
    color: "#7d7d7d",
    fontSize: "15px",
  },
  viewerNoteCompact: { fontSize: "9px" },
};
