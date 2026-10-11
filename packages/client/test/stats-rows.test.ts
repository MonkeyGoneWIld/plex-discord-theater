/**
 * The rows "Stats for nerds" shows for the preview frames and the subtitle:
 * how many frames are in and when each pass came, and whether a subtitle is
 * still loading, being read out of the film, or all there.
 */
import { clock, describePreview, type PreviewStatus } from "../src/lib/previewStatus";
import { describeSubtitle, type SubtitleLoadStatus } from "../src/lib/subtitleStatus";
import type { StreamTrack } from "../src/lib/api";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

console.log("— the clock —");
check("minutes and seconds, hours when there are any", [clock(0), clock(75.9), clock(3725)], ["0:00", "1:15", "1:02:05"]);

console.log("\n— preview frames —");
check("a file Plex has none for", describePreview(null, false), [["Preview thumbnails", "None — Plex has none for this file"]]);
check("before the film starts", describePreview(null, true)[0][1], "Not asked for yet — they come once the film starts");
const status: PreviewStatus = {
  partId: 42, state: "waiting", transport: "progressive-v2", frames: 60, ready: 9, bytes: 270_072,
  waitingForBufferS: 15,
  passes: [
    { pass: 0, askedS: null, doneS: 0, playheadS: 0, bytes: 90_024, readyAfter: 3, fromTitlePage: true },
    { pass: 1, askedS: 4.2, doneS: 6.7, playheadS: 6.5, bytes: 180_048, readyAfter: 9, fromTitlePage: false },
  ],
};
const rows = describePreview(status, true);
check("how many, and what the next pass waits for", rows[0], ["Preview thumbnails", "9 of 60 ready · 264 KB · pass 3 of 4 waits for 15 s of buffer"]);
check("the first pass, fetched on the title's page", rows[1], ["  Pass 1 (coarse)", "fetched on the title's page; 3 ready 0.0 s in, at 0:00 · 88 KB"]);
check("the second: when asked, when in, where the picture was", rows[2], ["  Pass 2 (medium)", "asked 4.2 s in; 9 ready 6.7 s in, at 0:06 · 176 KB"]);
check("one still coming in",
  describePreview({ ...status, state: "downloading", passes: [{ ...status.passes[1], doneS: null, bytes: 40_000 }] }, true),
  [["Preview thumbnails", "9 of 60 ready · 264 KB · downloading pass 1 of 4"], ["  Pass 2 (medium)", "asked 4.2 s in; coming in, 39 KB so far"]]);
check("all in", describePreview({ ...status, state: "complete", ready: 60, bytes: 1_802_712 }, true)[0][1], "All 60 ready · 1.7 MB");
check("none on the server: asked one at a time",
  describePreview({ ...status, state: "unavailable", httpStatus: 404, ready: 0, bytes: 0, passes: [] }, true)[0][1],
  "None — the server answered 404; asked one at a time instead");
check("an old server's whole BIF is one pass",
  describePreview({ ...status, transport: "legacy-bif", state: "complete", ready: 60, passes: [status.passes[1]] }, true)[1][0],
  "  Pass (all)");

console.log("\n— the subtitle —");
const track = (t: Partial<StreamTrack>): StreamTrack => ({
  id: 7, title: "English (SRT)", codec: "srt", channels: null, language: "English", languageCode: "eng", selected: false, ...t,
});
check("off", describeSubtitle(null, "off", null, false), [["Subtitles", "Off"]]);
check("burned in comes with the video",
  describeSubtitle(track({ title: "SDH (English PGS)", codec: "pgs" }), "burned", null, false),
  [["Subtitles", "SDH (English PGS) · burned into the picture by Plex"], ["Subtitle loading", "Comes with the video, segment by segment"]]);
const at = 1_000_000;
const loaded: SubtitleLoadStatus = {
  streamId: 7, state: "complete", lines: 1234, covered: null, startedAt: at - 5000, firstLinesMs: null, completeMs: 420,
};
check("a file beside the film, all in",
  describeSubtitle(track({ title: "English (SRT External)", external: true, sidecar: true }), "drawn", loaded, false, at),
  [["Subtitles", "English (SRT External) · drawn by the player, from the file beside the film"], ["Subtitle loading", "Fully loaded · 1,234 lines in 0.4 s"]]);
check("one inside the film, still being read",
  describeSubtitle(track({ external: true }), "drawn",
    { ...loaded, state: "reading", lines: 412, covered: [[0, 750], [3000, 3320]], firstLinesMs: 380, completeMs: null }, false, at),
  [
    ["Subtitles", "English (SRT) · drawn by the player, read out of the film's own file"],
    ["Subtitle loading", "Plex still reading it · 412 lines so far · 5.0 s in"],
    ["  Every line in", "0:00–12:30, 50:00–55:20"],
    ["  Lines for here", "in 0.4 s"],
  ]);
check("still loading, and for how long",
  describeSubtitle(track({ external: true }), "drawn", { ...loaded, state: "loading", lines: 0 }, false, at)[1],
  ["Subtitle loading", "Loading… 5.0 s"]);
check("the last subtitle's status isn't this one's",
  describeSubtitle(track({ id: 8, external: true }), "drawn", loaded, false, at)[1], ["Subtitle loading", "Loading…"]);
check("couldn't be loaded", describeSubtitle(track({ external: true }), "drawn", loaded, true, at)[1], ["Subtitle loading", "Couldn't be loaded"]);
check("a switch on its way", describeSubtitle(track({}), "switching", null, false), [["Subtitles", "English (SRT) · switching to it"]]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
