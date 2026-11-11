import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { QUIET_SURFACE } from "../lib/surface";
import {
  clock, msUntil, peoplePanelOpen, SHOW_REQUEST_EVENT, subscribePeoplePanel, type HostRequestView,
} from "../lib/hostRequest";

/**
 * Asking an away host for the role, on screen (lib/hostRequest):
 *  - the host: who asked, the countdown, Accept / Decline. Nothing else
 *    answers: only their Decline declines.
 *  - who asked: the countdown, which they can minimize or hide and see again
 *    from the People panel.
 *  - a host the countdown took the role from: Reclaim host, for a while.
 * Below the top bar, at the right, and never over the People panel, which
 * says the same, Accept and Decline included; styled as the pause request's
 * card (TransportRequestCard). That a request was declined is said the way
 * "You are now the host" is: the app's own notice, top centre, for a moment.
 */
interface Props {
  view: HostRequestView | null;
  selfUserId: string | null;
  isHost: boolean;
  hostName: string | null;
  onAnswer: (accept: boolean) => void;
  onReclaim: () => void;
}

/** As long as "You are now the host" (lib/usePromotedToast) and a line more to read. */
const NOTE_MS = 3_000;

/** "Lead-in " + a name that gives way first, as TransportRequestCard. */
function Heading({ lead, name }: { lead: string; name: string }) {
  return (
    <div style={styles.heading}>
      <span style={styles.lead}>{lead}</span>
      <strong style={styles.name} title={name}>{name}</strong>
    </div>
  );
}

export function HostRequestOverlay({ view, selfUserId, isHost, hostName, onAnswer, onReclaim }: Props) {
  const [, tick] = useState(0);
  const [mineShown, setMineShown] = useState<"open" | "pill" | "hidden">("open");
  const [reclaimHidden, setReclaimHidden] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const panelOpen = useSyncExternalStore(subscribePeoplePanel, peoplePanelOpen);

  const now = Date.now();
  const active = view?.on ? view.active : null;
  const forMe = !!active && isHost;
  const mine = !!active && active.requesterId === selfUserId && !isHost;
  const reclaimMs = view?.on && view.reclaimUntil !== null && !isHost ? msUntil(view, view.reclaimUntil, now) : 0;
  const counting = forMe || mine || reclaimMs > 0;
  const host = hostName || "the host";

  useEffect(() => {
    if (!counting) return;
    const t = setInterval(() => tick((n) => n + 1), 1_000);
    return () => clearInterval(t);
  }, [counting]);

  // A new request of mine opens; the People panel's button opens it again.
  useEffect(() => { if (mine) setMineShown("open"); }, [mine, active?.requesterId]);
  useEffect(() => {
    const show = () => setMineShown("open");
    window.addEventListener(SHOW_REQUEST_EVENT, show);
    return () => window.removeEventListener(SHOW_REQUEST_EVENT, show);
  }, []);
  useEffect(() => { if (view?.reclaimUntil) setReclaimHidden(false); }, [view?.reclaimUntil]);

  // A request of mine declined, said for a moment. One that made me the host
  // is said by the app's own "You are now the host".
  const wasMine = useRef(false);
  useEffect(() => {
    if (wasMine.current && !mine && !isHost && view?.blocked?.why === "you-declined") {
      setNote(`${hostName || "The host"} declined your host request`);
    }
    wasMine.current = mine;
  }, [mine, isHost, view?.blocked?.why, hostName]);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(t);
  }, [note]);

  // The notice is the app's, not a card: it shows over the People panel too.
  const notice = note ? <div data-host-request-note style={styles.note} role="status">{note}</div> : null;
  if (panelOpen) return notice;

  if (forMe && active) {
    return (
      <div data-host-request style={styles.wrap} role="alertdialog" aria-label="Host request">
        <div style={styles.card}>
          <Heading lead="Host requested by " name={active.requesterName || "a viewer"} />
          <p style={styles.body}>
            Host transfers in <b style={styles.time}>{clock(msUntil(view!, active.endsAt, now))}</b> unless
            you respond.
          </p>
          <div style={styles.row}>
            <button className="btn" style={styles.primary} onClick={() => onAnswer(true)}>Accept</button>
            <button className="btn" style={styles.secondary} onClick={() => onAnswer(false)}>Decline</button>
          </div>
        </div>
      </div>
    );
  }

  if (mine && active && mineShown !== "hidden") {
    const left = clock(msUntil(view!, active.endsAt, now));
    if (mineShown === "pill") {
      return (
        <div data-host-request style={styles.wrap} role="status">
          <div style={styles.pill}>
            <button className="btn" style={styles.pillBtn} onClick={() => setMineShown("open")}>
              Host request · <span style={styles.time}>{left}</span>
            </button>
            <button className="btn" style={styles.pillX} aria-label="Hide" title="Hide" onClick={() => setMineShown("hidden")}>&times;</button>
          </div>
        </div>
      );
    }
    return (
      <div data-host-request style={styles.wrap} role="status">
        <div style={styles.card}>
          <Heading lead="Host request sent to " name={host} />
          <p style={styles.body}>
            Host transfers to you in <b style={styles.time}>{left}</b> if there is no response. Reopen this
            from the People panel.
          </p>
          <div style={styles.row}>
            <button className="btn" style={styles.secondary} onClick={() => setMineShown("pill")}>Minimize</button>
            <button className="btn" style={styles.secondary} onClick={() => setMineShown("hidden")}>Hide</button>
          </div>
        </div>
      </div>
    );
  }

  if (reclaimMs > 0 && !reclaimHidden) {
    return (
      <div data-host-request style={styles.wrap} role="status">
        <div style={styles.card}>
          <Heading lead="Host transferred to " name={hostName || "another viewer"} />
          <p style={styles.body}>
            Their request went unanswered while you were away. You can reclaim host
            for <b style={styles.time}>{clock(reclaimMs)}</b>.
          </p>
          <div style={styles.row}>
            <button className="btn" style={styles.primary} onClick={onReclaim}>Reclaim host</button>
            <button className="btn" style={styles.secondary} onClick={() => setReclaimHidden(true)}>Dismiss</button>
          </div>
        </div>
      </div>
    );
  }

  return notice;
}

const styles: Record<string, React.CSSProperties> = {
  // Below the top bar (16px + its row + 16px, under Discord's own chrome) and
  // clear of its buttons; above the player, whose layer is 50.
  wrap: {
    position: "fixed", top: "calc(var(--sait, 0px) + 76px)", right: "calc(var(--sair, 0px) + 16px)",
    zIndex: 90, width: "min(300px, calc(100vw - 32px))", display: "flex", justifyContent: "flex-end",
    pointerEvents: "none",
  },
  card: {
    pointerEvents: "auto", width: "100%", boxSizing: "border-box",
    background: "rgba(0,0,0,0.85)", borderRadius: "12px", padding: "14px 16px",
    border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 2px 12px rgba(0,0,0,0.5)",
  },
  heading: { display: "flex", alignItems: "baseline", color: "#f0f0f0", fontSize: "14px" },
  lead: { flexShrink: 0, whiteSpace: "pre" },
  name: { fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  body: { color: "#aaa", fontSize: "12px", lineHeight: 1.5, margin: "6px 0 0" },
  time: { color: "#e5a00d", fontWeight: 600, fontVariantNumeric: "tabular-nums" },
  row: { display: "flex", gap: "8px", marginTop: "12px" },
  primary: {
    flex: 1, padding: "8px", borderRadius: "6px", border: "none", background: "#e5a00d", color: "#000",
    fontSize: "12px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
  },
  secondary: {
    ...QUIET_SURFACE, flex: 1, padding: "8px", borderRadius: "6px", color: "#aaa",
    fontSize: "12px", cursor: "pointer", fontFamily: "inherit",
  },
  pill: {
    pointerEvents: "auto", display: "flex", alignItems: "center", background: "rgba(0,0,0,0.85)",
    border: "1px solid rgba(255,255,255,0.1)", borderRadius: "999px", padding: "2px 4px 2px 12px",
    boxShadow: "0 2px 12px rgba(0,0,0,0.5)",
  },
  pillBtn: {
    background: "none", border: "none", color: "#f0f0f0", fontSize: "12px", fontWeight: 600, padding: "6px 4px",
    cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap",
  },
  pillX: {
    background: "none", border: "none", color: "#888", fontSize: "16px", lineHeight: 1, padding: "4px 8px",
    cursor: "pointer", fontFamily: "inherit",
  },
  // The shape, place and type of App's "You are now the host" (promotedToast),
  // in grey: it is news, not good news.
  note: {
    position: "fixed", top: "16px", left: "50%", transform: "translateX(-50%)", padding: "10px 24px",
    borderRadius: "8px", background: "rgba(60,60,60,0.95)", color: "#fff", fontSize: "14px", fontWeight: 600,
    zIndex: 1000, pointerEvents: "none", maxWidth: "calc(100vw - 32px)", textAlign: "center", overflowWrap: "anywhere",
  },
};
