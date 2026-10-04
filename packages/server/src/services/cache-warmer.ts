import { plexJSON } from "./plex.js";
import {
  buildMeta,
  getRelatedCached,
  invalidateTitleDetailCaches,
  seasonEpisodeSourcesConfigured,
  warmSeasonEpisodes,
  warmThumb,
  type PlexMetadataItem,
  type RelatedPayload,
} from "../routes/plex.js";
import { createSession } from "../middleware/auth.js";
import { detailCacheMatches, markDetailCacheVersion } from "./detail-cache.js";
import { replaceLibraryIndex } from "./library-index.js";
import { numberSetting } from "./env-settings.js";
import * as thumbCache from "./thumb-cache.js";
import {
  BACKDROP_SIZE,
  END_CARD_STILL_SIZE,
  EPISODE_STILL_SIZE,
  PERSON_SIZE,
  POSTER_SIZE,
  WARM_PORTRAITS_PER_TITLE,
  type ArtworkSize,
} from "./artwork-sizes.js";

/**
 * Background cache warmer.
 *
 * The detail pages need three things before they can paint: the item's
 * metadata (with its cast), its collections, and its TMDB recommendations.
 * Fetched on demand that is several round trips to Plex and TMDB with the user
 * watching a skeleton. This walks the library after startup and fills those
 * caches ahead of time, so opening a title is a cache hit.
 *
 * Then the artwork for those titles: posters and backdrops, then each title's
 * first portraits, then the posters in its collection and "More Like This"
 * rows. Then every season and episode of the shows among them: each season's
 * full episode list from TVDB or TMDB, episode details, season posters,
 * episode stills at the three sizes they are shown at, and each episode's
 * first portraits. Every image is fetched at the size the page asks for, so
 * the image proxy answers from its cache instead of waiting for Plex to resize
 * an original. Anything already cached is skipped, so after the first pass
 * only what is new, changed or expired costs anything.
 *
 * Deliberately slow and bounded. It runs behind the server rather than in front
 * of it, and a library of any size would otherwise mean thousands of Plex calls
 * in a burst — on the same machine that is about to transcode video. One request
 * at a time with a pause after each keeps it in the background where it
 * belongs, and nothing is asked of Plex at all while a room is playing.
 */

const ENABLED = process.env.WARM_CACHE !== "0";
/** Posters, backdrops, portraits and episode stills. WARM_CACHE_ARTWORK=0 leaves
 *  artwork to be fetched when a page first shows it. */
const ARTWORK = process.env.WARM_CACHE_ARTWORK !== "0";
/** Each warmed show's seasons and episodes. WARM_CACHE_EPISODES=0 stops at the
 *  show itself. */
const EPISODES = process.env.WARM_CACHE_EPISODES !== "0";
/** Titles to keep warm, newest first, or "all" for the whole library. Beyond
 *  the default the tail is unlikely to be opened before the next pass comes
 *  round anyway. */
const MAX_ITEMS = process.env.WARM_CACHE_MAX_ITEMS?.trim().toLowerCase() === "all"
  ? Infinity
  : numberSetting("WARM_CACHE_MAX_ITEMS", 600);
/** Pause after each title, episode or image fetched from Plex — the throttle
 *  that keeps this off Plex's critical path. Nothing already cached waits. */
const ITEM_DELAY_MS = numberSetting("WARM_CACHE_DELAY_MS", 250);
/** How often to look again while a room is playing. */
const BUSY_POLL_MS = 30_000;
/**
 * How full the image cache may get from warming. When the cache is full it
 * evicts its oldest entries, so warming into a full cache would push out
 * images people opened and then fetch them again on the next pass. Stopping
 * short leaves the rest for images pages fetch themselves. Raise
 * THUMB_CACHE_MAX_SIZE to warm more.
 */
const ARTWORK_CACHE_SHARE = 0.9;
/** How long after boot to start, letting the server settle first. */
const START_DELAY_MS = 15_000;
/** Re-run interval. Comfortably inside the 6h /collections TTL, so warm entries
 *  are refreshed rather than allowed to expire under a user. */
const INTERVAL_MS = numberSetting("WARM_CACHE_INTERVAL_MIN", 240, 1) * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let running = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CatalogItem extends PlexMetadataItem {
  addedAt?: number;
  updatedAt?: number;
}

const CATALOG_PAGE_SIZE = 1_000;

/**
 * One catalog scan supplies both jobs the old warmer performed expensively:
 * the newest-first warm queue and a complete local ownership index for TMDB
 * recommendations. Ownership matching can then stay in memory instead of
 * issuing as many as twenty `/hubs/search` requests for each title.
 */
async function libraryCatalog(): Promise<CatalogItem[]> {
  const sections = await plexJSON<{
    MediaContainer: { Directory?: Array<{ key: string; type: string }> };
  }>("/library/sections");

  const items: CatalogItem[] = [];
  for (const dir of sections.MediaContainer.Directory ?? []) {
    if (dir.type !== "movie" && dir.type !== "show") continue;
    let start = 0;
    for (;;) {
      const data = await plexJSON<{
        MediaContainer: { Metadata?: CatalogItem[]; totalSize?: number };
      }>(`/library/sections/${dir.key}/all`, {
        sort: "addedAt:desc",
        includeGuids: "1",
        "X-Plex-Container-Start": String(start),
        "X-Plex-Container-Size": String(CATALOG_PAGE_SIZE),
      });
      const page = data.MediaContainer.Metadata ?? [];
      const sectionId = Number.parseInt(dir.key, 10);
      for (const item of page) {
        items.push({
          ...item,
          librarySectionID: item.librarySectionID ?? (Number.isFinite(sectionId) ? sectionId : undefined),
        });
      }
      start += page.length;
      if (
        page.length === 0 ||
        page.length < CATALOG_PAGE_SIZE ||
        (data.MediaContainer.totalSize != null && start >= data.MediaContainer.totalSize)
      ) break;
    }
  }
  return items;
}

/**
 * Session the warmer authenticates with.
 *
 * /api/plex sits behind requireAuth, and these requests carried no credentials
 * at all — so every one answered 401 while the pass counted it a success and
 * reported "cached 600/600". None of the collections half was ever warmed.
 *
 * Minted lazily and re-minted on a 401, because sessions expire after 24h
 * (SESSION_TTL_MS in middleware/auth.ts) and this process outlives that. A
 * token cached for the life of the process meant the warmer worked for one day
 * and then quietly 401'd forever — the same failure it was just fixed for,
 * arriving a day late.
 */
let warmerToken: string | null = null;
function getWarmerToken(): string {
  if (!warmerToken) warmerToken = createSession();
  return warmerToken;
}

/**
 * Warm `/collections` by asking our own route for it.
 *
 * That endpoint's work isn't factored out the way buildMeta is — several exit
 * points, each writing its own cache entry — so the cheapest correct way to
 * populate it is to make the request a client would. Localhost, one at a time,
 * and exempt from the API rate limit (see the loopback skip in index.ts, which
 * this pass would otherwise exhaust on its own: 600 items, 600 requests).
 *
 * Throws on a non-OK response so the caller doesn't count it as warmed.
 */
async function warmRelated(port: number, ratingKey: string): Promise<void> {
  if (getRelatedCached(ratingKey)) return;

  const call = () =>
    fetch(`http://127.0.0.1:${port}/api/plex/collections/${ratingKey}`, {
      headers: { Authorization: `Bearer ${getWarmerToken()}` },
    });

  let res = await call();
  // Expired (or evicted) session — mint a new one and try once more.
  if (res.status === 401) {
    await res.arrayBuffer().catch(() => undefined);
    warmerToken = null;
    res = await call();
  }
  // Drain the body so the socket is released promptly.
  await res.arrayBuffer().catch(() => undefined);
  if (!res.ok) throw new Error(`collections warm failed: ${res.status}`);
}

/** What a pass needs from its caller. Injected so the server can say when a room
 *  is playing without this module importing the sync service, and so tests can. */
export interface WarmOptions {
  /** True while a room is playing. Nothing is asked of Plex until it is false. */
  isBusy?: () => boolean;
  busyPollMs?: number;
}

interface PassContext {
  port: number;
  isBusy: () => boolean;
  busyPollMs: number;
  /** Set once the image cache reaches ARTWORK_CACHE_SHARE. No more artwork this pass. */
  cacheFull: boolean;
}

interface ArtworkTally {
  fetched: number;
  cached: number;
  failed: number;
}

/**
 * Hold the next request to Plex while a room is playing.
 *
 * Every request here lands on the Plex server that is transcoding the room's
 * stream. One poster costs it little, but a first pass is tens of thousands
 * of them, and that is better spent between films than during one.
 */
async function whenIdle(ctx: PassContext): Promise<void> {
  if (!ctx.isBusy()) return;
  console.log("[warm] paused while a room is playing");
  while (ctx.isBusy()) await sleep(ctx.busyPollMs);
  console.log("[warm] resumed");
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${+(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${+(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${+(bytes / 1024).toFixed(1)} KB`;
}

/** An artwork URL as the API gives it to the client — see mapItem. */
function apiThumb(plexPath: string | undefined): string | null {
  return plexPath ? `/api/plex/thumb${plexPath}` : null;
}

async function warmImage(
  ctx: PassContext,
  tally: ArtworkTally,
  url: string | null,
  size: ArtworkSize,
): Promise<void> {
  if (!url || ctx.cacheFull) return;
  const { bytes, maxBytes } = thumbCache.usage();
  if (bytes >= maxBytes * ARTWORK_CACHE_SHARE) {
    ctx.cacheFull = true;
    console.log(
      `[warm] image cache is ${Math.round((bytes / maxBytes) * 100)}% of its ${formatSize(maxBytes)}; ` +
      "no more artwork this pass (THUMB_CACHE_MAX_SIZE raises the limit)",
    );
    return;
  }
  const outcome = await warmThumb(url, size.w, size.h, () => whenIdle(ctx));
  tally[outcome]++;
  // Only a request that reached Plex is paced. A pass over a warm cache is
  // all cache hits and has no reason to take hours.
  if (outcome !== "cached") await sleep(ITEM_DELAY_MS);
}

/**
 * The portraits a title page shows first: directors, then cast, without
 * repeats, up to WARM_PORTRAITS_PER_TITLE. The order and limit match the
 * client's hover prefetch.
 */
export function portraitUrls(meta: Record<string, unknown> | null): string[] {
  const credits = (list: unknown) => (Array.isArray(list) ? list : []) as Array<{ thumb?: string | null }>;
  const urls = new Set<string>();
  for (const person of [...credits(meta?.directors), ...credits(meta?.cast)]) {
    if (urls.size >= WARM_PORTRAITS_PER_TITLE) break;
    if (person.thumb) urls.add(person.thumb);
  }
  return [...urls];
}

/**
 * The posters in a title's collection and "More Like This" rows, as the
 * shelves draw them: an episode card shows its show's poster. Titles not in
 * the library carry TMDB artwork, which the proxy resizes itself.
 */
export function relatedPosterUrls(related: RelatedPayload | null): string[] {
  type Card = { type?: string; thumb?: string | null; showThumb?: string | null };
  const cards = [
    ...(related?.collections ?? []).flatMap((row) => ((row as { items?: Card[] }).items ?? [])),
    ...((related?.recommendations ?? []) as Card[]),
  ];
  const urls = new Set<string>();
  for (const card of cards) {
    const poster = card.type === "episode" ? card.showThumb ?? card.thumb : card.thumb;
    if (poster) urls.add(poster);
  }
  return [...urls];
}

/** Titles: the detail-page data, rebuilt only where Plex's copy changed. */
async function warmDetails(ctx: PassContext, candidates: CatalogItem[]): Promise<void> {
  const startedAt = Date.now();
  let warmed = 0;
  let unchanged = 0;
  for (const item of candidates) {
    const ratingKey = String(item.ratingKey);
    const sourceUpdatedAt = item.updatedAt;
    if (sourceUpdatedAt != null && detailCacheMatches(ratingKey, sourceUpdatedAt)) {
      unchanged++;
      continue;
    }
    await whenIdle(ctx);
    // Disk and memory must agree on invalidation. Otherwise buildMeta would
    // immediately return the old persistent row we came here to replace.
    invalidateTitleDetailCaches(ratingKey);
    try {
      const meta = await buildMeta(ratingKey);
      if (!meta) throw new Error("metadata warm returned no item");
      await warmRelated(ctx.port, ratingKey);
      if (sourceUpdatedAt != null) markDetailCacheVersion(ratingKey, sourceUpdatedAt);
      warmed++;
    } catch {
      // One unreachable title must not end the pass — the next one may be fine.
    }
    await sleep(ITEM_DELAY_MS);
  }
  console.log(
    `[warm] refreshed ${warmed}, reused ${unchanged}/${candidates.length} titles in ${Math.round((Date.now() - startedAt) / 1000)}s`,
  );
}

/**
 * Titles: posters and backdrops for all of them first, since the library grid
 * is the first thing anyone sees, then their portraits, then the posters in
 * their related rows.
 */
async function warmTitleArtwork(ctx: PassContext, candidates: CatalogItem[]): Promise<void> {
  const startedAt = Date.now();
  const tally: ArtworkTally = { fetched: 0, cached: 0, failed: 0 };
  for (const item of candidates) {
    await warmImage(ctx, tally, apiThumb(item.thumb), POSTER_SIZE);
    await warmImage(ctx, tally, apiThumb(item.art), BACKDROP_SIZE);
  }
  for (const item of candidates) {
    // Answered from the detail cache the first phase just filled. Only a title
    // that failed there reaches Plex.
    await whenIdle(ctx);
    const meta = await buildMeta(String(item.ratingKey)).catch(() => null);
    for (const url of portraitUrls(meta)) await warmImage(ctx, tally, url, PERSON_SIZE);
  }
  for (const item of candidates) {
    // Saved by the first phase. A title whose rows failed there has none.
    const related = getRelatedCached(String(item.ratingKey));
    for (const url of relatedPosterUrls(related)) await warmImage(ctx, tally, url, POSTER_SIZE);
  }
  console.log(
    `[warm] title artwork: fetched ${tally.fetched}, already cached ${tally.cached}, failed ${tally.failed} in ${Math.round((Date.now() - startedAt) / 1000)}s`,
  );
}

/**
 * Shows: every season and episode.
 *
 * Each season's full episode list first, the one that shows its missing and
 * upcoming episodes, when TVDB or TMDB is set up. Then episode details,
 * rebuilt only where Plex's copy changed, the same test titles get. Then the
 * artwork: season posters, then each episode's still at the three sizes it is
 * shown at — the season's list, the episode's own page, where a film has its
 * poster, and the card at the end of the episode before it — then each
 * episode's first portraits, guest cast included.
 */
async function warmEpisodes(ctx: PassContext, shows: CatalogItem[]): Promise<void> {
  const startedAt = Date.now();
  const tally: ArtworkTally = { fetched: 0, cached: 0, failed: 0 };
  const lists: ArtworkTally = { fetched: 0, cached: 0, failed: 0 };
  const seasonLists = seasonEpisodeSourcesConfigured();
  let refreshed = 0;
  let unchanged = 0;
  let failed = 0;
  let episodeCount = 0;
  for (const show of shows) {
    const showKey = String(show.ratingKey);
    let seasons: CatalogItem[];
    let episodes: CatalogItem[];
    try {
      await whenIdle(ctx);
      const children = await plexJSON<{ MediaContainer: { Metadata?: CatalogItem[] } }>(
        `/library/metadata/${showKey}/children`,
      );
      const leaves = await plexJSON<{ MediaContainer: { Metadata?: CatalogItem[] } }>(
        `/library/metadata/${showKey}/allLeaves`,
      );
      seasons = children.MediaContainer.Metadata ?? [];
      episodes = leaves.MediaContainer.Metadata ?? [];
    } catch {
      continue;
    }
    await sleep(ITEM_DELAY_MS);
    episodeCount += episodes.length;

    if (seasonLists) {
      for (const season of seasons) {
        const outcome = await warmSeasonEpisodes(String(season.ratingKey), () => whenIdle(ctx));
        lists[outcome]++;
        if (outcome !== "cached") await sleep(ITEM_DELAY_MS);
      }
    }

    for (const episode of episodes) {
      const ratingKey = String(episode.ratingKey);
      const sourceUpdatedAt = episode.updatedAt;
      if (sourceUpdatedAt != null && detailCacheMatches(ratingKey, sourceUpdatedAt, ["meta"])) {
        unchanged++;
        continue;
      }
      await whenIdle(ctx);
      invalidateTitleDetailCaches(ratingKey);
      try {
        if (!(await buildMeta(ratingKey))) throw new Error("metadata warm returned no item");
        if (sourceUpdatedAt != null) markDetailCacheVersion(ratingKey, sourceUpdatedAt);
        refreshed++;
      } catch {
        failed++;
      }
      await sleep(ITEM_DELAY_MS);
    }

    if (ARTWORK) {
      for (const season of seasons) await warmImage(ctx, tally, apiThumb(season.thumb), POSTER_SIZE);
      for (const size of [EPISODE_STILL_SIZE, POSTER_SIZE, END_CARD_STILL_SIZE]) {
        for (const episode of episodes) await warmImage(ctx, tally, apiThumb(episode.thumb), size);
      }
      for (const episode of episodes) {
        if (ctx.cacheFull) break;
        await whenIdle(ctx);
        const meta = await buildMeta(String(episode.ratingKey)).catch(() => null);
        for (const url of portraitUrls(meta)) await warmImage(ctx, tally, url, PERSON_SIZE);
      }
    }
  }
  console.log(
    `[warm] episodes of ${shows.length} shows: refreshed ${refreshed}, reused ${unchanged}/${episodeCount}, failed ${failed}; ` +
    (seasonLists ? `season lists fetched ${lists.fetched}, reused ${lists.cached}, failed ${lists.failed}; ` : "") +
    `artwork fetched ${tally.fetched}, already cached ${tally.cached}, failed ${tally.failed} in ${Math.round((Date.now() - startedAt) / 1000)}s`,
  );
}

/** One full pass. Exported for tests; the server runs it from startCacheWarmer. */
export async function runWarmPass(port: number, options: WarmOptions = {}): Promise<void> {
  if (running) return;
  running = true;
  const ctx: PassContext = {
    port,
    isBusy: options.isBusy ?? (() => false),
    busyPollMs: options.busyPollMs ?? BUSY_POLL_MS,
    cacheFull: false,
  };
  try {
    await whenIdle(ctx);
    const catalog = await libraryCatalog();
    replaceLibraryIndex(catalog);
    const candidates = [...catalog]
      .sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0))
      .slice(0, MAX_ITEMS);

    await warmDetails(ctx, candidates);
    if (ARTWORK) await warmTitleArtwork(ctx, candidates);
    if (EPISODES) await warmEpisodes(ctx, candidates.filter((item) => item.type === "show"));
  } catch (err) {
    console.warn("[warm] pass failed:", err);
  } finally {
    running = false;
  }
}

/**
 * Begin warming in the background. No-op when WARM_CACHE=0. `isBusy` reports
 * whether a room is playing, which holds every request to Plex until it isn't.
 */
export function startCacheWarmer(port: number, isBusy: () => boolean = () => false): void {
  if (!ENABLED) {
    console.log("[warm] disabled (WARM_CACHE=0)");
    return;
  }
  setTimeout(() => {
    void runWarmPass(port, { isBusy });
    timer = setInterval(() => void runWarmPass(port, { isBusy }), INTERVAL_MS);
    // Don't hold the process open on shutdown for the sake of a warm-up pass.
    timer.unref?.();
  }, START_DELAY_MS).unref?.();
}

export function stopCacheWarmer(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
