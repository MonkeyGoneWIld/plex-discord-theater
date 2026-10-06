/**
 * Languages offered when choosing a subtitle or audio language ahead of time,
 * in Settings — before there is a file whose own tracks could be listed. The
 * ones that turn up in a library like this one, by ISO 639-1 code; matching
 * against a file's tracks goes through trackPrefs, which understands Plex's
 * two- and three-letter codes alike.
 */
const CODES = [
  "ar", "bn", "zh", "cs", "da", "nl", "en", "fi", "fr", "de", "el", "he", "hi",
  "hu", "id", "it", "ja", "ko", "ms", "no", "fa", "pl", "pt", "ro", "ru", "es",
  "sv", "tl", "ta", "th", "tr", "uk", "ur", "vi",
];

const names = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" });
  } catch {
    return null;
  }
})();

/** A language's English name, or the code itself when it has none. */
export function languageName(code: string): string {
  try {
    return names?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** The languages to offer, by name. */
export const LANGUAGES: Array<{ code: string; name: string }> = CODES
  .map((code) => ({ code, name: languageName(code) }))
  .sort((a, b) => a.name.localeCompare(b.name));

/** A code in the form LANGUAGES uses — "eng" and "en" are both English. */
export function shortLanguageCode(code: string | null | undefined): string | null {
  if (!code) return null;
  try {
    return new Intl.Locale(code.toLowerCase().replace(/_/g, "-")).language;
  } catch {
    return code.toLowerCase();
  }
}
