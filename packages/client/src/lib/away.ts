import { useEffect, useRef } from "react";

/**
 * Whether this player looks away from the activity: hidden for HIDDEN_MS, or
 * nothing touched for IDLE_MS while nothing plays. A host away has a request
 * for their role count down from 1 minute rather than 5 (services/hostRequests).
 * Discord's own idle status isn't something an activity can read.
 */
export const HIDDEN_MS = 30_000;
export const IDLE_MS = 3 * 60_000;
const LOOK_MS = 5_000;

export function isAway(o: { hiddenForMs: number; idleForMs: number; playing: boolean }): boolean {
  return o.hiddenForMs >= HIDDEN_MS || (!o.playing && o.idleForMs >= IDLE_MS);
}

/** Calls `onChange` each time this player goes away or comes back. */
export function useActivityAway(playing: boolean, onChange: (away: boolean) => void): void {
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    let lastInput = Date.now();
    let hiddenAt: number | null = document.visibilityState === "hidden" ? Date.now() : null;
    let away = false;
    const look = () => {
      const now = Date.now();
      const next = isAway({
        hiddenForMs: hiddenAt === null ? 0 : now - hiddenAt,
        idleForMs: now - lastInput,
        playing: playingRef.current,
      });
      if (next !== away) {
        away = next;
        onChangeRef.current(away);
      }
    };
    const input = () => {
      lastInput = Date.now();
      if (away) look();
    };
    const visibility = () => {
      hiddenAt = document.visibilityState === "hidden" ? (hiddenAt ?? Date.now()) : null;
      if (hiddenAt === null) input();
    };
    const events = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
    for (const e of events) window.addEventListener(e, input, { passive: true, capture: true });
    document.addEventListener("visibilitychange", visibility);
    const timer = setInterval(look, LOOK_MS);
    return () => {
      for (const e of events) window.removeEventListener(e, input, { capture: true });
      document.removeEventListener("visibilitychange", visibility);
      clearInterval(timer);
    };
  }, []);
}
