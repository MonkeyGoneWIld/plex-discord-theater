/**
 * When a device can't keep up with decoding its picture (frameDrops.ts), on
 * the ten-second samples players logged, and when something else dropped the
 * frames: a tab-out, a stall, a spike.
 */
import { cantKeepUp, nextDropRun, DROPPED_SHARE, DROPPED_WINDOWS, type DropSample } from "../src/lib/frameDrops";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

/** Ten seconds of a 24 fps film with this share dropped. */
const at = (pct: number, clean = true, due = 240): DropSample => {
  const dropped = Math.round((due * pct) / 100);
  return { shown: due - dropped, dropped, seconds: 10, clean };
};
/** Whether the samples, in order, ever put the player on a lighter stream. */
function stepsDown(samples: DropSample[]): boolean {
  let run: DropSample[] = [];
  for (const s of samples) {
    run = nextDropRun(run, s);
    if (cantKeepUp(run)) return true;
  }
  return false;
}
/** The rule before: the last three samples taken, dropping 5% between them — tabbed out or not, unless hidden. */
function stepsDownBefore(samples: DropSample[]): boolean {
  const run: DropSample[] = [];
  for (const s of samples) {
    run.push(s);
    if (run.length > DROPPED_WINDOWS) run.shift();
    const shown = run.reduce((n, w) => n + w.shown, 0);
    const dropped = run.reduce((n, w) => n + w.dropped, 0);
    if (run.length === DROPPED_WINDOWS && dropped >= DROPPED_SHARE * (shown + dropped)) return true;
  }
  return false;
}
const both = (samples: DropSample[]) => [stepsDownBefore(samples), stepsDown(samples)];

console.log("— a device that can't keep up, as logged —");
check("a laptop on 10-bit HEVC, 23 and 29 October: 36, 41, 45%", both([at(36), at(41), at(45)]), [true, true]);
check("another, 17, 17, 15%", both([at(17), at(17), at(15)]), [true, true]);
check("a third, 19, 20, 19%, after a quiet start", both([at(1), at(19), at(20), at(19)]), [true, true]);
check("a laptop at 6, 8, 9%: still a stutter", both([at(6), at(8), at(9)]), [true, true]);
check("on a 60 fps film", both([at(30, true, 600), at(30, true, 600), at(30, true, 600)]), [true, true]);

console.log("\n— frames dropped for something else —");
check("a stall: three samples of no frames at all", both([at(0, true, 0), at(0, true, 0), at(0, true, 0)]), [true, false]);
check("a frozen picture, a few frames due", both([at(50, true, 20), at(50, true, 20), at(50, true, 20)]), [true, false]);
check("back from a tab-out: one sample at 33%, then none", both([at(33), at(0), at(0)]), [true, false]);
check("one spike mid-run: 0, 20, 0%", both([at(0), at(20), at(0)]), [true, false]);
check("5% on average, not every sample: 14, 0, 1%", both([at(14), at(0), at(1)]), [true, false]);
check("three dropping samples, one taken while tabbed out, still on screen", both([at(30), at(30, false), at(30)]), [true, false]);
check("dropping again after the break: three clean ones in a row", stepsDown([at(30), at(30, false), at(30), at(30), at(30)]), true);
check("a desktop through a stream rebuilt under it, under 2%", both([at(2), at(1), at(2), at(0)]), [false, false]);

console.log("\n— the run —");
{
  const run = nextDropRun(nextDropRun([], at(20)), at(20));
  check("two dropping samples aren't enough", [run.length, cantKeepUp(run)], [2, false]);
  check("a quiet sample ends it", nextDropRun(run, at(4)), []);
  check("it keeps the last three", nextDropRun(nextDropRun(run, at(20)), at(30)).map((s) => s.dropped), [48, 48, 72]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
