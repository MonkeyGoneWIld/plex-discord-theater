/**
 * A player handed a running stream while it plays nothing — its driver left,
 * or it came back to a room held for it — adopts that stream rather than
 * making another (Player.tsx, the stream-assignment effect).
 *
 * Adopting is taken up by the player's stream effect the next time it runs.
 * Whether to ask for that run depends on whether it has run already:
 *  - It has: nothing else will make it run, so a rebuild is asked for.
 *  - It hasn't (the player has only just mounted): its first run is about to
 *    happen and adopts. Asking for a rebuild as well gave it a second run,
 *    which found nothing left to adopt, tore the adopted stream down and
 *    started a new one from 0:00. On 11 November a host back in a room held
 *    at 0:43 waited 28.9 s for that, and the room moved back 12 s to meet them.
 */
export function rebuildToAdopt(streamEffectHasRun: boolean): boolean {
  return streamEffectHasRun;
}
