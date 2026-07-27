/**
 * Proactively fetches HLS segments from Plex to absorb throttle delays.
 * After manifest fetch, polls the sub-manifest to discover available segments,
 * fetches them concurrently, and caches in memory for instant delivery.
 */

import { plexFetchSegment } from "./plex.js";

// Verbose per-poll logging, off in production unless DEBUG=1 (mirrors routes/plex.ts).
const DEBUG = process.env.DEBUG === "1" || process.env.NODE_ENV !== "production";

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
  /** First segment to fetch — the seek offset's segment (0 for play-from-start).
   *  Segments before this are never fetched: the client seeked past them. */
  startIndex: number;
  /** Highest segment index actually delivered by Plex ≈ the transcode head.
   *  Diagnostic only now — the fetch ceiling is anchored to playbackIndex. */
  maxFetchedIndex: number;
  /** Segment the host is actually playing, fed from its keep-alive pings. This
   *  is what the fetch ceiling hangs off: see the comment on LEAD_SEGMENTS. */
  playbackIndex: number;
  /** Consecutive polls that produced nothing to queue, so a session that has
   *  quietly stopped making progress announces itself instead of going silent. */
  idlePolls: number;
}

// ─── Constants ──────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2_000;
const MAX_CONCURRENT_FETCHES = 3;
const MAX_CACHE_SIZE = 100;
const EVICTION_THRESHOLD = 50;
/**
 * How far past the *playhead* to keep requesting — ×3s ≈ 150s, comfortably over
 * the client's 120s buffer target.
 *
 * This used to hang off the transcode head instead, which sounds equivalent and
 * isn't: every successful fetch advanced the head, which raised the ceiling,
 * which queued more fetches. The ceiling ratcheted forward as fast as Plex could
 * encode and nothing in this module knew where the viewer was. In one session it
 * reached segment 2348 of a 2389-segment film while playback sat at 1188 —
 * ~1,300 segments pulled and discarded through a 50-entry cache, the transcoder
 * driven to the end of the file with an hour of the movie still unwatched, and
 * the viewer's buffer draining to zero behind it. Anchoring to the playhead is
 * what makes the lead a lead rather than a head start.
 */
const LEAD_SEGMENTS = 50;
/** Seconds per segment — Plex is asked for secondsPerSegment=3 at decision time. */
const SEGMENT_SECONDS = 3;
/** Polls with nothing new before we say so. ×2s, so ~30s of no progress. */
const IDLE_POLLS_BEFORE_WARN = 15;
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
          // 404 = ahead of the transcode head (not produced yet). Un-mark it so a
          // later poll re-queues it once the head reaches it — dropping it forever
          // is what let the head stop being pulled and the buffer drain.
          if (res.status === 404) session.knownSegments.delete(segPath);
          continue;
        }

        const data = Buffer.from(await res.arrayBuffer());
        if (session.abortController.signal.aborted) return;

        session.segmentCache.set(segPath, {
          data,
          served: false,
          cachedAt: Date.now(),
        });
        // This segment exists, so the head is at least here — slide the window.
        const idx = segmentIndex(segPath);
        if (idx > session.maxFetchedIndex) session.maxFetchedIndex = idx;

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

    // Queue only segments within [startIndex, playhead + LEAD], in order. Below
    // startIndex: seeked past. Above the ceiling: not needed yet — they get
    // queued on a later poll once the playhead advances toward them, which is
    // what stops the window from running away to the end of the file. The 404
    // un-mark in the worker keeps re-queuing near-head segments until produced.
    const windowTop = session.playbackIndex + LEAD_SEGMENTS;
    let newCount = 0;
    for (const segPath of segments) {
      const idx = segmentIndex(segPath);
      if (idx < session.startIndex || idx > windowTop) continue;
      if (session.knownSegments.has(segPath)) continue;
      session.knownSegments.add(segPath);
      session.fetchQueue.push(segPath);
      newCount++;
    }

    if (newCount > 0) {
      session.idlePolls = 0;
      // leadS is the number to watch: it should hover around LEAD_SEGMENTS×3s.
      // Unbounded growth here is the runaway this window exists to prevent.
      if (DEBUG) console.log("[Prefetch]", session.plexKey.substring(0, 8),
        "queued", newCount, "segments (head", session.maxFetchedIndex,
        "playback", session.playbackIndex,
        "lead", `${(session.maxFetchedIndex - session.playbackIndex) * SEGMENT_SECONDS}s`,
        session.startIndex > 0 ? `, from seg ${session.startIndex})` : ")");
      drainQueue(session);
    } else if (++session.idlePolls === IDLE_POLLS_BEFORE_WARN) {
      // Not necessarily fatal — a paused stream looks like this — but it is also
      // exactly how a dead transcode presents, and previously the prefetcher
      // just stopped logging and left seven minutes of silence before the
      // buffer ran dry.
      console.warn("[Prefetch] no new segments for",
        (IDLE_POLLS_BEFORE_WARN * POLL_INTERVAL_MS) / 1000, "s —",
        "plexKey", session.plexKey.substring(0, 8),
        "head", session.maxFetchedIndex, "playback", session.playbackIndex,
        "cached", session.segmentCache.size);
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

  const start = Math.max(0, startIndex);
  const session: PrefetchSession = {
    sessionId,
    plexKey,
    pollTimer: null,
    abortController: new AbortController(),
    segmentCache: new Map(),
    knownSegments: new Set(),
    fetchQueue: [],
    activeWorkers: 0,
    startIndex: start,
    // Seed the head at the start segment so the initial window is
    // [start, start + LEAD]; it advances as real segments come in.
    maxFetchedIndex: start,
    // Seeded to the same place, so a cold start still races ahead to fill the
    // first buffer before any ping has told us where playback really is.
    playbackIndex: start,
    idlePolls: 0,
  };

  sessions.set(sessionId, session);

  console.log("[Prefetch] Started for session", sessionId.substring(0, 8),
    "plexKey", plexKey.substring(0, 8));

  pollSubManifest(session);
  session.pollTimer = setInterval(() => pollSubManifest(session), POLL_INTERVAL_MS);
  session.pollTimer.unref();
}

/**
 * Tell the prefetcher where playback actually is, so the fetch ceiling tracks
 * the viewer instead of the encoder. Called from the host's keep-alive ping,
 * which already carries the position.
 *
 * Monotonic: a backward jump means a seek, and a seek restarts the transcode
 * (and therefore this session) at the new offset, so there is nothing to gain
 * from lowering the ceiling on a stale or out-of-order ping.
 */
export function updatePrefetchPosition(sessionId: string, positionSeconds: number): void {
  const session = sessions.get(sessionId);
  if (!session || !Number.isFinite(positionSeconds)) return;
  const idx = Math.floor(positionSeconds / SEGMENT_SECONDS);
  if (idx > session.playbackIndex) session.playbackIndex = idx;
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
