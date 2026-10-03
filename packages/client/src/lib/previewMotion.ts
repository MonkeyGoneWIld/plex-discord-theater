/**
 * Which speed tier the cursor is in, from how fast it is moving along the bar.
 * A tier only sets how often the preview picture may change (PREVIEW_GAP_MS in
 * Controls); every tier shows the same frames.
 *
 * Speed is in bar-widths per second — how much of the bar the cursor covers in
 * a second — so it behaves the same on a phone and a desktop:
 *
 *   still     below 0.02    slower than 50s to cross the bar
 *   slow      0.02 – 0.05   20s to 50s to cross it
 *   moderate  0.05 – 0.085  about 12s to 20s
 *   fast      0.085 – 0.17  about 6s to 12s
 *   sweep     0.17 and up   faster than about 6s
 *
 * It is how far the cursor got over the last SPEED_WINDOW_MS, rather than the
 * speed between two pointer events: those arrive unevenly, and pointer
 * positions are whole pixels, so event-to-event speed jumps around enough to
 * flicker between tiers. Net distance also lets a hand's jitter around one spot
 * read as still.
 *
 * Speeding up switches tier at once. Slowing down while still moving steps
 * one tier at a time, each only once the speed has read slower for
 * STEP_DOWN_MS: sweep to fast to moderate to slow. Holding still is different:
 * once the speed has read still for STEP_DOWN_MS it goes straight to still, so
 * the next small move is shown at once. A hover starts at sweep. A pointer
 * that stops sends no more events, so the caller asks again after
 * nextChangeIn, which is when the window or a step next moves on.
 */
export const SPEED_TIERS = ["still", "slow", "moderate", "fast", "sweep"] as const;
export type SpeedTier = typeof SPEED_TIERS[number];

export const SPEED_WINDOW_MS = 250;
export const STEP_DOWN_MS = 300;
/** The top of each tier but the last, in bar-widths per second. */
const TIER_MAX_SPEED = [0.02, 0.05, 0.085, 0.17];

/** A tier's place, slowest first. */
const rank = (tier: SpeedTier) => SPEED_TIERS.indexOf(tier);

export function tierForSpeed(barWidthsPerSecond: number): SpeedTier {
  const i = TIER_MAX_SPEED.findIndex((max) => barWidthsPerSecond < max);
  return SPEED_TIERS[i < 0 ? SPEED_TIERS.length - 1 : i];
}

export function createPreviewMotion() {
  // Recent positions, oldest first: those inside the window, plus the last one
  // before it, which is where the cursor was when the window began.
  let samples: Array<{ pct: number; time: number }> = [];
  let tier: SpeedTier = "sweep";
  // Since when the speed has read slower than `tier`, or null while it doesn't.
  let slowerSince: number | null = null;
  // Since when it has read still while `tier` isn't.
  let stillSince: number | null = null;

  const speedAt = (time: number): number => {
    if (samples.length === 0) return 0;
    const windowStart = time - SPEED_WINDOW_MS;
    while (samples.length > 1 && samples[1].time <= windowStart) samples.shift();
    const from = samples[0];
    const to = samples[samples.length - 1];
    return Math.abs(to.pct - from.pct) * 1000 / SPEED_WINDOW_MS;
  };

  const update = (time: number): SpeedTier => {
    const band = tierForSpeed(speedAt(time));
    if (rank(band) >= rank(tier)) {
      tier = band;
      slowerSince = stillSince = null;
      return tier;
    }
    if (slowerSince === null) slowerSince = time;
    if (band === "still") {
      // Held still: no steps on the way, one change straight to still.
      if (stillSince === null) stillSince = time;
      if (time - stillSince >= STEP_DOWN_MS) {
        tier = "still";
        slowerSince = stillSince = null;
      }
      return tier;
    }
    stillSince = null;
    // A late look can be owed more than one step; each still takes its turn.
    while (slowerSince !== null && time - slowerSince >= STEP_DOWN_MS) {
      tier = SPEED_TIERS[rank(tier) - 1];
      slowerSince = rank(band) < rank(tier) ? slowerSince + STEP_DOWN_MS : null;
    }
    return tier;
  };

  return {
    reset() {
      samples = [];
      tier = "sweep";
      slowerSince = stillSince = null;
    },
    /**
     * How long until the tier could change with no more pointer events: the
     * next step down, the move to still, or the window dropping its oldest
     * position. Null at still, where only movement can change it.
     */
    nextChangeIn(time: number): number | null {
      if (tier === "still") return null;
      let next = Infinity;
      if (stillSince !== null) next = stillSince + STEP_DOWN_MS;
      else if (slowerSince !== null) next = slowerSince + STEP_DOWN_MS;
      if (samples.length > 1) next = Math.min(next, samples[1].time + SPEED_WINDOW_MS);
      return next === Infinity ? null : Math.max(0, next - time);
    },
    settle(time: number): SpeedTier {
      return update(time);
    },
    sample(pct: number, time: number): SpeedTier {
      samples.push({ pct, time });
      return update(time);
    },
  };
}
