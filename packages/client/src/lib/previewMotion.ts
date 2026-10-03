import type { PreviewDetail } from "./previewFrames";

/**
 * Which preview tier to show, from how fast the cursor is moving along the bar.
 *
 * Speed is in bar-widths per second — how much of the bar the cursor covers in
 * a second — so it behaves the same on a phone and a desktop:
 *
 *   full     below 0.01   slower than 100s to cross the bar
 *   medium   0.01 – 0.04  25s to 100s to cross it
 *   coarse   0.04 and up  faster than 25s
 *
 * It is how far the cursor got over the last SPEED_WINDOW_MS, rather than the
 * speed between two pointer events: those arrive unevenly, and pointer
 * positions are whole pixels, so event-to-event speed jumps around enough to
 * flicker between tiers. Net distance also lets a hand's jitter around one spot
 * read as still. A pointer that stops sends no more events, so the caller asks
 * again once the window has passed (settleDelay) and the speed reads 0.
 */
export const SPEED_WINDOW_MS = 250;
const FULL_MAX_SPEED = 0.01;
const MEDIUM_MAX_SPEED = 0.04;

export function tierForSpeed(barWidthsPerSecond: number): PreviewDetail {
  if (barWidthsPerSecond < FULL_MAX_SPEED) return "full";
  if (barWidthsPerSecond < MEDIUM_MAX_SPEED) return "medium";
  return "coarse";
}

export function createPreviewMotion() {
  // Recent positions, oldest first: those inside the window, plus the last one
  // before it, which is where the cursor was when the window began.
  let samples: Array<{ pct: number; time: number }> = [];
  const speedAt = (time: number): number => {
    if (samples.length === 0) return 0;
    const windowStart = time - SPEED_WINDOW_MS;
    while (samples.length > 1 && samples[1].time <= windowStart) samples.shift();
    const from = samples[0];
    const to = samples[samples.length - 1];
    return Math.abs(to.pct - from.pct) * 1000 / SPEED_WINDOW_MS;
  };
  return {
    reset() { samples = []; },
    /** Time until a pointer that has stopped has been still for the whole window. */
    settleDelay(time: number): number {
      const last = samples[samples.length - 1];
      return last ? Math.max(0, last.time + SPEED_WINDOW_MS - time) : 0;
    },
    settle(time: number): PreviewDetail {
      return tierForSpeed(speedAt(time));
    },
    sample(pct: number, time: number): PreviewDetail {
      samples.push({ pct, time });
      return tierForSpeed(speedAt(time));
    },
  };
}
