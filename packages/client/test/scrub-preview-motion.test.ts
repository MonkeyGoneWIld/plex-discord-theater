/**
 * Which scrub-preview tier the cursor's speed picks.
 *
 * Three bands of speed along the bar, in bar-widths per second, and nothing
 * else: full below 0.04, medium to 0.16, coarse above. Driven here the way a
 * pointer drives it — an event every 16ms, at whole-pixel positions — on a
 * desktop-width and a phone-width bar.
 */
import { createPreviewMotion, tierForSpeed, SPEED_WINDOW_MS } from "../src/lib/previewMotion";

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

console.log("the bands");
check("standing still is full", tierForSpeed(0), "full");
check("just under 0.04 is full", tierForSpeed(0.0399), "full");
check("0.04 is medium", tierForSpeed(0.04), "medium");
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

console.log("stopping");
const fast = sweep(1300, 2000, 300);
check("still coarse on the last event of a sweep", fast.tier, "coarse");
check("asks again once the window has passed", fast.motion.settleDelay(fast.t), SPEED_WINDOW_MS);
check("not full before then", fast.motion.settle(fast.t + SPEED_WINDOW_MS - 50), "coarse");
check("full once still for the whole window", fast.motion.settle(fast.t + SPEED_WINDOW_MS), "full");

console.log("a hand that isn't quite still");
/** Every tier picked while jittering `px` either side of one spot on a 1300px bar. */
function jitterTiers(px: number) {
  const motion = createPreviewMotion();
  const tiers = new Set<string>();
  for (let t = 0; t <= 2000; t += 16) {
    const tier = motion.sample((650 + (t % 64 < 32 ? px : -px)) / 1300, t);
    if (t >= SPEED_WINDOW_MS) tiers.add(tier);
  }
  return [...tiers].sort();
}
// At most 4px apart within the window: 16px/s, inside full's 52px/s on this bar
// whatever the timing.
check("2px of jitter either side always reads full", jitterTiers(2), ["full"]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
