/**
 * Whether this device's decoder can't keep up with its picture, from the
 * two-second ticks of play Player.tsx takes (pictureCapRef): only then is the
 * room asked for a lighter stream for it, and the device remembers it.
 *
 * Every tick of a run has to drop frames, not the run on average: a decoder
 * that can't keep up drops in every stretch from the first, while a spike —
 * a tab-out, a resize, another program busy for a moment — drops in one and
 * not the next. Four ticks, eight seconds of play, are enough to tell.
 *
 * A tick only says something about the decoder when the page itself painted
 * as often as the film had frames. On 29 October a laptop dropped 37.5% —
 * fifteen frames of every 24 shown — of 10-bit HEVC, 8-bit HEVC, H.264 and
 * AV1 alike, while at other times it played the same streams and other
 * 10-bit HEVC (Airplane II, Punisher S2E5 and S2E6) without dropping any:
 * something held its whole page to 15 frames a second, and a lighter stream
 * changed nothing but the buffering of two restarts. Such a tick, a stall or
 * a frozen picture with next to no frames due, and one taken while anything
 * else could drop frames (Player.tsx: tabbed out, hidden, resized, seeking,
 * a new stream) say nothing either way: they are skipped, and the run goes on
 * from the ticks around them.
 */

/** Seconds of play a tick covers. */
export const DROP_TICK_S = 2;
/** Frames dropped, of those due, in every tick of a run. */
export const DROPPED_SHARE = 0.05;
/** Ticks in a row: eight seconds of play. */
export const DROPPED_TICKS = 4;
/** A run's ticks fall within this many seconds; older ones are let go. */
const RUN_SPAN_S = 20;
/** Fewer frames due than this a second is a picture that isn't moving. */
const MOVING_FPS = 6;
/** Paints, of the frames due, below which the page held the picture back. */
const PAINTED_SHARE = 0.9;

export interface DropTick {
  shown: number;
  dropped: number;
  /** Times the page painted (requestAnimationFrame) over the tick. */
  painted: number;
  /** Seconds of play it covers. */
  seconds: number;
  /** When it was taken, in seconds on any steady clock. */
  at: number;
  /** Nothing but decoding could have dropped its frames. */
  clean: boolean;
}

export type TickVerdict = "dropping" | "smooth" | "skipped";

/** What a tick says of the decoder. */
export function tickVerdict(tick: DropTick): TickVerdict {
  const due = tick.shown + tick.dropped;
  if (!tick.clean || due < MOVING_FPS * tick.seconds || tick.painted < PAINTED_SHARE * due) return "skipped";
  return tick.dropped >= DROPPED_SHARE * due ? "dropping" : "smooth";
}

/** The run of dropping ticks, ending with this one; empty when a smooth one breaks it. */
export function nextDropRun(run: readonly DropTick[], tick: DropTick): DropTick[] {
  const verdict = tickVerdict(tick);
  if (verdict === "smooth") return [];
  const recent = run.filter((t) => tick.at - t.at <= RUN_SPAN_S);
  return verdict === "skipped" ? recent : [...recent, tick].slice(-DROPPED_TICKS);
}

/** Whether a run says this device's decoder can't keep up. */
export const cantKeepUp = (run: readonly DropTick[]) => run.length >= DROPPED_TICKS;

/** Paints a second over a stretch, for the log; null with nothing to go by. */
export function paintRate(painted: number, seconds: number): number | null {
  return seconds > 0 ? Math.round(painted / seconds) : null;
}
