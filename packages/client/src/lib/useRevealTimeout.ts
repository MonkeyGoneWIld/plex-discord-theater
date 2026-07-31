import { useEffect, useState } from "react";

/**
 * Backstop for a reveal gate: true once `ms` has passed since `resetKey` last
 * changed.
 *
 * A page that waits for several independent requests needs a way out when one
 * of them never answers — a dead artwork URL or a Plex call that hangs must not
 * leave the viewer on a skeleton indefinitely. The wait is deliberately long,
 * because reaching it means showing a page that isn't finished; it's the
 * failure path, not the normal one.
 */
export function useRevealTimeout(resetKey: string, ms: number): boolean {
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    setTimedOut(false);
    const timer = window.setTimeout(() => setTimedOut(true), ms);
    return () => clearTimeout(timer);
  }, [resetKey, ms]);

  return timedOut;
}
