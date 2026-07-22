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
export function formatMediaTitle(item: TitleParts): string {
  const show = item.showTitle ?? item.parentTitle;
  if (show) {
    return `${show} — S${item.parentIndex ?? "?"}E${item.index ?? "?"} · ${item.title}`;
  }
  if (item.year) return `${item.title} (${item.year})`;
  return item.title;
}
