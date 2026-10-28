/**
 * What the upload budget is told one viewer of a stream downloads
 * (services/stream-bandwidth.ts): one figure for the stream, its target or,
 * with none, the average of its first half minute.
 */
import { START_KBPS, START_S, streamBandwidth } from "../src/services/stream-bandwidth.js";

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

console.log("\n— while it starts —");
{
  // The 'Burbs on 28 October: a 1.9 Mbps AV1 copy, whose figure the manager
  // reserved 5.2 Mbps for — and left its start that, ×1.2.
  const startedAt = 1_000_000;
  const copy = { targetKbps: 5203, averageKbps: null, segments: [], startedAt };
  check("a quiet copy, as it starts: START_KBPS", streamBandwidth(copy, startedAt + 1000), { kbps: START_KBPS, source: "target" });
  check("  to the end of its start", streamBandwidth(copy, startedAt + START_S * 1000 - 1), { kbps: START_KBPS, source: "target" });
  check("  then its own figure, once", streamBandwidth(copy, startedAt + START_S * 1000), { kbps: 5203, source: "target" });
  const big = { targetKbps: 48_000, averageKbps: null, segments: [], startedAt };
  check("a figure above it stays its own", streamBandwidth(big, startedAt + 1000), { kbps: 48_000, source: "target" });
  const unknown = { targetKbps: null, averageKbps: null, segments: [], startedAt };
  check("nothing to give is still nothing", streamBandwidth(unknown, startedAt + 1000), null);
  const untimed = { targetKbps: 5203, averageKbps: null, segments: [] };
  check("with no start known, its own figure", streamBandwidth(untimed, startedAt + 1000), { kbps: 5203, source: "target" });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
