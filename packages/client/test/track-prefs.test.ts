/**
 * Carrying a track choice from one episode to the next.
 *
 * Plex numbers streams per media part, so nothing can be carried by id — the
 * choice is remembered as a description and re-matched against whatever the new
 * file happens to hold. These are the cases where "same language" is not enough
 * to identify the right track.
 */
import { describeWatched, matchAudioTrack, matchSubtitleTrack, mergeTrackPrefs, plexAudioChoice, plexSubtitleChoice, tracksForNewItem, type AudioPref, type SubtitlePref } from "../src/lib/trackPrefs";
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
    ...(p.external !== undefined ? { external: p.external } : {}),
    ...(p.sidecar !== undefined ? { sidecar: p.sidecar } : {}),
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
  check("even somebody who was listening to commentary starts the next title on the film",
    matchAudioTrack([feature, commentary], audioPref({ title: "Japanese Commentary" }))?.id, 20);
  check("but one chosen for this title starts this title on it again",
    matchAudioTrack([feature, commentary], audioPref({ title: "Japanese Director's Commentary (AAC Stereo)", forTitle: true }))?.id, 21);
  check("while the feature chosen for it stays the feature",
    matchAudioTrack([commentary, feature], audioPref({ title: "Japanese (AAC Stereo)", forTitle: true }))?.id, 20);
  check("and a language only a commentary is in leaves Plex's choice instead",
    matchAudioTrack([commentary], audioPref({})), null);
  check("which isn't a commentary either, even when Plex has one selected",
    plexAudioChoice([{ ...commentary, selected: true }, feature])?.id, 20);
  check("the file's default, then its first track, when Plex has none selected",
    [plexAudioChoice([commentary, feature, { ...feature, id: 24, default: true }])?.id, plexAudioChoice([commentary, feature])?.id],
    [24, 20]);
  check("audio description is treated the same way",
    matchAudioTrack(
      [track({ id: 22, title: "English Audio Description", language: "English", languageCode: "eng" }),
       track({ id: 23, title: "English", language: "English", languageCode: "eng" })],
      audioPref({ languageCode: "eng", language: "English", codec: null, channels: null }),
    )?.id, 23);
}

console.log("\n— nor are a commentary's subtitles —");
{
  // Rear Window's English subtitles, as Plex lists them on 11 October.
  const sdh = track({ id: 304534, title: "SDH (English PGS)", language: "English", languageCode: "eng", codec: "pgs", external: false });
  const commentary = track({ id: 304562, title: "Commentary (English PGS)", language: "English", languageCode: "eng", codec: "pgs", external: false });
  const beside = track({ id: 375250, title: "English (SRT External)", language: "English", languageCode: "eng", codec: "srt", external: true, sidecar: true });
  const english = (t: Partial<SubtitlePref> = {}): SubtitlePref => ({ off: false, languageCode: "en", language: "English", ...t });
  check("English from Settings: the SDH, not the commentary, which isn't marked SDH",
    matchSubtitleTrack([sdh, commentary, beside], english())?.id, 304534);
  check("whichever order Plex lists them in",
    matchSubtitleTrack([commentary, beside, sdh], english())?.id, 304534);
  check("somebody who last picked a commentary's subtitles gets the film's",
    matchSubtitleTrack([sdh, commentary, beside], english({ title: "Commentary (English PGS)", codec: "pgs" }))?.id, 304534);
  check("but a commentary's chosen for this title starts this title on it again",
    matchSubtitleTrack([sdh, commentary, beside], english({ title: "Commentary (English PGS)", codec: "pgs", forTitle: true }))?.id, 304562);
  check("and a film with none falls back to its own English",
    matchSubtitleTrack([beside, sdh], english({ title: "Commentary (English PGS)", codec: "pgs", forTitle: true }))?.id, 304534);
  check("and only a commentary's in that language is none",
    matchSubtitleTrack([commentary], english()), null);
  check("Plex's own selection, a commentary's, is none",
    plexSubtitleChoice([{ ...commentary, selected: true }, sdh]), null);
  check("but its own selection otherwise stands",
    plexSubtitleChoice([commentary, { ...sdh, selected: true }])?.id, 304534);
  check("the next episode, after somebody watched one with a commentary's subtitles",
    tracksForNewItem(
      { audioTracks: [], subtitleTracks: [commentary, sdh] },
      { audio: null, subtitle: english({ title: "Commentary (English PGS)" }) },
      { audioStreamId: 0, subtitleStreamId: 0 },
    ).subtitleStreamId, 304534);
  check("unless it was chosen for the show",
    tracksForNewItem(
      { audioTracks: [], subtitleTracks: [commentary, sdh] },
      { audio: null, subtitle: english({ title: "Commentary (English PGS)", forTitle: true }) },
      { audioStreamId: 0, subtitleStreamId: 0 },
    ).subtitleStreamId, 304562);
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

console.log("\n— misleading Plex language tags —");
{
  // Real shape from Your Lie in April: Plex tags both streams as English. The
  // only indication that the first one is Japanese is its title.
  const japanese = track({
    id: 116749,
    title: "Japanese (English AC3 Stereo)",
    language: "English",
    languageCode: "eng",
    codec: "ac3",
    channels: 2,
    selected: true,
  });
  const english = track({
    id: 116750,
    title: "English (AC3 Stereo)",
    language: "English",
    languageCode: "eng",
    codec: "ac3",
    channels: 2,
  });

  check("English does not fall back to the first, Japanese stream",
    matchAudioTrack([japanese, english], {
      title: "English (AC3 Stereo)", language: "English", languageCode: "eng",
      codec: "ac3", channels: 2,
    })?.id, 116750);
  check("Japanese still carries when its language tag incorrectly says English",
    matchAudioTrack([japanese, english], {
      title: "Japanese (English AC3 Stereo)", language: "English", languageCode: "eng",
      codec: "ac3", channels: 2,
    })?.id, 116749);

  const previousEpisode = {
    audioTracks: [
      { ...japanese, id: 116744 },
      { ...english, id: 116745 },
    ],
    subtitleTracks: [],
  };
  const nextEpisode = { audioTracks: [japanese, english], subtitleTracks: [] };
  const watchedEnglish = describeWatched(previousEpisode, {
    audioStreamId: 116745,
    subtitleStreamId: 0,
  });
  check("English carries between the supplied episode metadata",
    tracksForNewItem(nextEpisode, watchedEnglish, {
      audioStreamId: 116749,
      subtitleStreamId: 0,
    }).audioStreamId, 116750);
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
  check("equivalent two- and three-letter Plex language codes match",
    matchSubtitleTrack([
      track({ id: 53, title: "English (ASS)", language: "English", languageCode: "en" }),
    ], pref)?.id, 53);
  check("an untagged track can still match the language named in its title",
    matchSubtitleTrack([
      track({ id: 54, title: "Japanese (ASS)" }),
      track({ id: 55, title: "English (ASS)" }),
    ], pref)?.id, 55);
  check("the same subtitle codec wins over Plex's first same-language track",
    matchSubtitleTrack([
      track({ id: 56, title: "English (PGS)", language: "English", languageCode: "eng", codec: "pgs" }),
      plain,
    ], pref)?.id, 50);

  const signs = track({
    id: 57,
    title: "Signs/Song for Dub (English ASS)",
    language: "English",
    languageCode: "eng",
    codec: "ass",
  });
  const dialogue = track({
    id: 58,
    title: "Subtitles (English ASS)",
    language: "English",
    languageCode: "eng",
    codec: "ass",
  });
  check("full dialogue does not fall back to the first English ASS track",
    matchSubtitleTrack([signs, dialogue], {
      off: false,
      title: "Subtitles (English ASS)",
      language: "English",
      languageCode: "eng",
      codec: "ass",
    })?.id, 58);
  check("Signs/Song still carries when that is what was selected",
    matchSubtitleTrack([dialogue, signs], {
      off: false,
      title: "Signs/Song for Dub (English ASS)",
      language: "English",
      languageCode: "eng",
      codec: "ass",
    })?.id, 57);
}

console.log("\n— inside the file before a file beside it —");
{
  // English chosen in Settings: a language and nothing else.
  const settings: SubtitlePref = { off: false, languageCode: "eng", language: "English", codec: null, title: null, pinned: true };
  const sidecar = track({ id: 60, title: "English (SRT External)", language: "English", languageCode: "eng", codec: "srt", external: true, sidecar: true });
  const insideSrt = track({ id: 61, title: "English (SRT)", language: "English", languageCode: "eng", codec: "srt", external: true });
  const insideAss = track({ id: 62, title: "English (ASS)", language: "English", languageCode: "eng", codec: "ass", external: true });
  const insidePgs = track({ id: 63, title: "English (PGS)", language: "English", languageCode: "eng", codec: "pgs", external: false });
  const forcedInside = track({ id: 64, title: "English Forced (SRT)", language: "English", languageCode: "eng", codec: "srt", external: true });
  const sdhInside = track({ id: 65, title: "English SDH (SRT)", language: "English", languageCode: "eng", codec: "srt", external: true });

  check("the subtitle inside the file, though Plex lists the downloaded one first",
    matchSubtitleTrack([sidecar, insideSrt], settings)?.id, 61);
  check("ASS inside it as much as SRT",
    matchSubtitleTrack([sidecar, insideAss], settings)?.id, 62);
  check("text inside it before a picture subtitle that would be burned in",
    matchSubtitleTrack([insidePgs, sidecar, insideSrt], settings)?.id, 61);
  check("a picture subtitle inside it before the downloaded one",
    matchSubtitleTrack([sidecar, insidePgs], settings)?.id, 63);
  check("the downloaded one when it is all there is in the language",
    matchSubtitleTrack([sidecar, track({ id: 66, title: "French (SRT)", language: "French", languageCode: "fra", codec: "srt", external: true })], settings)?.id, 60);
  check("but never the forced pair in place of full subtitles",
    matchSubtitleTrack([forcedInside, sidecar], settings)?.id, 60);
  check("SDH inside the file before plain subtitles beside it",
    matchSubtitleTrack([sidecar, sdhInside], settings)?.id, 65);
  check("and the same from the last pick, the downloaded one",
    matchSubtitleTrack([sidecar, insideSrt], { off: false, languageCode: "eng", language: "English", codec: "srt", title: "English (SRT External)" })?.id, 61);
}

console.log("\n— carrying a viewer's own tracks into the next episode —");
{
  // What the room put everyone on when the episode changed: the host's pair.
  const hostTracks = { audioStreamId: 70, subtitleStreamId: 71 };
  const audioTracks = [
    track({ id: 70, title: "English (AC3 5.1)", language: "English", languageCode: "eng", channels: 6 }),
    track({ id: 72, title: "Japanese (AAC Stereo)", language: "Japanese", languageCode: "jpn", channels: 2 }),
  ];
  const subtitleTracks = [
    track({ id: 71, title: "English (SRT)", language: "English", languageCode: "eng", codec: "srt" }),
  ];
  const file = { audioTracks, subtitleTracks };
  const jpnAudio = audioPref({ channels: 2 });
  const engSubs: SubtitlePref = { off: false, languageCode: "eng", language: "English", codec: "srt", title: "English (SRT)" };

  check("a viewer with no preferences at all stays on the host's",
    tracksForNewItem(file, { audio: null, subtitle: null }, hostTracks), hostTracks);

  check("their own language is picked up when the episode has it",
    tracksForNewItem(file, { audio: jpnAudio, subtitle: engSubs }, hostTracks),
    { audioStreamId: 72, subtitleStreamId: 71 });

  check("and the host's stands where it doesn't",
    tracksForNewItem(
      { audioTracks: [audioTracks[0]], subtitleTracks },
      { audio: jpnAudio, subtitle: engSubs },
      hostTracks,
    ),
    hostTracks);

  check("each side falls back on its own — audio carries, subtitles don't",
    tracksForNewItem(
      { audioTracks, subtitleTracks: [] },
      { audio: jpnAudio, subtitle: engSubs },
      hostTracks,
    ),
    { audioStreamId: 72, subtitleStreamId: 71 });

  // "None" is an answer, not a failed match, so a host with subtitles on does
  // not override it.
  check("a deliberate None survives into the next episode",
    tracksForNewItem(file, { audio: null, subtitle: { off: true } }, hostTracks),
    { audioStreamId: 70, subtitleStreamId: 0 });
}

console.log("\n— what you were watching describes what to look for —");
{
  // Last episode's file, and the pair this viewer was actually on in it.
  const before = {
    audioTracks: [
      track({ id: 80, title: "English (AC3 5.1)", language: "English", languageCode: "eng", codec: "ac3", channels: 6 }),
      track({ id: 81, title: "Japanese (AAC Stereo)", language: "Japanese", languageCode: "jpn", codec: "aac", channels: 2 }),
    ],
    subtitleTracks: [track({ id: 82, title: "English (SRT)", language: "English", languageCode: "eng", codec: "srt" })],
  };
  // This episode's file. Same tracks, completely different ids.
  const now = {
    audioTracks: [
      track({ id: 90, title: "English (AC3 5.1)", language: "English", languageCode: "eng", codec: "ac3", channels: 6 }),
      track({ id: 91, title: "Japanese (AAC Stereo)", language: "Japanese", languageCode: "jpn", codec: "aac", channels: 2 }),
    ],
    subtitleTracks: [track({ id: 92, title: "English (SRT)", language: "English", languageCode: "eng", codec: "srt" })],
  };
  const hostTracks = { audioStreamId: 90, subtitleStreamId: 92 };

  const watched = describeWatched(before, { audioStreamId: 81, subtitleStreamId: 82 });
  check("the dub they were on is carried by language, not by id",
    tracksForNewItem(now, watched, hostTracks),
    { audioStreamId: 91, subtitleStreamId: 92 });

  // Somebody who had subtitles off keeps them off.
  const noSubs = describeWatched(before, { audioStreamId: 81, subtitleStreamId: 0 });
  check("subtitles off is carried as a choice",
    tracksForNewItem(now, noSubs, hostTracks),
    { audioStreamId: 91, subtitleStreamId: 0 });

  // Somebody on the host's own pair asks for nothing new.
  const sameAsHost = describeWatched(before, { audioStreamId: 80, subtitleStreamId: 82 });
  check("and somebody already on the host's tracks stays put",
    tracksForNewItem(now, sameAsHost, hostTracks), hostTracks);

  // Ids that belong to no track in that file describe nothing, so the caller
  // falls through to the stored preference rather than inventing a match.
  const unknown = describeWatched(before, { audioStreamId: 999, subtitleStreamId: 998 });
  check("ids from nowhere describe nothing", [unknown.audio, unknown.subtitle], [null, null]);

  // Resolving audio must not prevent the subtitle side from using its saved
  // fallback when the previous episode's subtitle id cannot be described.
  const partial = describeWatched(before, { audioStreamId: 81, subtitleStreamId: 998 });
  const savedEnglishSubs: SubtitlePref = {
    off: false, languageCode: "eng", language: "English", codec: "srt", title: "English (SRT)",
  };
  const staleEnglishAudio = audioPref({
    languageCode: "eng", language: "English", codec: "ac3", channels: 6,
  });
  const filled = mergeTrackPrefs(partial, { audio: staleEnglishAudio, subtitle: savedEnglishSubs });
  check("observed audio wins while a missing subtitle falls back independently",
    tracksForNewItem(now, filled, hostTracks),
    { audioStreamId: 91, subtitleStreamId: 92 });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
