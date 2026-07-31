import { useCallback, useRef, useState } from "react";

interface InviteButtonProps {
  /** Opens Discord's invite dialog. Resolves false when it couldn't be shown. */
  onInvite: () => Promise<boolean>;
  /** "header" sits in the browsing chrome; "player" sits over the video, where
   *  the surrounding controls are darker and slightly larger. */
  variant?: "header" | "player";
  /** Hide the label and show the icon alone — for the player's crowded top bar
   *  on a narrow window. */
  compact?: boolean;
}

/**
 * "Invite to Activity" — hands off to Discord's own invite dialog.
 *
 * Discord owns the whole flow once the dialog opens: who can be invited, what
 * the invite looks like, and whether the user has permission to create one.
 * That's why the failure path here is a quiet note rather than an error — the
 * common reason is simply lacking Create Invite in the channel, which is the
 * server's decision and not something to alarm anyone about.
 */
export function InviteButton({ onInvite, variant = "header", compact = false }: InviteButtonProps) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const noteTimer = useRef<number | undefined>(undefined);

  const handle = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const opened = await onInvite();
    setBusy(false);
    if (opened) return;
    setNote("Can't invite here");
    if (noteTimer.current) window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(null), 2600);
  }, [busy, onInvite]);

  const style = variant === "player" ? styles.player : styles.header;

  return (
    <div style={styles.wrap}>
      <button
        type="button"
        onClick={handle}
        style={style}
        title="Invite people to this Activity"
        aria-label="Invite people to this Activity"
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "rgba(229,160,13,0.75)")}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.14)")}
      >
        {/* Person with a plus — the same idea Discord uses for "invite". */}
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="6" cy="5" r="2.6" stroke="currentColor" strokeWidth="1.5" />
          <path d="M1.6 13.2c0-2.4 2-4 4.4-4s4.4 1.6 4.4 4" stroke="currentColor"
            strokeWidth="1.5" strokeLinecap="round" />
          <path d="M12.6 5.4v4.2M14.7 7.5h-4.2" stroke="currentColor"
            strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        {!compact && <span>Invite</span>}
      </button>
      {note && <div style={styles.note}>{note}</div>}
    </div>
  );
}

const base: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "7px",
  borderRadius: "8px",
  border: "1px solid rgba(255,255,255,0.14)",
  color: "#e8e8e8",
  fontFamily: "inherit",
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
  transition: "border-color 0.15s ease, background 0.15s ease",
};

const styles: Record<string, React.CSSProperties> = {
  wrap: { position: "relative", display: "inline-flex" },
  header: {
    ...base,
    padding: "7px 13px",
    fontSize: "13px",
    background: "rgba(255,255,255,0.06)",
  },
  player: {
    ...base,
    padding: "8px 14px",
    fontSize: "13px",
    // Darker, because this sits over video rather than over the page.
    background: "rgba(0,0,0,0.55)",
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
