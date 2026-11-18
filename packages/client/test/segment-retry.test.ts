/**
 * A segment that won't load (lib/segmentRetry.ts).
 *
 * 15 November: Verity's segment 1765, near the end, failed to load. The
 * player asked again five times, two minutes apart, every try the same
 * ("fatal error (HLS)" each time), then took the failure for the blank tail
 * of a stream and ended the film four minutes early.
 */
import { fragLoadFailure, freshUrl, mayEndAtBreak, waitsToPlay } from "../src/lib/segmentRetry";
import { noteRefused, refusedStatus } from "../src/lib/segmentParts";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

console.log("\n— Verity, segment 1765 —");
check("its first fatal failure: asked for again", fragLoadFailure("fragLoadError", 1765, null), { fragLoad: true, failedAgain: false });
check("  the same one failing again: the stream is rebuilt, not asked a sixth time",
  fragLoadFailure("fragLoadError", 1765, 1765), { fragLoad: true, failedAgain: true });
check("  a timeout is the same", fragLoadFailure("fragLoadTimeOut", 1765, 1765), { fragLoad: true, failedAgain: true });
check("another segment, or not a segment, is not again",
  [fragLoadFailure("fragLoadError", 1766, 1765), fragLoadFailure("levelLoadError", 1765, 1765), fragLoadFailure("fragLoadError", undefined, 1765)],
  [{ fragLoad: true, failedAgain: false }, { fragLoad: false, failedAgain: false }, { fragLoad: true, failedAgain: false }]);
check("not the end of the title while a rebuild is left; once none is, or for another error, it may be",
  [mayEndAtBreak(true, true), mayEndAtBreak(true, false), mayEndAtBreak(false, true), mayEndAtBreak(false, false)],
  [false, true, true, true]);

// 18 November: the segment after 7002.5 s never came, with no error; the host
// sat paused "holding for the room" and the wedge watchdog never looked.
console.log("\n— Verity, 7002.5 s —");
check("a host paused only while the room waits for its picture is waiting to play; paused on purpose is not",
  [waitsToPlay(true, true), waitsToPlay(false, false), waitsToPlay(true, false)], [true, true, false]);
noteRefused("/hls/S1/seg/142.ts?n=9", 502, 1_000);
check("a refused segment's status, for the log: by its address, or the latest just now under another",
  [refusedStatus("/hls/S1/seg/142.ts?n=9", 60_000), refusedStatus("/hls/S1/seg/142.ts?fresh=1", 2_500), refusedStatus("/x.ts", 9_000)],
  [502, 502, undefined]);

console.log("\n— asked for again past every cache —");
check("an address of its own, keeping what it had",
  [freshUrl("https://bot.example/hls/S1/seg/1765.ts?n=3#part", 2), freshUrl("/hls/S1/seg/1765.ts", 1), freshUrl("/a.ts#x", 4)],
  ["https://bot.example/hls/S1/seg/1765.ts?n=3&fresh=2#part", "/hls/S1/seg/1765.ts?fresh=1", "/a.ts?fresh=4#x"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
