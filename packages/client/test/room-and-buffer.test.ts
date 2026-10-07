/**
 * Following the host, and the buffer a viewer is shown.
 *
 * - Nobody is shown the same seconds twice: a follower ahead of the room waits
 *   for it, and only a seek sends anybody back (lib/roomWait).
 * - The buffer counts what the P2P engine holds past the browser's own
 *   (lib/bufferAhead).
 * - The loading screen says what it is waiting for (lib/loadingMessage).
 * - The room's clock stands still while the host's picture does
 *   (roomPositionNow).
 */
import { MAX_WAIT_FOR_ROOM_S, resumeAheadAt, roomWaitOutcome, settleForward, waitsForRoom } from "../src/lib/roomWait";
import { coveredAheadS, heldRanges } from "../src/lib/bufferAhead";
import { arrivingKbps, loadingMessage, type LoadingFacts } from "../src/lib/loadingMessage";
import { roomPositionNow } from "../src/hooks/useSync";

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
const held = new Map<string, readonly [number, number]>([["a", [10, 20]], ["b", [190, 200]], ["c", [200, 210]]]);
check("the engine's long-passed segments are let go", heldRanges(held, 200).length, 2);
check("and dropped from what is tracked", [...held.keys()], ["b", "c"]);

console.log("\n— the room stands still while the host's picture does —");
const t = Date.now() - 4000;
check("a running room runs", Math.round(roomPositionNow({ position: 100, playing: true, positionAt: t })), 104);
check("a room waiting for the host doesn't",
  roomPositionNow({ position: 100, playing: true, positionAt: t, hostWaiting: true }), 100);
check("nor does a paused one", roomPositionNow({ position: 100, playing: false, positionAt: t }), 100);

console.log("\n— the loading screen says what it is waiting for —");
const facts = (f: Partial<LoadingFacts>): LoadingFacts => ({
  phase: "stalled", waitingForHost: null, forS: 0, downloadKbps: null, streamKbps: null, failing: false, copied: false, ...f,
});
check("holding for the host names them", loadingMessage(facts({ waitingForHost: "monkey26" })).title, "Waiting for monkey26…");
check("and after a while says why",
  loadingMessage(facts({ waitingForHost: "monkey26", forS: 6 })).detail, "Everyone starts together once their video is ready");
check("starting a copy", loadingMessage(facts({ phase: "starting", forS: 6, copied: true })),
  { title: "Starting the stream…", detail: "Plex is reading the file" });
check("starting, slowly", loadingMessage(facts({ phase: "starting", forS: 20 })).detail,
  "Plex is taking longer than usual to start this one");
check("a connection slower than the video says so",
  loadingMessage(facts({ forS: 5, downloadKbps: 21400, streamKbps: 30660 })),
  { title: "Buffering…", detail: "Your connection is bringing in 21 Mbps; this video needs about 31 Mbps" });
check("one that keeps up says how fast it is going",
  loadingMessage(facts({ phase: "first-frames", forS: 5, downloadKbps: 46000, streamKbps: 30660 })).detail,
  "Downloading at 46 Mbps");
check("nothing arriving at the start", loadingMessage(facts({ phase: "first-frames", forS: 9 })).detail,
  "Waiting for the server to send the first part");
check("failing downloads say so", loadingMessage(facts({ failing: true })).detail,
  "Having trouble reaching the server — retrying");
check("the first moments say only what is happening", loadingMessage(facts({ forS: 1, downloadKbps: 100, streamKbps: 30000 })).detail, null);

console.log("\n— what is arriving —");
const samples: Array<[number, number]> = [[0, 1_000_000], [5_000, 2_000_000], [9_000, 1_000_000]];
check("over the last eight seconds", arrivingKbps(samples, 10_000), 3000);
check("old downloads drop out", samples.length, 2);
check("nothing arriving is unmeasured", arrivingKbps([], 10_000), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
