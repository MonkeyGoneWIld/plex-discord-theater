/**
 * Which speed tier the cursor's speed picks.
 *
 * Five bands of speed along the bar, in bar-widths per second: still below
 * 0.02, slow to 0.05, moderate to 0.085, fast to 0.17, sweep above. Speeding
 * up switches at once; slowing down while moving steps one tier per
 * STEP_DOWN_MS; holding still goes straight to still after STEP_DOWN_MS, a
 * single change; and a hover starts at sweep. Driven here the way a pointer
 * drives it — an event every 16ms, at whole-pixel positions — on a
 * desktop-width and a phone-width bar.
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

/** Move at `first` px/s, then at `then` px/s on a 1300px bar; each tier seen during the second part. */
function slowTo(first: number, then: number, ms: number) {
  const motion = createPreviewMotion();
  const tiers: string[] = [];
  let { px, t, tier } = sweep(1300, first, 1500, motion);
  for (let e = 0; e < ms; e += 16) {
    t += 16;
    px += then * 16 / 1000;
    tiers.push(motion.sample(Math.round(px) / 1300, t));
  }
  return { before: tier, tiers };
}

console.log("the bands");
check("standing still is still", tierForSpeed(0), "still");
check("just under 0.02 is still", tierForSpeed(0.0199), "still");
check("0.02 is slow", tierForSpeed(0.02), "slow");
check("just under 0.05 is slow", tierForSpeed(0.0499), "slow");
check("0.05 is moderate", tierForSpeed(0.05), "moderate");
check("just under 0.085 is moderate", tierForSpeed(0.0849), "moderate");
check("0.085 is fast", tierForSpeed(0.085), "fast");
check("just under 0.17 is fast", tierForSpeed(0.1699), "fast");
check("0.17 is sweep", tierForSpeed(0.17), "sweep");
check("a flick across the bar is sweep", tierForSpeed(3), "sweep");

// Long enough for a hover's steps down from sweep.
console.log("a 1300px desktop bar");
check("creeping at 8px/s is still", sweep(1300, 8, 1500).tier, "still");
check("15px/s is still", sweep(1300, 15, 1500).tier, "still");
check("40px/s is slow", sweep(1300, 40, 1500).tier, "slow");
check("85px/s is moderate", sweep(1300, 85, 1500).tier, "moderate");
check("150px/s is fast", sweep(1300, 150, 1500).tier, "fast");
check("300px/s is sweep", sweep(1300, 300, 1500).tier, "sweep");
check("a fast flick is sweep", sweep(1300, 2000, 300).tier, "sweep");

console.log("a 375px phone bar");
check("2px/s is still there", sweep(375, 2, 1500).tier, "still");
check("12px/s is slow there", sweep(375, 12, 1500).tier, "slow");
check("25px/s is moderate there", sweep(375, 25, 1500).tier, "moderate");
check("45px/s is fast there", sweep(375, 45, 1500).tier, "fast");
check("100px/s is sweep there", sweep(375, 100, 1500).tier, "sweep");

console.log("starting");
{
  const motion = createPreviewMotion();
  check("a hover starts at sweep", motion.sample(0.5, 0), "sweep");
  check("held still, it changes once, straight to still", rest(motion, 0, "sweep"), [["still", STEP_DOWN_MS]]);
  motion.reset();
  check("and again after leaving the bar", motion.sample(0.2, 5000), "sweep");
}

console.log("stopping");
{
  const flick = sweep(1300, 2000, 300);
  check("sweep on the last event of a fast flick", flick.tier, "sweep");
  // The window reads still 250ms after the last event; 300ms after that it
  // goes to still, without stopping at any tier on the way.
  check("changes once, straight to still", rest(flick.motion, flick.t, "sweep"), [["still", 550]]);
  check("and stays there", flick.motion.nextChangeIn(flick.t + 600), null);
}

console.log("speeding up");
{
  const creeping = sweep(1300, 8, 1500);
  check("still while creeping", creeping.tier, "still");
  check("a flick is sweep on its first event", creeping.motion.sample((creeping.px + 100) / 1300, creeping.t + 16), "sweep");
  // The window still holds the slower part for a moment, so this is the
  // speed's own lag, not a hold: no step-up delay on top of it.
  const slow = sweep(1300, 40, 1500);
  check("slow to sweep within 100ms of speeding up", sweep(1300, 600, 100, slow.motion, slow).tier, "sweep");
}

console.log("slowing down");
{
  // The window lets go of the faster part within 250ms, and each step then
  // waits its 300ms in turn.
  const toFast = slowTo(300, 150, 1000);
  check("sweep before slowing", toFast.before, "sweep");
  check("sweep to fast, and no further", [...new Set(toFast.tiers)], ["sweep", "fast"]);
  check("holding sweep for at least 300ms after slowing", toFast.tiers.indexOf("fast") * 16 >= STEP_DOWN_MS, true);
  const toSlow = slowTo(300, 40, 1500);
  check("sweep to fast to moderate to slow while moving", [...new Set(toSlow.tiers)], ["sweep", "fast", "moderate", "slow"]);
}

console.log("a hand that isn't quite still");
/** Every tier picked, once settled, while jittering `px` either side of one spot on a 1300px bar. */
function jitterTiers(px: number) {
  const motion = createPreviewMotion();
  const tiers = new Set<string>();
  for (let t = 0; t <= 2000; t += 16) {
    const tier = motion.sample((650 + (t % 64 < 32 ? px : -px)) / 1300, t);
    if (t >= STEP_DOWN_MS + 100) tiers.add(tier);
  }
  return [...tiers].sort();
}
// At most 4px apart within the window: 16px/s, inside still's 26px/s on this bar
// whatever the timing.
check("2px of jitter either side always reads still", jitterTiers(2), ["still"]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
