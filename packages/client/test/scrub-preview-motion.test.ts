/**
 * Which scrub-preview tier the cursor's speed picks.
 *
 * Medium only for now: every speed, standing still included, picks medium.
 * Driven here the way a pointer drives it — an event every 16ms, at
 * whole-pixel positions — on a desktop-width and a phone-width bar.
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
check("standing still is medium", tierForSpeed(0), "medium");
check("0.01 is medium", tierForSpeed(0.01), "medium");
check("0.04 is medium", tierForSpeed(0.04), "medium");
check("a flick across the bar is medium", tierForSpeed(3), "medium");

console.log("a 1300px desktop bar");
check("creeping at 8px/s is medium", sweep(1300, 8, 1000).tier, "medium");
check("30px/s is medium", sweep(1300, 30, 1000).tier, "medium");
check("a fast sweep is medium", sweep(1300, 2000, 300).tier, "medium");

console.log("a 375px phone bar");
check("2px/s is medium there", sweep(375, 2, 1000).tier, "medium");
check("30px/s is medium there", sweep(375, 30, 1000).tier, "medium");

console.log("stopping");
const fast = sweep(1300, 2000, 300);
check("medium on the last event of a sweep", fast.tier, "medium");
check("asks again once the window has passed", fast.motion.settleDelay(fast.t), SPEED_WINDOW_MS);
check("still medium once still for the whole window", fast.motion.settle(fast.t + SPEED_WINDOW_MS), "medium");
check("and long after", fast.motion.settle(fast.t + 10_000), "medium");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
