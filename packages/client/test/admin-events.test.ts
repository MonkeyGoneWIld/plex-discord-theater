/**
 * A session's events on the dashboard, as said (admin/events.ts).
 *
 * 17 November: everyone joining "switched" to the stream they started on;
 * everyone moved with the host's change of audio and nothing said it was
 * the host's; "Playback held for 4.0 s until every viewer was ready", when
 * the room waits only for the host; a player loading the start was
 * "buffering"; tracks were numbers; and the oldest came first.
 */
import { eventText, eventTone, groupOf, newestFirst, positionAt, streamDiff, trackName, unionParts, variantParts } from "../admin/events";
import type { PlayEvent, TrackPoint } from "../admin/types";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

let id = 0;
const ev = (kind: string, detail: Record<string, unknown> | null, username: string | null = "robin", at = 0): PlayEvent =>
  ({ id: ++id, at, kind, userId: "222", username, posS: null, detail }) as PlayEvent;
const ctx = {
  tracks: { 1: "English (AAC Stereo)", 2: "Japanese (AC3 5.1)", 3: "English (SRT)" },
  streams: [{ variantKey: "1:0" }, { variantKey: "1:3" }, { variantKey: "2:0" }],
};

console.log("\n— a viewer's stream —");
check("joining: the stream they started on, its tracks by name",
  eventText(ev("stream changed", { from: null, to: "1:3", audioStreamId: 1, subtitleStreamId: 3 }), ctx),
  "robin started on Stream 2 (audio English (AAC Stereo), subtitles English (SRT))");
check("moved by the host: why",
  eventText(ev("stream changed", { from: "1:0", to: "2:0", host: "alex", why: "audio", audioStreamId: 2, subtitleStreamId: 0 }, "sam"), ctx),
  "sam moved to Stream 3 (audio Japanese (AC3 5.1), subtitles off) because alex changed the audio");
check("  the host's own change",
  eventText(ev("stream changed", { from: "1:0", to: "2:0", why: "audio", audioStreamId: 2, subtitleStreamId: 0 }, "alex"), ctx),
  "alex changed the audio: now on Stream 3 (audio Japanese (AC3 5.1), subtitles off)");
check("their own change: from which to which, and what changed",
  eventText(ev("stream changed", { from: "1:0", to: "1:3" }), ctx),
  "robin moved from Stream 1 to Stream 2 (audio English (AAC Stereo), subtitles English (SRT)): a change of subtitles");
check("subtitles by name; a track not known by number; none is off",
  [eventText(ev("subtitles", { from: 0, to: 3 }), ctx), trackName(ctx, 9), trackName(ctx, 0), trackName(undefined, 2)],
  ["robin changed subtitles from off to English (SRT)", "track 9", "off", "track 2"]);
check("a stream's key in parts, and what differs between two",
  [variantParts("135836:0@8000/h264"), streamDiff("1:0@8000", "2:3"), streamDiff("1:0", "1:0"), variantParts("nonsense")],
  [{ audio: 135836, subtitle: 0, quality: 8000, format: "/h264" }, ["audio", "subtitles", "quality"], [], null]);

console.log("\n— the room waiting, loading, buffering —");
check("the room waits for the host's picture, and says after what",
  [eventText(ev("room waited", { ms: 4_000, why: "the host's stream is being rebuilt", switching: "audio" }, null)),
    eventText(ev("room waited", { ms: 1_500, why: "a seek" }, null)),
    eventText(ev("room waited", { ms: 2_000, why: "something new" }, null)),
    eventText(ev("room waited", { ms: 2_000 }, null))],
  ["Playback waited 4.0 s for the host's picture after the host changed the audio",
    "Playback waited 1.5 s for the host's picture after a seek",
    "Playback waited 2.0 s for the host's picture (something new)",
    "Playback waited 2.0 s for the host's picture"]);
const start = ev("loaded at start", { ms: 3_000 });
const stall = ev("buffering", { ms: 3_000 });
check("loading the start is said as that, among loading and errors, and not marked as a problem",
  [eventText(start), groupOf(start), eventTone(start), eventText(stall), eventTone(stall)],
  ["robin loaded for 3.0 s as they started", "problems", "", "robin buffered for 3.0 s", "warn"]);

console.log("\n— in order, and where in the title —");
check("the newest first; at the same time, the later one",
  newestFirst([ev("play", null, "a", 1_000), ev("pause", null, "b", 3_000), ev("resume", null, "c", 3_000)]).map((e) => e.username),
  ["c", "b", "a"]);
const track: TrackPoint[] = [[0, 100, 1], [10_000, 110, 1], [20_000, 110, 0], [30_000, 500, 1], [40_000, -1, 0], [50_000, 600, 1]];
check("where the room was: moving on while playing, still while paused, nowhere in a break or before it began",
  [positionAt(track, 5_000), positionAt(track, 15_000), positionAt(track, 25_000), positionAt(track, 45_000),
    positionAt(track, 60_000), positionAt(track, -1)],
  [105, 110, 110, null, 600, null]);
check("parts of a title watched, put together where they meet",
  unionParts([[[0, 10], [20, 30]], [[9, 15], [31, 40]], [[50, 50]]]), [[0, 15], [20, 40]]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
