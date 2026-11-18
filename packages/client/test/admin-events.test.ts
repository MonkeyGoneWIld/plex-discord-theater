/**
 * A session's events on the dashboard, as said (admin/events.ts).
 *
 * 17 November: everyone joining "switched" to the stream they started on;
 * everyone moved with the host's change of audio and nothing said it was
 * the host's; "Playback held for 4.0 s until every viewer was ready", when
 * the room waits only for the host; a player loading the start was
 * "buffering"; tracks were numbers; and the oldest came first.
 */
import { eventDetails, eventText, eventTone, finishedAt, groupOf, jumpsOf, newestFirst, positionAt, positionTicks, streamDiff, trackName, unionParts, variantParts } from "../admin/events";
import { clientName, clientsOf, rolesOf } from "../admin/clients";
import { awayOf, deliveryParts, hostAt, loadTimes, pausesByPerson, pausesOf, requiredOf, streamAt } from "../admin/session";
import { drift } from "../admin/timeline";
import { progressText } from "../admin/streams";
import { sessionLogsHref } from "../admin/Logs";
import type { PlayEvent, PlayStream, TrackPoint } from "../admin/types";

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
  ["Playback waited 4 s for the host's video after the host changed the audio",
    "Playback waited 1.5 s for the host's video after a seek",
    "Playback waited 2 s for the host's video (something new)",
    "Playback waited 2 s for the host's video"]);
const start = ev("loaded at start", { ms: 3_000 });
const stall = ev("buffering", { ms: 3_000 });
check("loading the start is said as that, among loading and errors, and not marked as a problem",
  [eventText(start), groupOf(start), eventTone(start), eventText(stall), eventTone(stall)],
  ["Initial load for robin: 3 s", "problems", "", "Buffering for robin: 3 s", "warn"]);

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
    "alex (host) jumped back 10 s: 1:40 to 1:30", "alex (host) moved playback from 1:40 to 8:20 using the seek bar",
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
    "robin reached the end of the stream at 1:56:42, before the duration Plex reports; playback ended there", "playback"]);
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

// 18 November: the position line and the coverage chart name each seek.
console.log("\n— seeks on the charts —");
check("each seek: from, to, and the control, or on the seek bar how far; one without both ends or that went nowhere is left out",
  jumpsOf([ev("seek", { fromS: 30, toS: 105, cause: "skip intro" }, "alex", 1), ev("play", null, "alex", 2),
    ev("seek", { fromS: 2_700, toS: 2_400, cause: "timeline" }, "alex", 3), ev("seek", { fromS: 4_200, toS: 5_400 }, "alex", 4),
    ev("seek", { toS: 90 }, "alex", 5), ev("seek", { fromS: 90, toS: 90.4, cause: "timeline" }, "alex", 6)])
    .map((j) => [j.at, j.fromS, j.toS, j.label]),
  [[1, 30, 105, "Skip Intro"], [3, 2_700, 2_400, "Seek −5:00"], [4, 4_200, 5_400, "Seek +20:00"]]);
check("the position lane's lines: closer for a short title, wider for a film, at most five spaces",
  [positionTicks(1_416), positionTicks(7_256).map((t) => t / 60), positionTicks(150)],
  [[0, 300, 600, 900, 1_200], [0, 30, 60, 90, 120], [0, 30, 60, 90, 120, 150]]);

check("  the title finishing: when and where; closed or stopped part way is not finishing",
  [finishedAt([ev("stop", { cause: "closed" }, "alex", 1), { ...ev("ended", { reason: "stopped", cause: "finished" }, null, 9), posS: 7_002 }]),
    finishedAt([ev("ended", { reason: "stopped", cause: "closed" }, null, 9)])],
  [{ at: 9, posS: 7_002 }, null]);

// 18 November: History said nothing of which client a viewer watched on, nor
// of one moving from their computer to their phone part way.
console.log("\n— which client —");
const UA = {
  desktop: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9268 Chrome/138.0.7204.251 Electron/44.0.0 Safari/537.36",
  vesktop: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) vesktop/1.6.9 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  android: "Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36",
  safari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  firefox: "Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
};
check("a client by name: the Discord apps, Vesktop, and browsers, on which system",
  [clientName(UA.desktop), clientName(UA.vesktop), clientName(UA.iphone), clientName(UA.android), clientName(UA.safari),
    clientName(UA.firefox), clientName(UA.edge), clientName(null)],
  ["Discord desktop app · Windows", "Vesktop · Linux", "Discord app · iPhone", "Discord app · Android",
    "Safari · iPhone", "Firefox · Linux", "Edge · Windows", "Unknown client"]);
check("joining and coming back: on which client; a switch: from which to which",
  [eventText(ev("joined", { role: "viewer", device: UA.desktop })), eventText(ev("came back", { role: "viewer", device: UA.iphone })),
    eventText(ev("switched client", { from: UA.desktop, to: UA.iphone, role: "viewer" })), eventText(ev("joined", { role: "viewer" })), groupOf(ev("switched client", null))],
  ["robin joined as viewer on Discord desktop app · Windows", "robin reconnected on Discord app · iPhone",
    "robin moved from Discord desktop app · Windows to Discord app · iPhone", "robin joined as viewer", "people"]);
check("  its details: the client by name, what it plays, and its user agent as given",
  eventDetails(ev("joined", { role: "viewer", device: UA.firefox, caps: ["hevc", "opus"] })),
  [["Role", "Viewer"], ["Client", "Firefox · Linux"], ["Supported formats", "HEVC, Opus"], ["User agent", UA.firefox]]);
check("a viewer's clients in order, each from joining on it to moving on or being last seen",
  clientsOf([ev("joined", { device: UA.desktop }, "robin", 10), ev("play", null, "alex", 20), ev("switched client", { from: UA.desktop, to: UA.iphone }, "robin", 300),
    ev("left", null, "robin", 400), ev("came back", { device: UA.iphone }, "robin", 500), { ...ev("joined", { device: UA.firefox }, "alex", 5), userId: "111" }], "222", 0, 900),
  [{ device: UA.desktop, caps: null, av1Encode: false, from: 10, to: 300 }, { device: UA.iphone, caps: null, av1Encode: false, from: 300, to: 900 }]);
check("  back on another after leaving: the first ends where they left",
  clientsOf([ev("joined", { device: UA.desktop }, "robin", 10), ev("left", null, "robin", 400), ev("came back", { device: UA.android }, "robin", 500)], "222", 0, 900),
  [{ device: UA.desktop, caps: null, av1Encode: false, from: 10, to: 400 }, { device: UA.android, caps: null, av1Encode: false, from: 500, to: 900 }]);

// 18 November: the host joins before choosing a title, so History had no client
// for them; and a viewer on two clients had one list of formats for both.
check("each client with what its player plays; joined before the session, from when the session saw them",
  clientsOf([ev("joined", { device: UA.desktop, caps: ["hevc"], av1Encode: true }, "robin", 10), ev("joined", { device: UA.iphone, caps: ["av1"] }, "robin", 300),
    ev("switched client", { from: UA.desktop, to: UA.iphone }, "robin", 300)], "222", 100, 900),
  [{ device: UA.desktop, caps: ["hevc"], av1Encode: true, from: 100, to: 300 }, { device: UA.iphone, caps: ["av1"], av1Encode: false, from: 300, to: 900 }]);
check("  a client left before the session isn't one of its own",
  clientsOf([ev("joined", { device: UA.desktop }, "robin", 10), ev("left", null, "robin", 50), ev("joined", { device: UA.firefox }, "robin", 100)], "222", 100, 900)
    .map((c) => [clientName(c.device), c.from, c.to]),
  [["Firefox \u00b7 Linux", 100, 900]]);
check("a viewer's roles over the session: from before it, each change, and the same either side of a time away as one",
  rolesOf([ev("joined", { role: "viewer" }, "robin", 10), ev("role", { from: "viewer", to: "co-host" }, "robin", 50),
    ev("role", { from: "co-host", to: "host" }, "robin", 300), ev("left", null, "robin", 400), ev("came back", { role: "host" }, "robin", 500),
    ev("role", { from: "host", to: "viewer" }, "robin", 700), { ...ev("role", { to: "host" }, "alex", 20), userId: "111" }], "222", 100, 900),
  [{ role: "co-host", from: 100, to: 300 }, { role: "host", from: 300, to: 700 }, { role: "viewer", from: 700, to: 900 }]);

console.log("\n— how the host changed —");
const roleEv = (who: string, from: string, to: string, d: Record<string, unknown>) => eventText(ev("role", { from, to, ...d }, who));
check("each way the host changes, said for whoever got it and whoever had it",
  [roleEv("sam", "viewer", "host", { why: "handed over", by: "alex", target: "sam" }),
    roleEv("alex", "host", "co-host", { why: "handed over", by: "alex", target: "sam" }),
    roleEv("sam", "viewer", "host", { why: "request accepted", by: "alex", target: "sam" }),
    roleEv("alex", "host", "co-host", { why: "request accepted", by: "alex", target: "sam" }),
    roleEv("sam", "viewer", "host", { why: "request not answered", by: "alex", target: "sam", away: true }),
    roleEv("alex", "host", "co-host", { why: "request not answered", by: "alex", target: "sam" }),
    roleEv("alex", "co-host", "host", { why: "taken back", by: "sam", target: "alex" }),
    roleEv("sam", "host", "co-host", { why: "taken back", by: "sam", target: "alex" }),
    roleEv("sam", "viewer", "host", { why: "host left", by: "alex", target: "sam" }),
    roleEv("sam", "viewer", "host", { why: "host not back", target: "sam" }),
    roleEv("sam", "host", "viewer", { why: "host back", by: "sam", target: "alex" }),
    roleEv("sam", "viewer", "co-host", { why: "co-host given", by: "alex", target: "sam" }),
    roleEv("sam", "co-host", "viewer", { why: "co-host removed", by: "alex", target: "sam" }),
    roleEv("sam", "viewer", "host", {})],
  ["sam became host: transferred by alex", "alex transferred host to sam and became co-host",
    "sam became host: alex approved the request", "alex approved sam's host request and became co-host",
    "sam became host: alex did not respond to the request in time (away from Discord)",
    "alex did not respond to sam's host request in time; host transferred to sam and alex became co-host",
    "alex reclaimed host from sam", "sam became co-host: alex reclaimed host",
    "sam became host after alex left the session", "sam became host: the previous host did not reconnect in time",
    "sam returned to a viewer: alex reconnected in time and resumed as host",
    "alex granted co-host to sam", "alex revoked co-host from sam", "sam became host"]);
check("  coming in as host: back in time, or no other host present",
  [eventText(ev("came back", { role: "host", why: "host back" }, "alex")), eventText(ev("joined", { role: "host", why: "nobody was host" }, "sam"))],
  ["alex reconnected and resumed as host", "sam joined as host: no other host was present"]);
check("  its details: how, and the hosts either side; a co-host's, who gave it",
  [eventDetails(ev("role", { from: "host", to: "co-host", why: "handed over", by: "alex", target: "sam" }, "alex")),
    eventDetails(ev("role", { from: "viewer", to: "co-host", why: "co-host given", by: "alex", target: "sam" }, "sam")),
    eventDetails(ev("role", { from: "viewer", to: "host", why: "request not answered", by: "alex", target: "sam", away: true }, "sam")).at(-1)],
  [[["From", "Host"], ["To", "Co-host"], ["How", "Transferred by the host"], ["Host before", "alex"], ["Host after", "sam"]],
    [["From", "Viewer"], ["To", "Co-host"], ["How", "Granted by the host"], ["By", "alex"]],
    ["Host away from Discord", "Yes"]]);

console.log("\n— requests for host, and a title's short sound —");
check("asked, declined, and ended unanswered: who and why",
  [eventText(ev("asked for host", { host: "alex", away: true, waitS: 30 })), eventText(ev("asked for host", { host: "alex", away: false, waitS: 15 })),
    eventText(ev("request declined", { host: "alex" })),
    eventText(ev("request ended", { host: "alex", why: "asker left" })), eventText(ev("request ended", { host: "alex", why: "host changed" }))],
  ["robin requested host from alex (away from Discord)", "robin requested host from alex",
    "alex declined robin's request for host",
    "robin's host request was withdrawn: robin left before alex responded", "robin's host request was withdrawn: host changed before alex responded"]);
check("  in People; the short sound in Streams",
  ["asked for host", "request declined", "request ended", "short sound"].map((k) => groupOf(ev(k, {}))), ["people", "people", "people", "streams"]);
check("  the time the host had to respond, as a time",
  eventDetails(ev("asked for host", { host: "alex", away: true, waitS: 30 })).find(([l]) => l === "Time to respond"), ["Time to respond", "30 s"]);
check("short sound: where the audio and the video end",
  [eventText(ev("short sound", { soundEndsS: 5400, pictureEndsS: 5460, ratingKey: "173916" }, null)),
    eventDetails(ev("short sound", { soundEndsS: 5400, pictureEndsS: 5460, ratingKey: "173916" }, null))],
  ["The audio ends at 1:30:00, before the video ends at 1:31:00; the audio was processed separately and padded with silence to the end of the video",
    [["Audio ends at", "1:30:00"], ["Video ends at", "1:31:00"], ["Plex item", "173916"]]]);

console.log("\n— a session's cards: away, pauses, loading —");
const by = (kind: string, userId: string, at: number, detail: Record<string, unknown> | null = null, posS: number | null = null, username = userId === "1" ? "robin" : "sam"): PlayEvent =>
  ({ id: ++id, at, kind, userId, username, posS, detail }) as PlayEvent;
check("away from Discord: each stretch until back, left, or the session's end; others' not counted",
  awayOf([by("away from Discord", "1", 1000), by("back in Discord", "1", 4000), by("away from Discord", "2", 2000),
    by("away from Discord", "1", 6000), by("left", "1", 9000), by("away from Discord", "1", 10000)], "1", 12000),
  [{ from: 1000, to: 4000 }, { from: 6000, to: 9000 }, { from: 10000, to: 12000 }]);
const pauses = pausesOf([by("pause", "1", 1000, null, 60), by("resume", "1", 5000), by("pause", "2", 8000, null, 64), by("stop", "2", 9000),
  by("pause", "1", 10000, null, 65)], 15000);
check("pauses: who, where in the title, how long; one still paused at the end",
  pauses.map((p) => [p.username, p.posS, p.ms, p.open]), [["robin", 60, 4000, false], ["sam", 64, 1000, false], ["robin", 65, 5000, true]]);
check("  by who paused: how often, for how long, the longest; the most paused first",
  pausesByPerson(pauses).map((p) => [p.username, p.count, p.totalMs, p.longestMs]), [["robin", 2, 9000, 5000], ["sam", 1, 1000, 1000]]);
const loads = [by("loaded at start", "1", 0, { ms: 1200 }), by("loaded at start", "2", 0, { ms: 3000 }),
  by("loaded after seek", "1", 0, { ms: 800 }), by("loaded after seek", "1", 0, { ms: 1000 }), by("loaded after seek", "1", 0, { ms: "?" })];
check("loading times: a viewer's at the start and after seeks; the session's across everyone",
  [loadTimes(loads, "1"), loadTimes(loads, null).start, loadTimes(loads, "3")],
  [{ start: { count: 1, avgMs: 1200, longestMs: 1200 }, seek: { count: 2, avgMs: 900, longestMs: 1000 } },
    { count: 2, avgMs: 2100, longestMs: 3000 }, { start: null, seek: null }]);

console.log("\n— coverage by how it reached the viewer —");
const stream = (variantKey: string, decision: string, ownerUserId: string | null): PlayStream =>
  ({ id: ++id, hlsSessionId: `s${id}`, variantKey, decision, ownerUserId, startedAt: 0, endedAt: null }) as PlayStream;
const streams = [stream("1:0", "copy", null), stream("2:0", "transcode", "1")];
const moved = [by("stream changed", "1", 25000, { from: "2:0", to: "1:0" })];
check("the stream a viewer was on: their own until they moved, then the one they moved to; someone else, the shared one",
  [streamAt(moved, streams, "1", 1000)?.decision, streamAt(moved, streams, "1", 26000)?.decision, streamAt(moved, streams, "2", 1000)?.decision],
  ["transcode", "copy", "copy"]);
const theirs: TrackPoint[] = [[0, 0, 1], [10000, 10, 1], [20000, 20, 1], [30000, 30, 1], [40000, 40, 1], [50000, 100, 1], [60000, 110, 0]];
check("  what they watched by it: transcoded until the move, direct after; a jump is not watched",
  deliveryParts(theirs, moved, streams, "1"),
  [{ from: 0, to: 30, decision: "transcode" }, { from: 30, to: 40, decision: "copy" }, { from: 100, to: 110, decision: "copy" }]);
// 18 November: a co-host joined onto the host's stream (the only one, the host's own) and no move was recorded.
const hostOwn = [stream("9:0", "copy", "1")];
const joinedOnto = [by("play", "1", 0, { role: "host" }), by("stream changed", "1", 500, { from: null, to: "9:0" }),
  by("joined", "2", 30000, { role: "viewer" }), by("role", "2", 60000, { from: "viewer", to: "co-host" }),
  by("role", "2", 90000, { from: "co-host", to: "host" }), by("left", "1", 90000)];
check("  one who joined onto the host's stream, none recorded for them: the host's, as viewer, co-host and host",
  [streamAt(joinedOnto, hostOwn, "2", 40000)?.variantKey, streamAt(joinedOnto, hostOwn, "2", 70000)?.variantKey,
    streamAt(joinedOnto, hostOwn, "2", 95000)?.variantKey, hostAt(joinedOnto, 70000), hostAt(joinedOnto, 95000)],
  ["9:0", "9:0", "9:0", "1", "2"]);
check("  the stream they came in on, noted with the join, is theirs",
  streamAt([by("joined", "3", 0, { role: "viewer", stream: "2:0" })], streams, "3", 1000)?.decision, "transcode");
const followerTrack: TrackPoint[] = [[30000, 30, 1], [40000, 40, 1], [50000, 50, 1]];
check("  so their coverage shows how it reached them, not an unrecorded stream",
  deliveryParts(followerTrack, joinedOnto, hostOwn, "2"), [{ from: 30, to: 50, decision: "copy" }]);

console.log("\n— the bitrate the players needed —");
{
  const s8 = { ...stream("1:0", "copy", null), kbps: 8000 } as PlayStream;
  const s3 = { ...stream("2:0", "transcode", "2"), kbps: 3000 } as PlayStream;
  const evs = [by("play", "1", 0), by("joined", "2", 10000, { role: "viewer", stream: "1:0" }), by("stream changed", "2", 20000, { from: "1:0", to: "2:0" }),
    by("pause", "1", 30000), by("resume", "1", 40000), by("left", "2", 50000)];
  const people = [{ userId: "1", roles: [{ from: 0, to: 60000 }] }, { userId: "2", roles: [{ from: 10000, to: 50000 }] }];
  const playing = [{ from: 0, to: 30000 }, { from: 40000, to: 60000 }];
  check("each viewer in at their stream's bitrate while it plays, nothing while paused, a step at each change",
    requiredOf(evs, [s8, s3], people, playing, 0, 60000),
    [[0, 8e6], [10000, 16e6], [20000, 11e6], [30000, 0], [40000, 11e6], [50000, 8e6], [60000, 8e6]]);
}

console.log("\n— live: sync, encoding, logs —");
check("sync offset, said to a hundredth", [drift(0.3), drift(-0.04), drift(0.004), drift(2.44), drift(-3)],
  ["0.30 s ahead", "0.04 s behind", "in sync", "2.44 s ahead", "3.00 s behind"]);
check("processing: its speed now, how far ahead of playback, what it uses",
  [progressText({ encode: true, state: "making", speedX: 3, recentX: 4.2, aheadS: 190, cores: 1.2, gpu: [{ engine: "video", share: 0.34 }] }),
    progressText({ encode: true, state: "making", speedX: 2, recentX: null, aheadS: 40, cores: 2, gpu: [] }),
    progressText({ encode: false, state: "made", speedX: 9, recentX: null, aheadS: 0, cores: null, gpu: null })],
  ["Transcode running at 4.2× real time · 3:10 ahead of playback · GPU video 34% · CPU 1.2 cores",
    "Transcode running at 2.0× real time · 0:40 ahead of playback · No GPU (CPU encoding) · CPU 2 cores",
    "Remux complete: end of file reached"]);
const day = Date.UTC(2026, 10, 18, 23, 50);
check("logs for a session: its lines in its UTC day's file, both days' over midnight",
  [sessionLogsHref(day - 3_600_000, day).map(decodeURIComponent), sessionLogsHref(day, day + 1_800_000).map(decodeURIComponent)],
  [[`#logs/file=theater-2026-11-18.log&from=${day - 3_600_000}&to=${day}`],
    [`#logs/file=theater-2026-11-18.log&from=${day}&to=${day + 1_800_000}`, `#logs/file=theater-2026-11-19.log&from=${day}&to=${day + 1_800_000}`]]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
