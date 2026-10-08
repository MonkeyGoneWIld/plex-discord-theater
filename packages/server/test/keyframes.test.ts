/**
 * Telling a film whose keyframes are all IDR frames from an open-GOP one,
 * which is re-encoded rather than copied (services/keyframes.ts): from the
 * start of its Matroska file, and from a copied segment.
 */
import { matroskaKeyframes } from "../src/services/keyframes.js";
import { firstKeyframe } from "../src/services/ts-timestamps.js";
import { isISlice } from "../src/services/h264.js";
import { NAL, matroska, tsSegment } from "./mkv-fixture.js";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

console.log("— a slice's type —");
check("an I-slice is one", isISlice(Uint8Array.from(NAL.i)), true);
check("a P-slice isn't", isISlice(Uint8Array.from(NAL.p)), false);
check("nor is a slice too short to say", isISlice(Uint8Array.from([0x21])), false);

console.log("\n— the start of a Matroska file —");
check("keyframes all IDR",
  matroskaKeyframes(matroska(["idr", "p", "p", "idr", "p", "idr", "p"])), "idr");
check("an open GOP: a plain I-frame as the second keyframe",
  matroskaKeyframes(matroska(["idr", "p", "p", "i", "p", "i"])), "not-idr");
check("P-frames a muxer marked as keyframes aren't taken for I-frames",
  matroskaKeyframes(matroska(["idr", "p-key", "p-key", "idr", "p-key", "idr"])), "idr");
check("two IDR keyframes are too few to say",
  matroskaKeyframes(matroska(["idr", "p", "idr", "p"])), "unknown");
check("the same in BlockGroups",
  matroskaKeyframes(matroska(["idr", "p", "i", "p"], { groups: true })), "not-idr");
check("and with the sizes of a file still being written",
  matroskaKeyframes(matroska(["idr", "p", "i", "p"], { unknownSizes: true })), "not-idr");
const whole = matroska(["idr", "p", "idr", "p", "i"]);
check("cut off before its plain I-frame, it can't say",
  matroskaKeyframes(whole.subarray(0, whole.length - 6)), "unknown");
check("anything that isn't Matroska is unknown",
  matroskaKeyframes(Buffer.from("not a matroska file at all")), "unknown");
check("as is an empty one", matroskaKeyframes(new Uint8Array()), "unknown");

console.log("\n— a copied segment —");
check("opening on an IDR frame", firstKeyframe(tsSegment("idr")), "idr");
check("opening on a plain I-frame", firstKeyframe(tsSegment("i")), "not-idr");
check("without an access unit delimiter it can't tell H.264 from anything else",
  firstKeyframe(tsSegment("i", false)), null);
check("nor from what isn't MPEG-TS", firstKeyframe(Buffer.from("not a transport stream")), null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
