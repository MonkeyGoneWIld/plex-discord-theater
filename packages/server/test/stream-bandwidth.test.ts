/**
 * What the upload budget is told one viewer of a stream downloads
 * (services/stream-bandwidth.ts): the segments in hand from the room's
 * position to two minutes past it, or the stream's target with too few.
 */
import { measureBandwidth } from "../src/services/stream-bandwidth.js";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

console.log("\n— how much of a stream is measured, for the upload budget —");
{
  // 300 s in 5 s segments: a loud prologue at 8000 kbps to 100 s, 2000 kbps to
  // 220 s, 500 kbps to the end — the whole of it 3600. Every stretch says
  // something different, so a window in the wrong place shows.
  const kbpsAt = (s: number) => (s < 100 ? 8000 : s < 220 ? 2000 : 500);
  const run = Array.from({ length: 60 }, (_, i) => ({ start: i * 5, end: i * 5 + 5, bytes: (kbpsAt(i * 5) * 1000 / 8) * 5 }));
  const upTo = (s: number) => run.filter((seg) => seg.end <= s);
  check("a room at 100 s is measured from there to 120 s on: not from the start (7000), past it (1400) or behind it too (4727)",
    measureBandwidth(run, 100, 3000), { kbps: 2000, source: "measured" });
  check("  and at the start, from the start: the prologue's, mostly",
    measureBandwidth(run, 0, 3000), { kbps: 7000, source: "measured" });
  check("  the segment playing at the room's position counted whole, the one before it not",
    measureBandwidth(run, 98, 3000), { kbps: 2240, source: "measured" });
  check("30 s in hand past the room is a measure", measureBandwidth(upTo(130), 100, 3000), { kbps: 2000, source: "measured" });
  check("  25 s is none: the target is given instead", measureBandwidth(upTo(125), 100, 3000), { kbps: 3000, source: "target" });
  check("  and nothing, with no target either", measureBandwidth(upTo(125), 100, null), null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
