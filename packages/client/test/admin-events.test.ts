/**
 * A session's events on the dashboard, as said (admin/events.ts).
 *
 * 17 November: everyone joining "switched" to the stream they started on;
 * everyone moved with the host's change of audio and nothing said it was
 * the host's; "Playback held for 4.0 s until every viewer was ready", when
 * the room waits only for the host; a player loading the start was
 * "buffering"; tracks were numbers; and the oldest came first.
 */
import { eventDetails, eventText, eventTone, groupOf, newestFirst, positionAt, streamDiff, trackName, unionParts, variantParts } from "../admin/events";
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
  ["robin changed the subtitles from off to English (SRT)", "track 9", "off", "track 2"]);
check("a stream's key in parts, and what differs between two",
  [variantParts("135836:0@8000/h264"), streamDiff("1:0@8000", "2:3"), streamDiff("1:0", "1:0"), variantParts("nonsense")],
  [{ audio: 135836, subtitle: 0, quality: 8000, format: "/h264" }, ["audio", "subtitles", "quality"], [], null]);

console.log("\n— the room waiting, loading, buffering —");
check("the room waits for the host's picture, and says after what",
  [eventText(ev("room waited", { ms: 4_000, why: "the host's stream is being rebuilt", switching: "audio" }, null)),
    eventText(ev("room waited", { ms: 1_500, why: "a seek" }, null)),
    eventText(ev("room waited", { ms: 2_000, why: "something new" }, null)),
    eventText(ev("room waited", { ms: 2_000 }, null))],
  ["Playback waited 4.0 s for the host's video after the host changed the audio",
    "Playback waited 1.5 s for the host's video after a seek",
    "Playback waited 2.0 s for the host's video (something new)",
    "Playback waited 2.0 s for the host's video"]);
const start = ev("loaded at start", { ms: 3_000 });
const stall = ev("buffering", { ms: 3_000 });
check("loading the start is said as that, among loading and errors, and not marked as a problem",
  [eventText(start), groupOf(start), eventTone(start), eventText(stall), eventTone(stall)],
  ["robin's player took 3.0 s to load at the start", "problems", "", "robin was buffering for 3.0 s", "warn"]);

// 17 November: a skip of the intro was "seeked"; how a title ended was
// "playback was stopped" whatever had happened; the host's subtitles were
// each viewer's own change; a stream "ended" with nothing to say why.
console.log("\n— what each action came from —");
check("a seek: the control it came from",
  [eventText(ev("seek", { role: "host", fromS: 30, toS: 105, cause: "skip intro" }, "alex")),
    eventText(ev("seek", { role: "co-host", fromS: 6_900, toS: 7_200, cause: "skip credits" }, "sam")),
    eventText(ev("seek", { role: "host", fromS: 100, toS: 90, cause: "jump back" }, "alex")),
    eventText(ev("seek", { role: "host", fromS: 100, toS: 500, cause: "timeline" }, "alex")),
    eventText(ev("seek", { fromS: 100, toS: 500 }, "alex"))],
  ["alex (host) used Skip Intro: 0:30 to 1:45", "sam (co-host) used Skip Credits: 1:55:00 to 2:00:00",
    "alex (host) jumped back 10 s: 1:40 to 1:30", "alex (host) moved playback from 1:40 to 8:20 using the timeline",
    "alex moved playback from 1:40 to 8:20"]);
check("  a start: where it was started from, and whose request",
  [eventText(ev("play", { role: "host", cause: "next episode" }, "alex")),
    eventText(ev("play", { role: "host", cause: "co-host", askedBy: "sam" }, "alex")),
    eventText(ev("play", { role: "host" }, "alex"))],
  ["alex (host) started this title from Next Episode", "alex (host) started this title at sam's request", "alex (host) started playback"]);
check("  a stop: closing the player, or the title finishing",
  [eventText(ev("stop", { role: "host", cause: "closed" }, "alex")), eventText(ev("stop", { role: "host", cause: "finished" }, "alex"))],
  ["alex (host) closed the player; playback stopped", "alex (host) reached the end of the title; playback stopped"]);
check("how a session ended: finished, closed, the next episode, a co-host's request, another title",
  [eventText(ev("ended", { reason: "stopped", cause: "finished", reachedEnd: true }, "alex")),
    eventText(ev("ended", { reason: "stopped", cause: "closed" }, "alex")),
    eventText(ev("ended", { reason: "another title", cause: "next episode", next: "Verity 2" }, "alex")),
    eventText(ev("ended", { reason: "another title", cause: "co-host", next: "Verity 3", askedBy: "sam" }, "alex")),
    eventText(ev("ended", { reason: "another title", cause: "picked", next: "Beast" }, "alex")),
    eventText(ev("ended", { reason: "room closed" }, null))],
  ["Session ended: the title finished", "Session ended: alex closed the player",
    "Session ended: alex started the next episode, Verity 2", "Session ended: alex started Verity 3 at sam's request",
    "Session ended: alex started a different title, Beast", "Session ended: all viewers left"]);
check("reaching the end: of the title, or of a stream shorter than Plex says, which is playback",
  [eventText(ev("reached the end", null)), eventText(ev("reached the end", { early: true, breakAtS: 7_002.5 })), groupOf(ev("reached the end", null))],
  ["robin reached the end of the title",
    "robin reached the end of the stream at 1:56:42, before the length Plex reports; playback was ended there", "playback"]);
check("the host's subtitles: theirs, and whose followed",
  [eventText(ev("subtitles", { from: 0, to: 3, byHost: true }, "alex"), ctx), eventText(ev("subtitles", { from: 0, to: 3, host: "alex" }, "sam"), ctx)],
  ["alex (host) changed the subtitles from off to English (SRT)", "sam's subtitles changed from off to English (SRT), following alex (host)"]);
check("why a stream ended: the host's change, or nobody left on it",
  [eventText(ev("stream ended", { variant: "1:0", host: "alex", switching: "audio" }, null), ctx),
    eventText(ev("stream ended", { variant: "1:3", unwatched: true }, null), ctx)],
  ["Stream 1 ended after alex changed the audio", "Stream 2 ended: no viewers remained on it"]);
check("an event's detail in words, not its field names",
  [eventDetails(ev("seek", { role: "host", fromS: 30, toS: 105, cause: "skip intro" }, "alex")),
    eventDetails(ev("ended", { reason: "another title", cause: "co-host", next: "Verity 3", askedBy: "sam" }, "alex")),
    eventDetails(ev("stream changed", { from: "1:0", to: "2:0", audioStreamId: 2, subtitleStreamId: 0, session: "S1" }, "sam"), ctx)],
  [[["Role", "Host"], ["From", "0:30"], ["To", "1:45"], ["Action", "Skip Intro"]],
    [["Reason", "Another title was started"], ["Action", "A co-host's request"], ["Next title", "Verity 3"], ["Requested by", "sam"]],
    [["From", "Stream 1"], ["To", "Stream 3"], ["Audio", "Japanese (AC3 5.1)"], ["Subtitles", "Off"], ["Stream session", "S1"]]]);

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
