import { plexJSON } from "./plex.js";
import { buildMeta, getRelatedCached } from "../routes/plex.js";

/**
 * Background cache warmer.
 *
 * The detail pages need three things before they can paint: the item's
 * metadata (with its cast), its collections, and its TMDB recommendations.
 * Fetched on demand that is several round trips to Plex and TMDB with the user
 * watching a skeleton. This walks the library after startup and fills those
 * caches ahead of time, so opening a title is a cache hit.
 *
 * Deliberately slow and bounded. It runs behind the server rather than in front
 * of it, and a library of any size would otherwise mean thousands of Plex calls
 * in a burst — on the same machine that is about to transcode video. One item at
 * a time with a pause between them keeps it in the background where it belongs.
 */

const ENABLED = process.env.WARM_CACHE !== "0";
/** Titles to keep warm. Beyond this the tail is unlikely to be opened before
 *  the next pass comes round anyway. */
const MAX_ITEMS = Number(process.env.WARM_CACHE_MAX_ITEMS ?? 600);
/** Gap between items — the throttle that keeps this off Plex's critical path. */
const ITEM_DELAY_MS = Number(process.env.WARM_CACHE_DELAY_MS ?? 250);
/** How long after boot to start, letting the server settle first. */
const START_DELAY_MS = 15_000;
/** Re-run interval. Comfortably inside the 6h /collections TTL, so warm entries
 *  are refreshed rather than allowed to expire under a user. */
const INTERVAL_MS = Number(process.env.WARM_CACHE_INTERVAL_MIN ?? 240) * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let running = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every movie and show ratingKey in the library, newest first — the order that
 *  best matches what people actually open. */
async function libraryRatingKeys(): Promise<string[]> {
  const sections = await plexJSON<{
    MediaContainer: { Directory?: Array<{ key: string; type: string }> };
  }>("/library/sections");

  const keys: string[] = [];
  for (const dir of sections.MediaContainer.Directory ?? []) {
    if (dir.type !== "movie" && dir.type !== "show") continue;
    const data = await plexJSON<{
      MediaContainer: { Metadata?: Array<{ ratingKey: string }> };
    }>(`/library/sections/${dir.key}/all`, {
      // Newest first, and capped per section so one huge library can't crowd out
      // the others entirely.
      sort: "addedAt:desc",
      "X-Plex-Container-Start": "0",
      "X-Plex-Container-Size": String(MAX_ITEMS),
    });
    for (const item of data.MediaContainer.Metadata ?? []) keys.push(item.ratingKey);
  }
  return keys.slice(0, MAX_ITEMS);
}

/**
 * Warm `/collections` by asking our own route for it.
 *
 * That endpoint's work isn't factored out the way buildMeta is — it has several
 * exit points and writes its own cache entry on each — so the cheapest correct
 * way to populate it is to make the same request a client would. Localhost, and
 * one at a time.
 */
async function warmRelated(port: number, ratingKey: string): Promise<void> {
  if (getRelatedCached(ratingKey)) return;
  const res = await fetch(`http://127.0.0.1:${port}/api/plex/collections/${ratingKey}`);
  // Drain the body so the socket is released promptly.
  await res.arrayBuffer().catch(() => undefined);
}

async function runPass(port: number): Promise<void> {
  if (running) return;
  running = true;
  const startedAt = Date.now();
  let warmed = 0;
  try {
    const keys = await libraryRatingKeys();
    for (const ratingKey of keys) {
      try {
        await buildMeta(ratingKey);
        await warmRelated(port, ratingKey);
        warmed++;
      } catch {
        // One unreachable title must not end the pass — the next one may be fine.
      }
      await sleep(ITEM_DELAY_MS);
    }
    console.log(
      `[warm] cached ${warmed}/${keys.length} titles in ${Math.round((Date.now() - startedAt) / 1000)}s`,
    );
  } catch (err) {
    console.warn("[warm] pass failed:", err);
  } finally {
    running = false;
  }
}

/** Begin warming in the background. No-op when WARM_CACHE=0. */
export function startCacheWarmer(port: number): void {
  if (!ENABLED) {
    console.log("[warm] disabled (WARM_CACHE=0)");
    return;
  }
  setTimeout(() => {
    void runPass(port);
    timer = setInterval(() => void runPass(port), INTERVAL_MS);
    // Don't hold the process open on shutdown for the sake of a warm-up pass.
    timer.unref?.();
  }, START_DELAY_MS).unref?.();
}

export function stopCacheWarmer(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
