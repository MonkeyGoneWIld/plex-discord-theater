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
/** Milliseconds as a playback timecode: "1:04:12", or "4:12" under an hour. */
export function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
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
    return `${show} — S${item.parentIndex ?? "?"}E${item.index ?? "?"} · ${item.title}`;
  }
  if (item.year) return `${item.title} (${item.year})`;
  return item.title;
}
