import type { StreamTrack } from "./api";

const SUBTITLE_KEY = "pdt:subtitlePref";
const AUDIO_KEY = "pdt:audioPref";

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
}

export interface TrackPrefs {
  audio: AudioPref | null;
  subtitle: SubtitlePref | null;
}

export interface SubtitlePref extends TrackPref {
  /** `true` means the user explicitly chose "None" — remembered, so an opt-out
   *  isn't undone by a later episode that happens to have a default track. */
  off: boolean;
}

export interface AudioPref extends TrackPref {
  /** 2 for stereo, 6 for 5.1, and so on. A dub often ships in fewer channels
   *  than the original, so this separates "the Japanese 5.1" from "the Japanese
   *  stereo" when a file carries both. */
  channels?: number | null;
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
  return read<SubtitlePref>(SUBTITLE_KEY, (p) => typeof (p as SubtitlePref)?.off === "boolean");
}

/** Remember the subtitle just chosen. Pass `null` for the "None" option. */
export function saveSubtitlePref(track: StreamTrack | null): void {
  write(SUBTITLE_KEY, track ? { off: false, ...describe(track) } : { off: true });
}

export function loadAudioPref(): AudioPref | null {
  return read<AudioPref>(AUDIO_KEY, (p) => !!p && typeof p === "object");
}

/** Remember the audio track just chosen. There is no "off" — every file has audio. */
export function saveAudioPref(track: StreamTrack | null): void {
  if (!track) return;
  write(AUDIO_KEY, { ...describe(track), channels: track.channels ?? null });
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
 */
export function matchSubtitleTrack(
  tracks: StreamTrack[],
  pref: SubtitlePref | null,
): StreamTrack | null {
  if (!pref || pref.off || tracks.length === 0) return null;

  const wantFlavour = flavour(pref.title);
  const sameLang = tracks.filter((t) => sameLanguage(t, pref));
  if (sameLang.length === 0) return null;

  // Rank within the language: flavour (forced/SDH) matters most, then codec.
  const scored = sameLang.map((t) => {
    const f = flavour(t.title);
    let score = 0;
    if (f.forced === wantFlavour.forced) score += 4;
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
 * A subtitle id of 0 is "none", and is described as a deliberate opt-out.
 */
export function describeWatched(
  available: { audioTracks: StreamTrack[]; subtitleTracks: StreamTrack[] },
  watching: { audioStreamId: number; subtitleStreamId: number },
): TrackPrefs {
  const audio = available.audioTracks.find((t) => t.id === watching.audioStreamId);
  const subtitle = available.subtitleTracks.find((t) => t.id === watching.subtitleStreamId);
  return {
    audio: audio ? { ...describe(audio), channels: audio.channels ?? null } : null,
    subtitle: watching.subtitleStreamId === 0
      ? { off: true }
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
 * however many subtitle tracks the new file happens to have.
 */
export function tracksForNewItem(
  available: { audioTracks: StreamTrack[]; subtitleTracks: StreamTrack[] },
  prefs: TrackPrefs,
  fallback: { audioStreamId: number; subtitleStreamId: number },
): { audioStreamId: number; subtitleStreamId: number } {
  return {
    audioStreamId:
      matchAudioTrack(available.audioTracks, prefs.audio)?.id ?? fallback.audioStreamId,
    subtitleStreamId: prefs.subtitle?.off
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

  const wantCommentary = isCommentary(pref.title);
  const sameLang = tracks.filter((t) => sameLanguage(t, pref));
  if (sameLang.length === 0) return null;

  const scored = sameLang.map((t) => {
    let score = 0;
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
