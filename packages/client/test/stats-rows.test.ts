/**
 * The lines "Stats for nerds" shows: one for each of the preview frames, the
 * subtitle and the audio, and the details each opens to — how many frames are
 * in and when each pass came, whether a subtitle is loading, being read out
 * of the film or all there, and what happens to the audio.
 */
import { clock, previewDetails, previewSummary, type PreviewStatus } from "../src/lib/previewStatus";
import { subtitleDetails, subtitleSummary, type SubtitleLoadStatus } from "../src/lib/subtitleStatus";
import { audioDetails, audioSummary, type StreamNotes } from "../src/lib/streamNotes";
import type { StreamTrack } from "../src/lib/api";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}
/** Short enough for one line of the panel. */
const ONE_LINE = 40;
const fits = (rows: Array<[string, string]>) => rows.filter(([, v]) => v.length > ONE_LINE).map(([l]) => l);

console.log("— the clock —");
check("minutes and seconds, hours when there are any", [clock(0), clock(75.9), clock(3725)], ["0:00", "1:15", "1:02:05"]);

console.log("\n— thumbnails —");
check("a file Plex has none for", [previewSummary(null, false), previewDetails(null)], ["None", []]);
check("before the film starts", previewSummary(null, true), "Waiting for playback");
const status: PreviewStatus = {
  partId: 42, state: "waiting", transport: "progressive-v2", frames: 3759, ready: 564, bytes: 4_900_000,
  waitingForBufferS: 25,
  passes: [
    { pass: 0, askedS: null, doneS: 0, playheadS: 0, bytes: 1_677_722, readyAfter: 188, fromTitlePage: true },
    { pass: 1, askedS: 1.5, doneS: 3.6, playheadS: 3.2, bytes: 3_460_300, readyAfter: 564, fromTitlePage: false },
  ],
};
check("how many, and what the next pass waits for", previewSummary(status, true), "564/3759 · pass 3/4 at 25 s buffer");
check("each pass on a line of its own, the waiting one too", previewDetails(status), [
  ["Transport", "Progressive · 4 passes"],
  ["Pass 1 · coarse", "188 · title page · 1.6 MB"],
  ["Pass 2 · medium", "564 · 1.5→3.6 s @0:03 · 3.3 MB"],
  ["Pass 3 · fine", "waiting for 25 s buffer"],
]);
const coming = { ...status, state: "downloading" as const, passes: [...status.passes, { pass: 2, askedS: 25.4, doneS: null, playheadS: null, bytes: 2_202_009, readyAfter: null, fromTitlePage: false }] };
check("one coming in", [previewSummary(coming, true), previewDetails(coming)[3]], ["564/3759 · pass 3/4", ["Pass 3 · fine", "asked 25.4 s · 2.1 MB…"]]);
const done = { ...status, state: "complete" as const, ready: 3759, bytes: 34_393_293 };
check("all in", previewSummary(done, true), "3759/3759 · 32.8 MB");
check("none on the server", previewSummary({ ...status, state: "unavailable", httpStatus: 404, passes: [] }, true), "Unavailable (404) · per frame");
check("an old server's whole index is one",
  previewDetails({ ...done, transport: "legacy-bif", passes: [status.passes[1]] }), [["Transport", "Single index"], ["Index", "564 · 1.5→3.6 s @0:03 · 3.3 MB"]]);
check("every line fits on one", fits([["", previewSummary(status, true)], ...previewDetails(coming)]), []);

console.log("\n— subtitles —");
const track = (t: Partial<StreamTrack>): StreamTrack => ({
  id: 7, title: "English (SRT)", codec: "srt", channels: null, language: "English", languageCode: "eng", selected: false, ...t,
});
check("off", [subtitleSummary(null, "off", null, false), subtitleDetails(null, "off", null, false)], ["Off", []]);
const pgs = track({ title: "SDH (English PGS)", codec: "pgs" });
check("burned in", [subtitleSummary(pgs, "burned", null, false), subtitleDetails(pgs, "burned", null, false)],
  ["SDH (English PGS) · burned in", [["Track", "SDH (English PGS)"], ["Rendering", "Burned in by Plex"]]]);
const at = 1_000_000;
const loaded: SubtitleLoadStatus = {
  streamId: 7, state: "complete", lines: 1914, covered: null, startedAt: at - 50_000, firstLinesMs: null, completeMs: 48_500,
};
const beside = track({ title: "English (SRT External)", external: true, sidecar: true });
check("a file beside the film, all in",
  [subtitleSummary(beside, "drawn", loaded, false), subtitleDetails(beside, "drawn", loaded, false, at)],
  ["English (SRT External) · loaded", [["Track", "English (SRT External)"], ["Rendering", "Client · sidecar file"], ["Status", "Loaded · 1,914 cues · 48.5 s"]]]);
const reading: SubtitleLoadStatus = { ...loaded, state: "reading", lines: 412, covered: [[0, 750], [3000, 3320]], firstLinesMs: 380, completeMs: null };
const inside = track({ external: true });
check("one inside the film, still being read",
  [subtitleSummary(inside, "drawn", reading, false), subtitleDetails(inside, "drawn", reading, false, at)],
  ["English (SRT) · reading (412)", [
    ["Track", "English (SRT)"], ["Rendering", "Client · embedded text"], ["Status", "Reading · 412 cues · 50.0 s"],
    ["Coverage", "0:00–12:30, 50:00–55:20"], ["First cues", "0.4 s"],
  ]]);
check("still loading, and for how long",
  [subtitleSummary(inside, "drawn", { ...loaded, state: "loading", lines: 0 }, false),
   subtitleDetails(inside, "drawn", { ...loaded, state: "loading", lines: 0 }, false, at)[2]],
  ["English (SRT) · loading", ["Status", "Loading · 50.0 s"]]);
check("the last subtitle's status isn't this one's", subtitleSummary(track({ id: 8, external: true }), "drawn", loaded, false), "English (SRT) · loading");
check("couldn't be loaded", subtitleSummary(inside, "drawn", loaded, true), "English (SRT) · failed");
check("a switch on its way", subtitleSummary(track({}), "switching", null, false), "English (SRT) · switching");
check("every detail fits on one line", fits(subtitleDetails(inside, "drawn", reading, false, at)), []);

console.log("\n— audio —");
const notes = (n: Partial<StreamNotes>): StreamNotes => ({
  video: "copy", reason: null, kbps: null, quality: null, audio: null, audioFrom: null, audioTo: null, audioKbps: null, audioReason: null, ...n,
});
check("as it is in the file: the row says it all", [audioSummary(notes({ audio: "copy", audioFrom: "AAC Stereo" })), audioDetails(notes({ audio: "copy", audioFrom: "AAC Stereo" }))],
  ["AAC Stereo · direct", []]);
const converted = notes({ audio: "transcode", audioFrom: "EAC3 5.1", audioTo: "AAC 5.1", audioKbps: 384, audioReason: "Unsupported codec (EAC3)" });
check("converted: from what, to what, and why behind it", [audioSummary(converted), audioDetails(converted)],
  ["EAC3 5.1 → AAC 5.1", [["Source", "EAC3 5.1"], ["Output", "AAC 5.1 · 384 kbps"], ["Reason", "Unsupported codec (EAC3)"]]]);
check("a server that doesn't say", [audioSummary(null), audioDetails(null)], ["—", []]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
