/**
 * Which scrub-preview tier the cursor's speed picks.
 *
 * Three bands of speed along the bar, in bar-widths per second: full below
 * 0.035, medium to 0.16, coarse above. Speeding up switches at once; slowing
 * down steps one tier per STEP_DOWN_MS, and a hover starts at coarse. Driven
 * here the way a pointer drives it — an event every 16ms, at whole-pixel
 * positions — on a desktop-width and a phone-width bar.
 */
import { createPreviewMotion, tierForSpeed, STEP_DOWN_MS } from "../src/lib/previewMotion";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

/** Move along a `width`-pixel bar at `pxPerS` for `ms`; the tier after the last event. */
function sweep(width: number, pxPerS: number, ms: number, motion = createPreviewMotion(), from = { px: width / 2, t: 0 }) {
  let tier = motion.sample(Math.round(from.px) / width, from.t);
  let { px, t } = from;
  for (let e = 0; e < ms; e += 16) {
    t += 16;
    px += pxPerS * 16 / 1000;
    tier = motion.sample(Math.round(px) / width, t);
  }
  return { tier, motion, px, t };
}

/**
 * Leave the pointer where it is and look again whenever the motion says to,
 * as the player's timer does: each tier change, and how long after `from`.
 */
function rest(motion: ReturnType<typeof createPreviewMotion>, from: number, tier: string) {
  const changes: Array<[string, number]> = [];
  let t = from;
  for (let delay = motion.nextChangeIn(t); delay !== null && changes.length < 10; delay = motion.nextChangeIn(t)) {
    t += delay;
    const next = motion.settle(t);
    if (next !== tier) changes.push([next, t - from]);
    tier = next;
  }
  return changes;
}

console.log("the bands");
check("standing still is full", tierForSpeed(0), "full");
check("just under 0.035 is full", tierForSpeed(0.0349), "full");
check("0.035 is medium", tierForSpeed(0.035), "medium");
check("just under 0.16 is medium", tierForSpeed(0.1599), "medium");
check("0.16 is coarse", tierForSpeed(0.16), "coarse");
check("a flick across the bar is coarse", tierForSpeed(3), "coarse");

console.log("a 1300px desktop bar");
check("creeping at 8px/s is full", sweep(1300, 8, 1000).tier, "full");
check("30px/s is full", sweep(1300, 30, 1000).tier, "full");
check("120px/s is medium", sweep(1300, 120, 1000).tier, "medium");
check("180px/s is medium", sweep(1300, 180, 1000).tier, "medium");
check("400px/s is coarse", sweep(1300, 400, 1000).tier, "coarse");
check("a fast sweep is coarse", sweep(1300, 2000, 300).tier, "coarse");

console.log("a 375px phone bar");
check("5px/s is full there", sweep(375, 5, 1000).tier, "full");
check("30px/s is medium there", sweep(375, 30, 1000).tier, "medium");
check("40px/s is medium there", sweep(375, 40, 1000).tier, "medium");
check("100px/s is coarse there", sweep(375, 100, 1000).tier, "coarse");

console.log("starting");
{
  const motion = createPreviewMotion();
  check("a hover starts at coarse", motion.sample(0.5, 0), "coarse");
  check("then steps to medium, then full", rest(motion, 0, "coarse"), [["medium", STEP_DOWN_MS], ["full", 2 * STEP_DOWN_MS]]);
  motion.reset();
  check("and again after leaving the bar", motion.sample(0.2, 5000), "coarse");
}

console.log("stopping");
{
  const fast = sweep(1300, 2000, 300);
  check("coarse on the last event of a fast sweep", fast.tier, "coarse");
  // The window drops below coarse speed 234ms after the last event, and to
  // still at 250ms; each step down then waits its 150ms in turn.
  check("steps down through medium to full", rest(fast.motion, fast.t, "coarse"), [["medium", 384], ["full", 534]]);
  check("and stays there", fast.motion.nextChangeIn(fast.t + 600), null);
}

console.log("speeding up");
{
  const settled = sweep(1300, 8, 1000);
  check("full while creeping", settled.tier, "full");
  check("a flick is coarse on its first event", settled.motion.sample((settled.px + 100) / 1300, settled.t + 16), "coarse");
  // The window still holds the slower part for a moment, so this is the
  // speed's own lag, not a hold: no step-up delay on top of it.
  const medium = sweep(1300, 120, 1000);
  check("medium to coarse within 100ms of speeding up", sweep(1300, 600, 100, medium.motion, medium).tier, "coarse");
}

console.log("slowing down");
{
  // From a coarse sweep to a medium speed: the window lets go of the fast part
  // within 250ms, and the step then waits another 150ms.
  const slowing = createPreviewMotion();
  const tiers: string[] = [];
  let { px, t, tier } = sweep(1300, 400, 1000, slowing);
  check("coarse before the slowdown", tier, "coarse");
  for (let e = 0; e < 600; e += 16) {
    t += 16;
    px += 120 * 16 / 1000;
    tiers.push(slowing.sample(Math.round(px) / 1300, t));
  }
  check("coarse to medium, never straight to full", [...new Set(tiers)], ["coarse", "medium"]);
  check("holding coarse for at least 150ms after the speed drops", tiers.indexOf("medium") * 16 >= STEP_DOWN_MS, true);
}

console.log("a hand that isn't quite still");
/** Every tier picked, once settled, while jittering `px` either side of one spot on a 1300px bar. */
function jitterTiers(px: number) {
  const motion = createPreviewMotion();
  const tiers = new Set<string>();
  for (let t = 0; t <= 2000; t += 16) {
    const tier = motion.sample((650 + (t % 64 < 32 ? px : -px)) / 1300, t);
    if (t >= 400) tiers.add(tier);
  }
  return [...tiers].sort();
}
// At most 4px apart within the window: 16px/s, inside full's 45px/s on this bar
// whatever the timing.
check("2px of jitter either side always reads full", jitterTiers(2), ["full"]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
