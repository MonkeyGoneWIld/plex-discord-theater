/**
 * What the player is told about its stream, and what it offers someone whose
 * connection can't keep up with it.
 *
 * The notes arrive as EXT-X-SESSION-DATA in the master playlist, which hls.js
 * hands over as one attribute list per DATA-ID — built here in that shape.
 */
import { M3U8Parser } from "hls.js";
import { lowerQualityFor, qualityLabel } from "../src/lib/quality";
import { readStreamNotes } from "../src/lib/streamNotes";

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

console.log("— what the server says about a stream —");
check("a re-encode, with why and at what rate",
  readStreamNotes(sessionData({ video: "transcode", reason: "a picture subtitle is burned into it", kbps: "12000" })),
  { video: "transcode", reason: "a picture subtitle is burned into it", kbps: 12000, quality: null });
check("a copy, with the file's own rate",
  readStreamNotes(sessionData({ video: "copy", kbps: "30660" })),
  { video: "copy", reason: null, kbps: 30660, quality: null });
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
  readStreamNotes(parsed.sessionData), { video: "transcode", reason, kbps: 12000, quality: null });
check("and still finds the stream in it", parsed.levels.length, 1);
check("nor from notes it doesn't recognise", readStreamNotes(sessionData({ video: "maybe" })), null);

console.log("\n— which quality to offer someone buffering —");
check("on a 30 Mbps remux over a 14 Mbps connection: the highest under three quarters of it",
  lowerQualityFor(30660, 14_000_000), 8000);
check("with nothing measured, the next level down", lowerQualityFor(30660, 0), 20000);
check("on a 12 Mbps re-encode, something under it", lowerQualityFor(12000, 0), 8000);
check("the lowest when even that is more than the connection has carried",
  lowerQualityFor(12000, 2_000_000), 4000);
check("nothing when already at the lowest", lowerQualityFor(4000, 0), null);

console.log("\n— naming them —");
check("no setting", qualityLabel(0), "Auto");
check("a level", qualityLabel(8000), "8 Mbps");
check("the 720p one says so", qualityLabel(4000), "4 Mbps · 720p");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
