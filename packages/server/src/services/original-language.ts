/**
 * Which of a title's audio tracks are in the language it was made in.
 *
 * "Original language" audio used to mean the track a file marks as its
 * default, and plenty of files mark a dub: an Italian release of Capote opens
 * on Italian, a dual-audio Re:Zero on English. TMDB knows each film's and
 * show's original language; this matches it against the tracks, so the player
 * can pick the one that is actually original.
 */

/** English language names, lower-cased, to their ISO 639-1 codes. */
const CODE_BY_NAME = (() => {
  const map = new Map<string, string>();
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
  } catch {
    return map;
  }
  for (let a = 97; a <= 122; a++) {
    for (let b = 97; b <= 122; b++) {
      const code = String.fromCharCode(a, b);
      try {
        const name = names.of(code);
        if (name) map.set(name.toLowerCase(), code);
      } catch {
        // Not a language code.
      }
    }
  }
  return map;
})();

/** "eng", "en", "en-US" alike → "en". Null for none, or "und". */
export function shortCode(code: string | null | undefined): string | null {
  if (!code) return null;
  const lower = code.toLowerCase().replace(/_/g, "-");
  if (lower === "und" || lower === "unk" || lower === "zxx" || lower === "mul") return null;
  try {
    return new Intl.Locale(lower).language;
  } catch {
    return lower;
  }
}

/**
 * The language a track is spoken in.
 *
 * Its title's first word, when that is a language's name: some anime files tag
 * the Japanese track "eng" and say Japanese only in its title ("Japanese
 * (English AC3 Stereo)"). Otherwise its tag.
 */
export function spokenLanguage(track: { title?: string | null; languageCode?: string | null }): string | null {
  const lead = (track.title ?? "").trim().split(/[\s(\-–|·,]+/, 1)[0]?.toLowerCase() ?? "";
  return CODE_BY_NAME.get(lead) ?? shortCode(track.languageCode);
}

function isCommentary(title?: string | null): boolean {
  return /\b(commentary|descriptive|audio description)\b/i.test(title ?? "");
}

/**
 * Mark the tracks in `originalLanguage` (ISO 639-1, from TMDB) as `original`.
 * Commentary never is. Nothing is marked when no track is in that language —
 * the player then goes by the file's own default.
 */
export function markOriginalAudio(
  tracks: Array<{ title?: string | null; languageCode?: string | null; original?: boolean }>,
  originalLanguage: string | null,
): void {
  const want = shortCode(originalLanguage);
  if (!want) return;
  for (const t of tracks) {
    if (!isCommentary(t.title) && spokenLanguage(t) === want) t.original = true;
  }
}
