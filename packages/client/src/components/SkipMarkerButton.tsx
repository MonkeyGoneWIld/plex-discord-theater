interface SkipMarkerButtonProps {
  type: "intro" | "credits";
  onSkip: () => void;
}

/**
 * "Skip Intro" / "Skip Credits" button, shown while playback sits inside a Plex
 * marker window.
 *
 * Deliberately stateless — visibility is entirely the parent's call: mounting
 * means visible, and Player unmounts this the moment playback leaves the marker
 * window. Placement belongs to Player's bottom-right stack, not to this button.
 */
export function SkipMarkerButton({ type, onSkip }: SkipMarkerButtonProps) {
  return (
    <button onClick={onSkip} style={styles.button}>
      {type === "intro" ? "Skip Intro" : "Skip Credits"}
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  button: {
    padding: "10px 20px",
    borderRadius: "8px",
    border: "none",
    background: "#e5a00d",
    color: "#000",
    fontSize: "14px",
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
    boxShadow: "0 2px 12px rgba(0,0,0,0.5)",
  },
};
