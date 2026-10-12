/**
 * How Stats for nerds judges each line: green, amber, red or blue, and the
 * words of its Sync line and of why a stream isn't Direct Play.
 */
import {
  bufferFalling, bufferHealth, framesHealth, modeHealth, playbackWhy, previewHealth, pushSample, sparkLines, speedHealth,
  stallsHealth, subtitleHealth, syncSummary, type SyncInfo,
} from "../src/lib/statsHealth";
import type { StreamNotes } from "../src/lib/streamNotes";
import type { StreamTrack } from "../src/lib/api";
import type { PreviewStatus } from "../src/lib/previewStatus";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

console.log("— playback —");
check("Direct Play green, Direct Stream amber, Transcode red", ["Direct Play", "Direct Stream", "Transcode", null].map(modeHealth), ["ok", "warn", "bad", "none"]);
const notes = (n: Partial<StreamNotes>): StreamNotes => ({
  video: "copy", reason: null, kbps: null, quality: null, audio: "copy", audioFrom: null, audioTo: null, audioKbps: null, audioReason: null, ...n,
});
check("Direct Play needs no why", playbackWhy(notes({}), "Direct Play"), []);
check("a Direct Stream's why is its audio",
  playbackWhy(notes({ audio: "transcode", audioReason: "Unsupported codec (EAC3)" }), "Direct Stream"), [["Why", "Audio: Unsupported codec (EAC3)"]]);
check("a Transcode gives every reason, video's first",
  playbackWhy(notes({ video: "transcode", reason: "38.7 Mbps average exceeds 25 Mbps server limit", audio: "transcode", audioReason: "Unsupported codec (DTS-HD MA)" }), "Transcode"),
  [["Why", "Video: 38.7 Mbps average exceeds 25 Mbps server limit"], ["", "Audio: Unsupported codec (DTS-HD MA)"]]);
check("a transcode with its audio copied gives the one",
  playbackWhy(notes({ video: "transcode", reason: "Open-GOP keyframes" }), "Transcode"), [["Why", "Video: Open-GOP keyframes"]]);
check("a server that said nothing of the audio says so",
  playbackWhy(notes({ audio: null }), "Direct Stream"), [["Why", "Audio: not reported by the server"]]);
check("and one that said nothing at all", playbackWhy(null, "Transcode"), [["Why", "Not reported by the server"]]);

console.log("\n— buffer, speed, frames —");
check("buffer: over 30 s green, 10 to 30 amber, under 10 red",
  [bufferHealth(149), bufferHealth(30), bufferHealth(10), bufferHealth(9.9), bufferHealth(null)], ["ok", "warn", "warn", "bad", "none"]);
check("downloaded to the end is fine however little is left", bufferHealth(4, true), "ok");
check("speed: 1.5 times the stream green, 1 to 1.5 amber, under it red",
  [speedHealth(49e6, 10e6), speedHealth(15e6, 10e6), speedHealth(14e6, 10e6), speedHealth(10e6, 10e6), speedHealth(4e6, 8e6)], ["ok", "ok", "warn", "warn", "bad"]);
check("speed with nothing to compare to, or none measured", [speedHealth(20e6, null), speedHealth(null, 8e6)], ["info", "none"]);
// The buffer full: the player asks for what it plays, and the speed reads
// about what the stream needs — which is nothing wrong.
check("a full buffer holding: green, however close to the need the speed reads",
  speedHealth(8.4e6, 8e6, { health: "ok", falling: false }), "ok");
check("a middling buffer holding or growing: green too", speedHealth(6e6, 8e6, { health: "warn", falling: false }), "ok");
check("a buffer going down: judged on its speed",
  [speedHealth(9e6, 8e6, { health: "ok", falling: true }), speedHealth(5e6, 8e6, { health: "warn", falling: true }), speedHealth(20e6, 8e6, { health: "warn", falling: true })],
  ["warn", "bad", "ok"]);
check("a buffer nearly empty: judged on its speed even if not falling", speedHealth(5e6, 8e6, { health: "bad", falling: false }), "bad");
check("falling: down three seconds or more over the last ten",
  [bufferFalling([60, 58, 57, 56]), bufferFalling([60, 59.5, 59, 58]), bufferFalling([30, 40, 50]), bufferFalling([null, 20, null, 15])],
  [true, false, false, true]);
check("frames: none dropped at the usual rate is green", framesHealth({ shown: 240, dropped: 0 }, 24, 24), "ok");
check("a few dropped is amber", framesHealth({ shown: 240, dropped: 2 }, 24, 24), "warn");
check("two in a hundred is red", framesHealth({ shown: 200, dropped: 5 }, 23.5, 24), "bad");
check("well under the usual rate is red, drops or not", framesHealth({ shown: 150, dropped: 0 }, 15, 24), "bad");
check("a 60 fps film at 60 is green", framesHealth({ shown: 600, dropped: 0 }, 59.9, 60), "ok");
check("paused, nothing to judge", framesHealth({ shown: 0, dropped: 0 }, null, 24), "none");

console.log("\n— sync —");
const sync = (s: Partial<SyncInfo>): SyncInfo => ({
  role: "viewer", driftS: 0.05, rate: 1, waitingForRoom: false, roomPlaying: true, stalls: { count: 0, totalMs: 0 }, ...s,
});
check("the host sets the clock", syncSummary(sync({ role: "host", driftS: null })), { text: "Host · sets the room clock", health: "ok" });
check("a viewer in step", syncSummary(sync({})), { text: "+0.05 s from the room", health: "ok" });
check("behind, and being sped up", syncSummary(sync({ driftS: -2.4, rate: 1.05 })), { text: "−2.40 s from the room · catching up 1.05×", health: "bad" });
check("a little ahead, eased back", syncSummary(sync({ driftS: 0.8, rate: 0.95 })), { text: "+0.80 s from the room · easing back 0.95×", health: "warn" });
check("waiting ahead of the room on purpose", syncSummary(sync({ driftS: 6, waitingForRoom: true })), { text: "+6.00 s · waiting for the room", health: "info" });
check("the room paused", syncSummary(sync({ driftS: 0, roomPlaying: false })), { text: "+0.00 s · room paused", health: "ok" });
check("the room on another title", syncSummary(sync({ driftS: null })), { text: "Room on another title", health: "none" });
check("no room", syncSummary(null), { text: "—", health: "none" });
check("stalls: none green, under 2 s in all amber, more red",
  [stallsHealth({ count: 0, totalMs: 0 }), stallsHealth({ count: 1, totalMs: 400 }), stallsHealth({ count: 4, totalMs: 11200 })], ["ok", "warn", "bad"]);

console.log("\n— subtitles and thumbnails —");
const track = { id: 7, title: "English (SRT)", codec: "srt", channels: null, language: "English", languageCode: "eng", selected: false, external: true } as StreamTrack;
const status = (state: "loading" | "reading" | "complete" | "failed", id = 7) => ({ streamId: id, state, lines: 0, covered: null, startedAt: 0, firstLinesMs: null, completeMs: null });
check("off, switching, burned in",
  [subtitleHealth("off", null, null, false), subtitleHealth("switching", track, null, false), subtitleHealth("burned", track, null, false)], ["none", "info", "warn"]);
check("drawn: loading and reading blue, loaded green, failed red",
  [subtitleHealth("drawn", track, status("loading"), false), subtitleHealth("drawn", track, status("reading"), false),
   subtitleHealth("drawn", track, status("complete"), false), subtitleHealth("drawn", track, status("failed"), false),
   subtitleHealth("drawn", track, status("complete"), true)], ["info", "info", "ok", "bad", "bad"]);
check("the last subtitle's status isn't this one's: still coming", subtitleHealth("drawn", track, status("complete", 8), false), "info");
const preview = (state: PreviewStatus["state"]): PreviewStatus => ({ partId: 1, state, transport: "progressive-v2", frames: 100, ready: 50, bytes: 0, passes: [], waitingForBufferS: null });
check("thumbnails by state",
  (["complete", "waiting", "downloading", "incomplete", "unavailable", "unreadable", "failed"] as const).map((s) => previewHealth(preview(s), true)),
  ["ok", "info", "info", "warn", "warn", "warn", "bad"]);
check("none for the file, or not asked for yet", [previewHealth(null, false), previewHealth(null, true)], ["none", "none"]);

console.log("\n— graphs —");
const kept: number[] = [];
for (let i = 0; i < 70; i++) pushSample(kept, i, 60);
check("a minute of samples kept, the newest", [kept.length, kept[0], kept[59]], [60, 10, 69]);
check("a gap splits the line, the newest at the right edge",
  sparkLines([10, 20, null, 30], 40, 300, 23, 4), ["0.0,17.0 100.0,12.0", "300.0,7.0"]);
check("nothing to draw, no line", sparkLines([null, null], 10, 300, 20), []);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
