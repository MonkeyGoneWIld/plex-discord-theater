/**
 * Episodes that play the same file.
 *
 * Plex files a multi-episode file — "S02E18-E19" — as one episode entry per
 * episode, each pointing at that same file. Plex's own players treat the file as
 * the unit: playing either entry marks both played, and the episode after
 * either one is E20. Treating the entries as ordinary neighbours instead played
 * the file twice in a row, once as E18 and again as E19.
 *
 * The file path is only ever compared here, on the server; it is never sent to
 * a client.
 */
import { plexJSON } from "./plex.js";
import { LruMap } from "./lru.js";

/** As much of a Plex episode as these helpers read. */
export interface PlexEpisodeLike {
  ratingKey?: string;
  index?: number;
  title?: string;
  type?: string;
  parentRatingKey?: string;
  Media?: Array<{ Part?: Array<{ id?: number; file?: string }> }>;
}

/** One episode a multi-episode file plays, as the client is told about it. */
export interface FileEpisode {
  ratingKey: string;
  index: number | null;
  title: string;
}

/** What identifies the files an episode plays: its part ids and paths. */
function fileKeys(episode: PlexEpisodeLike): Set<string> {
  const keys = new Set<string>();
  for (const media of episode.Media ?? []) {
    for (const part of media.Part ?? []) {
      if (part.file) keys.add(`file:${part.file}`);
      if (part.id != null) keys.add(`part:${part.id}`);
    }
  }
  return keys;
}

/** Whether two episodes play the same file. False when either says nothing about its files. */
export function sharesFile(a: PlexEpisodeLike, b: PlexEpisodeLike): boolean {
  const ours = fileKeys(a);
  if (ours.size === 0) return false;
  for (const key of fileKeys(b)) if (ours.has(key)) return true;
  return false;
}

/**
 * The run of neighbouring episodes around `i` that play the same file as it —
 * just `i` itself for an ordinary episode. Bounds are inclusive. `episodes`
 * must be in episode order, as /allLeaves and a season's /children return them.
 */
export function sameFileRun(
  episodes: readonly PlexEpisodeLike[],
  i: number,
): { start: number; end: number } {
  let start = i;
  let end = i;
  while (start > 0 && sharesFile(episodes[start - 1], episodes[i])) start--;
  while (end < episodes.length - 1 && sharesFile(episodes[end + 1], episodes[i])) end++;
  return { start, end };
}

/** Membership changes only when the library is rescanned. */
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new LruMap<string, { at: number; episodes: Promise<FileEpisode[]> }>(2_000);

/**
 * Every episode the file behind `ratingKey` plays, in order — or an empty list
 * when it plays only its own: a film, an ordinary episode, or anything Plex
 * can't describe. Cached, since playback asks on every progress write.
 */
export function episodesInSameFile(ratingKey: string): Promise<FileEpisode[]> {
  const hit = cache.get(ratingKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.episodes;
  const episodes = lookUp(ratingKey);
  cache.set(ratingKey, { at: Date.now(), episodes });
  // A failure is not an answer worth keeping for ten minutes.
  episodes.catch(() => cache.delete(ratingKey));
  return episodes;
}

async function lookUp(ratingKey: string): Promise<FileEpisode[]> {
  type Listing = { MediaContainer: { Metadata?: PlexEpisodeLike[] } };
  const item = (await plexJSON<Listing>(`/library/metadata/${ratingKey}`)).MediaContainer.Metadata?.[0];
  if (item?.type !== "episode" || !item.parentRatingKey) return [];
  // A multi-episode file never spans seasons, so the season is enough.
  const season = (await plexJSON<Listing>(`/library/metadata/${item.parentRatingKey}/children`))
    .MediaContainer.Metadata ?? [];
  const leaves = season.filter((e) => e.type === "episode" && e.ratingKey);
  const i = leaves.findIndex((e) => e.ratingKey === ratingKey);
  if (i === -1) return [];
  const { start, end } = sameFileRun(leaves, i);
  if (end === start) return [];
  return leaves.slice(start, end + 1).map((e) => ({
    ratingKey: e.ratingKey!,
    index: e.index ?? null,
    title: e.title ?? "",
  }));
}
