/**
 * What the player is told about its stream, and what it offers someone whose
 * connection can't keep up with it.
 *
 * The notes arrive as EXT-X-SESSION-DATA in the master playlist, which hls.js
 * hands over as one attribute list per DATA-ID — built here in that shape.
 */
import { M3U8Parser } from "hls.js";
import {
  carryQualityTo,
  lowerQualityFor,
  preferredQuality,
  qualityLabel,
  resetPreferredQuality,
  setPreferredQuality,
} from "../src/lib/quality";
import { engineText, playbackMode, readStreamNotes } from "../src/lib/streamNotes";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

/** Session data as hls.js parses it out of a master playlist. */
const sessionData = (notes: Record<string, string>) => Object.fromEntries(
  Object.entries(notes).map(([k, v]) => [`com.pdt.${k}`, { "DATA-ID": `com.pdt.${k}`, VALUE: v }]),
);

/** What a server that says nothing about the audio leaves. */
const NO_AUDIO = {
  audio: null, audioFrom: null, audioTo: null, audioKbps: null, audioReason: null, videoFrom: null, range: null,
  encoder: null, fallback: null,
};

console.log("— what the server says about a stream —");
check("a re-encode, with why and at what rate",
  readStreamNotes(sessionData({ video: "transcode", reason: "a picture subtitle is burned into it", kbps: "12000" })),
  { video: "transcode", reason: "a picture subtitle is burned into it", kbps: 12000, quality: null, ...NO_AUDIO, engine: "plex" });
check("a copy, with the file's own rate",
  readStreamNotes(sessionData({ video: "copy", kbps: "30660" })),
  { video: "copy", reason: null, kbps: 30660, quality: null, ...NO_AUDIO, engine: "plex" });
check("a stream started under someone's quality setting says so",
  readStreamNotes(sessionData({ video: "transcode", kbps: "8000", quality: "8000" }))?.quality, 8000);
check("nothing from a server that sends none", readStreamNotes(null), null);

// The real parser, over a master playlist written the way the server writes
// one — commas, colons and apostrophes in the reason and all.
const reason = "Plex wouldn't copy it at 25.6 Mbps: the file averages 16.7 Mbps, and its peaks are likely higher";
const master = [
  "#EXTM3U",
  '#EXT-X-SESSION-DATA:DATA-ID="com.pdt.video",VALUE="transcode"',
  `#EXT-X-SESSION-DATA:DATA-ID="com.pdt.reason",VALUE="${reason}"`,
  '#EXT-X-SESSION-DATA:DATA-ID="com.pdt.kbps",VALUE="12000"',
  "#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080",
  "/api/plex/hls/seg?p=session%2Fabc%2Fbase%2Findex.m3u8",
  "",
].join("\n");
const parsed = M3U8Parser.parseMasterPlaylist(master, "http://localhost/master.m3u8");
check("hls.js reads the server's notes out of the playlist intact",
  readStreamNotes(parsed.sessionData), { video: "transcode", reason, kbps: 12000, quality: null, ...NO_AUDIO, engine: "plex" });
check("and still finds the stream in it", parsed.levels.length, 1);
check("nor from notes it doesn't recognise", readStreamNotes(sessionData({ video: "maybe" })), null);
check("a stream ffmpeg made says so", readStreamNotes(sessionData({ video: "copy", engine: "ffmpeg" }))?.engine, "ffmpeg");
check("and what it re-encoded on",
  engineText(readStreamNotes(sessionData({ video: "transcode", engine: "ffmpeg", encoder: "NVIDIA NVENC, GPU decode" }))!),
  "ffmpeg · NVIDIA NVENC, GPU decode");
check("a copy by ffmpeg is just ffmpeg", engineText(readStreamNotes(sessionData({ video: "copy", engine: "ffmpeg" }))!), "ffmpeg");
check("one ffmpeg left to Plex says so (why is a line of its own)",
  engineText(readStreamNotes(sessionData({ video: "transcode", fallback: "all 6 encode slots taken" }))!),
  "Plex (ffmpeg fallback)");
check("and Plex without the engine is just Plex", engineText(readStreamNotes(sessionData({ video: "copy" }))!), "Plex");

console.log("\n— its audio, and what Plex would call it —");
const converted = readStreamNotes(sessionData({
  video: "copy", kbps: "6274", audio: "transcode", audioFrom: "EAC3 Stereo", audioTo: "AAC Stereo",
  audioKbps: "256", audioReason: "the file's audio is EAC3, and the player takes AAC only",
}));
check("audio converted, from what to what and why",
  converted && [converted.audio, converted.audioFrom, converted.audioTo, converted.audioKbps, converted.audioReason],
  ["transcode", "EAC3 Stereo", "AAC Stereo", 256, "the file's audio is EAC3, and the player takes AAC only"]);
check("the original video with its audio converted is a Direct Stream", playbackMode(converted), "Direct Stream");
const untouched = readStreamNotes(sessionData({ video: "copy", audio: "copy", audioFrom: "AAC 5.1" }));
check("the original video and audio both is Direct Play", playbackMode(untouched), "Direct Play");
check("a copy whose audio the server doesn't mention is still only a Direct Stream",
  playbackMode(readStreamNotes(sessionData({ video: "copy" }))), "Direct Stream");
check("a re-encode is a Transcode, whatever its audio",
  playbackMode(readStreamNotes(sessionData({ video: "transcode", audio: "copy" }))), "Transcode");
check("nothing to call a stream nobody has said anything about", playbackMode(null), null);
check("an audio decision it doesn't recognise is none",
  readStreamNotes(sessionData({ video: "copy", audio: "maybe" }))?.audio, null);

console.log("\n— which quality to offer someone buffering —");
check("on a 30 Mbps remux over a 14 Mbps connection: the highest under three quarters of it",
  lowerQualityFor(30660, 14_000_000), 10000);
check("with nothing measured, the next level down", lowerQualityFor(30660, 0), 20000);
check("on a 12 Mbps re-encode, the next one down: 10 Mbps, as Plex offers", lowerQualityFor(12000, 0), 10000);
check("the lowest when even that is more than the connection has carried",
  lowerQualityFor(12000, 2_000_000), 4000);
check("nothing when already at the lowest", lowerQualityFor(4000, 0), null);
check("not a level barely under the file: 10 Mbps for a 12.5 Mbps one, not 12",
  lowerQualityFor(12559, 44_000_000), 10000);

console.log("\n— naming them —");
check("no setting is the original", qualityLabel(0), "Original");
check("a level", qualityLabel(8000), "8 Mbps");
check("the 720p one says so", qualityLabel(4000), "4 Mbps · 720p");

console.log("\n— how long a choice lasts —");
check("a player starts at Original", preferredQuality(), 0);
setPreferredQuality(8000, { ratingKey: "s1e1", show: "s1" });
check("the next episode keeps it", carryQualityTo("s1e2", "s1"), 8000);
check("and the one after", carryQualityTo("s1e3", "s1"), 8000);
check("the title it was chosen on keeps it, through a restart", carryQualityTo("s1e3", "s1"), 8000);
check("a film is something else, and starts at Original", carryQualityTo("film", null), 0);
check("which sticks", preferredQuality(), 0);
setPreferredQuality(4000, { ratingKey: "film", show: null });
check("a film keeps its own", carryQualityTo("film", null), 4000);
check("but not into a show", carryQualityTo("s2e1", "s2"), 0);
setPreferredQuality(12000, { ratingKey: "s1e1", show: "s1" });
check("an episode of another show starts at Original", carryQualityTo("s2e1", "s2"), 0);
setPreferredQuality(12000, { ratingKey: "s1e1", show: "s1" });
resetPreferredQuality();
check("closing the player goes back to Original", preferredQuality(), 0);
check("and starting the same show again starts there", carryQualityTo("s1e2", "s1"), 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
