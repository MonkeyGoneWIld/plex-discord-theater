/**
 * Whether this device can't keep up with decoding its picture, from the
 * ten-second samples of play Player.tsx takes (pictureCapRef): only then is
 * the room asked for a lighter stream for it.
 *
 * Every sample of a run has to drop frames, not the run on average: a laptop
 * that can't decode 10-bit HEVC dropped 12–45% in every sample from the first
 * (23 and 29 October), while a spike — a tab-out, a resize, another program
 * busy for a moment — drops in one sample and not the next. A sample with
 * next to no frames, shown or dropped, is a stall or a frozen picture, not a
 * decoder falling behind: 321 of 3,348 logged samples were, and three of them
 * in a row read as "5% of nothing dropped". A sample taken while anything
 * else could drop frames (Player.tsx: tabbed out, resized, seeking,
 * buffering, a speed or stream change) breaks the run.
 */

/** Frames dropped, of those due, in every sample of a run. */
export const DROPPED_SHARE = 0.05;
/** Samples in a row. */
export const DROPPED_WINDOWS = 3;
/** Fewer frames due than this a second is a picture that isn't moving. */
const MOVING_FPS = 6;

export interface DropSample {
  shown: number;
  dropped: number;
  /** Seconds of play it covers. */
  seconds: number;
  /** Nothing but decoding could have dropped its frames. */
  clean: boolean;
}

/** The run of dropping samples in a row, ending with this one; empty when it breaks the run. */
export function nextDropRun(run: readonly DropSample[], sample: DropSample): DropSample[] {
  const due = sample.shown + sample.dropped;
  if (!sample.clean || due < MOVING_FPS * sample.seconds || sample.dropped < DROPPED_SHARE * due) return [];
  return [...run, sample].slice(-DROPPED_WINDOWS);
}

/** Whether a run says this device can't keep up. */
export const cantKeepUp = (run: readonly DropSample[]) => run.length >= DROPPED_WINDOWS;
