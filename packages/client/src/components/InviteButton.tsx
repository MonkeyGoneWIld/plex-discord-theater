interface InviteButtonProps {
  /** Open the invite picker. The button owns the look; the panel owns the flow. */
  onInvite: () => void;
}

/**
 * "Invite" — opens the invite picker (see InvitePanel).
 *
 * Two homes, one look: the browsing header, and the people panel during
 * playback. It isn't in the control bar — that sits over the film, where every
 * pixel competes with it, and "who else is here" is already this panel's job.
 *
 * Purely a trigger now. It used to call Discord's dialog directly and report
 * the outcome in a little note; the panel owns that flow, and per-person
 * feedback belongs next to the person it is about.
 */
export function InviteButton({ onInvite }: InviteButtonProps) {
  return (
    <div style={styles.wrap}>
      <button
        type="button"
        onClick={onInvite}
        style={styles.button}
        title="Invite someone to watch"
        aria-label="Invite someone to watch"
        // Comes forward on hover rather than sitting forward all the time.
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = "rgba(229,160,13,0.55)";
          e.currentTarget.style.color = "#e5a00d";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = "rgba(255,255,255,0.10)";
          e.currentTarget.style.color = "#9a9a9a";
        }}
      >
        {/* Person with a plus — the same idea Discord uses for "invite". */}
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="6" cy="5" r="2.6" stroke="currentColor" strokeWidth="1.5" />
          <path d="M1.6 13.2c0-2.4 2-4 4.4-4s4.4 1.6 4.4 4" stroke="currentColor"
            strokeWidth="1.5" strokeLinecap="round" />
          <path d="M12.6 5.4v4.2M14.7 7.5h-4.2" stroke="currentColor"
            strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <span>Invite</span>
      </button>
    </div>
  );
}

const base: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "5px",
  // Pill, matching the roster count it sits beside in the header. As a rounded
  // rectangle in a lighter tone it read as the loudest thing up there, which
  // is not what a secondary action should be doing.
  borderRadius: "999px",
  border: "1px solid rgba(255,255,255,0.10)",
  background: "transparent",
  color: "#9a9a9a",
  fontFamily: "inherit",
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
  transition: "border-color 0.15s ease, color 0.15s ease, background 0.15s ease",
};

const styles: Record<string, React.CSSProperties> = {
  wrap: { position: "relative", display: "inline-flex" },
  button: {
    ...base,
    padding: "3px 9px",
    fontSize: "12px",
  },
};
