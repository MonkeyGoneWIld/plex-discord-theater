interface SkipMarkerButtonProps {
  type: "intro" | "credits";
  onSkip: () => void;
  /** Raise above the UpNext banner when both are on screen. */
  stacked?: boolean;
}

/**
 * "Skip Intro" / "Skip Credits" button, shown while playback sits inside a Plex
 * marker window.
 *
 * Deliberately stateless — unlike UpNext, which owns a countdown, visibility here
 * is entirely the parent's call: mounting means visible, and Player unmounts this
 * the moment playback leaves the marker window.
 */
export function SkipMarkerButton({ type, onSkip, stacked }: SkipMarkerButtonProps) {
  return (
    <button
      onClick={onSkip}
      style={{ ...styles.button, bottom: stacked ? "200px" : "80px" }}
    >
      {type === "intro" ? "Skip Intro" : "Skip Credits"}
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  button: {
    position: "absolute",
    right: "20px",
    zIndex: 30,
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
