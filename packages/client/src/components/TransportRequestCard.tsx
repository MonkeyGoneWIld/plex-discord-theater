interface TransportRequestCardProps {
  action: "pause" | "resume";
  fromUsername: string;
  onAccept: () => void;
  onDismiss: () => void;
}

/**
 * "monkey26 asked to pause" — shown to whoever can act on it.
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
      <div style={styles.label}>Request</div>
      <div style={styles.text}>
        <strong style={styles.who} title={fromUsername}>{fromUsername}</strong>
        <span style={styles.what}>
          {action === "pause" ? " asked to pause" : " asked to resume"}
        </span>
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
  label: {
    color: "#e5a00d",
    fontSize: "10px",
    fontWeight: 700,
    letterSpacing: "1px",
    textTransform: "uppercase",
    marginBottom: "6px",
  },
  /**
   * The name gives way, never the verb.
   *
   * A row rather than a sentence, so the two halves can be told apart: the
   * name takes what is left and the question is never asked to shrink. As one
   * line with an ellipsis on it, a long enough Discord name spent the whole
   * card on itself and left "a_really_long_discord_nam…" with nothing after
   * it — a card that says who wants something and not what.
   *
   * Flex rather than a max-width on the name, because the number that would
   * be is the card's width minus the longest phrasing, and neither of those
   * is something to keep in step by hand.
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
    flex: 1,
    padding: "8px",
    borderRadius: "6px",
    border: "1px solid rgba(255,255,255,0.15)",
    background: "transparent",
    color: "#888",
    fontSize: "12px",
    cursor: "pointer",
    fontFamily: "inherit",
  },
};
