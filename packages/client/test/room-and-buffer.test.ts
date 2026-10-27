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
 * - A follower going past the room doesn't land on the last sliver of a
 *   segment (lib/roomWait landingFor).
 * - A seek in front of a stream's first picture goes to it, and one waiting
 *   for its segment waits (lib/copyStart pictureAfterSeek).
 */
import { KEYFRAME_INTO_S, LAND_INTO_SEGMENT_S, MAX_KEYFRAME_WAIT_S, MAX_SEEK_LEAD_S, MAX_WAIT_FOR_ROOM_S, SEEK_LEAD_UNKNOWN_S, cameFromCache, catchUpLeadS, keyframeLanding, landingBySize, landingBytesPerS, landingFor, recentSeeksMs, recentSegmentBytesPerS, recentSegmentMs, rememberSeekMs, rememberSegmentMs, resumeAheadAt, roomWaitOutcome, seekLeadS, seekTimed, seeksSlow, settleForward, waitsForRoom } from "../src/lib/roomWait";
import { coveredAheadS, forgetEvicted, heldRanges, type HeldSegment } from "../src/lib/bufferAhead";
import { arrivingKbps, loadingTitle } from "../src/lib/loadingMessage";
import { safeBackCutS } from "../src/lib/bufferTrim";
import { roomPositionNow } from "../src/hooks/useSync";
import { enoughToStart, nextSegmentInS, pictureAfterSeek, pictureStartFor } from "../src/lib/copyStart";
import { AFTER_STOPS_S, MAX_EXTRA_WAIT_S, MAX_READY_CUSHION_AFTER_STOPS_S, MAX_READY_CUSHION_S, afterStopsS, comingInBytesPerS, lateByS, readiness } from "../src/lib/readyCushion";

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

console.log("\n— a follower behind the room goes past it to wait —");
// May on 12 October: the viewer's last segment took 5.6s, and the room was
// nine seconds on, in a segment it hadn't got.
check("as far as its last segment took, half as long again and a second", catchUpLeadS(5600), 9.4);
check("at least three seconds", catchUpLeadS(400), 3);
check("at most twenty", catchUpLeadS(30_000), 20);
check("six with nothing to go on", [catchUpLeadS(null), catchUpLeadS(0)], [6, 6]);
check("and no further than a follower waits for the room", catchUpLeadS(30_000) <= MAX_WAIT_FOR_ROOM_S, true);

console.log("\n— a follower going past the room lands where its segment has picture to play —");
{
  const at = (t: number) => Math.round(t * 1000) / 1000;
  // The test page's host back from a pop-out: four-second segments, and it
  // landed 0.82s from the end of one.
  const copy4 = [{ start: 20.139, duration: 3.925 }, { start: 24.064, duration: 3.925 }, { start: 27.989, duration: 4.011 }, { start: 32, duration: 4 }];
  check("0.82s from the end of a four-second segment: the start of the next",
    at(landingFor(27.167, copy4, Infinity)), at(27.989 + LAND_INTO_SEGMENT_S));
  check("half of it left: where it was going", landingFor(26, copy4, Infinity), 26);
  // monkey26's on 12 October: seg 185 ran 569.03–589.44, and it landed at 576.01.
  const long = [{ start: 569.03, duration: 20.41 }, { start: 589.44, duration: 2.5 }];
  check("thirteen seconds of a twenty-second segment left: where it was going", landingFor(576.01, long, Infinity), 576.01);
  check("two and a half of it left: the next", at(landingFor(586.94, long, Infinity)), at(589.44 + LAND_INTO_SEGMENT_S));
  const short = [{ start: 10, duration: 1 }, { start: 11, duration: 1 }, { start: 12, duration: 1 }];
  check("one-second segments: only the last half second of one is a sliver", at(landingFor(10.6, short, Infinity)), at(11 + LAND_INTO_SEGMENT_S));
  check("and more than that isn't", landingFor(10.4, short, Infinity), 10.4);
  check("not past the limit", landingFor(27.167, copy4, 28), 27.167);
  check("in the last segment: where it was going", landingFor(35, copy4, Infinity), 35);
  check("outside the segments: where it was going", landingFor(50, copy4, Infinity), 50);
  check("no segments yet: where it was going", [landingFor(27.167, null, Infinity), landingFor(27.167, [], Infinity)], [27.167, 27.167]);
}

console.log("\n— and far enough past it for what it lands in to come first —");
{
  const MB = 1_000_000;
  const at = (t: number) => Math.round(t * 100) / 100;
  // blah0391 back from a pop-out on 13 October: 3.7 s past the room, in seg
  // 906 — 26.21 MB, 2721.4 to 2732.3 — its last page's segments coming at
  // about 26 Mbps.
  const segs = [{ start: 2715, duration: 6.4, bytes: 8 * MB }, { start: 2721.4, duration: 10.9, bytes: 26.21 * MB },
    { start: 2732.3, duration: 3, bytes: 3 * MB }, { start: 2735.3, duration: 4, bytes: 20 * MB }];
  const bps = 26e6 / 8;
  const landS = landingBySize(2725.08, 2721.38, segs, bps, 2721.38 + 25);
  check(`26 MB at 26 Mbps would come after the room got there: it lands past it, at the start of the next (${at(landS - 2721.38)}s past the room)`,
    at(landS), at(2732.3 + LAND_INTO_SEGMENT_S));
  check("a fast connection: just past the room, not as far as the guess",
    at(landingBySize(2725.08, 2721.38, segs, 100 * MB, Infinity)), at(2721.38 + 26.21 / 80 + 1));
  // The viewer on Avengers on 17 October: its first segment took 16 s at about
  // 9 Mbps, the room was at 15.35, and the guess sent it 20 s past — 35.35.
  const avengers = [{ start: 0.08, duration: 11.65, bytes: 18.03 * MB }, { start: 11.73, duration: 10.35, bytes: 22.15 * MB },
    { start: 22.08, duration: 11.32, bytes: 16.84 * MB }, { start: 33.4, duration: 8.52, bytes: 10.51 * MB },
    { start: 41.92, duration: 10.3, bytes: 9.64 * MB }, { start: 52.22, duration: 10, bytes: 5.45 * MB }];
  check("by the sizes, the start of the first segment that can be in before the room gets to it, short of the guess",
    at(landingBySize(15.35 + 20, 15.35, avengers, 9e6 / 8, 15.35 + 25)), at(33.4 + LAND_INTO_SEGMENT_S));
  // A heavy segment just after the one it would land in is needed when the
  // room gets to it, wherever before it the landing is: it lands beyond it.
  const heavy = [{ start: 100, duration: 4, bytes: 2 * MB }, { start: 104, duration: 4, bytes: 30 * MB }, { start: 108, duration: 30, bytes: 3 * MB }];
  check("a heavy segment just after: it lands beyond that, at the start of the next",
    at(landingBySize(101, 99, heavy, 4 * MB, 99 + 25)), at(108 + LAND_INTO_SEGMENT_S));
  // A heavy one it lands in: further into it, for it to be in by then.
  const long = [{ start: 0, duration: 20, bytes: 10 * MB }, { start: 20, duration: 4, bytes: 1 * MB }];
  check("a heavy segment it lands in: further into it, in by the time the room gets there",
    at(landingBySize(3, 0, long, 1 * MB, 25)), at(10 / 0.8 + 1));
  check("never past the limit", landingBySize(2725.08, 2721.38, segs, 1 * MB, 2721.38 + 10), 2721.38 + 10);
  check("no speed, no size: where it was going",
    [landingBySize(2725.08, 2721.38, segs, null, Infinity), landingBySize(2725.08, 2721.38, [{ start: 2721.4, duration: 10.9, bytes: null }], bps, Infinity), landingBySize(2725.08, 2721.38, null, bps, Infinity)],
    [2725.08, 2725.08, 2725.08]);
  // blah0391 back from a pop-out on 14 October: its next 30 to 40 seconds in
  // the browser's cache, and it landed 10.7 s past the room all the same.
  const cached = segs.map((s) => ({ ...s, cached: true }));
  check("what it lands in, and after, out of the browser's cache: a second past the room",
    at(landingBySize(2721.38, 2721.38, cached, bps, 2721.38 + 25)), at(2721.38 + 1));
  check("so with no speed to go by",
    at(landingBySize(2721.38, 2721.38, cached, null, 2721.38 + 25)), at(2721.38 + 1));
  // Cached up to the heavy one, which is fetched from the bot: far enough past
  // the room for that to come in time, whatever else is cached.
  const partly = segs.map((s, i) => (i < 1 ? { ...s, cached: true } : s));
  check("cached only up to a heavy one still to come: past that, as before",
    at(landingBySize(2716, 2716, partly, bps, 2716 + 25)), at(2732.3 + LAND_INTO_SEGMENT_S));
  check("and with no speed to say it will come in time, not landed on the cached one",
    landingBySize(2716, 2716, partly, null, 2716 + 25) > 2716 + 1, true);
}

console.log("\n— a landing goes by the fastest recent segment, not a slow start —");
{
  const MB = 1_000_000;
  const now = 1_000_000;
  // The viewer on 20176 skipped to 45:23 on 21 October: 7.21 MB in 3.0 s,
  // 2.12 in 1.0, 4.34 in 3.5 and 2.87 in 5.0 — about 8 Mbps over the last ten
  // seconds — then 5.75 MB in 2.6 s once it had landed.
  const skipped = [{ at: now - 11_000, bytes: 7.21 * MB, ms: 3_000 }, { at: now - 10_000, bytes: 2.12 * MB, ms: 1_000 },
    { at: now - 7_000, bytes: 4.34 * MB, ms: 3_500 }, { at: now - 5_000, bytes: 2.87 * MB, ms: 5_000 }];
  const windowBps = 1 * MB;
  check("the fastest segment of the last minute, over a slow last few seconds",
    Math.round(landingBytesPerS(windowBps, skipped, now)! / 1000), Math.round(7.21 * MB / 3 / 1000));
  check("the window, when that is faster", landingBytesPerS(9 * MB, skipped, now), 9 * MB);
  check("the window on a second go", landingBytesPerS(windowBps, skipped, now, true), windowBps);
  check("not a segment under a megabyte, whose time is mostly asking for it",
    landingBytesPerS(windowBps, [{ at: now - 1_000, bytes: 0.4 * MB, ms: 100 }], now), windowBps);
  check("not one over a minute old", landingBytesPerS(windowBps, [{ at: now - 61_000, bytes: 8 * MB, ms: 1_000 }], now), windowBps);
  check("nothing to go by: nothing", landingBytesPerS(null, [], now), null);
  // What it does to the landing on that skip: segments of about 5.5 MB every
  // four seconds from the room on.
  const ahead = Array.from({ length: 10 }, (_, i) => ({ start: 2733 + i * 4, duration: 4, bytes: 5.5 * MB }));
  const before = landingBySize(2733.47 + 20, 2733.47, ahead, windowBps, 2733.47 + 25) - 2733.47;
  const after = landingBySize(2733.47 + 20, 2733.47, ahead, landingBytesPerS(windowBps, skipped, now), 2733.47 + 25) - 2733.47;
  check(`it lands ${after.toFixed(1)}s past the room, not ${before.toFixed(1)}`, after < 6, true);
}

console.log("\n— a segment out of the browser's cache says nothing of the connection —");
check("4.7 MB in 10 ms came out of the cache", cameFromCache(4_730_000, 10), true);
check("3 MB in a tenth of a second did too", cameFromCache(3_010_000, 100), true);
check("28 MB in 8.5 s came over the connection", cameFromCache(28_130_000, 8500), false);
check("as did 25.7 MB at 48 Mbps", cameFromCache(25_740_000, 4200), false);
check("nothing in no time is nothing", cameFromCache(0, 0), false);

console.log("\n— the last segment's time, kept across a reload —");
{
  const kept = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v),
    removeItem: (k: string) => void kept.delete(k), clear: () => kept.clear(), key: () => null, length: 0,
  } as Storage;
  check("nothing kept, nothing known", recentSegmentMs(), null);
  rememberSegmentMs(5600, 1_000_000);
  check("the page after a pop-out knows how long its last segment took", recentSegmentMs(1_000_000 + 4_000), 5600);
  check("and leads the room by enough for one like it", catchUpLeadS(recentSegmentMs(1_000_000 + 4_000)), 9.4);
  check("but not after ten minutes: the connection may have changed", recentSegmentMs(1_000_000 + 11 * 60_000), null);
  check("no speed kept with it, none known", recentSegmentBytesPerS(1_000_000 + 4_000), null);
  rememberSegmentMs(5600, 2_000_000, 3_250_000);
  check("and with the speed segments came at, that too", [recentSegmentMs(2_000_000 + 4_000), recentSegmentBytesPerS(2_000_000 + 4_000)], [5600, 3_250_000]);
  check("for ten minutes", recentSegmentBytesPerS(2_000_000 + 11 * 60_000), null);

  // A catch-up aims past the room by what this device's seeks take.
  check("a device that hasn't seeked to picture it had goes to where the room is", [seekLeadS(recentSeeksMs()), SEEK_LEAD_UNKNOWN_S], [0, 0]);
  // blah0391 on 23 October: three seconds to seek into what it had, then two.
  let seeks = rememberSeekMs(recentSeeksMs(), 3_030);
  seeks = rememberSeekMs(seeks, 1_950);
  check("one whose seeks took 3 s and 2 s aims 3 s past it", seekLeadS(seeks), 3.03);
  check("and the next page knows it", recentSeeksMs(), [3030, 1950]);
  seeks = rememberSeekMs(rememberSeekMs(rememberSeekMs(seeks, 200), 150), 220);
  check("three quick ones since, and it aims by them", [seeks, seekLeadS(seeks)], [[200, 150, 220], 0.22]);
  check("no further than a decoder ever takes", seekLeadS([13_830]), MAX_SEEK_LEAD_S);
  kept.set("pdt:seekMs", "not json");
  check("nothing readable kept, nothing known", recentSeeksMs(), []);

  // A device that decodes slowly lands on a keyframe instead.
  check("quick seeks aren't slow", seeksSlow([200, 150, 220]), false);
  check("one of a second or more in the last few is", seeksSlow([3_030, 200, 150]), true);
  check("and so is one still under way that long", seeksSlow([200], 3_200), true);
  check("but not once three since have been quick", seeksSlow([3_030, 200, 150, 220]), false);
  // The Punisher S2E4 on 24 October: 5.6 s segments, the room at 5:40.99 after
  // a skip to 5:36.51, the picture in at 5:36.51.
  const punisher = [{ start: 330.9, duration: 5.6 }, { start: 336.5, duration: 5.6 }, { start: 342.1, duration: 5.6 }, { start: 347.7, duration: 5.6 }];
  check("the room 4.5 s into a segment: just into the next, 1.4 s past it", keyframeLanding(340.99, punisher), 342.1 + KEYFRAME_INTO_S);
  check("the room just before a segment's start: that one", keyframeLanding(342.0, punisher), 342.1 + KEYFRAME_INTO_S);
  check("the room just past a segment's start, before the landing: that one still", keyframeLanding(342.2, punisher), 342.1 + KEYFRAME_INTO_S);
  check("past the landing: the next", keyframeLanding(342.4, punisher), 347.7 + KEYFRAME_INTO_S);
  check("no segment after the room: none", keyframeLanding(350, punisher), null);
  check("none starting within the wait: none", keyframeLanding(10, [{ start: 0, duration: 20 }, { start: 20, duration: 20 }]), null);
  check("a gap isn't landed on", keyframeLanding(340.99, [{ ...punisher[2], gap: true }, punisher[3]]), 347.7 + KEYFRAME_INTO_S);
  check("no segments known: none", keyframeLanding(340.99, null), null);
  check("a seek a second into its segment is timed", seekTimed(1.0), true);
  check("one onto a keyframe isn't, nor washes out the slow ones", seekTimed(KEYFRAME_INTO_S), false);
  check("one whose segment isn't known is", seekTimed(null), true);
  check("the longest wait is a long segment", MAX_KEYFRAME_WAIT_S, 8);
}

console.log("\n— picture enough in hand to go —");
{
  const MB = 1_000_000;
  /** Four-second segments from `fromS`, sizes in MB. */
  const segs = (fromS: number, mb: number[]) => mb.map((m, i) => ({ start: fromS + 4 * i, duration: 4, bytes: m * MB }));
  const base = { nowS: 100, leftS: 3600, bytesPerFilmS: null, stops: 0, fallbackS: 6, skip: false, waitedS: 0 };
  // A film of 10 Mbps, coming in at 40.
  const fast = readiness({ ...base, heldToS: 103.5, upcoming: segs(103.5, Array(14).fill(5)), bytesPerS: 5 * MB });
  check("well ahead of the film, three seconds in hand is enough, as it always was", [fast.ready, fast.why], [true, "the next minute comes in time"]);
  // blah0391 back from a pop-out on 13 October: 3.02 s in hand, segments coming
  // at about 28 Mbps, and one of 23 MB eleven seconds on.
  const back = readiness({ ...base, nowS: 1870.68, heldToS: 1873.7, upcoming: segs(1873.7, [4.95, 7, 23.36, 3.7, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6]), bytesPerS: 3.5 * MB });
  check("with a heavy stretch coming that won't be in in time, it waits", [back.ready, back.why], [false, "the next minute won't come in time"]);
  check("and says by how much it would have been late", back.lateS !== null && back.lateS > 1, true);
  const backLater = readiness({ ...base, nowS: 1870.68, heldToS: 1886.2, upcoming: segs(1886.2, Array(11).fill(6)), bytesPerS: 3.5 * MB });
  check("once that stretch is in, it goes", backLater.ready, true);
  const backWaited = readiness({ ...base, nowS: 1870.68, heldToS: 1876.2, upcoming: segs(1876.2, [7, 23.36, 3.7, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6]), bytesPerS: 1.4 * MB, waitedS: MAX_EXTRA_WAIT_S });
  check("but a connection that won't catch the film up isn't waited on for ever", [backWaited.ready, backWaited.why], [true, "waited long enough for more"]);
  check("a skip well ahead of the film goes with three seconds in hand, as it always has",
    readiness({ ...base, heldToS: 103.5, upcoming: segs(103.5, Array(14).fill(5)), bytesPerS: 5 * MB, skip: true }).ready, true);
  // monkey26 skipping 113522, a 20 Mbps copy, on 23 October: 3.55 s in hand,
  // segments of 10 to 16 MB coming at 15 to 17 Mbps. It went, and stopped ten
  // seconds later.
  const skipped = readiness({ ...base, heldToS: 103.55, upcoming: segs(103.55, [13, 16, 10, 12, 14, 13, 12, 13, 14, 12, 13, 12, 13, 14]), bytesPerS: 2 * MB, skip: true });
  check("a skip with the next minute not coming in time waits as a start does", [skipped.ready, skipped.why], [false, "the next minute won't come in time"]);
  check("up to the same eight seconds in hand",
    readiness({ ...base, heldToS: 100 + MAX_READY_CUSHION_S, upcoming: segs(108, Array(13).fill(13)), bytesPerS: 2 * MB, skip: true }).ready, true);
  check("having stopped lately: a stop's wait is for starting again after it, not for a skip",
    readiness({ ...base, heldToS: 103.5, upcoming: segs(103.5, Array(14).fill(5)), bytesPerS: 50 * MB, stops: 2, skip: true }).ready, true);
  check("after a stop, with what the stops ask for in hand, it waits for the next minute as a start does, for a while",
    [readiness({ ...base, heldToS: 108, upcoming: segs(108, Array(13).fill(30)), bytesPerS: 1 * MB, stops: 1 }).ready,
      readiness({ ...base, heldToS: 108, upcoming: segs(108, Array(13).fill(30)), bytesPerS: 1 * MB, stops: 1, waitedS: MAX_EXTRA_WAIT_S }).ready],
    [false, true]);
  check("having stopped once lately, not with less than eight seconds, however fast things come",
    readiness({ ...base, heldToS: 105, upcoming: segs(105, Array(14).fill(5)), bytesPerS: 50 * MB, stops: 1 }).ready, false);
  check("eight is enough then", readiness({ ...base, heldToS: 108, upcoming: segs(108, Array(13).fill(5)), bytesPerS: 50 * MB, stops: 1 }).ready, true);
  check("more each time it has stopped", [afterStopsS(0), afterStopsS(1), afterStopsS(2), afterStopsS(3), afterStopsS(7)], [0, ...AFTER_STOPS_S, AFTER_STOPS_S[2]]);
  const slow = readiness({ ...base, heldToS: 100 + MAX_READY_CUSHION_S, upcoming: segs(130, Array(8).fill(30)), bytesPerS: 1 * MB });
  check("with eight seconds in hand it goes, whatever is coming", [slow.ready, slow.why], [true, "enough in hand"]);
  // monkey26 starting a title on 14 October: its first segments came at
  // 3 Mbps, then at 17 to 32 once it was playing; it went after waiting its
  // longest with 7.5 s, and never stopped.
  const firstSegments = segs(108.1, Array(13).fill(6.5));
  check("a start with eight seconds in hand goes, whatever its first segments' speed says of the next minute",
    [readiness({ ...base, heldToS: 108.1, upcoming: firstSegments, bytesPerS: 0.41 * MB }).ready,
      readiness({ ...base, heldToS: 106, upcoming: segs(106, Array(14).fill(6.5)), bytesPerS: 0.41 * MB }).ready],
    [true, false]);
  check("but having stopped lately it holds out for the next minute as it did, up to twenty",
    [readiness({ ...base, heldToS: 112, upcoming: segs(112, Array(12).fill(30)), bytesPerS: 1 * MB, stops: 1 }).ready,
      readiness({ ...base, heldToS: 100 + MAX_READY_CUSHION_AFTER_STOPS_S, upcoming: segs(120, Array(10).fill(30)), bytesPerS: 1 * MB, stops: 1 }).ready],
    [false, true]);
  check("but not after stopping three times lately: then it holds out for more",
    [readiness({ ...base, heldToS: 100 + MAX_READY_CUSHION_S, upcoming: segs(120, Array(10).fill(30)), bytesPerS: 1 * MB, stops: 3 }).ready,
      readiness({ ...base, heldToS: 100 + AFTER_STOPS_S[2], upcoming: segs(125, Array(9).fill(30)), bytesPerS: 1 * MB, stops: 3 }).ready],
    [false, true]);
  check("near the end of the film, what is left is enough",
    readiness({ ...base, heldToS: 102, leftS: 2, upcoming: [], bytesPerS: 1 * MB, stops: 2 }).ready, true);
  check("never with less than three seconds in hand",
    readiness({ ...base, heldToS: 101, upcoming: [], bytesPerS: 50 * MB }).why, "short of the least in hand");
  check("with no speed to go by, what the last segment's time says (catchUpLeadS)",
    [readiness({ ...base, heldToS: 104, upcoming: segs(104, [5]), bytesPerS: null }).ready, readiness({ ...base, heldToS: 106.1, upcoming: segs(106.1, [5]), bytesPerS: null }).ready],
    [false, true]);
  check("a segment whose size isn't given is taken at what the held ones weigh",
    lateByS(100, [{ start: 103, duration: 4, bytes: null }], 1 * MB, 1.5 * MB), 3);
  check("with neither, no telling", lateByS(100, [{ start: 103, duration: 4, bytes: null }], 1 * MB, null), null);
  check("nothing coming is never late", lateByS(100, [], 1 * MB, null), 0);
  // The download meter: [when, bytes, ms with something in flight].
  check("the speed while anything comes in, over the last ten seconds",
    comingInBytesPerS([[0, 0, 0], [5_000, 10 * MB, 4_000], [20_000, 20 * MB, 6_000], [25_000, 30 * MB, 8_000]], 25_000), 5 * MB);
  check("over everything, with too little in the last ten seconds",
    comingInBytesPerS([[0, 0, 0], [5_000, 10 * MB, 4_000], [20_000, 11 * MB, 4_500], [25_000, 12 * MB, 5_000]], 25_000), 2.4 * MB);
  check("nothing to go by yet", [comingInBytesPerS([], 0), comingInBytesPerS([[0, 0, 0], [500, 1 * MB, 400]], 500)], [null, null]);
  // Punisher S2E5 on 24 October: its first segment, 0.25 MB, in 1.3 s.
  const tiny = comingInBytesPerS([[0, 0, 0], [1_300, 0.26 * MB, 1_300]], 1_300);
  check("a small segment's time isn't a speed: it is mostly the request's way there and back", tiny, null);
  check("  so the start goes by what is in hand, as with nothing to go by",
    readiness({ ...base, nowS: 0, heldToS: 4.9, leftS: 3000, upcoming: segs(4.9, Array(6).fill(10)), bytesPerS: tiny, fallbackS: 3 }).ready, true);
}

console.log("\n— a seek in front of a stream's first picture —");
{
  // monkey26 on 18 October: the copy's first segment from its keyframe at
  // 5913.95, its sound — and so its picture — from 5914.98; gaps before it,
  // as the bot lists a copy.
  const copy = [{ start: 0, duration: 5913.95, gap: true }, { start: 5913.95, duration: 4.05 }, { start: 5918, duration: 4 }];
  check("goes to where the picture starts", pictureAfterSeek(5914.9, [[5914.98, 6035]], copy, 10), 5914.98);
  check("in the buffer, it finishes on its own", pictureAfterSeek(5915.2, [[5914.98, 6035]], copy, 10), null);
  check("its segment not in yet, it waits for it", pictureAfterSeek(5914.9, [[5918, 6035]], copy, 10), null);
  check("past an earlier range too", pictureAfterSeek(5914.9, [[5800, 5850], [5914.98, 6035]], copy, 10), 5914.98);
  check("nothing buffered, nothing to go to", pictureAfterSeek(5914.9, [], copy, 10), null);
  check("in a later segment whose start the browser let go of, it waits for it again",
    pictureAfterSeek(5919, [[5920.5, 6035]], copy, 10), null);
  check("before the stream starts, nothing", pictureAfterSeek(5900, [[5914.98, 6035]], copy, 10), null);
  check("further on than a hole is ever jumped, it waits",
    pictureAfterSeek(100, [[111, 130]], [{ start: 98, duration: 20 }], 10), null);
  check("without the playlist, nothing", pictureAfterSeek(10, [[10.5, 20]], null, 10), null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
