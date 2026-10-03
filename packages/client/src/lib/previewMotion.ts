import type { PreviewDetail } from "./previewFrames";

/**
 * Which preview tier to show, from how fast the cursor is moving along the bar.
 *
 * Speed is in bar-widths per second — how much of the bar the cursor covers in
 * a second — so it behaves the same on a phone and a desktop:
 *
 *   full     below 0.03   slower than about 33s to cross the bar
 *   fine     0.03 – 0.09  about 11s to 33s to cross it
 *   medium   0.09 – 0.15  about 7s to 11s
 *   coarse   0.15 and up  faster than about 7s
 *
 * It is how far the cursor got over the last SPEED_WINDOW_MS, rather than the
 * speed between two pointer events: those arrive unevenly, and pointer
 * positions are whole pixels, so event-to-event speed jumps around enough to
 * flicker between tiers. Net distance also lets a hand's jitter around one spot
 * read as still.
 *
 * Speeding up switches tier at once. Slowing down steps one tier at a time,
 * each only once the speed has read finer for STEP_DOWN_MS: coarse to medium,
 * to fine, to full. A hover starts at coarse and steps down the same way.
 * A pointer that stops sends no more events, so the caller asks again after
 * nextChangeIn, which is when the window or a step-down next moves on.
 */
export const SPEED_WINDOW_MS = 250;
export const STEP_DOWN_MS = 300;
const FULL_MAX_SPEED = 0.03;
const FINE_MAX_SPEED = 0.09;
const MEDIUM_MAX_SPEED = 0.15;

const RANK: Record<PreviewDetail, number> = { full: 0, fine: 1, medium: 2, coarse: 3 };
const FINER: Record<PreviewDetail, PreviewDetail> = { coarse: "medium", medium: "fine", fine: "full", full: "full" };

export function tierForSpeed(barWidthsPerSecond: number): PreviewDetail {
  if (barWidthsPerSecond < FULL_MAX_SPEED) return "full";
  if (barWidthsPerSecond < FINE_MAX_SPEED) return "fine";
  if (barWidthsPerSecond < MEDIUM_MAX_SPEED) return "medium";
  return "coarse";
}

export function createPreviewMotion() {
  // Recent positions, oldest first: those inside the window, plus the last one
  // before it, which is where the cursor was when the window began.
  let samples: Array<{ pct: number; time: number }> = [];
  let tier: PreviewDetail = "coarse";
  // Since when the speed has read finer than `tier`, or null while it doesn't.
  let finerSince: number | null = null;

  const speedAt = (time: number): number => {
    if (samples.length === 0) return 0;
    const windowStart = time - SPEED_WINDOW_MS;
    while (samples.length > 1 && samples[1].time <= windowStart) samples.shift();
    const from = samples[0];
    const to = samples[samples.length - 1];
    return Math.abs(to.pct - from.pct) * 1000 / SPEED_WINDOW_MS;
  };

  const update = (time: number): PreviewDetail => {
    const band = tierForSpeed(speedAt(time));
    if (RANK[band] >= RANK[tier]) {
      tier = band;
      finerSince = null;
      return tier;
    }
    if (finerSince === null) finerSince = time;
    // A late look can be owed more than one step; each still takes its turn.
    while (finerSince !== null && time - finerSince >= STEP_DOWN_MS) {
      tier = FINER[tier];
      finerSince = RANK[band] < RANK[tier] ? finerSince + STEP_DOWN_MS : null;
    }
    return tier;
  };

  return {
    reset() {
      samples = [];
      tier = "coarse";
      finerSince = null;
    },
    /**
     * How long until the tier could change with no more pointer events: the
     * next step down, or the window dropping its oldest position. Null at full,
     * where only movement can change it.
     */
    nextChangeIn(time: number): number | null {
      if (tier === "full") return null;
      let next = Infinity;
      if (finerSince !== null) next = finerSince + STEP_DOWN_MS;
      if (samples.length > 1) next = Math.min(next, samples[1].time + SPEED_WINDOW_MS);
      return next === Infinity ? null : Math.max(0, next - time);
    },
    settle(time: number): PreviewDetail {
      return update(time);
    },
    sample(pct: number, time: number): PreviewDetail {
      samples.push({ pct, time });
      return update(time);
    },
  };
}
