import { useEffect, useRef, useState } from "react";

/** How long "You are now the host" stays up. */
export const PROMOTED_TOAST_MS = 2000;

/**
 * Whether to say "You are now the host": for a moment after being handed the
 * room, and only while it is so. test/host-toast.html goes through it.
 *
 * Only on a genuine false → true handover. `null` is the third state and it
 * means "we don't know our role yet", which is where every client starts:
 * once the join reply began carrying isHost from the roster, null → true
 * became the *normal* opening move for whoever launched the activity, and
 * they were congratulated on becoming the host of a room they had just
 * opened. Starting something is not being handed it.
 *
 * The timer belongs to the toast, not to the role: cleared by the role's next
 * change, it left waawee told they were the host for the rest of the episode
 * when artemidorus's connection dropped and took the room back 1.7 s later
 * (27 Oct, within the grace).
 */
export function usePromotedToast(isHost: boolean | null): boolean {
  const [shown, setShown] = useState(false);
  const prev = useRef(isHost);
  useEffect(() => {
    const was = prev.current;
    prev.current = isHost;
    setShown(isHost === true && was === false);
  }, [isHost]);
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(false), PROMOTED_TOAST_MS);
    return () => clearTimeout(timer);
  }, [shown]);
  return shown;
}
