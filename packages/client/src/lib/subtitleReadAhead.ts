import { apiPost, fetchMeta, versionOf } from "./api";
import {
  matchAudioTrack,
  startingAudioPref,
  startingSubtitle,
  startingSubtitlePref,
  titleTrackPrefs,
  type AudioPref,
  type SubtitlePref,
} from "./trackPrefs";

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
 * against the title's own tracks, with the audio they would get. Nothing is
 * asked for when that is none, or a picture subtitle (which is burned in, not
 * read out). Never throws: this is a
 * head start, and failing to get one changes nothing else.
 */
export async function readSubtitlesAhead(
  ratingKey: string,
  scope: "first" | "all",
  opts: { mediaIndex?: number; pref?: SubtitlePref | null; audio?: AudioPref | null } = {},
): Promise<void> {
  try {
    const meta = await fetchMeta(ratingKey);
    const version = versionOf(meta, opts.mediaIndex);
    const own = titleTrackPrefs(meta);
    const audioTracks = version.audioTracks ?? [];
    const audio = matchAudioTrack(audioTracks, opts.audio ?? own.audio ?? startingAudioPref())
      ?? audioTracks.find((t) => t.selected);
    const track = startingSubtitle(
      version.subtitleTracks ?? [],
      opts.pref ?? own.subtitle ?? startingSubtitlePref(),
      audio,
    );
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
