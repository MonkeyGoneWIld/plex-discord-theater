/**
 * What of a player's decoding a stream leans on (lib/codecs.ts capsUsed), from
 * the codec strings hls.js reads out of its segments: what the player gives up
 * when it drops frames on it, or its picture sticks (Player.tsx).
 */
import { capsUsed } from "../src/lib/codecs";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

check("8-bit H.264 with AAC leans on nothing", capsUsed("avc1.640028", "mp4a.40.2"), []);
check("10-bit H.264 (High 10) on hi10", [capsUsed("avc1.6e0028", null), capsUsed("avc3.6E001F", null)], [["hi10"], ["hi10"]]);
check("VP9, in either spelling, on vp9", [capsUsed("vp09.00.40.08", "opus"), capsUsed("vp9", null)], [["vp9", "opus"], ["vp9"]]);
check("AV1 and HEVC as before", [capsUsed("av01.0.08M.10", null), capsUsed("hvc1.2.4.L120.90", "ec-3")], [["av1"], ["hevc", "eac3"]]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
