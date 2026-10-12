/**
 * Codecs as the browser names them, in the words Stats for nerds shows.
 */
import { codecFamily, codecName } from "../src/lib/codecName";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

console.log("— audio —");
check("AAC by its object type", ["mp4a.40.2", "mp4a.40.5", "mp4a.40.29"].map(codecName), ["AAC-LC", "HE-AAC", "HE-AAC v2"]);
check("AAC whose type it doesn't know", codecName("mp4a.40.99"), "AAC");
check("the rest by name", ["ac-3", "ec-3", "opus", "flac", "mp4a.69", "mp4a.6B"].map(codecName), ["AC3", "EAC3", "Opus", "FLAC", "MP3", "MP3"]);

console.log("\n— video —");
check("H.264 with profile and level", ["avc1.640028", "avc1.4d401f", "avc1.42e01e", "avc1.64002a"].map(codecName),
  ["H.264 High@L4.0", "H.264 Main@L3.1", "H.264 Baseline@L3.0", "H.264 High@L4.2"]);
check("H.264 without them", codecName("avc1"), "H.264");
check("HEVC with profile and level", ["hvc1.2.4.L120.90", "hev1.1.6.L93.B0", "hvc1.2.4.L153.90"].map(codecName),
  ["HEVC Main 10@L4", "HEVC Main@L3.1", "HEVC Main 10@L5.1"]);
check("AV1 and VP9", ["av01.0.08M.10", "vp09.00.40.08"].map(codecName), ["AV1 Main", "VP9"]);
check("anything else as it is", codecName("theora"), "theora");
check("nothing for nothing", [codecName(null), codecName("")], [null, null]);

console.log("\n— the family alone —");
check("for the one-line summary", ["avc1.640028", "hvc1.2.4.L120.90", "mp4a.40.2", "mp4a.40.5", "ec-3"].map(codecFamily),
  ["H.264", "HEVC", "AAC", "AAC", "EAC3"]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
