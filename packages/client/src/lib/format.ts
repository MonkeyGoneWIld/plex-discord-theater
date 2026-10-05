/**
 * Fields needed to render a media title. Structural rather than a union of
 * PlexItem | QueueItem so any item-ish shape works.
 */
export interface TitleParts {
  title: string;
  year?: number;
  showTitle?: string;
  parentTitle?: string;
  parentIndex?: number;
  index?: number;
  /** Every episode a multi-episode file plays, in order — see FileEpisode. */
  fileEpisodes?: ReadonlyArray<{ index: number | null; title: string }>;
}

/**
 * Human-readable title: "Show — S1E2 · Episode Name" for episodes,
 * "Movie (2024)" for films, bare title as a last resort.
 *
 * The show name is read from `showTitle` first and `parentTitle` only as a
 * fallback, because two conventions coexist in this codebase:
 *
 *  - Server `mapItem()` mirrors Plex, where an episode's `parentTitle` is the
 *    SEASON ("Season 1") and the show lives in `grandparentTitle` → `showTitle`.
 *  - Client-built QueueItems (e.g. SeasonDetail) put the show name directly in
 *    `parentTitle` and carry no `showTitle`.
 *
 * Reading showTitle first keeps both correct; reading parentTitle first renders
 * server-sourced episodes as "Season 1 — S1E1 · …" with the show name missing.
 */
/** Milliseconds as a playback timecode: "1:04:12", or "4:12" under an hour. */
export function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * An air date as the episode page shows it: "June 3, 2005".
 *
 * Read from Plex's "YYYY-MM-DD" as written rather than through Date, which
 * takes it as UTC midnight and shows the day before anywhere west of UTC.
 * Null for anything that isn't such a date.
 */
export function formatAirDate(iso: string | null | undefined): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

/** Coarse "when did this happen" label for history rows. */
export function formatWhen(timestamp: number): string {
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? "A week ago" : `${weeks} weeks ago`;
  }
  return new Date(timestamp).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function formatMediaTitle(item: TitleParts): string {
  const show = item.showTitle ?? item.parentTitle;
  if (show) {
    // A multi-episode file names every episode it plays, as Plex does:
    // "Show — S2E18–E19 · First Title / Second Title".
    const episodes = item.fileEpisodes && item.fileEpisodes.length > 1 ? item.fileEpisodes : null;
    if (episodes) {
      const first = episodes[0].index ?? "?";
      const last = episodes[episodes.length - 1].index ?? "?";
      const titles = episodes.map((e) => e.title || `Episode ${e.index ?? "?"}`).join(" / ");
      return `${show} — S${item.parentIndex ?? "?"}E${first}–E${last} · ${titles}`;
    }
    return `${show} — S${item.parentIndex ?? "?"}E${item.index ?? "?"} · ${item.title}`;
  }
  if (item.year) return `${item.title} (${item.year})`;
  return item.title;
}
