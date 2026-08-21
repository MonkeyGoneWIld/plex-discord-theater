/**
 * Carrying a track choice from one episode to the next.
 *
 * Plex numbers streams per media part, so nothing can be carried by id — the
 * choice is remembered as a description and re-matched against whatever the new
 * file happens to hold. These are the cases where "same language" is not enough
 * to identify the right track.
 */
import { matchAudioTrack, matchSubtitleTrack, type AudioPref, type SubtitlePref } from "../src/lib/trackPrefs";
import type { StreamTrack } from "../src/lib/api";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

let nextId = 1;
function track(p: Partial<StreamTrack> & { title: string }): StreamTrack {
  return {
    id: p.id ?? nextId++,
    title: p.title,
    codec: p.codec ?? null,
    channels: p.channels ?? null,
    language: p.language ?? null,
    languageCode: p.languageCode ?? null,
    selected: p.selected ?? false,
  };
}

const audioPref = (t: Partial<AudioPref>): AudioPref => ({
  languageCode: "jpn", language: "Japanese", codec: "aac", channels: 2, title: null, ...t,
});

console.log("\n— audio follows the language, not the id —");
{
  const eng = track({ id: 10, title: "English (AC3 5.1)", language: "English", languageCode: "eng", codec: "ac3", channels: 6, selected: true });
  const jpn = track({ id: 11, title: "Japanese (AAC Stereo)", language: "Japanese", languageCode: "jpn", codec: "aac", channels: 2 });

  check("the remembered language wins over the file's own default",
    matchAudioTrack([eng, jpn], audioPref({}))?.id, 11);
  check("a language the file doesn't carry leaves Plex's choice alone",
    matchAudioTrack([eng], audioPref({})), null);
  check("no preference at all leaves it alone too",
    matchAudioTrack([eng, jpn], null), null);
  check("and an empty track list is not a crash",
    matchAudioTrack([], audioPref({})), null);
}

console.log("\n— commentary is not the film —");
{
  // The trap: a commentary track is the same language as the feature, so
  // language matching alone lands on it about as often as not.
  const feature = track({ id: 20, title: "Japanese (AAC Stereo)", language: "Japanese", languageCode: "jpn", codec: "aac", channels: 2 });
  const commentary = track({ id: 21, title: "Japanese Director's Commentary (AAC Stereo)", language: "Japanese", languageCode: "jpn", codec: "aac", channels: 2 });

  check("the feature is chosen even when commentary is listed first",
    matchAudioTrack([commentary, feature], audioPref({}))?.id, 20);
  check("somebody who was listening to commentary keeps it",
    matchAudioTrack([feature, commentary], audioPref({ title: "Japanese Commentary" }))?.id, 21);
  check("audio description is treated the same way",
    matchAudioTrack(
      [track({ id: 22, title: "English Audio Description", language: "English", languageCode: "eng" }),
       track({ id: 23, title: "English", language: "English", languageCode: "eng" })],
      audioPref({ languageCode: "eng", language: "English", codec: null, channels: null }),
    )?.id, 23);
}

console.log("\n— within a language, the closest match —");
{
  const stereo = track({ id: 30, title: "Japanese (AAC Stereo)", language: "Japanese", languageCode: "jpn", codec: "aac", channels: 2 });
  const surround = track({ id: 31, title: "Japanese (FLAC 5.1)", language: "Japanese", languageCode: "jpn", codec: "flac", channels: 6 });

  check("channel count decides between two tracks of one language",
    matchAudioTrack([stereo, surround], audioPref({ channels: 6, codec: null }))?.id, 31);
  check("and codec breaks the tie when the channels match",
    matchAudioTrack(
      [track({ id: 32, title: "Japanese (AC3 5.1)", language: "Japanese", languageCode: "jpn", codec: "ac3", channels: 6 }), surround],
      audioPref({ channels: 6, codec: "flac" }),
    )?.id, 31);
  check("an equal score keeps the file's own order",
    matchAudioTrack([stereo, track({ id: 33, title: "Japanese (AAC Stereo)", language: "Japanese", languageCode: "jpn", codec: "aac", channels: 2 })],
      audioPref({}))?.id, 30);
}

console.log("\n— language names when there are no codes —");
{
  // Plex doesn't always fill languageCode; the name is the only thing left.
  const jpn = track({ id: 40, title: "Japanese", language: "Japanese" });
  const eng = track({ id: 41, title: "English", language: "English" });
  check("matched on the language name",
    matchAudioTrack([eng, jpn], audioPref({ languageCode: null, codec: null, channels: null }))?.id, 40);
}

console.log("\n— subtitles still behave —");
{
  const pref: SubtitlePref = { off: false, languageCode: "eng", language: "English", codec: "srt", title: "English (SRT)" };
  const plain = track({ id: 50, title: "English (SRT)", language: "English", languageCode: "eng", codec: "srt" });
  const forced = track({ id: 51, title: "English Forced (SRT)", language: "English", languageCode: "eng", codec: "srt" });

  check("full subtitles are not replaced by the forced pair",
    matchSubtitleTrack([forced, plain], pref)?.id, 50);
  check("a remembered opt-out stays off",
    matchSubtitleTrack([plain], { off: true }), null);
  check("a language this episode lacks turns subtitles off rather than guessing",
    matchSubtitleTrack([track({ id: 52, title: "French", language: "French", languageCode: "fra" })], pref), null);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
