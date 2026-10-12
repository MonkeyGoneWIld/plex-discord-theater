/**
 * What Plex does with a stream's audio, as "Stats for nerds" tells it: from
 * Plex's decision, and the file's own tracks for what it was before.
 */
import { audioName, audioNotes } from "../src/services/stream-audio.js";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

// Rear Window, as Plex lists it and decided on it on 11 October.
const rearWindow = [
  { id: 304532, codec: "eac3", channels: 2 },
  { id: 304533, codec: "ac3", channels: 2 },
];

console.log("— naming audio —");
check("codec and channels", [audioName("eac3", 2), audioName("truehd", 8), audioName("aac", 6), audioName("dca-ma", 6)],
  ["EAC3 Stereo", "TrueHD 7.1", "AAC 5.1", "DTS-HD MA 5.1"]);
check("as much as is known", [audioName("flac", null), audioName(null, 1), audioName(null, null)], ["FLAC", "Mono", null]);
check("a codec it has no name for, as Plex spells it", audioName("wmapro", 3), "WMAPRO 3 channels");

console.log("\n— what Plex does with it —");
check("converted: from what, to what, at what rate and why",
  audioNotes({ id: 304532, decision: "transcode", codec: "aac", channels: 2, bitrate: 256 }, rearWindow),
  {
    audio: "transcode", audioFrom: "EAC3 Stereo", audioTo: "AAC Stereo", audioKbps: 256,
    audioReason: "Unsupported codec (EAC3)",
  });
check("copied: as it is in the file",
  audioNotes({ id: 7, decision: "copy", codec: "aac", channels: 6, bitrate: 384 }, [{ id: 7, codec: "aac", channels: 6 }]),
  { audio: "copy", audioFrom: "AAC 5.1", audioTo: null, audioKbps: null, audioReason: null });
check("AAC converted all the same: mixed down",
  audioNotes({ id: 7, decision: "transcode", codec: "aac", channels: 2, bitrate: 256 }, [{ id: 7, codec: "aac", channels: 8 }])?.audioReason,
  "Downmixed from 7.1 to Stereo");
check("AAC converted for no reason anyone can see says so",
  audioNotes({ id: 7, decision: "transcode", codec: "aac", channels: 2, bitrate: 256 }, [{ id: 7, codec: "aac", channels: 2 }])?.audioReason,
  "Not stated by Plex");
check("a track not in the list: what came out, no reason to give but Plex's",
  audioNotes({ id: 99, decision: "transcode", codec: "aac", channels: 2, bitrate: null }, rearWindow),
  { audio: "transcode", audioFrom: null, audioTo: "AAC Stereo", audioKbps: null, audioReason: "Not stated by Plex" });
check("a copy of a track not in the list names what Plex sends",
  audioNotes({ id: 99, decision: "copy", codec: "aac", channels: 2, bitrate: null }, rearWindow)?.audioFrom, "AAC Stereo");
check("no decision, nothing said",
  audioNotes(null, rearWindow), { audio: null, audioFrom: null, audioTo: null, audioKbps: null, audioReason: null });
check("nor for a decision it doesn't know",
  audioNotes({ id: 304532, decision: "burn", codec: null, channels: null, bitrate: null }, rearWindow).audio, null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
