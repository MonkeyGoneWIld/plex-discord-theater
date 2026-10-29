/**
 * When a device's decoder can't keep up with its picture (frameDrops.ts), on
 * what players logged, and when something else dropped the frames: a page
 * held to 15 frames a second, a tab-out, a stall, a spike.
 */
import { cantKeepUp, nextDropRun, tickVerdict, DROP_TICK_S, type DropTick } from "../src/lib/frameDrops";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

interface Spec { pct: number; fps?: number; pageFps?: number; clean?: boolean; due?: number }
/** Ticks of play, one after another: a 24 fps film on a page painting at 60 unless said. */
function ticks(...specs: Spec[]): DropTick[] {
  return specs.map((s, i) => {
    const due = s.due ?? Math.round((s.fps ?? 24) * DROP_TICK_S);
    const dropped = Math.round((due * s.pct) / 100);
    return { shown: due - dropped, dropped, painted: Math.round((s.pageFps ?? 60) * DROP_TICK_S), seconds: DROP_TICK_S, at: (i + 1) * DROP_TICK_S, clean: s.clean ?? true };
  });
}
/** Seconds of play until the player steps down; null if it never does. */
function stepsDownAfter(all: DropTick[]): number | null {
  let run: DropTick[] = [];
  for (const t of all) {
    run = nextDropRun(run, t);
    if (cantKeepUp(run)) return t.at;
  }
  return null;
}
/**
 * The rule before (6266265): ten-second samples, every one of three in a row
 * dropping 5% with a moving picture and nothing else going on — with no
 * thought for how often the page painted.
 */
function stepsDownBefore(all: DropTick[]): boolean {
  let run = 0;
  for (let i = 0; i + 5 <= all.length; i += 5) {
    const five = all.slice(i, i + 5);
    const shown = five.reduce((n, t) => n + t.shown, 0);
    const dropped = five.reduce((n, t) => n + t.dropped, 0);
    const moving = shown + dropped >= 6 * 10;
    run = five.every((t) => t.clean) && moving && dropped >= 0.05 * (shown + dropped) ? run + 1 : 0;
    if (run >= 3) return true;
  }
  return false;
}
const repeat = (n: number, s: Spec) => Array.from({ length: n }, () => s);

console.log("— a decoder that can't keep up —");
check("36% from the first tick, the page painting freely: eight seconds", stepsDownAfter(ticks(...repeat(15, { pct: 36 }))), 8);
check("  and it would have before, after thirty", stepsDownBefore(ticks(...repeat(15, { pct: 36 }))), true);
check("stalling every few seconds with the buffer full, as on 29 October: the stalls skipped, not the run broken",
  stepsDownAfter(ticks({ pct: 36 }, { pct: 40, due: 6 }, { pct: 37 }, { pct: 0, due: 0 }, { pct: 35 }, { pct: 38 })), 12);
check("a seek in the middle, skipped", stepsDownAfter(ticks({ pct: 36 }, { pct: 36 }, { pct: 50, clean: false }, { pct: 36 }, { pct: 36 })), 10);
check("a phone at 8%", stepsDownAfter(ticks(...repeat(8, { pct: 8 }))), 8);
check("a 60 fps film on a 60 Hz screen, a third dropped", stepsDownAfter(ticks(...repeat(6, { pct: 33, fps: 60, pageFps: 59 }))), 8);

console.log("\n— frames dropped for something else —");
check("the page held to 15 frames a second, 37.5% of a 24 fps film dropped (29 October)",
  [stepsDownBefore(ticks(...repeat(15, { pct: 37.5, pageFps: 15 }))), stepsDownAfter(ticks(...repeat(15, { pct: 37.5, pageFps: 15 })))], [true, null]);
check("held to 20, 17% dropped (23 October)",
  [stepsDownBefore(ticks(...repeat(15, { pct: 17, pageFps: 20 }))), stepsDownAfter(ticks(...repeat(15, { pct: 17, pageFps: 20 })))], [true, null]);
check("a 60 fps film on a page held to 30", stepsDownAfter(ticks(...repeat(10, { pct: 50, fps: 60, pageFps: 30 }))), null);
check("a stall: ticks of no frames at all", stepsDownAfter(ticks(...repeat(10, { pct: 0, due: 0 }))), null);
check("a frozen picture, a few frames due", stepsDownAfter(ticks(...repeat(10, { pct: 50, due: 8 }))), null);
check("tabbed out, then one tick at 33% back, then none", stepsDownAfter(ticks({ pct: 40, clean: false }, { pct: 40, clean: false }, { pct: 33 }, { pct: 0 }, { pct: 0 })), null);
check("one spike: 0, 20, 0%", stepsDownAfter(ticks({ pct: 0 }, { pct: 20 }, { pct: 0 }, { pct: 20 }, { pct: 0 })), null);
check("a smooth tick ends the run: 30, 30, 30, 2, 30", stepsDownAfter(ticks({ pct: 30 }, { pct: 30 }, { pct: 30 }, { pct: 2 }, { pct: 30 })), null);
check("dropping ticks too far apart, with nothing between to go by",
  stepsDownAfter(ticks({ pct: 30 }, { pct: 30 }, ...repeat(10, { pct: 0, due: 0 }), { pct: 30 }, { pct: 30 })), null);
check("a desktop through a stream rebuilt under it, under 2%", stepsDownAfter(ticks({ pct: 2 }, { pct: 1 }, { pct: 4 }, { pct: 0 }, { pct: 2 })), null);

console.log("\n— a tick —");
check("what each says", [
  tickVerdict(ticks({ pct: 36 })[0]), tickVerdict(ticks({ pct: 2 })[0]), tickVerdict(ticks({ pct: 37.5, pageFps: 15 })[0]),
  tickVerdict(ticks({ pct: 36, clean: false })[0]), tickVerdict(ticks({ pct: 0, due: 4 })[0]),
], ["dropping", "smooth", "skipped", "skipped", "skipped"]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
