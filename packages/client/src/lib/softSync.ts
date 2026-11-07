/**
 * How a viewer closes a small gap to the room: by playing a little faster or
 * slower, which nobody sees, instead of seeking, which everybody does.
 *
 * Every change of speed can be heard, though. At any speed but 1 the browser
 * stretches the sound to keep its pitch, and it starts and stops doing that
 * with each change. Until 4 November a viewer was nudged whenever it was more
 * than 0.35 s from the room, at a speed worked out again on every heartbeat.
 * The room's heartbeat is always a little old when it arrives, so a viewer in
 * step with the host reads a few tenths of a second ahead. On main on
 * 4 November the two viewers in from the start of the film sat at 0.29 to
 * 0.44 s ahead and went to 0.99 and back to 1 from the first heartbeat on, and
 * a viewer heard the sound go strange on joining.
 *
 * So a nudge starts only well clear of that, keeps one speed for the whole of
 * it, and runs until the gap has closed, not just until it is back under the
 * line. Its speed only changes if the gap grows.
 */

/** Further than this from the room, a nudge starts. */
export const NUDGE_START_S = 0.6;
/** Once nudging, it stops this close to the room. */
export const NUDGE_DONE_S = 0.15;
/** Largest speed change: 8% closes 4 s in under a minute. */
export const MAX_RATE_ADJUST = 0.08;
/** The gap at which the nudge reaches MAX_RATE_ADJUST; past it a seek takes over. */
export const NUDGE_FULL_SCALE_S = 4;
/** Never speed up into a buffer thinner than this: catching up is what drains it. */
export const NUDGE_MIN_BUFFER_S = 6;

/**
 * The speed to play at, `aheadS` ahead of the room (behind it when negative),
 * playing at `rate` now with `bufferAheadS` loaded in front of the playhead.
 * 1 when there's nothing to close, or nothing to catch up into.
 */
export function nudgedRate(aheadS: number, rate: number, bufferAheadS: number): number {
  const gap = Math.abs(aheadS);
  const slowing = aheadS > 0;
  // Already nudging this way: a nudge the other way is a new one.
  const nudging = rate !== 1 && (rate < 1) === slowing;
  if (!(gap > (nudging ? NUDGE_DONE_S : NUDGE_START_S))) return 1;
  if (!slowing && !(bufferAheadS >= NUDGE_MIN_BUFFER_S)) return 1;
  const scale = Math.min(1, gap / NUDGE_FULL_SCALE_S);
  const target = Math.round((1 + (slowing ? -1 : 1) * MAX_RATE_ADJUST * scale) * 1000) / 1000;
  // Held at its speed while the gap closes; stronger only once it has grown.
  if (nudging && Math.abs(target - 1) < Math.abs(rate - 1) + 0.005) return rate;
  return target;
}
