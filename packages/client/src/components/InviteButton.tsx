import { useCallback, useEffect, useRef, useState } from "react";

interface InviteButtonProps {
  /** Opens Discord's invite dialog. Resolves false when it couldn't be shown. */
  onInvite: () => Promise<boolean>;
}

/**
 * "Invite to Activity" — hands off to Discord's own invite dialog.
 *
 * Two homes, one look: the browsing header, and the people panel during
 * playback. It isn't in the control bar — that sits over the film, where every
 * pixel competes with it, and "who else is here" is already this panel's job.
 *
 * Discord owns the whole flow once the dialog opens: who can be invited, what
 * the invite looks like, and whether the user has permission to create one.
 * That's why the failure path here is a quiet note rather than an error — the
 * common reason is simply lacking Create Invite in the channel, which is the
 * server's decision and not something to alarm anyone about.
 */
export function InviteButton({ onInvite }: InviteButtonProps) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const noteTimer = useRef<number | undefined>(undefined);
  // The dialog can outlive this component (closing the people panel while it is
  // open), and both timers below would then fire into an unmounted tree.
  const aliveRef = useRef(true);
  useEffect(() => () => {
    aliveRef.current = false;
    if (noteTimer.current) window.clearTimeout(noteTimer.current);
  }, []);

  const handle = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const opened = await onInvite();
    if (!aliveRef.current) return;
    setBusy(false);
    if (opened) return;
    setNote("Can't invite here");
    if (noteTimer.current) window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => {
      if (aliveRef.current) setNote(null);
    }, 2600);
  }, [busy, onInvite]);

  return (
    <div style={styles.wrap}>
      <button
        type="button"
        onClick={handle}
        style={styles.button}
        title="Invite people to this Activity"
        aria-label="Invite people to this Activity"
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
      {note && <div style={styles.note}>{note}</div>}
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
  note: {
    position: "absolute",
    top: "calc(100% + 8px)",
    right: 0,
    padding: "6px 10px",
    borderRadius: "6px",
    background: "rgba(0,0,0,0.9)",
    border: "1px solid rgba(255,255,255,0.12)",
    color: "#bbb",
    fontSize: "12px",
    whiteSpace: "nowrap",
    pointerEvents: "none",
    zIndex: 60,
  },
};
