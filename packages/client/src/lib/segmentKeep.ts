/**
 * What this page has of the film from the bot, kept where the page after it
 * finds it.
 *
 * Discord's pop-out reloads the activity, and so does coming back from it. A
 * page back found the page before's segments only while the browser's HTTP
 * cache still had them, and under a 20 to 38 Mbps film it often hadn't let
 * them go or had at random: on 14 October seven pages back found theirs and
 * landed playing in about a second, and four found nothing and landed and
 * waited by the bot's speed, 3.5 to 8.3 seconds. Cache Storage keeps what it
 * is given until it is taken out — the check made that evening
 * (lib/storageCheck) found the page before's entry whole after every pop-out —
 * so every whole segment this page has from the bot goes there as well, and
 * the page after asks there first (installSegmentParts, inBrowserCache).
 *
 * For five minutes, as the bot lets the browser keep them; in one cache per
 * minute, so that letting go of what is older is deleting whole caches, and at
 * most KEEP_BYTES of this page's, the oldest minute let go first. Where Cache
 * Storage refuses — monkey26's first device that evening threw SecurityError
 * opening it — nothing is kept or looked for, and everything goes as before.
 */
import { logEvent, logWarn } from "./log";

const PREFIX = "pdt-segments-";
/** As long as the bot lets the browser keep a segment (its Cache-Control). */
const KEEP_FOR_MS = 5 * 60_000;
const MINUTE_MS = 60_000;
/** This page's kept segments at most: more than three minutes of a 38 Mbps
 *  film, which is more than any player here holds ahead of where it plays. */
const KEEP_BYTES = 1_500_000_000;
/**
 * Segments being kept at once, at most — read and waiting for Cache Storage to
 * take them. Each holds its bytes in the page until then, so writes that fall
 * behind the downloads would pile up in memory: a segment that comes in while
 * this many are still being kept isn't kept. On 14 October Troy's page held
 * 1.5 GB more than the P2P engine may keep, two hours in with a skip or two a
 * minute, and climbing.
 */
const KEEPING_AT_MOST = 3;

/** What keeping needs of Cache Storage — the browser's, or a stand-in. */
type Store = Pick<CacheStorage, "open" | "keys" | "delete" | "match">;
let store: Store | null | undefined;
function cacheStorage(): Store | null {
  if (store === undefined) store = typeof caches === "undefined" ? null : caches;
  return store;
}
/** For the tests: a Cache Storage of their own, and a page's state afresh. */
export function useCacheStorageForTests(s: Store | null): void {
  store = s;
  ownBytes.clear();
  sweptMinute = null;
  servedOne = false;
  keeping = 0;
  notKept = 0;
  stopped = false;
}

/** This page's kept bytes, by minute. */
const ownBytes = new Map<number, number>();
/** Segments being kept now, and those not kept for it — see KEEPING_AT_MOST. */
let keeping = 0;
let notKept = 0;
/** Set when memory runs short: nothing more is kept — see stopKeepingSegments. */
let stopped = false;
/** The minute old caches were last let go in. */
let sweptMinute: number | null = null;
let servedOne = false;

function refused(err: unknown, doing: string): void {
  if (store === null) return;
  store = null;
  logWarn("Storage", "not keeping the film for the page after this one: Cache Storage refused", {
    doing,
    error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
  });
}

/** Whether this page keeps segments at all. */
export function keepingSegments(): boolean {
  return cacheStorage() !== null && !stopped;
}

/** Whether to keep one more segment now, or let it go by — KEEPING_AT_MOST. */
export function roomToKeep(): boolean {
  if (keeping < KEEPING_AT_MOST) return true;
  if (notKept++ === 0) logWarn("Storage", "keeping the film for the page after this one has fallen behind: letting segments go by", { keeping });
  return false;
}

/** Keep nothing more on this page, for want of memory; what is kept stays. */
export function stopKeepingSegments(): void {
  stopped = true;
}

/** How keeping is going, for the health samples. */
export function keepStats(): { keptMB: number; keeping: number; notKept: number } {
  let bytes = 0;
  for (const b of ownBytes.values()) bytes += b;
  return { keptMB: Math.round(bytes / 1e6), keeping, notKept };
}

/** Let go of minutes past keeping, once a minute; and of this page's oldest
 *  while it has more than KEEP_BYTES. */
async function letGo(s: Store, minute: number): Promise<void> {
  if (sweptMinute !== minute) {
    sweptMinute = minute;
    for (const name of await s.keys()) {
      if (!name.startsWith(PREFIX)) continue;
      const m = Number(name.slice(PREFIX.length));
      if (Number.isFinite(m) && (m + 1) * MINUTE_MS > Date.now() - KEEP_FOR_MS) continue;
      await s.delete(name);
      ownBytes.delete(m);
    }
  }
  let total = 0;
  for (const b of ownBytes.values()) total += b;
  for (const m of [...ownBytes.keys()].sort((a, b) => a - b)) {
    if (total <= KEEP_BYTES) break;
    total -= ownBytes.get(m)!;
    ownBytes.delete(m);
    await s.delete(PREFIX + m);
  }
}

/**
 * Keep the segment at `url` as `body` brings it — a branch of what is handed
 * on, read here as fast as it comes. Kept only whole: `bytes` long when its
 * size is known, and never when the download fails or is called off.
 */
export async function keepSegment(url: string, body: ReadableStream<Uint8Array>, contentType: string | null, bytes: number | null): Promise<void> {
  keeping++;
  try {
    await keepWhole(url, body, contentType, bytes);
  } finally {
    keeping--;
  }
}

async function keepWhole(url: string, body: ReadableStream<Uint8Array>, contentType: string | null, bytes: number | null): Promise<void> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    return;
  }
  const s = cacheStorage();
  if (!s || stopped || size === 0 || (bytes !== null && size !== bytes)) return;
  const minute = Math.floor(Date.now() / MINUTE_MS);
  // The bytes go into the Blob here; the page's own copies of them needn't
  // wait for Cache Storage too.
  const blob = new Blob(chunks as BlobPart[]);
  chunks.length = 0;
  try {
    const cache = await s.open(PREFIX + minute);
    await cache.put(url, new Response(blob, {
      headers: {
        "Content-Type": contentType ?? "video/mp2t",
        "Content-Length": String(size),
        "x-kept-at": String(Date.now()),
      },
    }));
    ownBytes.set(minute, (ownBytes.get(minute) ?? 0) + size);
    await letGo(s, minute);
  } catch (err) {
    // Full is no reason to stop: older minutes go, and the next one may fit.
    if (err instanceof DOMException && err.name === "QuotaExceededError") {
      for (const m of [...ownBytes.keys()].sort((a, b) => a - b).slice(0, -1)) {
        ownBytes.delete(m);
        await s.delete(PREFIX + m).catch(() => false);
      }
      return;
    }
    refused(err, "keeping a segment");
  }
}

/** The segment at `url` as this page or the one before it kept it, within the
 *  five minutes; null when it isn't kept. */
export async function keptSegment(url: string): Promise<Response | null> {
  const s = cacheStorage();
  if (!s) return null;
  try {
    const kept = await s.match(url);
    if (!kept) return null;
    const at = Number(kept.headers.get("x-kept-at"));
    if (!(Date.now() - at <= KEEP_FOR_MS)) {
      kept.body?.cancel().catch(() => {});
      return null;
    }
    if (!servedOne) {
      servedOne = true;
      // On a page back, the page before's.
      logEvent("Storage", "a segment from what was kept on this device", { keptAgoS: Math.round((Date.now() - at) / 1000) });
    }
    return kept;
  } catch (err) {
    refused(err, "looking for a segment");
    return null;
  }
}
