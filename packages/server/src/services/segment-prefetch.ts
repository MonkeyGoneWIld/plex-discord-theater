/**
 * Proactively fetches HLS segments from Plex to absorb throttle delays.
 * After manifest fetch, polls the sub-manifest to discover available segments,
 * fetches them concurrently, and caches in memory for instant delivery.
 */

import { plexFetchSegment } from "./plex.js";

// ─── Types ──────────────────────────────────────────────────────

interface CachedSegment {
  data: Buffer;
  served: boolean;
  cachedAt: number;
}

interface PrefetchSession {
  sessionId: string;
  plexKey: string;
  pollTimer: ReturnType<typeof setInterval> | null;
  abortController: AbortController;
  segmentCache: Map<string, CachedSegment>;
  knownSegments: Set<string>;
  fetchQueue: string[];
  activeWorkers: number;
  /** Segment index playback starts at (offset ÷ segment seconds). After a
   *  far-seek restart the transcode begins here, so the queue is ordered from
   *  this point forward rather than from segment 0. */
  startIndex: number;
}

// ─── Constants ──────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2_000;
const MAX_CONCURRENT_FETCHES = 3;
const MAX_CACHE_SIZE = 100;
const EVICTION_THRESHOLD = 50;
const TRANSCODE_BASE = "/video/:/transcode/universal/";

// ─── Module State ───────────────────────────────────────────────

const sessions = new Map<string, PrefetchSession>();

// ─── M3U8 Parser ────────────────────────────────────────────────

/**
 * Parse an M3U8 sub-manifest and extract .ts segment filenames.
 * Returns full Plex paths (e.g. /video/:/transcode/universal/session/<key>/base/00000.ts).
 */
function parseSegmentPaths(m3u8Text: string, baseDir: string): string[] {
  const segments: string[] = [];
  for (const line of m3u8Text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      if (!trimmed.startsWith("/") && !trimmed.startsWith("http")) {
        segments.push(`${baseDir}${trimmed}`);
      } else if (trimmed.startsWith("/")) {
        segments.push(trimmed);
      }
    }
  }
  return segments;
}

/** Numeric segment index from a path like ".../00976.ts" (0 if unparseable). */
function segmentIndex(path: string): number {
  const m = path.match(/(\d+)\.ts$/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Order key for the fetch queue given the playback start segment. Segments at or
 * ahead of the playhead are fetched first, nearest-first (so playback is served
 * before anything else); segments behind the seek point sink to the tail — the
 * client is unlikely to need them after seeking forward.
 */
function queuePriority(startIndex: number, path: string): number {
  const idx = segmentIndex(path);
  return idx >= startIndex ? idx - startIndex : 1_000_000 + (startIndex - idx);
}

// ─── Eviction ───────────────────────────────────────────────────

/**
 * Evict old segments to stay within memory budget.
 * Prioritizes evicting served segments (already in VPS nginx cache).
 */
function evictIfNeeded(session: PrefetchSession): void {
  if (session.segmentCache.size <= EVICTION_THRESHOLD) return;

  // First pass: evict served segments (oldest first)
  const served: [string, CachedSegment][] = [];
  for (const [path, entry] of session.segmentCache) {
    if (entry.served) served.push([path, entry]);
  }
  served.sort((a, b) => a[1].cachedAt - b[1].cachedAt);
  for (const [path] of served) {
    session.segmentCache.delete(path);
    if (session.segmentCache.size <= EVICTION_THRESHOLD) return;
  }

  if (session.segmentCache.size >= MAX_CACHE_SIZE) {
    const all = [...session.segmentCache.entries()].sort(
      (a, b) => a[1].cachedAt - b[1].cachedAt,
    );
    for (const [path] of all) {
      session.segmentCache.delete(path);
      if (session.segmentCache.size <= EVICTION_THRESHOLD) return;
    }
  }
}

// ─── Fetch Workers ──────────────────────────────────────────────

/**
 * Worker that pulls segment paths from the queue and fetches them.
 * Runs until the queue is empty or the session is aborted.
 */
async function fetchWorker(session: PrefetchSession): Promise<void> {
  session.activeWorkers++;
  try {
    while (session.fetchQueue.length > 0) {
      if (session.abortController.signal.aborted) return;

      const segPath = session.fetchQueue.shift()!;

      if (session.segmentCache.has(segPath)) continue;

      try {
        const res = await plexFetchSegment(segPath);
        if (session.abortController.signal.aborted) return;

        if (!res.ok) {
          res.body?.cancel().catch(() => {});
          continue;
        }

        const data = Buffer.from(await res.arrayBuffer());
        if (session.abortController.signal.aborted) return;

        session.segmentCache.set(segPath, {
          data,
          served: false,
          cachedAt: Date.now(),
        });

        evictIfNeeded(session);
      } catch {
        if (session.abortController.signal.aborted) return;
      }
    }
  } finally {
    session.activeWorkers--;
  }
}

/** Spawn workers up to MAX_CONCURRENT_FETCHES if queue has items. */
function drainQueue(session: PrefetchSession): void {
  while (
    session.activeWorkers < MAX_CONCURRENT_FETCHES &&
    session.fetchQueue.length > 0 &&
    !session.abortController.signal.aborted
  ) {
    fetchWorker(session).catch((err) => {
      console.error("[Prefetch] Unexpected worker error:", err);
    });
  }
}

// ─── Sub-Manifest Polling ───────────────────────────────────────

/**
 * Poll the sub-manifest to discover new segments and queue them for fetching.
 */
async function pollSubManifest(session: PrefetchSession): Promise<void> {
  if (session.abortController.signal.aborted) return;

  const subManifestPath = `${TRANSCODE_BASE}session/${session.plexKey}/base/index.m3u8`;
  const baseDir = `${TRANSCODE_BASE}session/${session.plexKey}/base/`;

  try {
    const res = await plexFetchSegment(subManifestPath);
    if (!res.ok) {
      if (res.status === 404) {
        console.log("[Prefetch] Sub-manifest 404 — transcode may be dead, stopping poll for",
          session.plexKey.substring(0, 8));
        stopPrefetch(session.sessionId);
      }
      res.body?.cancel().catch(() => {});
      return;
    }

    const m3u8 = await res.text();
    const segments = parseSegmentPaths(m3u8, baseDir);

    let newCount = 0;
    for (const segPath of segments) {
      if (!session.knownSegments.has(segPath)) {
        session.knownSegments.add(segPath);
        session.fetchQueue.push(segPath);
        newCount++;
      }
    }

    if (newCount > 0) {
      // After a far-seek restart, fetch from the playhead forward instead of from
      // segment 0 — otherwise the queue burns throttle on pre-seek segments the
      // client will never request while it starves for the ones it's playing.
      if (session.startIndex > 0) {
        session.fetchQueue.sort(
          (a, b) => queuePriority(session.startIndex, a) - queuePriority(session.startIndex, b),
        );
      }
      console.log("[Prefetch]", session.plexKey.substring(0, 8),
        "discovered", newCount, "new segments (total:", session.knownSegments.size,
        session.startIndex > 0 ? `, from seg ${session.startIndex})` : ")");
      drainQueue(session);
    }
  } catch {
    if (session.abortController.signal.aborted) return;
  }
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Start pre-fetching segments for a transcode session.
 * Call after manifest fetch once the plexKey is known.
 */
const MAX_CONCURRENT_SESSIONS = 2;

export function startPrefetch(sessionId: string, plexKey: string, startIndex = 0): void {
  stopPrefetch(sessionId);

  // Guard: one Express process serves up to 2 Discord servers
  if (sessions.size >= MAX_CONCURRENT_SESSIONS) {
    console.warn("[Prefetch] Max concurrent sessions reached (" + MAX_CONCURRENT_SESSIONS +
      "), skipping prefetch for", sessionId.substring(0, 8));
    return;
  }

  const session: PrefetchSession = {
    sessionId,
    plexKey,
    pollTimer: null,
    abortController: new AbortController(),
    segmentCache: new Map(),
    knownSegments: new Set(),
    fetchQueue: [],
    activeWorkers: 0,
    startIndex: Math.max(0, startIndex),
  };

  sessions.set(sessionId, session);

  console.log("[Prefetch] Started for session", sessionId.substring(0, 8),
    "plexKey", plexKey.substring(0, 8));

  pollSubManifest(session);
  session.pollTimer = setInterval(() => pollSubManifest(session), POLL_INTERVAL_MS);
  session.pollTimer.unref();
}

/**
 * Stop pre-fetching and clear the cache for a session.
 */
export function stopPrefetch(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  console.log("[Prefetch] Stopping for session", sessionId.substring(0, 8),
    "(cached:", session.segmentCache.size, "segments)");

  session.abortController.abort();
  if (session.pollTimer) {
    clearInterval(session.pollTimer);
    session.pollTimer = null;
  }
  session.segmentCache.clear();
  session.knownSegments.clear();
  session.fetchQueue.length = 0;
  sessions.delete(sessionId);
}

/**
 * Look up a cached segment by its full Plex path.
 * Checks all active sessions. Returns the Buffer if found, undefined otherwise.
 * Marks the segment as served for eviction priority.
 */
export function getCachedSegment(plexPath: string): Buffer | undefined {
  for (const session of sessions.values()) {
    const entry = session.segmentCache.get(plexPath);
    if (entry) {
      entry.served = true;
      return entry.data;
    }
  }
  return undefined;
}
