import { useCallback, useEffect, useRef, useState } from "react";
import type { CallMember, InviteResult } from "../hooks/useDiscord";

interface InvitePanelProps {
  /** Everyone in the activity's voice channel. */
  listCallMembers: () => Promise<CallMember[]>;
  /** Invite one person straight into this instance. */
  inviteUser: (userId: string) => Promise<boolean>;
  /** Discord's own channel-invite dialog, for anyone not on the call. */
  openInvite: () => Promise<InviteResult>;
  /** Discord ids already in the watch party — they don't need inviting. */
  alreadyHere: string[];
  /** Us. Never offer to invite yourself. */
  selfUserId: string | null;
  onClose: () => void;
}

/** Colour for the initial circle, picked from the id so a person keeps theirs. */
const AVATAR_COLOURS = ["#e5a00d", "#5865f2", "#3ba55d", "#eb459e", "#ed4245", "#00a8fc"];

function colourFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLOURS[hash % AVATAR_COLOURS.length];
}

/**
 * A people-only invite list.
 *
 * Discord's `openInviteDialog` is the only SDK command that invites someone
 * into *this* activity instance, and it renders a picker of Discord's choosing
 * — text channels, voice channels and bots alongside people. For a watch party
 * that list is mostly noise: you want to invite the people you are already on a
 * call with.
 *
 * So the list here is the voice channel's own roster (getChannel → voice_states,
 * which needs only the `guilds` scope), minus whoever is already watching, with
 * `inviteUserEmbedded` per row. The real friend list would need
 * `relationships.read`, which Discord gates behind Social SDK approval.
 *
 * Discord's dialog is still one tap away at the bottom, because someone who
 * isn't in the call can only be reached that way — and because if any of the
 * above fails, that fallback is the whole panel.
 */
export function InvitePanel({
  listCallMembers,
  inviteUser,
  openInvite,
  alreadyHere,
  selfUserId,
  onClose,
}: InvitePanelProps) {
  const [members, setMembers] = useState<CallMember[] | null>(null);
  /** Per-person state, so a row can say what happened to it. */
  const [sent, setSent] = useState<Record<string, "sending" | "sent" | "failed">>({});
  const [dialogFailed, setDialogFailed] = useState(false);
  const aliveRef = useRef(true);
  const anyFailed = Object.values(sent).includes("failed");

  useEffect(() => {
    aliveRef.current = true;
    listCallMembers()
      .then((all) => {
        if (!aliveRef.current) return;
        const here = new Set(alreadyHere);
        setMembers(all.filter((m) => m.id !== selfUserId && !here.has(m.id)));
      })
      .catch(() => { if (aliveRef.current) setMembers([]); });
    return () => { aliveRef.current = false; };
    // alreadyHere is a fresh array each render; depending on it would refetch
    // the roster on every roster broadcast. The snapshot at open is what the
    // list should reflect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listCallMembers, selfUserId]);

  const invite = useCallback(async (member: CallMember) => {
    setSent((prev) => ({ ...prev, [member.id]: "sending" }));
    const ok = await inviteUser(member.id);
    if (!aliveRef.current) return;
    setSent((prev) => ({ ...prev, [member.id]: ok ? "sent" : "failed" }));
  }, [inviteUser]);

  const openDiscordDialog = useCallback(async () => {
    const result = await openInvite();
    if (!aliveRef.current) return;
    // Only close on success. Closing regardless meant a refused dialog — the
    // usual cause is lacking Create Invite in the channel — looked exactly like
    // a successful one: the panel vanished and nothing happened.
    if (result === "opened") onClose();
    else setDialogFailed(true);
  }, [openInvite, onClose]);

  const loading = members === null;
  const empty = members !== null && members.length === 0;

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <h3 style={styles.title}>Invite to watch</h3>
          <button onClick={onClose} style={styles.closeBtn} aria-label="Close">&times;</button>
        </div>

        <div style={styles.list}>
          {loading && <div style={styles.hint}>Looking who&rsquo;s in the call&hellip;</div>}

          {empty && (
            <div style={styles.hint}>
              {/* Two different situations, one message that covers both honestly:
                  nobody else is on the call, or everyone on it is already here. */}
              Nobody in the call to invite. Use the button below to invite
              someone else.
            </div>
          )}

          {members?.map((m) => {
            const status = sent[m.id];
            return (
              <div key={m.id} style={styles.row}>
                <span style={{ ...styles.avatar, background: colourFor(m.id) }}>
                  {m.name.slice(0, 1).toUpperCase()}
                </span>
                <span style={styles.names}>
                  <span style={styles.name}>{m.name}</span>
                  {m.username !== m.name && <span style={styles.handle}>{m.username}</span>}
                </span>
                <button
                  onClick={() => invite(m)}
                  disabled={status === "sending" || status === "sent"}
                  style={status === "sent" ? styles.sentBtn : styles.inviteBtn}
                >
                  {status === "sent" ? "Invited"
                    : status === "sending" ? "…"
                    : status === "failed" ? "Retry"
                    : "Invite"}
                </button>
              </div>
            );
          })}
          {anyFailed && (
            <div style={styles.hint}>
              Discord wouldn&rsquo;t send that one. You can try again, or use the
              button below.
            </div>
          )}
        </div>

        {dialogFailed && (
          <div style={styles.hint}>
            Discord wouldn&rsquo;t open the invite dialog — you may not have
            permission to create invites in this channel.
          </div>
        )}
        <button onClick={openDiscordDialog} style={styles.moreBtn}>
          Invite someone else&hellip;
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 120,
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  panel: {
    width: "340px", maxWidth: "88vw", maxHeight: "78vh", background: "#1a1a1a",
    border: "1px solid rgba(255,255,255,0.1)", borderRadius: "12px",
    display: "flex", flexDirection: "column", overflow: "hidden",
  },
  header: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "14px 16px", borderBottom: "1px solid rgba(255,255,255,0.06)",
  },
  title: { margin: 0, color: "#f0f0f0", fontSize: "15px", fontWeight: 600 },
  closeBtn: {
    background: "transparent", border: "none", color: "#888", fontSize: "22px",
    lineHeight: 1, cursor: "pointer", padding: 0, fontFamily: "inherit",
  },
  list: { overflowY: "auto", padding: "6px 0", flex: 1, minHeight: "60px" },
  hint: { color: "#888", fontSize: "13px", lineHeight: 1.5, padding: "14px 16px" },
  row: { display: "flex", alignItems: "center", gap: "10px", padding: "7px 16px" },
  avatar: {
    width: "30px", height: "30px", borderRadius: "50%", flexShrink: 0,
    display: "flex", alignItems: "center", justifyContent: "center",
    color: "#000", fontSize: "13px", fontWeight: 700,
  },
  names: { display: "flex", flexDirection: "column", minWidth: 0, flex: 1 },
  name: {
    color: "#f0f0f0", fontSize: "13px", fontWeight: 600,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  handle: {
    color: "#777", fontSize: "11px",
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  inviteBtn: {
    flexShrink: 0, padding: "4px 12px", borderRadius: "999px",
    border: "1px solid rgba(229,160,13,0.45)", background: "transparent",
    color: "#e5a00d", fontSize: "12px", fontWeight: 700, cursor: "pointer",
    fontFamily: "inherit",
  },
  sentBtn: {
    flexShrink: 0, padding: "4px 12px", borderRadius: "999px",
    border: "1px solid rgba(255,255,255,0.1)", background: "transparent",
    color: "#666", fontSize: "12px", fontWeight: 700, cursor: "default",
    fontFamily: "inherit",
  },
  moreBtn: {
    padding: "11px 16px", border: "none",
    borderTop: "1px solid rgba(255,255,255,0.06)", background: "transparent",
    color: "#9a9a9a", fontSize: "12px", fontWeight: 600, cursor: "pointer",
    fontFamily: "inherit", textAlign: "center",
  },
};
