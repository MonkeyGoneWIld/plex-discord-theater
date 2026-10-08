/**
 * Following the host, and the buffer a viewer is shown.
 *
 * - Nobody is shown the same seconds twice: a follower ahead of the room waits
 *   for it, and only a seek sends anybody back (lib/roomWait).
 * - The buffer counts what the P2P engine holds past the browser's own
 *   (lib/bufferAhead).
 * - The loading screen says only "Loading…" or "Buffering…" (lib/loadingMessage).
 * - A cut behind the playhead never reaches the picture (lib/bufferTrim).
 * - The room's clock stands still while the host's picture does
 *   (roomPositionNow).
 * - A copy started together starts on its keyframe when its first segment
 *   ends too soon after the start point to start on (lib/copyStart).
 */
import { MAX_WAIT_FOR_ROOM_S, resumeAheadAt, roomWaitOutcome, settleForward, waitsForRoom } from "../src/lib/roomWait";
import { coveredAheadS, forgetEvicted, heldRanges, type HeldSegment } from "../src/lib/bufferAhead";
import { arrivingKbps, loadingTitle } from "../src/lib/loadingMessage";
import { safeBackCutS } from "../src/lib/bufferTrim";
import { roomPositionNow } from "../src/hooks/useSync";
import { enoughToStart, nextSegmentInS, pictureStartFor } from "../src/lib/copyStart";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

console.log("\n— a follower ahead of the room waits for it —");
check("a few seconds ahead waits", waitsForRoom(9.2), true);
check("behind never waits", waitsForRoom(-3), false);
check("level doesn't wait", waitsForRoom(0), false);
check("too far ahead to be a freeze follows the room", waitsForRoom(MAX_WAIT_FOR_ROOM_S + 1), false);
check("waiting while the room is still behind", roomWaitOutcome(1117.7, 1108.6, 0.35), "wait");
check("plays when the room arrives", roomWaitOutcome(1117.7, 1117.4, 0.35), "play");
check("plays when the room has passed it", roomWaitOutcome(1117.7, 1119, 0.35), "play");
check("follows a room that has gone far behind", roomWaitOutcome(1200, 1100, 0.35), "follow");

console.log("\n— a rebuilt stream starts where the follower was, not behind it —");
const now = { ratingKey: "1", roomRatingKey: "1", roomS: 1100, streamStartS: 1095, toleranceS: 0.75, seekedBackS: 2 };
check("ahead of the room: back where it was", resumeAheadAt({ ratingKey: "1", atS: 1108, roomAtS: 1099 }, now), 1108);
check("nothing carried: the room's clock", resumeAheadAt(null, now), null);
check("another title: the room's clock", resumeAheadAt({ ratingKey: "2", atS: 1108, roomAtS: 1099 }, now), null);
check("the room sent back since — a seek: the room's clock",
  resumeAheadAt({ ratingKey: "1", atS: 1108, roomAtS: 1300 }, now), null);
check("barely ahead: not worth a jump", resumeAheadAt({ ratingKey: "1", atS: 1100.5, roomAtS: 1099 }, now), null);
check("before the new stream's first segment: the room's clock",
  resumeAheadAt({ ratingKey: "1", atS: 1108, roomAtS: 1099 }, { ...now, streamStartS: 1110 }), null);
check("far ahead: the room's clock",
  resumeAheadAt({ ratingKey: "1", atS: 1100 + MAX_WAIT_FOR_ROOM_S + 5, roomAtS: 1099 }, now), null);

console.log("\n— settling onto the room after joining goes forward only —");
check("behind the room: forward to it", settleForward(100, 20, 103, 0.75), 103);
check("no further than buffered", settleForward(100, 2, 110, 0.75), 101.5);
check("ahead of the room: stays put", settleForward(105, 20, 100, 0.75), null);
check("close enough: stays put", settleForward(100, 20, 100.5, 0.75), null);

console.log("\n— the buffer is what the browser holds and what the engine holds after it —");
check("the browser's buffer alone", coveredAheadS(100, [[90, 140]]), 40);
check("carried on through the engine's segments", coveredAheadS(100, [[90, 140], [140, 150], [150, 220]]), 120);
check("a gap ends it", coveredAheadS(100, [[90, 140], [150, 220]]), 40);
check("segment edges a hair apart still join", coveredAheadS(100, [[90, 140], [140.3, 160]]), 60);
check("out of order and overlapping", coveredAheadS(100, [[150, 220], [95, 130], [120, 152]]), 120);
check("nothing at the playhead is nothing", coveredAheadS(100, [[105, 200]]), 0);
const held = new Map<string, HeldSegment>([["a", [10, 20, 100]], ["b", [190, 200, 100]], ["c", [200, 210, 100]], ["d", [220, 230, 100]]]);
forgetEvicted(held, 205, 400);
check("what the engine holds, within its memory, is all kept", heldRanges(held).length, 4);
forgetEvicted(held, 205, 250);
check("over it, the earliest watched goes first", [...held.keys()], ["c", "d"]);
forgetEvicted(held, 205, 50);
check("but never what the playhead hasn't passed", [...held.keys()], ["c", "d"]);

console.log("\n— the room stands still while it waits —");
const t = Date.now() - 4000;
check("a running room runs", Math.round(roomPositionNow({ position: 100, playing: true, positionAt: t })), 104);
check("a waiting room doesn't",
  roomPositionNow({ position: 100, playing: true, positionAt: t, hostWaiting: true }), 100);
check("nor does a paused one", roomPositionNow({ position: 100, playing: false, positionAt: t }), 100);

console.log("\n— the loading screen says loading or buffering, and nothing else —");
check("before the picture has moved", loadingTitle(false), "Loading…");
check("once it has", loadingTitle(true), "Buffering…");

console.log("\n— a cut behind the playhead stops short of the segment before it —");
// Pressure, 04:50:08: playing at 393.63 in a segment that ran 387.4–396.65,
// keyframes only at segment starts. A cut to 388.63 was carried on to 396.65,
// took the picture with it, and the picture froze three seconds later.
const frags = [
  { start: 369.37, duration: 9.2 },
  { start: 378.57, duration: 8.83 },
  { start: 387.4, duration: 9.25 },
  { start: 396.65, duration: 6.1 },
];
check("stops at the start of the segment before the one playing", safeBackCutS(frags, 393.63, 388.63), 378.57);
check("further back is cut as asked", safeBackCutS(frags, 393.63, 371), 371);
check("just into the next segment, the one before is the limit", safeBackCutS(frags, 396.7, 395.7), 387.4);
check("in the first segment, nothing behind can go", safeBackCutS(frags, 372, 371), null);
check("in the second, up to the first", safeBackCutS(frags, 380, 379), 369.37);
check("without segments, nothing", safeBackCutS(null, 393, 390), null);

console.log("\n— what is arriving —");
const samples: Array<[number, number]> = [[0, 1_000_000], [5_000, 2_000_000], [9_000, 1_000_000]];
check("over the last eight seconds", arrivingKbps(samples, 10_000), 3000);
check("old downloads drop out", samples.length, 2);
check("nothing arriving is unmeasured", arrivingKbps([], 10_000), null);

console.log("\n— a copy started together starts on its keyframe —");
// From the night of 8 October: a start point, and the first segment it fell in.
check("0.58s from the end of a 3.9s first segment: its keyframe",
  pictureStartFor(910.25, { start: 906.91, end: 910.83 }), 906.91);
check("0.77s from the end of a 3.1s one", pictureStartFor(1414.86, { start: 1412.49, end: 1415.63 }), 1412.49);
check("a three-second keyframe interval is enough", pictureStartFor(1443.17, { start: 1441.44, end: 1444.42 }), 1441.44);
check("with enough ahead already, where it was asked", pictureStartFor(2915, { start: 2910.06, end: 2919.02 }), 2915);
check("a first segment too short to start on either: where it was asked",
  pictureStartFor(100.33, { start: 100, end: 102.31 }), 100.33);
check("too far back from where it was asked: where it was asked",
  pictureStartFor(68, { start: 60, end: 70 }), 68);
check("outside the segment: where it was asked", pictureStartFor(50, { start: 60, end: 70 }), 50);
check("nothing in: where it was asked", pictureStartFor(50, null), 50);
// The host's first segment came at these speeds, and the next is this big.
check("the next segment in two seconds: the keyframe",
  pictureStartFor(910.25, { start: 906.91, end: 910.83 }, nextSegmentInS(2.6e6, 21e6)), 906.91);
check("the next one 23 MB, the first at 27 Mbps: where it was asked, waiting for the next",
  pictureStartFor(1414.86, { start: 1412.49, end: 1415.63 }, nextSegmentInS(23.35e6, 27.4e6)), 1414.86);
check("no speed to go on: where it was asked", pictureStartFor(910.25, { start: 906.91, end: 910.83 }, nextSegmentInS(2.6e6, 0)), 910.25);
check("three seconds ahead is enough to start on", enoughToStart(3), true);
check("and 2.98", enoughToStart(2.98), true);
check("but not two", enoughToStart(2), false);
check("at the end of the film, what is left is enough", enoughToStart(1, 1), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
