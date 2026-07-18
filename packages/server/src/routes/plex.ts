import { Router, type Request, type Response } from "express";
import { plexFetch, plexFetchSegment, plexJSON, plexUrl } from "../services/plex.js";
import { startPrefetch, stopPrefetch, getCachedSegment } from "../services/segment-prefetch.js";
import * as thumbCache from "../services/thumb-cache.js";

const router = Router();
const DEBUG = process.env.NODE_ENV !== "production";

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const NUMERIC_RE = /^\d+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PROXY_PATH_LENGTH = 500;

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);


const ALLOWED_MEDIA_TYPES = new Set([
  "video/MP2T",
  "video/mp2t",
  "application/vnd.apple.mpegurl",
]);

// Pre-compile the Plex URL regex at module level (plexBase never changes at runtime)
const plexBase = process.env.PLEX_URL?.replace(/\/$/, "") ?? "";
const PLEX_URL_REGEX = new RegExp(escapeRegExp(plexBase) + "(/[^\\s]{1,500})", "g");
const RELATIVE_URL_REGEX = /^(?!#)(?!https?:\/\/)(?!\/api\/plex\/)(.{1,500}\.(?:m3u8|ts).{0,200})$/gm;
const PLEX_TOKEN_REGEX = /[?&]X-Plex-Token=[^&\s]*/g;

// VPS relay config — when set, HLS segment URLs point to the VPS
// instead of proxying through this Express server.
const VPS_RELAY_URL = process.env.VPS_RELAY_URL?.replace(/\/$/, "");
const VPS_RELAY_KEY = process.env.VPS_RELAY_KEY;

// ─── Types ──────────────────────────────────────────────────────

interface PlexDirectory {
  key: string;
  title: string;
  type: string;
}

interface PlexStream {
  id: number;
  streamType: number;
  codec?: string;
  channels?: number;
  language?: string;
  languageCode?: string;
  displayTitle?: string;
  extendedDisplayTitle?: string;
  title?: string;
  selected?: boolean;
}

interface PlexPart {
  id: number;
  Stream?: PlexStream[];
}

interface PlexMedia {
  Part?: PlexPart[];
}

interface PlexMetadataItem {
  ratingKey: string;
  title: string;
  year?: number;
  type: string;
  thumb?: string;
  summary?: string;
  duration?: number;
  art?: string;
  Genre?: Array<{ tag: string }>;
  Media?: PlexMedia[];
  index?: number;
  parentIndex?: number;
  parentTitle?: string;
  leafCount?: number;
  childCount?: number;
}

// ─── Library browsing ────────────────────────────────────────────

/**
 * GET /api/plex/config
 * Returns client-facing configuration (VPS relay status, etc.)
 */
router.get("/config", (_req: Request, res: Response) => {
  res.json({
    vpsRelay: !!(VPS_RELAY_URL && VPS_RELAY_KEY),
  });
});

/**
 * GET /api/plex/sections
 * List all library sections (Movies, TV Shows, etc.)
 */
const ALLOWED_SECTION_TYPES = new Set(["movie", "show"]);

router.get("/sections", async (_req: Request, res: Response) => {
  try {
    const data = await plexJSON<{ MediaContainer: { Directory?: PlexDirectory[] } }>("/library/sections");
    const directories = data.MediaContainer.Directory || [];
    const sections = directories
      .filter((d) => ALLOWED_SECTION_TYPES.has(d.type))
      .map((d) => ({
        id: d.key,
        title: d.title,
        type: d.type,
      }));
    res.json({ sections });
  } catch (err) {
    console.error("Sections error:", err);
    res.status(502).json({ error: "Failed to fetch library sections" });
  }
});

/**
 * GET /api/plex/sections/:id/genres
 * List all genres available in a library section.
 */
router.get("/sections/:id/genres", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (!NUMERIC_RE.test(id)) {
    res.status(400).json({ error: "Invalid section ID" });
    return;
  }

  try {
    const data = await plexJSON<{
      MediaContainer: { Directory?: Array<{ key: string; title: string }> };
    }>(`/library/sections/${id}/genre`);
    const genres = (data.MediaContainer.Directory || []).map((d) => ({
      id: d.key,
      title: d.title,
    }));
    res.json({ genres });
  } catch (err) {
    console.error("Genres error:", err);
    res.status(502).json({ error: "Failed to fetch genres" });
  }
});

/**
 * GET /api/plex/sections/:id/all
 * List all items in a library section.
 * Optional query params:
 *   genre - comma-separated numeric genre IDs (AND logic)
 *   sort  - one of: titleSort:asc, year:desc, year:asc, addedAt:desc, rating:desc
 */
const ALLOWED_SORTS = new Set([
  "titleSort:asc",
  "year:desc",
  "year:asc",
  "addedAt:desc",
  "rating:desc",
]);

router.get("/sections/:id/all", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (!NUMERIC_RE.test(id)) {
    res.status(400).json({ error: "Invalid section ID" });
    return;
  }

  const start = Math.max(0, parseInt(req.query.start as string, 10) || 0);
  const size = Math.min(100, Math.max(1, parseInt(req.query.size as string, 10) || 50));

  const params: Record<string, string> = {
    "X-Plex-Container-Start": String(start),
    "X-Plex-Container-Size": String(size),
  };

  // Genre filter — validate each ID is numeric
  const genreParam = req.query.genre as string | undefined;
  if (genreParam) {
    const ids = genreParam.split(",");
    if (ids.every((g) => NUMERIC_RE.test(g))) {
      params.genre = ids.join(",");
    } else {
      res.status(400).json({ error: "Invalid genre IDs" });
      return;
    }
  }

  // Sort — whitelist allowed values
  const sortParam = req.query.sort as string | undefined;
  if (sortParam) {
    if (ALLOWED_SORTS.has(sortParam)) {
      params.sort = sortParam;
    } else {
      res.status(400).json({ error: "Invalid sort value" });
      return;
    }
  }

  try {
    const data = await plexJSON<{
      MediaContainer: { Metadata?: PlexMetadataItem[]; totalSize?: number };
    }>(`/library/sections/${id}/all`, params);
    const items = (data.MediaContainer.Metadata || []).map(mapItem);
    const totalSize = data.MediaContainer.totalSize ?? items.length;
    res.json({ items, totalSize, start, size });
  } catch (err) {
    console.error("Section items error:", err);
    res.status(502).json({ error: "Failed to fetch section items" });
  }
});

/**
 * GET /api/plex/search?q=<query>
 * Search across all Plex libraries.
 */
router.get("/search", async (req: Request, res: Response) => {
  const q = req.query.q;
  if (!q || typeof q !== "string") {
    res.status(400).json({ error: "Missing query parameter q" });
    return;
  }
  if (q.length > 200) {
    res.status(400).json({ error: "Query too long" });
    return;
  }

  try {
    const data = await plexJSON<{
      MediaContainer: { Hub?: Array<{ Metadata?: PlexMetadataItem[] }> };
    }>("/hubs/search", { query: q });
    const hubs = data.MediaContainer.Hub || [];
    const items: ReturnType<typeof mapItem>[] = [];
    for (const hub of hubs) {
      if (!hub.Metadata) continue;
      for (const m of hub.Metadata) {
        items.push(mapItem(m));
      }
    }
    res.json({ items });
  } catch (err) {
    console.error("Search error:", err);
    res.status(502).json({ error: "Failed to search Plex" });
  }
});

/**
 * GET /api/plex/meta/:ratingKey
 * Get detailed metadata for a single item.
 */
router.get("/meta/:ratingKey", async (req: Request, res: Response) => {
  const ratingKey = req.params.ratingKey as string;
  if (!NUMERIC_RE.test(ratingKey)) {
    res.status(400).json({ error: "Invalid rating key" });
    return;
  }

  try {
    const data = await plexJSON<{ MediaContainer: { Metadata?: PlexMetadataItem[] } }>(
      `/library/metadata/${ratingKey}`,
    );
    const metadata = data.MediaContainer.Metadata;
    if (!metadata || metadata.length === 0) {
      res.status(404).json({ error: "Item not found" });
      return;
    }
    const m = metadata[0];
    const part = m.Media?.[0]?.Part?.[0];
    const streams = part?.Stream || [];
    const audioTracks = streams
      .filter((s) => s.streamType === 2)
      .map((s) => ({
        id: s.id,
        title: s.extendedDisplayTitle || s.displayTitle || s.title || "Unknown",
        codec: s.codec ?? null,
        channels: s.channels ?? null,
        language: s.language ?? null,
        languageCode: s.languageCode ?? null,
        selected: !!s.selected,
      }));
    const subtitleTracks = streams
      .filter((s) => s.streamType === 3)
      .map((s) => ({
        id: s.id,
        title: s.extendedDisplayTitle || s.displayTitle || s.title || "Unknown",
        language: s.language ?? null,
        languageCode: s.languageCode ?? null,
        selected: !!s.selected,
      }));

    // Cache duration for timeline stopped notifications
    if (m.duration && m.ratingKey) {
      mediaDurations.set(m.ratingKey, m.duration);
    }

    res.json({
      ratingKey: m.ratingKey,
      title: m.title,
      year: m.year,
      summary: m.summary,
      duration: m.duration,
      thumb: m.thumb ? `/api/plex/thumb${m.thumb}` : null,
      art: m.art ? `/api/plex/thumb${m.art}` : null,
      genres: (m.Genre || []).map((g) => g.tag),
      type: m.type,
      partId: part?.id ?? null,
      audioTracks,
      subtitleTracks,
    });
  } catch (err) {
    console.error("Metadata error:", err);
    res.status(502).json({ error: "Failed to fetch metadata" });
  }
});

/**
 * GET /api/plex/children/:ratingKey
 * Get children of a container (show → seasons, season → episodes).
 */
router.get("/children/:ratingKey", async (req: Request, res: Response) => {
  const ratingKey = req.params.ratingKey as string;
  if (!NUMERIC_RE.test(ratingKey)) {
    res.status(400).json({ error: "Invalid rating key" });
    return;
  }

  try {
    const data = await plexJSON<{ MediaContainer: { Metadata?: PlexMetadataItem[] } }>(
      `/library/metadata/${ratingKey}/children`,
    );
    const items = (data.MediaContainer.Metadata || []).map(mapItem);
    res.json({ items });
  } catch (err) {
    console.error("Children error:", err);
    res.status(502).json({ error: "Failed to fetch children" });
  }
});

/**
 * PUT /api/plex/streams/:partId
 * Set audio/subtitle stream selection on a media part before transcoding.
 */
router.put("/streams/:partId", async (req: Request, res: Response) => {
  const partId = req.params.partId as string;
  if (!NUMERIC_RE.test(partId)) {
    res.status(400).json({ error: "Invalid part ID" });
    return;
  }

  const { audioStreamID, subtitleStreamID } = req.body ?? {};
  const params: Record<string, string> = { allParts: "1" };
  if (audioStreamID != null && NUMERIC_RE.test(String(audioStreamID))) {
    params.audioStreamID = String(audioStreamID);
  }
  if (subtitleStreamID != null) {
    const id = String(subtitleStreamID);
    if (id === "0" || NUMERIC_RE.test(id)) {
      params.subtitleStreamID = id;
    }
  }

  try {
    const plexRes = await plexFetch(`/library/parts/${partId}`, params, undefined, "PUT");
    if (!plexRes.ok) {
      res.status(plexRes.status).json({ error: "Failed to set streams" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Set streams error:", err);
    res.status(502).json({ error: "Failed to set streams" });
  }
});

// ─── Image proxy ────────────────────────────────────────────────

/**
 * GET /api/plex/thumb/*
 * Proxy Plex images (posters, artwork).
 * Optional query params ?w=320&h=480 to resize via Plex's photo transcoder.
 */
router.get("/thumb/*", async (req: Request, res: Response) => {
  const imagePath = "/" + (req.params[0] as string);
  if (imagePath.length > MAX_PROXY_PATH_LENGTH || !isAllowedThumbPath(imagePath)) {
    res.status(400).end();
    return;
  }

  const w = req.query.w as string | undefined;
  const h = req.query.h as string | undefined;
  if (w && !NUMERIC_RE.test(w)) { res.status(400).end(); return; }
  if (h && !NUMERIC_RE.test(h)) { res.status(400).end(); return; }
  const cacheKey = w && h ? `${imagePath}:${w}x${h}` : imagePath;

  // Check server-side cache first
  const cached = thumbCache.get(cacheKey);
  if (cached) {
    res.setHeader("Content-Type", cached.contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(cached.data);
    return;
  }

  try {
    // Use Plex photo transcoder for resized images, raw fetch for full-size
    const plexRes = w && h
      ? await plexFetch("/photo/:/transcode", {
          width: w,
          height: h,
          minSize: "1",
          upscale: "1",
          url: imagePath,
        })
      : await plexFetch(imagePath);

    if (!plexRes.ok) {
      plexRes.body?.cancel().catch(() => {});
      res.status(plexRes.status).end();
      return;
    }
    const contentType = plexRes.headers.get("content-type");
    const resolvedType =
      contentType && ALLOWED_IMAGE_TYPES.has(contentType.split(";")[0])
        ? contentType
        : "application/octet-stream";

    const contentLength = plexRes.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > 10 * 1024 * 1024) {
      plexRes.body?.cancel().catch(() => {});
      res.status(502).end();
      return;
    }

    // Buffer the response so we can cache it
    const data = Buffer.from(await plexRes.arrayBuffer());
    if (data.length > 10 * 1024 * 1024) {
      res.status(502).end();
      return;
    }

    // Store in cache (fire-and-forget, don't block response)
    try {
      thumbCache.set(cacheKey, resolvedType, data);
    } catch (cacheErr) {
      console.error("Thumb cache write error:", cacheErr);
    }

    res.setHeader("Content-Type", resolvedType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(data);
  } catch (err) {
    console.error("Thumb proxy error:", err);
    res.status(502).end();
  }
});

// ─── HLS helpers ────────────────────────────────────────────────

const OUR_CLIENT_ID = "plex-discord-theater";

/**
 * Maps our session UUID → Plex's internal transcode key.
 * Plex generates its own key (visible in segment URLs like session/<key>/base/...)
 * which differs from the X-Plex-Session-Identifier we send. We need the Plex key
 * to reliably stop transcodes.
 */
const plexTranscodeKeys = new Map<string, string>();
/** Maps our session UUID → the ratingKey being played (needed for timeline stopped). */
const sessionRatingKeys = new Map<string, string>();
/** Maps ratingKey → duration in ms (cached from metadata endpoint for timeline stopped). */
const mediaDurations = new Map<string, number>();
const PLEX_SESSION_KEY_RE = /session\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i;

/** Look up the Plex internal transcode key for one of our session UUIDs. */
export function getPlexTranscodeKey(sessionId: string): string | undefined {
  return plexTranscodeKeys.get(sessionId);
}

/** Look up the ratingKey for one of our session UUIDs. */
export function getSessionRatingKey(sessionId: string): string | undefined {
  return sessionRatingKeys.get(sessionId);
}

/** Return the stable client identifier used for all Plex requests. */
export function getSessionClientId(_sessionId: string): string {
  return OUR_CLIENT_ID;
}

/**
 * Active Plex transcode keys. Segment requests for keys NOT in this set
 * are rejected at our proxy to prevent viewer hls.js from hitting Plex
 * after the host stops (which creates phantom state blocking new transcodes).
 */
const activeTranscodeKeys = new Set<string>();

/**
 * Sessions currently being stopped. Prevents the WebSocket stop handler and
 * HTTP DELETE handler from racing to send duplicate stop calls to Plex,
 * which creates phantom per-client state blocking new transcodes.
 */
const stoppingSessions = new Set<string>();

/** Check if a session is already being stopped (used by sync.ts). */
export function isSessionStopping(sessionId: string): boolean {
  return stoppingSessions.has(sessionId);
}

/** Mark a session as currently stopping (used by sync.ts). */
export function markSessionStopping(sessionId: string): void {
  stoppingSessions.add(sessionId);
}

/** Clear the stopping flag for a session (used by sync.ts). */
export function clearSessionStopping(sessionId: string): void {
  stoppingSessions.delete(sessionId);
}

/**
 * Every Plex transcode key allocated during this server instance's lifetime,
 * mapped to the timestamp when the key was first seen. Used by flushStaleTranscodes
 * to identify orphaned transcodes that belong to us. Entries older than 24h are
 * pruned periodically to prevent unbounded growth on long-running servers.
 */
const allKnownPlexKeys = new Map<string, number>();
const KNOWN_KEY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

setInterval(() => {
  const cutoff = Date.now() - KNOWN_KEY_TTL_MS;
  for (const [key, ts] of allKnownPlexKeys) {
    if (ts < cutoff) allKnownPlexKeys.delete(key);
  }
}, 60 * 60 * 1000).unref(); // prune every hour

/** Mark a Plex transcode key as stopped — segment requests will be rejected. */
export function markTranscodeStopped(sessionId: string): void {
  stopPrefetch(sessionId);
  const plexKey = plexTranscodeKeys.get(sessionId);
  if (plexKey) activeTranscodeKeys.delete(plexKey);
  plexTranscodeKeys.delete(sessionId);
  sessionRatingKeys.delete(sessionId);
  manifestCache.delete(sessionId);
}

/**
 * Notify Plex that playback has stopped via the timeline endpoint.
 * This clears per-client session state that persists after the transcode is killed,
 * preventing 400 errors on subsequent transcode starts.
 */
export async function notifyPlexStopped(ratingKey: string | null, sessionId: string): Promise<void> {
  // Use the tracked ratingKey if caller doesn't provide one
  const effectiveRatingKey = ratingKey || sessionRatingKeys.get(sessionId) || "0";
  const duration = mediaDurations.get(effectiveRatingKey);
  try {
    const res = await plexFetch(
      "/:/timeline",
      {
        ratingKey: effectiveRatingKey,
        key: `/library/metadata/${effectiveRatingKey}`,
        state: "stopped",
        time: "0",
        duration: duration ? String(duration) : "0",
        identifier: "com.plexapp.plugins.library",
      },
      {
        "X-Plex-Session-Identifier": sessionId,
        "X-Plex-Client-Identifier": OUR_CLIENT_ID,
      },
      "POST",
    );
    console.log("[HLS] Timeline stopped for session:", sessionId.substring(0, 8),
      "ratingKey:", effectiveRatingKey, "→", res.status);
  } catch (err) {
    console.log("[HLS] Timeline stopped failed (non-fatal):", err);
  }
}

/**
 * Safely terminate a specific Plex session using the official API.
 * Triple safety:
 * 1. Matches TranscodeSession.key against our exact plexKey
 * 2. Verifies Player.machineIdentifier is ours
 * 3. Verifies plexKey exists in our allKnownPlexKeys map
 * This ensures we never terminate another bot instance's or external user's session.
 */
async function terminatePlexSession(plexKey: string): Promise<void> {
  if (!allKnownPlexKeys.has(plexKey)) {
    if (DEBUG) console.log("[HLS] Terminate skipped — plexKey not in allKnownPlexKeys:", plexKey.substring(0, 8));
    return;
  }

  try {
    const data = await plexJSON<{
      MediaContainer: {
        Metadata?: Array<{
          Player?: { machineIdentifier?: string };
          TranscodeSession?: { key?: string };
          Session?: { id?: string };
        }>;
      };
    }>("/status/sessions");

    const sessions = data.MediaContainer.Metadata || [];
    for (const s of sessions) {
      const transcodeKey = s.TranscodeSession?.key;
      const keyUuid = transcodeKey?.split("/").pop();

      if (keyUuid !== plexKey) continue;
      if (!s.Player?.machineIdentifier?.startsWith("plex-discord-theater")) continue;

      const sessionId = s.Session?.id;
      if (!sessionId) continue;

      console.log("[HLS] Terminating Plex session:", sessionId, "for transcode key:", plexKey.substring(0, 8));
      await plexFetch(
        "/status/sessions/terminate",
        { sessionId, reason: "Playback ended" },
        undefined,
        "POST",
      );
      return;
    }

    if (DEBUG) console.log("[HLS] No matching Plex session found for terminate:", plexKey.substring(0, 8));
  } catch (err) {
    console.log("[HLS] Terminate session failed (non-fatal):", err);
  }
}

export { terminatePlexSession };

/** Ping Plex to keep a transcode session alive. Called server-side per room. */
export async function pingPlexTranscode(hlsSessionId: string): Promise<void> {
  const plexKey = plexTranscodeKeys.get(hlsSessionId) ?? hlsSessionId;
  try {
    await plexFetch(
      "/video/:/transcode/universal/ping",
      { transcodeSessionId: plexKey },
      {
        "X-Plex-Session-Identifier": plexKey,
        "X-Plex-Client-Identifier": OUR_CLIENT_ID,
      },
    );
  } catch (err) {
    console.error("[HLS] Server-side ping failed for", hlsSessionId.substring(0, 8), err);
  }
}

/**
 * Stop transcode sessions created by our app (plex-discord-theater).
 * When ratingKey is provided, only stops sessions for that specific media item
 * to avoid killing unrelated watch parties in other guilds.
 */
async function flushStaleTranscodes(ratingKey?: string): Promise<number> {
  let stopped = 0;

  // 1. Check /status/sessions for active playback sessions (client-visible)
  try {
    const data = await plexJSON<{
      MediaContainer: {
        Metadata?: Array<{
          Player?: { machineIdentifier?: string; product?: string };
          TranscodeSession?: { key?: string };
          Session?: { id?: string };
          key?: string;
        }>;
      };
    }>("/status/sessions");

    const sessions = data.MediaContainer.Metadata || [];
    console.log("[HLS] /status/sessions:", sessions.length);
    for (const s of sessions) {
      const player = s.Player;
      // Match both the base identifier and per-session identifiers (plex-discord-theater-XXXXXXXX)
      const isOurs =
        player?.machineIdentifier?.startsWith("plex-discord-theater") ||
        player?.product === "Plex Discord Theater";
      if (!isOurs) continue;

      // If ratingKey filter provided, only flush sessions for the same media
      if (ratingKey && s.key && !s.key.includes(`/metadata/${ratingKey}`)) {
        continue;
      }

      const key = s.TranscodeSession?.key;
      if (key) {
        try {
          await plexFetch(
            "/video/:/transcode/universal/stop",
            { transcodeSessionId: key },
            {
              "X-Plex-Session-Identifier": key,
              "X-Plex-Client-Identifier": OUR_CLIENT_ID,
            },
          );
          stopped++;
        } catch {}
      } else {
        // Direct stream session (no TranscodeSession) — stop via the session ID.
        // These can still block new transcodes on the same client identifier.
        const sessionKey = s.Session?.id;
        if (sessionKey) {
          if (DEBUG) console.log("[HLS] Stopping direct-stream session:", sessionKey);
          try {
            await plexFetch(
              "/video/:/transcode/universal/stop",
              { transcodeSessionId: sessionKey },
              {
                "X-Plex-Session-Identifier": sessionKey,
                "X-Plex-Client-Identifier": OUR_CLIENT_ID,
              },
            );
            stopped++;
          } catch {}
        }
      }
    }
  } catch {}

  // 2. Check /transcode/sessions for orphaned transcodes (server-side only).
  //    These are transcode processes that persist after the client disconnects
  //    and don't appear in /status/sessions. Only kill HLS transcodes (our protocol).
  try {
    const data = await plexJSON<{
      MediaContainer: {
        TranscodeSession?: Array<{
          key?: string;
          protocol?: string;
          videoDecision?: string;
        }>;
      };
    }>("/transcode/sessions");

    const transcodes = data.MediaContainer.TranscodeSession || [];
    if (DEBUG) console.log("[HLS] /transcode/sessions count:", transcodes.length);
    for (const t of transcodes) {
      // Only kill HLS transcodes whose Plex key we recognize from a manifest we parsed.
      // Extract UUID from /transcode/sessions/<uuid> path
      const keyUuid = t.key?.split("/").pop();
      if (t.key && t.protocol === "hls" && keyUuid && allKnownPlexKeys.has(keyUuid)) {
        if (DEBUG) console.log("[HLS] Killing orphaned HLS transcode:", t.key);
        try {
          await plexFetch(
            "/video/:/transcode/universal/stop",
            { transcodeSessionId: t.key },
            {
              "X-Plex-Session-Identifier": t.key,
              "X-Plex-Client-Identifier": OUR_CLIENT_ID,
            },
          );
          stopped++;
        } catch {}
      }
    }
  } catch {}

  return stopped;
}

// ─── HLS manifest cache (for viewer session sharing) ────────────
/** Cache rewritten master manifests so viewers reusing a host's sessionId
 *  don't trigger a second Plex transcode request. */
const manifestCache = new Map<string, { manifest: string; createdAt: number }>();
/** Dedup concurrent manifest requests — prevents duplicate decision+start calls to Plex */
const manifestInFlight = new Map<string, Promise<string>>();
const MANIFEST_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Prune stale entries every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of manifestCache) {
    if (now - entry.createdAt > MANIFEST_CACHE_TTL_MS) manifestCache.delete(key);
  }
}, 2 * 60 * 1000).unref();

// ─── HLS streaming ──────────────────────────────────────────────

/**
 * GET /api/plex/hls/:ratingKey/:sessionId/master.m3u8
 * Start a Plex HLS transcode session and return rewritten manifest.
 * The client generates the sessionId (UUID) and passes it in the URL.
 */
router.get(
  "/hls/:ratingKey/:sessionId/master.m3u8",
  async (req: Request, res: Response) => {
    const ratingKey = req.params.ratingKey as string;
    const sessionId = req.params.sessionId as string;

    if (!NUMERIC_RE.test(ratingKey)) {
      res.status(400).json({ error: "Invalid rating key" });
      return;
    }
    if (!UUID_RE.test(sessionId)) {
      res.status(400).json({ error: "Invalid session ID" });
      return;
    }

    // Return cached manifest if available (viewer sharing the host's session)
    const cached = manifestCache.get(sessionId);
    if (cached && Date.now() - cached.createdAt < MANIFEST_CACHE_TTL_MS) {
      if (DEBUG) console.log("[HLS] Returning cached manifest for session:", sessionId.substring(0, 8));
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.send(cached.manifest);
      return;
    }

    // Dedup concurrent manifest requests — if another request is already doing
    // the decision+start round-trip for this session, wait for it instead of
    // sending duplicate calls that race on Plex's per-client state
    const inFlight = manifestInFlight.get(sessionId);
    if (inFlight) {
      try {
        const manifest = await inFlight;
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.send(manifest);
      } catch (err) {
        res.status(502).json({ error: "Failed to start HLS session" });
      }
      return;
    }

    // Optional offset (seconds) — used to resume from a position after audio/subtitle switch.
    // Round to integer — Plex can reject offsets with many decimal places.
    const offsetSec = Math.round(parseFloat(req.query.offset as string));
    const offset = Number.isFinite(offsetSec) && offsetSec > 0 ? String(offsetSec) : undefined;
    // Subtitle mode — "none" when user explicitly disabled subtitles, otherwise "burn"
    const subtitleMode = req.query.subtitles === "burn" ? "burn" : "none";

    console.log("[HLS] Master manifest requested for ratingKey:", ratingKey, "session:", sessionId.substring(0, 8), offset ? `offset:${offset}s` : "");

    // Core manifest fetch logic — wrapped in a promise for in-flight deduplication
    const fetchManifest = async (): Promise<string> => {
      const params: Record<string, string> = {
        hasMDE: "1",
        path: `/library/metadata/${ratingKey}`,
        mediaIndex: "0",
        partIndex: "0",
        protocol: "hls",
        fastSeek: "1",
        directPlay: "0",
        directStream: "0",
        directStreamAudio: "1",
        videoResolution: "1920x1080",
        videoBitrate: "8000",
        peakBitrate: "12000",
        videoQuality: "99",
        autoAdjustQuality: "0",
        location: "lan",
        mediaBufferSize: "102400",
        // Shorter segments transcode faster individually, so Plex can start
        // delivering them sooner on cold start. At 3s segments, Plex only needs
        // to transcode ~3s of video before the first segment is ready (vs ~6s
        // with the default). Trade-off: more HTTP requests, but each is smaller.
        secondsPerSegment: "3",
        subtitles: subtitleMode,
      };
      if (offset) params.offset = offset;

      // Use a single stable client identifier so Plex counts us as one player.
      // Per-session IDs caused Plex to count each session as a separate stream,
      // hitting the "remote streams per user" limit after 2 sessions.
      // The decision + timeline stopped flow properly clears per-client state between sessions.
      const hlsHeaders = {
        "X-Plex-Session-Identifier": sessionId,
        "X-Plex-Client-Profile-Extra":
          "add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264&audioCodec=aac)",
        "X-Plex-Client-Identifier": OUR_CLIENT_ID,
        "X-Plex-Product": "Plex Discord Theater",
        "X-Plex-Platform": "Chrome",
        "X-Plex-Device": "Browser",
      };

      // Call the decision endpoint first to prime Plex's per-client session state.
      // Without this, Plex can reject start.m3u8 with 400 if it has stale per-client
      // state from a previous session (even though the transcode itself was stopped).
      const decisionPath = "/video/:/transcode/universal/decision";
      try {
        const decisionRes = await plexFetch(decisionPath, { ...params, transcodeSessionId: sessionId }, hlsHeaders);
        // Log the decision body — contains generalDecisionCode that tells us
        // whether Plex will direct play (1000), transcode (1001), or error (2xxx/4xxx)
        try {
          const decBody = await decisionRes.json() as Record<string, unknown>;
          const mc = decBody.MediaContainer as Record<string, unknown> | undefined;
          console.log("[HLS] Decision:", decisionRes.status,
            "code:", mc?.generalDecisionCode, mc?.generalDecisionText);
        } catch {
          console.log("[HLS] Decision:", decisionRes.status, "(no body)");
        }
        if (!decisionRes.ok) {
          console.error("[HLS] Decision returned non-OK status:", decisionRes.status,
            "— transcode start may fail");
        }
      } catch (err) {
        console.log("[HLS] Decision failed (non-fatal):", err);
      }

      // Pass session as both a query param and header (matching plex-mpv-shim behavior)
      const startParams = { ...params, transcodeSessionId: sessionId };
      const hlsPath = "/video/:/transcode/universal/start.m3u8";
      let plexRes = await plexFetch(hlsPath, startParams, hlsHeaders);

      // On 400, flush stale transcodes and retry with increasing delays.
      // Plex can take several seconds to fully release resources after a transcode is killed.
      // Don't stop the current session — it was never started, so stopping it sends a ghost
      // request with our UUID that pollutes Plex's per-client state.
      if (plexRes.status === 400) {
        console.log("[HLS] Start returned 400, flushing stale transcodes...");
        let flushed = await flushStaleTranscodes();
        console.log("[HLS] Flushed", flushed, "stale transcode(s)");

        for (let attempt = 1; attempt <= 3 && plexRes.status === 400; attempt++) {
          const delay = flushed > 0 ? 3000 + attempt * 1500 : 2000 * attempt;
          console.log("[HLS] Retry", attempt, "in", delay, "ms");
          await new Promise((r) => setTimeout(r, delay));
          if (attempt === 2 && plexRes.status === 400) {
            const reflushed = await flushStaleTranscodes();
            if (reflushed > 0) {
              flushed += reflushed;
              console.log("[HLS] Re-flushed", reflushed, "more transcode(s)");
              await new Promise((r) => setTimeout(r, 3000));
            }
          }
          // Re-prime decision before retry
          try {
            const retryDecision = await plexFetch(decisionPath, { ...params, transcodeSessionId: sessionId }, hlsHeaders);
            console.log("[HLS] Retry decision:", retryDecision.status);
          } catch {}
          plexRes = await plexFetch(hlsPath, startParams, hlsHeaders);
          console.log("[HLS] Retry", attempt, "result:", plexRes.status);
        }
      }

      if (!plexRes.ok) {
        const text = await plexRes.text();
        console.error("HLS start error:", plexRes.status, text.substring(0, 200));
        throw new Error(`Plex returned ${plexRes.status}`);
      }

      const m3u8 = await plexRes.text();

      // Extract Plex's internal transcode key from the manifest URLs
      // (e.g. "session/ce1be0e5-.../base/index.m3u8" → "ce1be0e5-...")
      const plexKeyMatch = m3u8.match(PLEX_SESSION_KEY_RE);
      if (plexKeyMatch) {
        plexTranscodeKeys.set(sessionId, plexKeyMatch[1]);
        sessionRatingKeys.set(sessionId, ratingKey);
        activeTranscodeKeys.add(plexKeyMatch[1]);
        allKnownPlexKeys.set(plexKeyMatch[1], Date.now());
        console.log("[HLS] Plex transcode key:", plexKeyMatch[1].substring(0, 8), "for session:", sessionId.substring(0, 8));

        // Start pre-fetching segments to absorb Plex's HTTP throttle
        startPrefetch(sessionId, plexKeyMatch[1]);
      } else {
        console.error("[HLS] FATAL: Could not extract Plex transcode key from manifest for session:",
          sessionId.substring(0, 8), "— aborting session to prevent phantom state");
        try {
          await plexFetch(
            "/video/:/transcode/universal/stop",
            { transcodeSessionId: sessionId },
            { "X-Plex-Session-Identifier": sessionId, "X-Plex-Client-Identifier": OUR_CLIENT_ID },
          );
        } catch {}
        await notifyPlexStopped(ratingKey, sessionId);
        throw new Error("Could not extract Plex transcode key from manifest");
      }

      // Send initial timeline "playing" at position 0 so Plex unthrottles delivery.
      // Without this, Plex throttles segment HTTP delivery to ~1x because it has no
      // playback position context. Subsequent pings update the position.
      const duration = mediaDurations.get(ratingKey);
      plexFetch(
        "/:/timeline",
        {
          ratingKey,
          key: `/library/metadata/${ratingKey}`,
          state: "playing",
          time: offset ? String(Math.round(parseFloat(offset) * 1000)) : "0",
          duration: duration ? String(duration) : "0",
          identifier: "com.plexapp.plugins.library",
        },
        {
          "X-Plex-Session-Identifier": sessionId,
          "X-Plex-Client-Identifier": OUR_CLIENT_ID,
        },
        "POST",
      ).catch(() => {}); // fire-and-forget

      const authToken = req.query.token as string | undefined;
      const rewritten = rewriteManifestUrls(m3u8, authToken);
      // Cache for viewer session sharing
      manifestCache.set(sessionId, { manifest: rewritten, createdAt: Date.now() });
      return rewritten;
    };

    // Store promise in in-flight map so concurrent requests wait on it
    const promise = fetchManifest();
    manifestInFlight.set(sessionId, promise);

    try {
      const manifest = await promise;
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.send(manifest);
    } catch (err) {
      console.error("HLS start error:", err);
      res.status(502).json({ error: "Failed to start HLS session" });
    } finally {
      manifestInFlight.delete(sessionId);
    }
  },
);

/**
 * GET /api/plex/hls/seg?p=<encoded-plex-path>
 * Proxy HLS segments and sub-manifests from Plex.
 * The Plex path is passed as a query parameter to avoid special characters
 * (like ":/" in Plex transcode paths) being mangled by proxies.
 */
router.get("/hls/seg", async (req: Request, res: Response) => {
  const rawPath = req.query.p;
  if (!rawPath || typeof rawPath !== "string") {
    if (DEBUG) console.log("[HLS seg] Missing p param. Query:", req.query);
    res.status(400).json({ error: "Missing segment path" });
    return;
  }
  const segPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;

  if (segPath.length > MAX_PROXY_PATH_LENGTH || !isAllowedProxyPath(segPath)) {
    if (DEBUG) console.log("[HLS seg] Path rejected by validation");
    res.status(400).end();
    return;
  }

  // Block segment requests for stopped transcode sessions.
  // After the host stops, the viewer's hls.js keeps fetching for a moment —
  // those requests hitting Plex create phantom state that blocks new transcodes.
  const segKeyMatch = segPath.match(PLEX_SESSION_KEY_RE);
  if (segKeyMatch && allKnownPlexKeys.has(segKeyMatch[1]) && !activeTranscodeKeys.has(segKeyMatch[1])) {
    res.status(410).end(); // Gone — transcode was stopped
    return;
  }

  if (DEBUG) console.log("[HLS seg] Fetching:", segPath.substring(0, 120));

  // Check pre-fetch cache first — serves instantly if the segment was already fetched
  const cachedSeg = getCachedSegment(segPath);
  if (cachedSeg) {
    if (segPath.endsWith(".ts")) {
      res.setHeader("Content-Type", "video/MP2T");
    } else if (segPath.endsWith(".m3u8")) {
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    } else {
      res.setHeader("Content-Type", "application/octet-stream");
    }
    if (DEBUG) console.log("[HLS seg] Cache HIT:", segPath.substring(0, 80));
    res.send(cachedSeg);
    return;
  }

  try {
    const plexRes = await plexFetchSegment(segPath);

    if (!plexRes.ok) {
      // Drain the body so the underlying TCP connection is returned to the pool
      plexRes.body?.cancel().catch(() => {});

      // If Plex returns 404 for a segment, the transcode was killed server-side
      // (ping timeout, resource pressure, etc.). Mark it dead so we stop proxying
      // and return 410 immediately for all subsequent requests to this session,
      // instead of hammering Plex with dozens of doomed requests.
      if (plexRes.status === 404 && segKeyMatch) {
        const deadKey = segKeyMatch[1];
        if (activeTranscodeKeys.has(deadKey)) {
          console.warn("[HLS seg] Plex returned 404 for active transcode", deadKey.substring(0, 8),
            "— marking dead");
          activeTranscodeKeys.delete(deadKey);
        }
        res.status(410).end();
        return;
      }
      console.error("HLS seg proxy error:", plexRes.status, segPath.substring(0, 100));
      res.status(plexRes.status).end();
      return;
    }

    const contentType = plexRes.headers.get("content-type")?.split(";")[0];
    if (contentType && ALLOWED_MEDIA_TYPES.has(contentType)) {
      res.setHeader("Content-Type", contentType);
    } else if (segPath.endsWith(".ts")) {
      res.setHeader("Content-Type", "video/MP2T");
    } else if (segPath.endsWith(".m3u8")) {
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    } else {
      res.setHeader("Content-Type", "application/octet-stream");
    }

    // If this is a sub-manifest, rewrite all URLs (including bare filenames like 00000.ts)
    if (segPath.endsWith(".m3u8")) {
      const m3u8 = await plexRes.text();
      const authToken = req.query.token as string | undefined;
      const baseDir = segPath.substring(0, segPath.lastIndexOf("/") + 1);
      res.send(rewriteManifestUrls(m3u8, authToken, true, baseDir));
      return;
    }

    await pipeBody(plexRes.body, res);
  } catch (err) {
    console.error("HLS segment proxy error:", err);
    res.status(502).end();
  }
});

/**
 * GET /api/plex/hls/ping/:sessionId?time=<ms>
 * Keep a transcode session alive and update Plex timeline with current position.
 * Without timeline updates, Plex throttles segment delivery because it doesn't
 * know the client's playback position and rate-limits to ~1x realtime.
 */
router.get("/hls/ping/:sessionId", async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  if (!UUID_RE.test(sessionId)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  try {
    const plexKey = plexTranscodeKeys.get(sessionId) ?? sessionId;
    const clientId = getSessionClientId(sessionId);

    // Ping to keep transcode alive
    await plexFetch(
      "/video/:/transcode/universal/ping",
      { transcodeSessionId: plexKey },
      {
        "X-Plex-Session-Identifier": plexKey,
        "X-Plex-Client-Identifier": clientId,
      },
    );

    // Send timeline update so Plex knows our playback position.
    // Without this, Plex throttles HTTP segment delivery to ~1x realtime.
    const timeMs = typeof req.query.time === "string" ? parseInt(req.query.time, 10) : NaN;
    const ratingKey = sessionRatingKeys.get(sessionId);
    if (ratingKey && Number.isFinite(timeMs)) {
      const duration = mediaDurations.get(ratingKey);
      plexFetch(
        "/:/timeline",
        {
          ratingKey,
          key: `/library/metadata/${ratingKey}`,
          state: "playing",
          time: String(timeMs),
          duration: duration ? String(duration) : "0",
          identifier: "com.plexapp.plugins.library",
        },
        {
          "X-Plex-Session-Identifier": sessionId,
          "X-Plex-Client-Identifier": clientId,
        },
        "POST",
      ).catch(() => {}); // fire-and-forget — don't block the ping response
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Ping error:", err);
    res.status(502).json({ error: "Ping failed" });
  }
});

/**
 * DELETE /api/plex/hls/session/:sessionId
 * Stop a transcode session.
 */
router.delete(
  "/hls/session/:sessionId",
  async (req: Request, res: Response) => {
    const sessionId = req.params.sessionId as string;
    if (!UUID_RE.test(sessionId)) {
      res.status(400).json({ error: "Invalid session ID" });
      return;
    }

    if (stoppingSessions.has(sessionId)) {
      if (DEBUG) console.log("[HLS] Stop session", sessionId.substring(0, 8), "(already stopping via sync)");
      res.json({ ok: true });
      return;
    }
    stoppingSessions.add(sessionId);

    try {
      // Clear cached manifest
      manifestCache.delete(sessionId);
      const ratingKey = sessionRatingKeys.get(sessionId) || null;
      const plexKey = plexTranscodeKeys.get(sessionId);

      // Only send the stop to Plex if we still have a valid Plex transcode key.
      // If the mapping is gone, the WebSocket handler already stopped it — sending
      // a stop with our UUID creates ghost state in Plex that blocks new transcodes.
      if (plexKey) {
        try {
          const stopRes = await plexFetch(
            "/video/:/transcode/universal/stop",
            { transcodeSessionId: plexKey },
            {
              "X-Plex-Session-Identifier": plexKey,
              "X-Plex-Client-Identifier": OUR_CLIENT_ID,
            },
          );
          console.log("[HLS] Stop session", sessionId.substring(0, 8),
            `(plex key: ${plexKey.substring(0, 8)})`, "→", stopRes.status);
        } catch (err) {
          console.error("Stop session error:", err);
          res.status(502).json({ error: "Stop failed" });
          return;
        } finally {
          // Always clear mappings and notify Plex — even on error the transcode
          // key should not be reused, and notifyPlexStopped prevents stale 400s
          activeTranscodeKeys.delete(plexKey);
          plexTranscodeKeys.delete(sessionId);
          sessionRatingKeys.delete(sessionId);
          await notifyPlexStopped(ratingKey, sessionId);
          if (plexKey) await terminatePlexSession(plexKey);
        }
      } else {
        sessionRatingKeys.delete(sessionId);
        if (DEBUG) console.log("[HLS] Stop session", sessionId.substring(0, 8),
          "(already stopped via sync)");
      }

      res.json({ ok: true });
    } finally {
      stoppingSessions.delete(sessionId);
    }
  },
);

/**
 * DELETE /api/plex/hls/sessions
 * Kill ALL active transcode sessions. Useful for flushing stale sessions
 * that weren't properly stopped (e.g. during development).
 */
router.delete("/hls/sessions", async (req: Request, res: Response) => {
  // Dev-only endpoint — refuse in production unless admin secret is provided
  const isDev = process.env.NODE_ENV !== "production";
  const adminSecret = process.env.ADMIN_SECRET;
  if (!isDev && (!adminSecret || req.headers["x-admin-secret"] !== adminSecret)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  try {
    const data = await plexJSON<{
      MediaContainer: {
        Metadata?: Array<{
          Session?: { id?: string };
          TranscodeSession?: { key?: string };
          Player?: { machineIdentifier?: string };
        }>;
      };
    }>("/status/sessions");

    const sessions = data.MediaContainer.Metadata || [];
    if (DEBUG) console.log("[HLS] Active sessions:", sessions.length);

    let stopped = 0;
    for (const s of sessions) {
      // Only kill sessions started by our app (skip other Plex clients)
      if (!s.Player?.machineIdentifier?.startsWith("plex-discord-theater")) continue;

      const key = s.TranscodeSession?.key;
      if (key) {
        try {
          const stopRes = await plexFetch(`/video/:/transcode/universal/stop`, { transcodeSessionId: key }, {
            "X-Plex-Session-Identifier": key,
            "X-Plex-Client-Identifier": OUR_CLIENT_ID,
          });
          if (DEBUG) console.log("[HLS] Killed session", key, "→", stopRes.status);
          stopped++;
        } catch (err) {
          console.error("[HLS] Failed to kill session", key, err);
        }
      }
    }

    res.json({ total: sessions.length, stopped });
  } catch (err) {
    console.error("Kill sessions error:", err);
    res.status(502).json({ error: "Failed to fetch/kill sessions" });
  }
});

// ─── Helpers ────────────────────────────────────────────────────

function mapItem(m: PlexMetadataItem) {
  return {
    ratingKey: m.ratingKey,
    title: m.title,
    year: m.year,
    type: m.type,
    thumb: m.thumb ? `/api/plex/thumb${m.thumb}` : null,
    ...(m.index != null && { index: m.index }),
    ...(m.parentIndex != null && { parentIndex: m.parentIndex }),
    ...(m.parentTitle != null && { parentTitle: m.parentTitle }),
    ...(m.leafCount != null && { leafCount: m.leafCount }),
    ...(m.childCount != null && { childCount: m.childCount }),
    ...(m.summary != null && { summary: m.summary }),
    ...(m.duration != null && { duration: m.duration }),
  };
}

/** Reject paths with traversal sequences, double slashes, null bytes, or backslashes. */
function isAllowedProxyPath(p: string): boolean {
  let decoded = p;
  let prev: string;
  do {
    prev = decoded;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return false;
    }
  } while (decoded !== prev);

  return (
    !/\.\./.test(decoded) &&
    !/\/\//.test(decoded) &&
    !decoded.includes("\0") &&
    !decoded.includes("\\")
  );
}

const ALLOWED_THUMB_PREFIXES = ["/library/", "/photo/"];

function isAllowedThumbPath(p: string): boolean {
  return isAllowedProxyPath(p) && ALLOWED_THUMB_PREFIXES.some(prefix => p.startsWith(prefix));
}

/**
 * Rewrite Plex URLs in an m3u8 manifest to route through our proxy.
 *
 * Master manifests from Plex contain relative paths like:
 *   session/<id>/base/index.m3u8
 * These are relative to /video/:/transcode/universal/ on Plex, so we
 * rewrite them to /api/plex/hls/seg/video/:/transcode/universal/session/...
 *
 * Sub-manifests contain bare filenames like "00000.ts" which hls.js
 * resolves relative to the sub-manifest URL — these are left untouched.
 *
 * When authToken is provided (Safari native HLS), it is appended to segment URLs
 * so that the auth middleware can validate requests made by the native player.
 */
const TRANSCODE_PREFIX = "/video/:/transcode/universal/";

function segProxyUrl(plexPath: string, authToken?: string): string {
  if (VPS_RELAY_URL && VPS_RELAY_KEY && !plexPath.endsWith(".m3u8")) {
    // VPS mode: only route .ts segments through VPS, NOT sub-manifests.
    // Sub-manifests (.m3u8) must stay on Express so rewriteManifestUrls() can
    // rewrite their bare filenames (e.g. "00000.ts") into full proxied URLs.
    // If sub-manifests went to VPS, hls.js would resolve "00000.ts" relative to
    // the VPS URL, dropping the ?key= query param (RFC 3986) → nginx 403.
    // Sub-manifests are ~2KB so routing them through Express has negligible
    // bandwidth impact.
    // Use relative path (/theater/seg/...) so requests go through Discord's
    // Activity proxy (which forwards to theater.zuby.website via URL Mapping).
    // Absolute URLs to the VPS would be blocked by Discord's iframe CSP.
    return `/theater/seg${plexPath}?key=${encodeURIComponent(VPS_RELAY_KEY)}`;
  }
  // No VPS, or sub-manifest — proxy through Express
  let url = `/api/plex/hls/seg?p=${encodeURIComponent(plexPath)}`;
  if (authToken) url += `&token=${encodeURIComponent(authToken)}`;
  return url;
}

function rewriteManifestUrls(m3u8: string, authToken?: string, isSubManifest = false, baseDir = ""): string {
  let result = m3u8;

  const cleanPlexToken = (path: string) => path.replace(PLEX_TOKEN_REGEX, "");

  // Rewrite absolute Plex URLs (e.g. http://localhost:32400/video/...)
  PLEX_URL_REGEX.lastIndex = 0;
  result = result.replace(PLEX_URL_REGEX, (_match: string, path: string) =>
    segProxyUrl(cleanPlexToken(path), authToken),
  );

  // Rewrite relative paths in the manifest.
  // Master manifests: prepend the Plex transcode prefix (e.g. session/<id>/base/index.m3u8)
  // Sub-manifests: prepend the sub-manifest's base directory (e.g. 00000.ts → full Plex path)
  RELATIVE_URL_REGEX.lastIndex = 0;
  const prefix = isSubManifest ? baseDir : TRANSCODE_PREFIX;
  result = result.replace(RELATIVE_URL_REGEX, (_match: string, path: string) =>
    segProxyUrl(`${prefix}${cleanPlexToken(path)}`, authToken),
  );

  return result;
}

/** Stream a fetch response body to an Express response, with error logging. */
async function pipeBody(
  body: ReadableStream<Uint8Array> | null,
  res: Response,
): Promise<void> {
  if (!body) {
    res.end();
    return;
  }
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.writableEnded) {
        await reader.cancel();
        break;
      }
      res.write(value);
    }
    if (!res.writableEnded) res.end();
  } catch (err) {
    console.error("Stream pipe error:", err);
    await reader.cancel().catch(() => {});
    if (!res.writableEnded) res.end();
  }
}

/** Stop transcode sessions started by this server instance during graceful shutdown.
 *  Only affects sessions in our plexTranscodeKeys map; other Plex clients are untouched. */
export async function stopAllActiveSessions(): Promise<void> {
  const entries = [...plexTranscodeKeys.entries()];
  for (const [sessionId, plexKey] of entries) {
    const ratingKey = sessionRatingKeys.get(sessionId) || null;
    try {
      await plexFetch(
        "/video/:/transcode/universal/stop",
        { transcodeSessionId: plexKey },
        { "X-Plex-Session-Identifier": plexKey, "X-Plex-Client-Identifier": OUR_CLIENT_ID },
      );
      console.log("[Shutdown] Stopped transcode:", plexKey.substring(0, 8));
    } catch {}
    markTranscodeStopped(sessionId);
    await notifyPlexStopped(ratingKey, sessionId).catch(() => {});
    await terminatePlexSession(plexKey).catch(() => {});
  }
}

export default router;
