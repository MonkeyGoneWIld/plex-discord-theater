/**
 * What the upload budget is told one viewer of a stream downloads
 * (services/stream-bandwidth.ts): one figure for the stream, its target or,
 * with none, the average of its first half minute.
 */
import { streamBandwidth } from "../src/services/stream-bandwidth.js";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

console.log("\n— one figure for a stream, for the upload budget —");
{
  // 300 s in 5 s segments: 8000 kbps to 100 s, 2000 kbps to 220 s, 500 kbps to
  // the end. A figure that followed the film would change three times.
  const kbpsAt = (s: number) => (s < 100 ? 8000 : s < 220 ? 2000 : 500);
  const run = Array.from({ length: 60 }, (_, i) => ({ start: i * 5, end: i * 5 + 5, bytes: (kbpsAt(i * 5) * 1000 / 8) * 5 }));
  const withTarget = { targetKbps: 3000, averageKbps: null, segments: run.slice(0, 2) };
  check("its target, from the first moment", streamBandwidth(withTarget), { kbps: 3000, source: "target" });
  withTarget.segments = run;
  check("  and still, whatever has come in since", streamBandwidth(withTarget), { kbps: 3000, source: "target" });

  const s = { targetKbps: null, averageKbps: null as number | null, segments: run.slice(0, 5) };
  check("with no target, nothing until half a minute is in hand", streamBandwidth(s), null);
  s.segments = run.slice(0, 6);
  check("  then the average of that", streamBandwidth(s), { kbps: 8000, source: "measured" });
  s.segments = run;
  check("  kept from then on, through the quieter rest of the film", streamBandwidth(s), { kbps: 8000, source: "measured" });
  check("  worked out once", s.averageKbps, 8000);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
