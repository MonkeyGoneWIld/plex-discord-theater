import { useEffect, useState } from "react";
import type { Participant } from "../hooks/useSync";
import { clock, requestButton, SHOW_REQUEST_EVENT, waitText, type HostRequestView } from "../lib/hostRequest";
import type { InviteResult } from "../hooks/useDiscord";
import { InviteButton } from "./InviteButton";
import { useMediaQuery, PHONE_QUERY } from "../lib/useMediaQuery";

interface PeoplePanelProps {
  participants: Participant[];
  /** Our own Discord user id — used to label ourselves and hide self-actions. */
  selfUserId: string | null;
  /** Whether the local client is the host. Only the host sees role controls. */
  isHost: boolean;
  onPromoteHost: (userId: string) => void;
  onSetCoHost: (userId: string, value: boolean) => void;
  /** Opens Discord's invite dialog. Omit where there's nothing to invite to,
   *  or where the surface already offers it elsewhere (the browsing header).
   *  Ignored on a phone — see the invite row below. */
  onInvite?: () => Promise<InviteResult>;
  onClose: () => void;
  sharePresenceDetails: boolean;
  onSharePresenceDetails: (share: boolean) => void;
  /** Asking an away host for the role (lib/hostRequest). Omit: no button. */
  hostRequest?: HostRequestView | null;
  onRequestHost?: () => void;
  onReclaimHost?: () => void;
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
  onInvite,
  onClose,
  sharePresenceDetails,
  onSharePresenceDetails,
  hostRequest = null,
  onRequestHost,
  onReclaimHost,
}: PeoplePanelProps) {
  // The request button's countdowns tick; a wait shows only once pressed.
  const [, tick] = useState(0);
  const [showWait, setShowWait] = useState(false);
  const button = isHost || !onRequestHost ? null : requestButton(hostRequest, selfUserId, Date.now());
  const ticking = !!button && button.kind !== "ask";
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => tick((n) => n + 1), 1_000);
    return () => clearInterval(t);
  }, [ticking]);
  useEffect(() => { if (button?.kind !== "wait") setShowWait(false); }, [button?.kind]);
  // Handing over the host role loses you all control, so it takes two taps.
  const [confirmingPromote, setConfirmingPromote] = useState<string | null>(null);
  // Discord's mobile client keeps its own bar pinned over the top of the
  // Activity, with "Invite To Activity" in the middle of it. See the invite row
  // and the panel's padding below, both of which exist because of that bar.
  const phone = useMediaQuery(PHONE_QUERY);

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
          <button className="btn" onClick={onClose} style={styles.closeBtn}>&times;</button>
        </div>

        {/* Inviting lives here during playback rather than in the control bar:
            this panel is already the "who's in the room" surface, and the bar
            over the video is where every pixel competes with the film. Above
            the roster, not below it — bringing someone in is the reason to open
            this panel when the list is short, which is most of the time.

            Never on a phone: Discord's own bar is on screen the whole time
            there, invite button included, so this would be the second one. */}
        {onInvite && !phone && (
          <div style={styles.inviteRow}>
            <InviteButton onInvite={onInvite} />
          </div>
        )}

        {/* Asking an away host for the role. One request at a time, so a
            pending one shows who asked and the time left; a wait shows only
            once pressed. */}
        {button && (
          <div style={styles.requestRow}>
            {button.kind === "ask" && (
              <button className="btn" style={styles.requestBtn} onClick={() => onRequestHost?.()}>Request host</button>
            )}
            {button.kind === "mine" && (
              <button className="btn" style={styles.requestBtn}
                onClick={() => { window.dispatchEvent(new Event(SHOW_REQUEST_EVENT)); onClose(); }}>
                Requested · {clock(button.leftMs)}
              </button>
            )}
            {button.kind === "theirs" && (
              <button className="btn" style={styles.requestOff} disabled>
                {button.name} asked · {clock(button.leftMs)}
              </button>
            )}
            {button.kind === "wait" && (
              <button className="btn" style={styles.requestOff} onClick={() => setShowWait((v) => !v)}>Request host</button>
            )}
            {button.kind === "reclaim" && (
              <button className="btn" style={styles.requestBtn} onClick={() => { onReclaimHost?.(); onClose(); }}>
                Take host back · {clock(button.leftMs)}
              </button>
            )}
            <p style={styles.requestHelp}>
              {button.kind === "ask" && "Asks the host for the role. If they don't answer in 5 minutes (1 if they're away), it passes to you."}
              {button.kind === "mine" && "Waiting for the host. Press to see the countdown."}
              {button.kind === "theirs" && "One request at a time. The host has until then to answer."}
              {button.kind === "wait" && showWait && waitText(button.why, button.leftMs)}
              {button.kind === "reclaim" && "The role passed on while you were away."}
            </p>
          </div>
        )}

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
                    <button className="btn"
                      onClick={() => onSetCoHost(p.userId, !p.isCoHost)}
                      style={p.isCoHost ? styles.revokeBtn : styles.grantBtn}
                    >
                      {p.isCoHost ? "Revoke" : "Co-host"}
                    </button>
                    {confirmingPromote === p.userId ? (
                      <button className="btn"
                        onClick={() => {
                          setConfirmingPromote(null);
                          onPromoteHost(p.userId);
                        }}
                        style={styles.confirmBtn}
                      >
                        Confirm
                      </button>
                    ) : (
                      <button className="btn"
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

        <label style={styles.presencePreference}>
          <input
            type="checkbox"
            checked={sharePresenceDetails}
            onChange={(event) => onSharePresenceDetails(event.target.checked)}
            style={{ accentColor: "#e5a00d", marginTop: "3px" }}
          />
          <span>
            <span style={styles.presenceLabel}>Show media details on Discord</span>
            <span style={styles.presenceHelp}>
              Share this room's title, artwork and progress on your profile.
              Turn off for a generic watching status. Artwork already fetched by Discord may remain cached.
            </span>
          </span>
        </label>

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
  // The insets keep the panel's own header clear of Discord's overlaid chrome.
  // Without them the title and close button sat underneath the mobile bar and
  // the roster began behind it — the panel is fixed to the viewport, so it gets
  // no benefit from the padding the app header carries. Defined in index.html.
  panel: {
    width: "320px", maxWidth: "80vw", height: "100%",
    background: "#1a1a1a", borderLeft: "1px solid rgba(255,255,255,0.1)",
    display: "flex", flexDirection: "column", overflow: "hidden",
    paddingTop: "var(--sait, 0px)",
    paddingRight: "var(--sair, 0px)",
    paddingBottom: "var(--saib, 0px)",
  },
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
  inviteRow: { padding: "10px 16px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)" },
  requestRow: { padding: "10px 16px 4px", borderBottom: "1px solid rgba(255,255,255,0.06)" },
  requestBtn: { width: "100%", padding: "8px 10px", borderRadius: "8px", border: "1px solid rgba(229,160,13,0.4)", background: "transparent", color: "#e5a00d", fontSize: "12px", fontWeight: 700, cursor: "pointer", fontFamily: "inherit", fontVariantNumeric: "tabular-nums" },
  requestOff: { width: "100%", padding: "8px 10px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.03)", color: "#666", fontSize: "12px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit", fontVariantNumeric: "tabular-nums" },
  requestHelp: { color: "#777", fontSize: "11px", lineHeight: 1.5, margin: "6px 0 6px", minHeight: "1em" },
  presencePreference: { display: "flex", alignItems: "flex-start", gap: "10px", padding: "14px 16px", borderTop: "1px solid rgba(255,255,255,0.06)", cursor: "pointer", flexShrink: 0 },
  presenceLabel: { display: "block", color: "#ddd", fontSize: "12px", fontWeight: 600 },
  presenceHelp: { display: "block", color: "#888", fontSize: "11px", lineHeight: 1.5, marginTop: "5px" },
  hint: { color: "#666", fontSize: "11px", lineHeight: 1.5, padding: "12px 16px 16px", borderTop: "1px solid rgba(255,255,255,0.06)" },
};
