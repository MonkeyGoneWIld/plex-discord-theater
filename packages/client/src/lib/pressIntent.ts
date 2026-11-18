/**
 * What the play button shows after somebody who runs the room presses it:
 * what they pressed, until their player has done it and the room's replies
 * have settled. One press is then one change of the button, not the several a
 * round trip through the server can make. A room state the server sent before
 * the press reached it plays a co-host's picture again for a moment: on
 * 18 November at 10:12:13 UTC a co-host's pause was followed 120 ms later by
 * "following room into play" and 150 ms after that by "following room into
 * pause", and the button showed pause, play, pause.
 */

/** A press is shown for at least this long, so a stale reply inside it does not show. */
export const INTENT_SETTLE_MS = 1500;
/** And no longer than this: a press the room did not take gives way to what the player is doing. */
export const INTENT_MAX_MS = 8000;

export interface PressIntent {
  /** Play pressed (true) or pause (false). */
  playing: boolean;
  at: number;
}

/** Whether a press still decides the button: until the player agrees with it after the settle time, and never past the limit. */
export function intentHolds(intent: PressIntent | null, elementPlaying: boolean, now: number): boolean {
  if (!intent) return false;
  const age = now - intent.at;
  if (age < 0 || age >= INTENT_MAX_MS) return false;
  return !(age >= INTENT_SETTLE_MS && elementPlaying === intent.playing);
}

/** How long until a held press should be looked at again: at the settle time, then at the limit. */
export function intentRecheckMs(intent: PressIntent, now: number): number {
  const age = now - intent.at;
  return Math.max(0, (age < INTENT_SETTLE_MS ? INTENT_SETTLE_MS : INTENT_MAX_MS) - age);
}

/** What the button shows: the press while it holds, else whether the player plays (or is held for the room). */
export function shownPlaying(intent: PressIntent | null, elementPlaying: boolean, held: boolean, now: number): boolean {
  return intentHolds(intent, elementPlaying, now) ? intent!.playing : elementPlaying || held;
}
