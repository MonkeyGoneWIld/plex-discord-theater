import type { StreamTrack } from "./api";

const STORAGE_KEY = "pdt:subtitlePref";

/**
 * A remembered subtitle choice, stored by *description* rather than by stream id.
 *
 * Plex assigns subtitle stream ids per media part, so the id of "English (SRT)"
 * on S1E4 says nothing about the same track on S1E5. What carries across
 * episodes is the language and the flavour of the track, so that is what gets
 * persisted and re-matched against the next episode's stream list.
 */
export interface SubtitlePref {
  /** `null` means the user explicitly chose "None" — remembered, so an opt-out
   *  isn't undone by a later episode that happens to have a default track. */
  off: boolean;
  languageCode?: string | null;
  language?: string | null;
  codec?: string | null;
  /** Plex spells forced/SDH variants into the title, which is the only place
   *  they appear — kept so "English Forced" doesn't match plain "English". */
  title?: string | null;
}

/** Forced/SDH/CC flavour flags parsed out of a track title. */
function flavour(title?: string | null): { forced: boolean; sdh: boolean } {
  const t = (title ?? "").toLowerCase();
  return { forced: t.includes("forced"), sdh: t.includes("sdh") || t.includes("cc") };
}

export function loadSubtitlePref(): SubtitlePref | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SubtitlePref;
    return typeof parsed?.off === "boolean" ? parsed : null;
  } catch {
    // Storage unavailable or corrupt — fall back to "no preference".
    return null;
  }
}

/** Remember the track just chosen. Pass `null` for the "None" option. */
export function saveSubtitlePref(track: StreamTrack | null): void {
  const pref: SubtitlePref = track
    ? {
        off: false,
        languageCode: track.languageCode ?? null,
        language: track.language ?? null,
        codec: track.codec ?? null,
        title: track.title ?? null,
      }
    : { off: true };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pref));
  } catch {
    // Storage unavailable — the choice just won't outlive this episode.
  }
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
  const sameLang = tracks.filter((t) =>
    pref.languageCode && t.languageCode
      ? t.languageCode === pref.languageCode
      : (t.language ?? "").toLowerCase() === (pref.language ?? "").toLowerCase(),
  );
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
