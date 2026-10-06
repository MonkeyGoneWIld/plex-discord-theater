import { apiPost, fetchMeta, versionOf } from "./api";
import { loadSubtitlePref, matchSubtitleTrack, type SubtitlePref } from "./trackPrefs";

/**
 * Have the server read a title's subtitle out of the file before anyone plays
 * it, so the stream doesn't start with "Loading subtitles…" for the minute
 * Plex takes to go through a film.
 *
 *   "first" — a title someone is looking at: only the subtitle they would start
 *             on, read when nothing more pressing is, and dropped if they move
 *             on to another title first.
 *   "all"   — the episode coming up next: every subtitle it has, soon.
 *
 * The subtitle is the one this viewer would get — their saved choice, matched
 * against the title's own tracks. Nothing is asked for when that is none, or a
 * picture subtitle (which is burned in, not read out). Never throws: this is a
 * head start, and failing to get one changes nothing else.
 */
export async function readSubtitlesAhead(
  ratingKey: string,
  scope: "first" | "all",
  opts: { mediaIndex?: number; pref?: SubtitlePref | null } = {},
): Promise<void> {
  try {
    const version = versionOf(await fetchMeta(ratingKey), opts.mediaIndex);
    const track = matchSubtitleTrack(version.subtitleTracks ?? [], opts.pref ?? loadSubtitlePref());
    if (scope === "first" && !track?.external) return;
    await apiPost("/api/plex/subtitles/prefetch", {
      ratingKey,
      ...(opts.mediaIndex != null && { mediaIndex: opts.mediaIndex }),
      ...(track?.external && { first: track.id }),
      scope,
    });
  } catch {
    // A head start, nothing more.
  }
}

/** Ask for the subtitle with this id specifically — a page that already knows
 *  which one it is showing. */
export function readSubtitleAhead(ratingKey: string, streamId: number, mediaIndex?: number): void {
  apiPost("/api/plex/subtitles/prefetch", {
    ratingKey,
    ...(mediaIndex != null && { mediaIndex }),
    first: streamId,
    scope: "first",
  }).catch(() => { /* A head start, nothing more. */ });
}
