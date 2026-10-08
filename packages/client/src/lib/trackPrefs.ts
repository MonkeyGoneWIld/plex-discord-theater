import type { StreamTrack } from "./api";
import { LANGUAGES } from "./languages";

export const SUBTITLE_PREF_KEY = "pdt:subtitlePref";
export const AUDIO_PREF_KEY = "pdt:audioPref";
/** "foreign" when subtitles are only wanted for audio in another language. */
export const SUBTITLE_WHEN_KEY = "pdt:subtitleWhen";
/** Tracks chosen for particular films and shows: see rememberTitleTracks. */
export const TITLE_TRACKS_KEY = "pdt:titleTracks:v1";

/**
 * A remembered track choice, stored by *description* rather than by stream id.
 *
 * Plex assigns stream ids per media part, so the id of "English (SRT)" on S1E4
 * says nothing about the same track on S1E5. What carries across episodes is the
 * language and the flavour of the track, so that is what gets persisted and
 * re-matched against the next episode's stream list.
 */
interface TrackPref {
  languageCode?: string | null;
  language?: string | null;
  codec?: string | null;
  /** Plex spells forced/SDH/commentary variants into the title, which is the
   *  only place they appear — kept so "English Forced" doesn't match plain
   *  "English", and so a commentary track isn't mistaken for the feature. */
  title?: string | null;
  /** Chosen in Settings rather than while watching: kept until it is changed
   *  there, whatever gets picked in a player in the meantime. */
  pinned?: boolean;
}

export interface TrackPrefs {
  audio: AudioPref | null;
  subtitle: SubtitlePref | null;
}

export interface SubtitlePref extends TrackPref {
  /** `true` means the user explicitly chose "None" — remembered, so an opt-out
   *  isn't undone by a later episode that happens to have a default track. */
  off: boolean;
  /** Chosen for this film or show in particular, which no general rule — the
   *  foreign-audio one included — overrides. */
  forTitle?: boolean;
}

export interface AudioPref extends TrackPref {
  /** 2 for stereo, 6 for 5.1, and so on. A dub often ships in fewer channels
   *  than the original, so this separates "the Japanese 5.1" from "the Japanese
   *  stereo" when a file carries both. */
  channels?: number | null;
  /** Whatever language each title was made in, rather than a particular one —
   *  see originalAudioTrack. Always pinned. */
  original?: boolean;
}

/** Forced/SDH/CC flavour flags parsed out of a track title. */
function flavour(title?: string | null): { forced: boolean; sdh: boolean } {
  const t = (title ?? "").toLowerCase();
  return { forced: t.includes("forced"), sdh: t.includes("sdh") || t.includes("cc") };
}

/**
 * Whether an audio track is a commentary or description rather than the film.
 *
 * These sit in the same language as the feature, so language matching alone
 * will happily land on one — and a viewer who asked for Japanese audio does not
 * mean the director talking over it.
 */
function isCommentary(title?: string | null): boolean {
  return /\b(commentary|descriptive|audio description)\b/i.test(title ?? "");
}

function normalizedText(value?: string | null): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/** Plex may use either ISO-639-1 (`en`) or ISO-639-2 (`eng`) per file. */
function canonicalLanguageCode(value?: string | null): string | null {
  const code = normalizedText(value).replace(/_/g, "-");
  if (!code || code === "und" || code === "unk" || code === "zxx") return null;
  try {
    return new Intl.Locale(code).language;
  } catch {
    return code;
  }
}

/**
 * Last-resort language hint for files whose subtitle streams are untagged.
 * Plex titles commonly look like "English (ASS)" or "English - Forced".
 */
function titleLanguageHint(value?: string | null): string {
  return normalizedText(value)
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .split(/\s[-·|]\s/, 1)[0]
    .replace(/\b(forced|sdh|cc|closed captions?|full|dialogue|subtitles?)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The human label before Plex's parenthesized language/codec decoration.
 *
 * Subtitle files commonly contain several English ASS tracks whose only useful
 * distinction is this label: "Signs/Song for Dub" versus "Subtitles", for
 * example. Comparing the full extended title would make the technical suffix
 * part of the identity and fail as soon as the next episode used another codec.
 */
function titleIdentity(value?: string | null): string {
  return normalizedText(value)
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sameLanguage(track: StreamTrack, pref: TrackPref): boolean {
  const trackCode = canonicalLanguageCode(track.languageCode);
  const prefCode = canonicalLanguageCode(pref.languageCode);
  if (trackCode && prefCode && trackCode === prefCode) return true;

  const trackName = normalizedText(track.language);
  const prefName = normalizedText(pref.language);
  if (trackName && prefName && trackName === prefName) return true;

  const trackTitle = normalizedText(track.title);
  const prefTitle = normalizedText(pref.title);
  if (prefName && new RegExp(`\\b${prefName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(trackTitle)) {
    return true;
  }
  if (trackName && new RegExp(`\\b${trackName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(prefTitle)) {
    return true;
  }

  // Explicit, conflicting language codes beat a coincidentally similar title.
  if (trackCode && prefCode) return false;
  const trackHint = titleLanguageHint(track.title);
  const prefHint = titleLanguageHint(pref.title);
  return !!trackHint && trackHint === prefHint;
}

function describe(track: StreamTrack): TrackPref {
  return {
    languageCode: track.languageCode ?? null,
    language: track.language ?? null,
    codec: track.codec ?? null,
    title: track.title ?? null,
  };
}

function read<T>(key: string, valid: (parsed: unknown) => boolean): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return valid(parsed) ? (parsed as T) : null;
  } catch {
    // Storage unavailable or corrupt — fall back to "no preference".
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable — the choice just won't outlive this episode.
  }
}

export function loadSubtitlePref(): SubtitlePref | null {
  return read<SubtitlePref>(SUBTITLE_PREF_KEY, (p) => typeof (p as SubtitlePref)?.off === "boolean");
}

/**
 * Remember the subtitle just chosen. Pass `null` for the "None" option, and the
 * audio it was chosen with when that is known.
 *
 * Nothing is written over a choice made in Settings. Nor is "None" written when
 * subtitles are only wanted for foreign audio and this audio is already in
 * their language: that is the rule at work rather than somebody deciding
 * against subtitles, and writing it down would turn them off for the next
 * title, foreign audio or not.
 */
export function saveSubtitlePref(track: StreamTrack | null, audio?: StreamTrack | null): void {
  const kept = loadSubtitlePref();
  if (kept?.pinned) return;
  if (!track && audio && kept && ruleTurnsOff(kept, audio)) return;
  write(SUBTITLE_PREF_KEY, track ? { off: false, ...describe(track) } : { off: true });
}

export function loadAudioPref(): AudioPref | null {
  return read<AudioPref>(AUDIO_PREF_KEY, (p) => !!p && typeof p === "object");
}

/** Remember the audio track just chosen. There is no "off" — every file has
 *  audio. Not over a choice made in Settings. */
export function saveAudioPref(track: StreamTrack | null): void {
  if (!track || loadAudioPref()?.pinned) return;
  write(AUDIO_PREF_KEY, { ...describe(track), channels: track.channels ?? null });
}

/**
 * Persist a pair already described from tracks that were actually playing.
 * Missing sides are left alone; `{ off: true }` is not missing and is saved.
 * Neither side is written over a choice made in Settings.
 */
export function saveTrackPrefs(prefs: TrackPrefs): void {
  if (prefs.audio && !loadAudioPref()?.pinned) write(AUDIO_PREF_KEY, prefs.audio);
  if (prefs.subtitle && !loadSubtitlePref()?.pinned) write(SUBTITLE_PREF_KEY, prefs.subtitle);
}

/**
 * Whether subtitles are wanted only when the audio is in another language —
 * English subtitles for a Japanese film, and none for an English one.
 */
export function subtitlesOnlyForForeignAudio(): boolean {
  try {
    return localStorage.getItem(SUBTITLE_WHEN_KEY) === "foreign";
  } catch {
    return false;
  }
}

export function setSubtitlesOnlyForForeignAudio(on: boolean): void {
  try {
    if (on) localStorage.setItem(SUBTITLE_WHEN_KEY, "foreign");
    else localStorage.removeItem(SUBTITLE_WHEN_KEY);
  } catch {
    // Storage unavailable — subtitles follow the language alone.
  }
}

/** A language name as LANGUAGES spells it, lower-cased, to its code. */
const LANGUAGE_BY_NAME = new Map(LANGUAGES.map((l) => [l.name.toLowerCase(), l.code]));

/**
 * The language an audio track is spoken in, judged against a subtitle choice.
 *
 * A title that starts with a language's name says it most reliably. Some
 * anime files tag the Japanese track "eng" and say Japanese only in its title
 * ("Japanese (English AC3 Stereo)"), and going by the tag would decide English
 * subtitles weren't needed for it.
 */
function spokenIn(audio: StreamTrack, pref: TrackPref): boolean {
  const named = LANGUAGE_BY_NAME.get(titleLanguageHint(audio.title)) ?? null;
  const wanted = canonicalLanguageCode(pref.languageCode)
    ?? LANGUAGE_BY_NAME.get(normalizedText(pref.language))
    ?? null;
  if (named && wanted) return named === wanted;
  return sameLanguage(audio, pref);
}

/** Subtitles are only for foreign audio, and this audio is in their language —
 *  unless they were chosen for this title, which nothing general overrides. */
function ruleTurnsOff(pref: SubtitlePref, audio: StreamTrack): boolean {
  return !pref.off && !pref.forTitle && subtitlesOnlyForForeignAudio() && spokenIn(audio, pref);
}

/**
 * The subtitle a title should start on, given the audio it will play with:
 * the saved choice matched against its tracks, unless subtitles are only
 * wanted for foreign audio and this audio is already in their language.
 */
export function startingSubtitle(
  tracks: StreamTrack[],
  pref: SubtitlePref | null,
  audio: StreamTrack | null | undefined,
): StreamTrack | null {
  if (pref && audio && ruleTurnsOff(pref, audio)) return null;
  return matchSubtitleTrack(tracks, pref);
}

/** Subtitle codecs that are text — drawn by the player, never burned in. */
const TEXT_SUBTITLE_CODECS = new Set(["srt", "subrip", "vtt", "webvtt", "ass", "ssa", "text", "mov_text", "tx3g"]);

/**
 * Where a subtitle comes from, best first: 2 for text inside the file, which
 * the player draws and which was made for this cut of the film; 1 for a
 * picture subtitle inside it (PGS, VobSub), which is just as well timed but
 * has to be burned into the picture, re-encoding it; 0 for a file beside it,
 * which is usually downloaded and not always in time with the film.
 */
function subtitleSource(track: StreamTrack): number {
  if (track.sidecar) return 0;
  const drawn = track.external ?? TEXT_SUBTITLE_CODECS.has((track.codec ?? "").toLowerCase());
  return drawn ? 2 : 1;
}

/**
 * Best match for the stored preference among a new episode's subtitle tracks.
 *
 * Returns the track to select, or `null` for "no subtitles" — which covers both
 * a remembered opt-out and a preference nothing in this episode satisfies.
 *
 * Matching is deliberately graded rather than exact: an episode may carry the
 * same language in a different container (SRT vs PGS) or without the forced
 * flag, and falling back to "English anything" is far closer to what the viewer
 * asked for than silently turning subtitles off.
 *
 * Among tracks that fit equally, one inside the file beats a file beside it —
 * see subtitleSource. A language chosen in Settings says nothing else, and the
 * downloaded sidecar used to win whenever Plex listed it first.
 */
export function matchSubtitleTrack(
  tracks: StreamTrack[],
  pref: SubtitlePref | null,
): StreamTrack | null {
  if (!pref || pref.off || tracks.length === 0) return null;

  const wantFlavour = flavour(pref.title);
  const wantedTitle = titleIdentity(pref.title);
  const sameLang = tracks.filter((t) => sameLanguage(t, pref));
  if (sameLang.length === 0) return null;

  // Rank within the language: the explicit label identifies tracks like
  // Signs/Song versus full dialogue; forced or not is the next thing that
  // makes one the wrong track; then where it comes from, ahead of SDH and
  // codec, which remain fallbacks for files whose titles are generic or
  // change between episodes.
  const scored = sameLang.map((t) => {
    const f = flavour(t.title);
    let score = 0;
    if (wantedTitle && titleIdentity(t.title) === wantedTitle) score += 64;
    if (f.forced === wantFlavour.forced) score += 32;
    score += subtitleSource(t) * 8;
    if (f.sdh === wantFlavour.sdh) score += 2;
    if (pref.codec && t.codec === pref.codec) score += 1;
    return { t, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].t;
}

/**
 * Turn the streams somebody is watching into something portable.
 *
 * The ids belong to one media part and mean nothing in the next episode, but
 * the tracks they name have a language and a flavour, and those do carry. This
 * is the same description `saveAudioPref` stores — built from what a viewer is
 * demonstrably watching rather than from what they last clicked, which is the
 * more reliable of the two: a stored preference is one global slot, shared by
 * every show and overwritten by whoever touched a picker last.
 *
 * A subtitle id of 0 is "none", and is described as a deliberate opt-out —
 * unless it is what the foreign-audio rule did with this audio, in which case
 * nobody opted out of anything and the saved choice still stands.
 */
export function describeWatched(
  available: { audioTracks: StreamTrack[]; subtitleTracks: StreamTrack[] },
  watching: { audioStreamId: number; subtitleStreamId: number },
): TrackPrefs {
  const audio = available.audioTracks.find((t) => t.id === watching.audioStreamId);
  const subtitle = available.subtitleTracks.find((t) => t.id === watching.subtitleStreamId);
  const saved = watching.subtitleStreamId === 0 && audio ? loadSubtitlePref() : null;
  return {
    audio: audio ? { ...describe(audio), channels: audio.channels ?? null } : null,
    subtitle: watching.subtitleStreamId === 0
      ? (saved && audio && ruleTurnsOff(saved, audio) ? null : { off: true })
      : subtitle ? { off: false, ...describe(subtitle) } : null,
  };
}

/** Fill an unresolved side without replacing a side we observed directly. */
export function mergeTrackPrefs(primary: TrackPrefs | null, fallback: TrackPrefs): TrackPrefs {
  return {
    audio: primary?.audio ?? fallback.audio,
    subtitle: primary?.subtitle ?? fallback.subtitle,
  };
}

/**
 * Which streams a viewer should be on for a title they have just been moved to.
 *
 * `fallback` is what the room put them on — in practice the host's tracks, which
 * are the only pair known to exist in this file. Each side falls back to it
 * independently, so a viewer whose audio language is present but whose subtitle
 * language isn't keeps the half that carried.
 *
 * The one case that isn't a fallback is a remembered "None" for subtitles. That
 * is an answer, not a failed match, and it survives into the next episode
 * however many subtitle tracks the new file happens to have. So is subtitles
 * being only for foreign audio, when the audio landed on is in their language.
 */
export function tracksForNewItem(
  available: { audioTracks: StreamTrack[]; subtitleTracks: StreamTrack[] },
  prefs: TrackPrefs,
  fallback: { audioStreamId: number; subtitleStreamId: number },
): { audioStreamId: number; subtitleStreamId: number } {
  const audioStreamId =
    matchAudioTrack(available.audioTracks, prefs.audio)?.id ?? fallback.audioStreamId;
  const audio = available.audioTracks.find((t) => t.id === audioStreamId);
  return {
    audioStreamId,
    subtitleStreamId: prefs.subtitle?.off || (prefs.subtitle && audio && ruleTurnsOff(prefs.subtitle, audio))
      ? 0
      : matchSubtitleTrack(available.subtitleTracks, prefs.subtitle)?.id
        ?? fallback.subtitleStreamId,
  };
}

/**
 * Best match for the stored audio preference among a new episode's tracks.
 *
 * Returns `null` when the preference names a language this file doesn't carry,
 * which the caller should read as "leave Plex's own choice alone" — unlike
 * subtitles, there is no sensible way to turn audio off, and picking some other
 * language because the wanted one is missing would be worse than the default.
 *
 * Ranks commentary above everything else it considers, in the sense that a
 * commentary track is only ever chosen for somebody who was listening to one:
 * a dub and its director's commentary share a language, and landing on the
 * wrong one is the difference between watching the film and not.
 */
export function matchAudioTrack(
  tracks: StreamTrack[],
  pref: AudioPref | null,
): StreamTrack | null {
  if (!pref || tracks.length === 0) return null;
  if (pref.original) return originalAudioTrack(tracks);

  const wantCommentary = isCommentary(pref.title);
  const sameLang = tracks.filter((t) => sameLanguage(t, pref));
  if (sameLang.length === 0) return null;
  // Some anime files tag *both* the Japanese and English streams as English,
  // leaving the real distinction only in the title: e.g. Plex reports
  // `languageCode="eng"` for both "Japanese (English AC3 Stereo)" and
  // "English (AC3 Stereo)". Language, channels and codec consequently tie and
  // the old stable sort always chose the first stream (usually Japanese, and
  // usually the file default). Treat a matching title prefix as stronger than
  // every technical tie-breaker so the user's actual choice carries over.
  const wantedTitleHint = titleLanguageHint(pref.title);

  const scored = sameLang.map((t) => {
    let score = 0;
    if (wantedTitleHint && titleLanguageHint(t.title) === wantedTitleHint) score += 16;
    if (isCommentary(t.title) === wantCommentary) score += 8;
    if (pref.channels != null && t.channels === pref.channels) score += 4;
    if (pref.codec && t.codec === pref.codec) score += 1;
    return { t, score };
  });
  // Stable, so an equal score keeps Plex's own ordering — which is the file's
  // track order, and the closest thing to a default it has.
  scored.sort((a, b) => b.score - a.score);
  return scored[0].t;
}

/**
 * The audio a title was made in.
 *
 * The server marks the tracks in the title's original language, from TMDB —
 * the one marked default as well, if there are two. Without that, the file is
 * all there is to go by: the track it marks as its default, unless that calls
 * itself a dub, then the first track. A file's default is often a dub, so the
 * mark is what makes this right; the rest is a fallback. Commentary is never
 * it.
 */
export function originalAudioTrack(tracks: StreamTrack[]): StreamTrack | null {
  const feature = tracks.filter((t) => !isCommentary(t.title));
  const pool = feature.length ? feature : tracks;
  const dub = (t: StreamTrack) => /\bdub(bed)?\b/i.test(t.title);
  return pool.find((t) => t.original && t.default)
    ?? pool.find((t) => t.original)
    ?? pool.find((t) => t.default && !dub(t))
    ?? pool.find((t) => !dub(t))
    ?? pool[0]
    ?? null;
}

/**
 * Choose a subtitle language from Settings: by language alone, with no
 * particular file's track to describe, and kept until it is changed there.
 * `"off"` is no subtitles. `"last"` is whatever gets picked while watching —
 * the choice already saved stays as where that starts.
 */
export function chooseSubtitleLanguage(choice: { code: string; name: string } | "off" | "last"): void {
  if (choice === "last") {
    const kept = loadSubtitlePref();
    if (kept?.pinned) {
      const { pinned: _, ...rest } = kept;
      write(SUBTITLE_PREF_KEY, rest);
    }
    return;
  }
  write(SUBTITLE_PREF_KEY, choice === "off"
    ? { off: true, pinned: true }
    : { off: false, languageCode: choice.code, language: choice.name, codec: null, title: null, pinned: true });
}

/**
 * The same, for audio: a language, `"original"` for whatever each title was
 * made in, or `"last"` for whatever gets picked while watching. A language
 * that is chosen but missing from a file leaves that file on its default.
 */
export function chooseAudioLanguage(choice: { code: string; name: string } | "original" | "last"): void {
  if (choice === "last") {
    const kept = loadAudioPref();
    if (kept?.original) forget(AUDIO_PREF_KEY);
    else if (kept?.pinned) {
      const { pinned: _, ...rest } = kept;
      write(AUDIO_PREF_KEY, rest);
    }
    return;
  }
  write(AUDIO_PREF_KEY, choice === "original"
    ? { original: true, pinned: true }
    : { languageCode: choice.code, language: choice.name, codec: null, title: null, channels: null, pinned: true });
}

function forget(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage unavailable — nothing was kept to forget.
  }
}

/**
 * Tracks carried from one title to the next within a sitting.
 *
 * A choice made in Settings isn't overwritten by what gets picked in a player,
 * so the saved preference can't be what carries a switch made mid-episode on
 * to the next one. This does, for as long as the player is open.
 */
let sitting: TrackPrefs | null = null;

/** What the player is on now, for whatever it plays next. */
export function carryTrackPrefs(prefs: TrackPrefs): void {
  sitting = mergeTrackPrefs(prefs, sitting ?? { audio: null, subtitle: null });
}

/** The player closed: the next one starts from the saved choices. */
export function endTrackSitting(): void {
  sitting = null;
}

/** The audio choice the next title starts from. */
export function startingAudioPref(): AudioPref | null {
  return sitting?.audio ?? loadAudioPref();
}

/** The subtitle choice the next title starts from. */
export function startingSubtitlePref(): SubtitlePref | null {
  return sitting?.subtitle ?? loadSubtitlePref();
}

/** Enough of a film or episode to say which title a track choice belongs to. */
export interface TitleRef {
  ratingKey: string;
  type?: string;
  grandparentRatingKey?: string | null;
}

/** A show's episodes share one choice; a film has its own. */
function titleKey(title: TitleRef): string {
  return title.type === "episode" && title.grandparentRatingKey
    ? `show:${title.grandparentRatingKey}`
    : `title:${title.ratingKey}`;
}

/** How many films and shows keep a choice; the longest unused go first. */
const TITLE_TRACKS_MAX = 500;

type TitleTracks = Record<string, { audio?: AudioPref; subtitle?: SubtitlePref; at: number }>;

function readTitleTracks(): TitleTracks {
  const all = read<TitleTracks>(TITLE_TRACKS_KEY, (p) => !!p && typeof p === "object" && !Array.isArray(p));
  return all ?? {};
}

/**
 * Remember a track picked for one film or show — on its page, or while
 * watching it — so that it starts on that track next time, whatever Settings
 * say. A choice made in Settings is everything else's default; this is the
 * exception someone made for this title, and it is kept as one. `subtitle`
 * null is "None". A side left out is left as it was.
 */
export function rememberTitleTracks(
  title: TitleRef,
  chosen: { audio?: StreamTrack | null; subtitle?: StreamTrack | null },
): void {
  const all = readTitleTracks();
  const key = titleKey(title);
  const entry = { ...(all[key] ?? {}), at: Date.now() };
  if (chosen.audio) entry.audio = { ...describe(chosen.audio), channels: chosen.audio.channels ?? null };
  if (chosen.subtitle !== undefined) {
    entry.subtitle = chosen.subtitle ? { off: false, ...describe(chosen.subtitle) } : { off: true };
  }
  all[key] = entry;
  const keys = Object.keys(all);
  if (keys.length > TITLE_TRACKS_MAX) {
    keys.sort((a, b) => all[a].at - all[b].at);
    for (const old of keys.slice(0, keys.length - TITLE_TRACKS_MAX)) delete all[old];
  }
  write(TITLE_TRACKS_KEY, all);
}

/** What was chosen for this film or show, if anything — see rememberTitleTracks. */
export function titleTrackPrefs(title: TitleRef | null | undefined): { audio: AudioPref | null; subtitle: SubtitlePref | null } {
  if (!title?.ratingKey) return { audio: null, subtitle: null };
  const entry = readTitleTracks()[titleKey(title)];
  return {
    audio: entry?.audio ?? null,
    subtitle: entry?.subtitle ? { ...entry.subtitle, forTitle: true } : null,
  };
}
