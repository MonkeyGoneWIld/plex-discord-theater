/**
 * Which scrub-preview tier the cursor's speed picks.
 *
 * Four bands of speed along the bar, in bar-widths per second: full below
 * 0.025, fine to 0.08, medium to 0.17, coarse above. Speeding up switches at
 * once; slowing down steps one tier per STEP_DOWN_MS, and a hover starts at
 * coarse. Driven here the way a pointer drives it — an event every 16ms, at
 * whole-pixel positions — on a desktop-width and a phone-width bar.
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
check("just under 0.025 is full", tierForSpeed(0.0249), "full");
check("0.025 is fine", tierForSpeed(0.025), "fine");
check("just under 0.08 is fine", tierForSpeed(0.0799), "fine");
check("0.08 is medium", tierForSpeed(0.08), "medium");
check("just under 0.17 is medium", tierForSpeed(0.1699), "medium");
check("0.17 is coarse", tierForSpeed(0.17), "coarse");
check("a flick across the bar is coarse", tierForSpeed(3), "coarse");

// Long enough for a hover's three steps down from coarse.
console.log("a 1300px desktop bar");
check("creeping at 8px/s is full", sweep(1300, 8, 1500).tier, "full");
check("20px/s is full", sweep(1300, 20, 1500).tier, "full");
check("80px/s is fine", sweep(1300, 80, 1500).tier, "fine");
check("150px/s is medium", sweep(1300, 150, 1500).tier, "medium");
check("300px/s is coarse", sweep(1300, 300, 1500).tier, "coarse");
check("a fast sweep is coarse", sweep(1300, 2000, 300).tier, "coarse");

console.log("a 375px phone bar");
check("5px/s is full there", sweep(375, 5, 1500).tier, "full");
check("20px/s is fine there", sweep(375, 20, 1500).tier, "fine");
check("45px/s is medium there", sweep(375, 45, 1500).tier, "medium");
check("100px/s is coarse there", sweep(375, 100, 1500).tier, "coarse");

console.log("starting");
{
  const motion = createPreviewMotion();
  check("a hover starts at coarse", motion.sample(0.5, 0), "coarse");
  check("then steps through medium and fine to full", rest(motion, 0, "coarse"),
    [["medium", STEP_DOWN_MS], ["fine", 2 * STEP_DOWN_MS], ["full", 3 * STEP_DOWN_MS]]);
  motion.reset();
  check("and again after leaving the bar", motion.sample(0.2, 5000), "coarse");
}

console.log("stopping");
{
  const fast = sweep(1300, 2000, 300);
  check("coarse on the last event of a fast sweep", fast.tier, "coarse");
  // The window drops below coarse speed 234ms after the last event, and to
  // still at 250ms; each step down then waits its 300ms in turn.
  check("steps down one tier at a time to full", rest(fast.motion, fast.t, "coarse"),
    [["medium", 534], ["fine", 834], ["full", 1134]]);
  check("and stays there", fast.motion.nextChangeIn(fast.t + 1200), null);
}

console.log("speeding up");
{
  const settled = sweep(1300, 8, 1500);
  check("full while creeping", settled.tier, "full");
  check("a flick is coarse on its first event", settled.motion.sample((settled.px + 100) / 1300, settled.t + 16), "coarse");
  // The window still holds the slower part for a moment, so this is the
  // speed's own lag, not a hold: no step-up delay on top of it.
  const fine = sweep(1300, 80, 1500);
  check("fine to coarse within 100ms of speeding up", sweep(1300, 600, 100, fine.motion, fine).tier, "coarse");
}

console.log("slowing down");
{
  // From a coarse sweep to a medium speed: the window lets go of the fast part
  // within 250ms, and the step then waits another 300ms.
  const slowing = createPreviewMotion();
  const tiers: string[] = [];
  let { px, t, tier } = sweep(1300, 300, 1500, slowing);
  check("coarse before the slowdown", tier, "coarse");
  for (let e = 0; e < 1000; e += 16) {
    t += 16;
    px += 150 * 16 / 1000;
    tiers.push(slowing.sample(Math.round(px) / 1300, t));
  }
  check("coarse to medium, and no further", [...new Set(tiers)], ["coarse", "medium"]);
  check("holding coarse for at least 300ms after slowing", tiers.indexOf("medium") * 16 >= STEP_DOWN_MS, true);
}

console.log("a hand that isn't quite still");
/** Every tier picked, once settled, while jittering `px` either side of one spot on a 1300px bar. */
function jitterTiers(px: number) {
  const motion = createPreviewMotion();
  const tiers = new Set<string>();
  for (let t = 0; t <= 2000; t += 16) {
    const tier = motion.sample((650 + (t % 64 < 32 ? px : -px)) / 1300, t);
    if (t >= 3 * STEP_DOWN_MS + 100) tiers.add(tier);
  }
  return [...tiers].sort();
}
// At most 4px apart within the window: 16px/s, inside full's 32px/s on this bar
// whatever the timing.
check("2px of jitter either side always reads full", jitterTiers(2), ["full"]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
