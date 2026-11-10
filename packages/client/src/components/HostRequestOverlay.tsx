import { useEffect, useRef, useState } from "react";
import { clock, msUntil, SHOW_REQUEST_EVENT, type HostRequestView } from "../lib/hostRequest";

/**
 * Asking an away host for the role, on screen (lib/hostRequest):
 *  - the host: who asked, the countdown, Give host / Decline. Using the
 *    activity while it counts down answers no: they are there.
 *  - who asked: the countdown, which they can shrink to a pill or hide and
 *    see again from the People tab.
 *  - a host the countdown took the role from: Take host back, for a while.
 * None of it blocks the film.
 */
interface Props {
  view: HostRequestView | null;
  selfUserId: string | null;
  isHost: boolean;
  hostName: string | null;
  onAnswer: (accept: boolean, present?: boolean) => void;
  onReclaim: () => void;
}

/** Input this soon after the host's prompt shows is from before it. */
const SETTLE_MS = 1_500;
const NOTE_MS = 8_000;

export function HostRequestOverlay({ view, selfUserId, isHost, hostName, onAnswer, onReclaim }: Props) {
  const [, tick] = useState(0);
  const [mineShown, setMineShown] = useState<"open" | "pill" | "hidden">("open");
  const [reclaimHidden, setReclaimHidden] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const now = Date.now();
  const active = view?.on ? view.active : null;
  const forMe = !!active && isHost;
  const mine = !!active && active.requesterId === selfUserId && !isHost;
  const reclaimMs = view?.on && view.reclaimUntil !== null && !isHost ? msUntil(view, view.reclaimUntil, now) : 0;
  const counting = forMe || mine || reclaimMs > 0;

  useEffect(() => {
    if (!counting) return;
    const t = setInterval(() => tick((n) => n + 1), 1_000);
    return () => clearInterval(t);
  }, [counting]);

  // A new request of mine opens; the People tab's button opens it again.
  const activeKey = active ? `${active.requesterId}:${active.endsAt}` : null;
  useEffect(() => { if (mine) setMineShown("open"); }, [mine, active?.requesterId]);
  useEffect(() => {
    const show = () => setMineShown("open");
    window.addEventListener(SHOW_REQUEST_EVENT, show);
    return () => window.removeEventListener(SHOW_REQUEST_EVENT, show);
  }, []);
  useEffect(() => { if (view?.reclaimUntil) setReclaimHidden(false); }, [view?.reclaimUntil]);

  // How a request of mine ended, said for a moment.
  const wasMine = useRef(false);
  useEffect(() => {
    if (wasMine.current && !mine) {
      if (isHost) setNote("You're the host now.");
      else if (view?.blocked?.why === "you-declined") setNote(`${hostName || "The host"} turned down your request.`);
    }
    wasMine.current = mine;
  }, [mine, isHost, view?.blocked?.why, hostName]);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(t);
  }, [note]);

  // The host using the activity while it counts down: they are there, so no.
  const shownAt = useRef(0);
  useEffect(() => { if (forMe) shownAt.current = Date.now(); }, [forMe, activeKey]);
  const answerRef = useRef(onAnswer);
  answerRef.current = onAnswer;
  useEffect(() => {
    if (!forMe) return;
    let answered = false;
    const used = (e: Event) => {
      if (answered || Date.now() - shownAt.current < SETTLE_MS) return;
      const t = e.target as Element | null;
      if (t?.closest?.("[data-host-request]")) return;
      answered = true;
      answerRef.current(false, true);
    };
    window.addEventListener("pointerdown", used, true);
    window.addEventListener("keydown", used, true);
    return () => {
      window.removeEventListener("pointerdown", used, true);
      window.removeEventListener("keydown", used, true);
    };
  }, [forMe, activeKey]);

  if (forMe && active) {
    const left = clock(msUntil(view!, active.endsAt, now));
    return (
      <div data-host-request style={styles.wrap}>
        <div style={styles.card}>
          <div style={styles.title}>{active.requesterName || "Someone"} is asking to be host</div>
          <div style={styles.body}>
            It passes to them in <b style={styles.time}>{left}</b> unless you answer. Using the activity answers no.
          </div>
          <div style={styles.row}>
            <button className="btn" style={styles.primary} onClick={() => onAnswer(true)}>Give host</button>
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
        <div data-host-request style={styles.wrap}>
          <div style={styles.pill}>
            <button className="btn" style={styles.pillBtn} onClick={() => setMineShown("open")}>Host in {left}</button>
            <button className="btn" style={styles.pillX} aria-label="Hide" onClick={() => setMineShown("hidden")}>&times;</button>
          </div>
        </div>
      );
    }
    return (
      <div data-host-request style={styles.wrap}>
        <div style={styles.card}>
          <div style={styles.title}>Asked {hostName || "the host"} for host</div>
          <div style={styles.body}>
            It's yours in <b style={styles.time}>{left}</b> unless they answer. The People tab shows this again.
          </div>
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
      <div data-host-request style={styles.wrap}>
        <div style={styles.card}>
          <div style={styles.title}>Host passed to {hostName || "someone else"}</div>
          <div style={styles.body}>
            They asked while you were away. You can take it back for <b style={styles.time}>{clock(reclaimMs)}</b>.
          </div>
          <div style={styles.row}>
            <button className="btn" style={styles.primary} onClick={onReclaim}>Take host back</button>
            <button className="btn" style={styles.secondary} onClick={() => setReclaimHidden(true)}>Dismiss</button>
          </div>
        </div>
      </div>
    );
  }

  if (note) {
    return (
      <div data-host-request style={styles.wrap}>
        <div style={styles.pill}><span style={styles.noteText}>{note}</span></div>
      </div>
    );
  }
  return null;
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    position: "fixed", left: "50%", transform: "translateX(-50%)", top: "calc(var(--sait, 0px) + 56px)",
    zIndex: 120, width: "min(360px, calc(100vw - 32px))", display: "flex", justifyContent: "center", pointerEvents: "none",
  },
  card: {
    pointerEvents: "auto", width: "100%", background: "rgba(26,26,26,0.96)", border: "1px solid rgba(229,160,13,0.35)",
    borderRadius: "10px", padding: "12px 14px", boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
  },
  title: { color: "#f0f0f0", fontSize: "13px", fontWeight: 700 },
  body: { color: "#aaa", fontSize: "12px", lineHeight: 1.5, marginTop: "4px" },
  time: { color: "#e5a00d", fontVariantNumeric: "tabular-nums" },
  row: { display: "flex", gap: "8px", marginTop: "10px", justifyContent: "flex-end" },
  primary: { padding: "6px 12px", borderRadius: "6px", border: "none", background: "#e5a00d", color: "#000", fontSize: "12px", fontWeight: 700, cursor: "pointer", fontFamily: "inherit" },
  secondary: { padding: "6px 12px", borderRadius: "6px", border: "1px solid rgba(255,255,255,0.15)", background: "transparent", color: "#ccc", fontSize: "12px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" },
  pill: {
    pointerEvents: "auto", display: "flex", alignItems: "center", gap: "2px", background: "rgba(26,26,26,0.96)",
    border: "1px solid rgba(229,160,13,0.35)", borderRadius: "999px", padding: "4px 6px 4px 12px",
  },
  pillBtn: { background: "none", border: "none", color: "#e5a00d", fontSize: "12px", fontWeight: 700, cursor: "pointer", fontFamily: "inherit", fontVariantNumeric: "tabular-nums" },
  pillX: { background: "none", border: "none", color: "#888", fontSize: "16px", cursor: "pointer", fontFamily: "inherit", padding: "0 6px" },
  noteText: { color: "#ddd", fontSize: "12px", padding: "2px 8px 2px 0" },
};
