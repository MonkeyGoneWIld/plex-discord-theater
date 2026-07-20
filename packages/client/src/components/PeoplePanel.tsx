import { useState } from "react";
import type { Participant } from "../hooks/useSync";

interface PeoplePanelProps {
  participants: Participant[];
  /** Our own Discord user id — used to label ourselves and hide self-actions. */
  selfUserId: string | null;
  /** Whether the local client is the host. Only the host sees role controls. */
  isHost: boolean;
  onPromoteHost: (userId: string) => void;
  onSetCoHost: (userId: string, value: boolean) => void;
  onClose: () => void;
}

function roleLabel(p: Participant): string | null {
  if (p.isHost) return "HOST";
  if (p.isCoHost) return "CO-HOST";
  return null;
}

export function PeoplePanel({
  participants,
  selfUserId,
  isHost,
  onPromoteHost,
  onSetCoHost,
  onClose,
}: PeoplePanelProps) {
  // Handing over the host role loses you all control, so it takes two taps.
  const [confirmingPromote, setConfirmingPromote] = useState<string | null>(null);

  // Host first, then co-hosts, then everyone else — the list reads as a hierarchy.
  const ordered = [...participants].sort((a, b) => {
    const rank = (p: Participant) => (p.isHost ? 0 : p.isCoHost ? 1 : 2);
    return rank(a) - rank(b);
  });

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <h3 style={styles.title}>People ({participants.length})</h3>
          <button onClick={onClose} style={styles.closeBtn}>&times;</button>
        </div>

        <div style={styles.list}>
          {ordered.map((p) => {
            const isSelf = p.userId === selfUserId;
            const label = roleLabel(p);
            return (
              <div key={p.userId} style={styles.item}>
                <div style={styles.info}>
                  <div style={styles.name}>
                    {p.username || "Unknown"}
                    {isSelf && <span style={styles.you}> (you)</span>}
                  </div>
                  {label && (
                    <div style={p.isHost ? styles.badgeHost : styles.badgeCoHost}>{label}</div>
                  )}
                </div>

                {/* Only the host manages roles, and never on themselves. */}
                {isHost && !p.isHost && (
                  <div style={styles.actions}>
                    <button
                      onClick={() => onSetCoHost(p.userId, !p.isCoHost)}
                      style={p.isCoHost ? styles.revokeBtn : styles.grantBtn}
                    >
                      {p.isCoHost ? "Revoke" : "Co-host"}
                    </button>
                    {confirmingPromote === p.userId ? (
                      <button
                        onClick={() => {
                          setConfirmingPromote(null);
                          onPromoteHost(p.userId);
                        }}
                        style={styles.confirmBtn}
                      >
                        Confirm
                      </button>
                    ) : (
                      <button
                        onClick={() => setConfirmingPromote(p.userId)}
                        style={styles.promoteBtn}
                      >
                        Make host
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {isHost && (
          <p style={styles.hint}>
            Co-hosts can play, pause and seek. Making someone host hands over full
            control — you become a viewer.
          </p>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 100, display: "flex", justifyContent: "flex-end" },
  panel: { width: "320px", maxWidth: "80vw", height: "100%", background: "#1a1a1a", borderLeft: "1px solid rgba(255,255,255,0.1)", display: "flex", flexDirection: "column", overflow: "hidden" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px", borderBottom: "1px solid rgba(255,255,255,0.06)" },
  title: { color: "#f0f0f0", fontSize: "16px", fontWeight: 600 },
  closeBtn: { background: "none", border: "none", color: "#888", fontSize: "20px", cursor: "pointer", fontFamily: "inherit" },
  list: { flex: 1, overflowY: "auto", padding: "8px" },
  item: { display: "flex", alignItems: "center", gap: "10px", padding: "10px 8px", borderRadius: "8px", background: "rgba(255,255,255,0.03)", marginBottom: "4px" },
  info: { flex: 1, minWidth: 0 },
  name: { color: "#f0f0f0", fontSize: "13px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  you: { color: "#666", fontWeight: 400 },
  badgeHost: { display: "inline-block", marginTop: "4px", color: "#e5a00d", fontSize: "10px", fontWeight: 700, letterSpacing: "0.5px" },
  badgeCoHost: { display: "inline-block", marginTop: "4px", color: "#5aa9e6", fontSize: "10px", fontWeight: 700, letterSpacing: "0.5px" },
  actions: { display: "flex", gap: "6px", flexShrink: 0 },
  grantBtn: { padding: "4px 8px", borderRadius: "6px", border: "1px solid rgba(90,169,230,0.4)", background: "transparent", color: "#5aa9e6", fontSize: "11px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" },
  revokeBtn: { padding: "4px 8px", borderRadius: "6px", border: "1px solid rgba(255,255,255,0.15)", background: "transparent", color: "#888", fontSize: "11px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" },
  promoteBtn: { padding: "4px 8px", borderRadius: "6px", border: "1px solid rgba(229,160,13,0.4)", background: "transparent", color: "#e5a00d", fontSize: "11px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" },
  confirmBtn: { padding: "4px 8px", borderRadius: "6px", border: "none", background: "#e5a00d", color: "#000", fontSize: "11px", fontWeight: 700, cursor: "pointer", fontFamily: "inherit" },
  hint: { color: "#666", fontSize: "11px", lineHeight: 1.5, padding: "12px 16px 16px", borderTop: "1px solid rgba(255,255,255,0.06)" },
};
