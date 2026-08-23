import { QUIET_SURFACE } from "../lib/surface";

interface TransportRequestCardProps {
  action: "pause" | "resume";
  fromUsername: string;
  onAccept: () => void;
  onDismiss: () => void;
}

/**
 * "Pause requested by monkey26" — shown to whoever can act on it.
 *
 * A card rather than a dialog. Someone is watching a film behind this, and a
 * request is not an interruption worth taking the screen for: nothing is
 * waiting on an answer, and no answer is also an answer. It sits in the same
 * bottom-right stack as the skip and next-episode affordances, in the same
 * shape, so a third thing appearing there costs the viewer nothing new to
 * learn.
 *
 * The verb on the button is the thing it will do — "Pause", not "Accept" —
 * because that is the part worth being sure about before pressing it.
 */
export function TransportRequestCard({
  action, fromUsername, onAccept, onDismiss,
}: TransportRequestCardProps) {
  return (
    <div style={styles.container}>
      {/* No eyebrow over this. "Request" above "someone requested a pause" is
          the same word twice, and the sentence identifies the card on its own. */}
      <div style={styles.text}>
        <span style={styles.what}>
          {action === "pause" ? "Pause requested by " : "Resume requested by "}
        </span>
        <strong style={styles.who} title={fromUsername}>{fromUsername}</strong>
      </div>
      <div style={styles.buttons}>
        <button onClick={onAccept} className="btn" style={styles.acceptBtn}>
          {action === "pause" ? "Pause" : "Resume"}
        </button>
        <button onClick={onDismiss} className="btn" style={styles.dismissBtn}>
          Ignore
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // Matched to NextUpButton, which owns the shape of everything in this stack.
  container: {
    background: "rgba(0,0,0,0.85)",
    backdropFilter: "blur(12px)",
    borderRadius: "12px",
    padding: "16px 20px",
    maxWidth: "280px",
    border: "1px solid rgba(255,255,255,0.1)",
    boxShadow: "0 2px 12px rgba(0,0,0,0.5)",
  },
  /**
   * The name gives way, never the request.
   *
   * A row rather than a sentence, so the two halves can be told apart: the
   * request holds its width and the name takes what is left. With the request
   * leading, the ellipsis lands where a sentence would put it anyway — a long
   * Discord name simply runs out of room at the end, and the line still says
   * what is being asked for.
   *
   * Flex rather than a max-width on the name, because the number that would be
   * is the card's width minus the longest phrasing, and neither of those is
   * something to keep in step by hand.
   */
  text: {
    display: "flex",
    alignItems: "baseline",
    color: "#f0f0f0",
    fontSize: "14px",
    marginBottom: "12px",
  },
  who: {
    fontWeight: 600,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  /** Never shrinks, and keeps its leading space. */
  what: { flexShrink: 0, whiteSpace: "pre" },
  buttons: { display: "flex", gap: "8px" },
  acceptBtn: {
    flex: 1,
    padding: "8px",
    borderRadius: "6px",
    border: "none",
    background: "#e5a00d",
    color: "#000",
    fontSize: "12px",
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  dismissBtn: {
    ...QUIET_SURFACE,
    flex: 1,
    padding: "8px",
    borderRadius: "6px",
    color: "#888",
    fontSize: "12px",
    cursor: "pointer",
    fontFamily: "inherit",
  },
};
