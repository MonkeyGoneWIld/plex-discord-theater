import { Router, type Request, type Response } from "express";

/**
 * Requesting non-library titles via a Seerr instance (Overseerr / Jellyseerr).
 *
 * Requests are attributed to *your* Seerr account rather than the admin API key:
 * the server logs in with your plex.tv token (POST /auth/plex) and reuses that
 * session cookie. Enabled by setting SEERR_URL; authenticates with the same
 * PLEX_ACCOUNT_TOKEN that Discover uses (falls back to PLEX_TOKEN).
 */
const router = Router();

const MEDIA_TYPES = new Set(["movie", "tv"]);
const SEERR_TIMEOUT_MS = 8000;
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

type SeerrConfig = { url: string; token: string };

function seerrConfig(): SeerrConfig | null {
  const url = process.env.SEERR_URL?.replace(/\/$/, "");
  const token = process.env.PLEX_ACCOUNT_TOKEN || process.env.PLEX_TOKEN;
  return url && token ? { url, token } : null;
}

// Cached Seerr session cookie from the Plex login; refreshed on TTL or a 401.
let sessionCookie: string | null = null;
let sessionAt = 0;

async function login(cfg: SeerrConfig): Promise<string | null> {
  try {
    const r = await fetch(`${cfg.url}/api/v1/auth/plex`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ authToken: cfg.token }),
      signal: AbortSignal.timeout(SEERR_TIMEOUT_MS),
    });
    if (!r.ok) {
      console.warn("[Seerr] plex login failed:", r.status);
      return null;
    }
    sessionCookie = r.headers.get("set-cookie")?.match(/connect\.sid=[^;]+/)?.[0] ?? null;
    sessionAt = Date.now();
    return sessionCookie;
  } catch (err) {
    console.error("[Seerr] plex login error:", err);
    return null;
  }
}

async function currentSession(cfg: SeerrConfig): Promise<string | null> {
  if (sessionCookie && Date.now() - sessionAt < SESSION_TTL_MS) return sessionCookie;
  return login(cfg);
}

/** Authenticated Seerr call via the Plex session cookie. Retries once with a
 *  fresh login if the session has expired. Returns null if we can't authenticate. */
async function seerrFetch(
  cfg: SeerrConfig,
  path: string,
  init?: RequestInit,
): Promise<globalThis.Response | null> {
  const call = (cookie: string) =>
    fetch(`${cfg.url}/api/v1${path}`, {
      ...init,
      headers: {
        Cookie: cookie,
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
      signal: AbortSignal.timeout(SEERR_TIMEOUT_MS),
    });

  let cookie = await currentSession(cfg);
  if (!cookie) return null;
  let r = await call(cookie);
  if (r.status === 401) {
    sessionCookie = null;
    cookie = await login(cfg);
    if (!cookie) return null;
    r = await call(cookie);
  }
  return r;
}

/**
 * GET /api/seerr/status?tmdbId=123&mediaType=movie
 * Availability/request status. { configured, status } where status is Seerr's
 * MediaStatus (2=pending, 3=processing, 4=partial, 5=available) or null (not
 * requested). configured is false when SEERR_URL isn't set.
 */
router.get("/status", async (req: Request, res: Response) => {
  const cfg = seerrConfig();
  if (!cfg) {
    res.json({ configured: false, status: null });
    return;
  }
  const tmdbId = String(req.query.tmdbId ?? "");
  const mediaType = String(req.query.mediaType ?? "");
  if (!/^\d+$/.test(tmdbId) || !MEDIA_TYPES.has(mediaType)) {
    res.status(400).json({ error: "Invalid tmdbId or mediaType" });
    return;
  }
  try {
    const r = await seerrFetch(cfg, `/${mediaType}/${tmdbId}`);
    if (!r || !r.ok) {
      // Login failed or title not tracked yet — either way, "not requested".
      res.json({ configured: true, status: null });
      return;
    }
    const data = (await r.json()) as { mediaInfo?: { status?: number } };
    res.json({ configured: true, status: data.mediaInfo?.status ?? null });
  } catch (err) {
    console.error("[Seerr] status error:", err);
    res.status(502).json({ error: "Failed to reach Seerr" });
  }
});

/**
 * GET /api/seerr/tv/:tmdbId
 * All seasons of a show plus per-season availability/request status, so the
 * detail view can show what's owned vs requestable. Season 0 (specials) omitted.
 */
router.get("/tv/:tmdbId", async (req: Request, res: Response) => {
  const cfg = seerrConfig();
  if (!cfg) {
    res.json({ configured: false, status: null, seasons: [] });
    return;
  }
  const tmdbId = String(req.params.tmdbId ?? "");
  if (!/^\d+$/.test(tmdbId)) {
    res.status(400).json({ error: "Invalid tmdbId" });
    return;
  }
  try {
    const r = await seerrFetch(cfg, `/tv/${tmdbId}`);
    if (!r || !r.ok) {
      res.json({ configured: true, status: null, seasons: [] });
      return;
    }
    const data = (await r.json()) as {
      seasons?: Array<{ seasonNumber?: number; name?: string; episodeCount?: number }>;
      mediaInfo?: {
        status?: number;
        seasons?: Array<{ seasonNumber?: number; status?: number }>;
        requests?: Array<{ status?: number; seasons?: Array<{ seasonNumber?: number; status?: number }> }>;
      };
    };
    // TEMP DIAGNOSTIC — confirm where per-season status lives; remove once verified.
    console.log("[Seerr] tv %s mediaInfo=%s", tmdbId,
      JSON.stringify(data.mediaInfo ?? null).slice(0, 600));
    const statusBySeason = new Map<number, number>();
    // Availability of already-tracked seasons.
    for (const s of data.mediaInfo?.seasons ?? []) {
      if (s.seasonNumber != null && s.status != null) statusBySeason.set(s.seasonNumber, s.status);
    }
    // Requested seasons (pending/processing) live on the request objects; don't
    // overwrite a richer availability status already recorded above.
    // request.status: 1 = pending approval, 2 = approved, 3 = declined, 4 = failed.
    // Only pending/approved reserve a season — declined/failed leave it requestable.
    for (const req of data.mediaInfo?.requests ?? []) {
      if (req.status !== 1 && req.status !== 2) continue;
      for (const rs of req.seasons ?? []) {
        if (rs.seasonNumber == null || statusBySeason.has(rs.seasonNumber)) continue;
        statusBySeason.set(rs.seasonNumber, req.status === 2 ? 3 : 2);
      }
    }
    const seasons = (data.seasons ?? [])
      .filter((s) => (s.seasonNumber ?? 0) >= 1)
      .map((s) => ({
        seasonNumber: s.seasonNumber!,
        name: s.name || `Season ${s.seasonNumber}`,
        episodeCount: s.episodeCount ?? 0,
        status: statusBySeason.get(s.seasonNumber!) ?? null,
      }));
    res.json({ configured: true, status: data.mediaInfo?.status ?? null, seasons });
  } catch (err) {
    console.error("[Seerr] tv error:", err);
    res.status(502).json({ error: "Failed to reach Seerr" });
  }
});

/**
 * POST /api/seerr/request  { tmdbId, mediaType, seasons? }
 * Create a request as your Seerr account. For TV, `seasons` is an array of
 * season numbers; omitted/empty requests all seasons.
 */
router.post("/request", async (req: Request, res: Response) => {
  const cfg = seerrConfig();
  if (!cfg) {
    res.status(503).json({ error: "Requests are not configured" });
    return;
  }
  const { tmdbId, mediaType, seasons } = (req.body ?? {}) as {
    tmdbId?: unknown; mediaType?: unknown; seasons?: unknown;
  };
  if (!Number.isInteger(tmdbId) || typeof mediaType !== "string" || !MEDIA_TYPES.has(mediaType)) {
    res.status(400).json({ error: "Invalid tmdbId or mediaType" });
    return;
  }
  try {
    const body: Record<string, unknown> = { mediaType, mediaId: tmdbId };
    if (mediaType === "tv") {
      const picked = Array.isArray(seasons)
        ? seasons.filter((n): n is number => Number.isInteger(n))
        : [];
      body.seasons = picked.length > 0 ? picked : "all";
    }
    const r = await seerrFetch(cfg, "/request", { method: "POST", body: JSON.stringify(body) });
    if (!r) {
      res.status(502).json({ error: "Couldn't sign in to Seerr" });
      return;
    }
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.warn("[Seerr] request failed:", r.status, text.slice(0, 200));
      res.status(r.status === 409 ? 409 : 502)
        .json({ error: r.status === 409 ? "Already requested" : "Request failed" });
      return;
    }
    const data = (await r.json()) as { media?: { status?: number } };
    // A fresh request is at least PENDING (2); use the returned media status if richer.
    res.json({ ok: true, status: data.media?.status ?? 2 });
  } catch (err) {
    console.error("[Seerr] request error:", err);
    res.status(502).json({ error: "Failed to reach Seerr" });
  }
});

/**
 * GET /api/seerr/partial
 * Plex rating keys of shows that are only partially available, so the library
 * grid can flag them. One cached lookup rather than per-card requests.
 */
let partialCache: { keys: string[]; at: number } | null = null;
const PARTIAL_TTL_MS = 5 * 60 * 1000;

router.get("/partial", async (_req: Request, res: Response) => {
  const cfg = seerrConfig();
  if (!cfg) {
    res.json({ configured: false, ratingKeys: [] });
    return;
  }
  if (partialCache && Date.now() - partialCache.at < PARTIAL_TTL_MS) {
    res.json({ configured: true, ratingKeys: partialCache.keys });
    return;
  }
  try {
    const r = await seerrFetch(cfg, "/media?filter=partial&take=500&sort=added");
    if (!r || !r.ok) {
      res.json({ configured: true, ratingKeys: [] });
      return;
    }
    const data = (await r.json()) as { results?: Array<{ ratingKey?: string; tmdbId?: number }> };
    // TEMP DIAGNOSTIC — confirm partial media carry a Plex ratingKey; remove after.
    console.log("[Seerr] partial count=%d sample=%s", data.results?.length ?? 0,
      JSON.stringify((data.results ?? [])[0] ?? null).slice(0, 300));
    const keys = (data.results ?? [])
      .map((m) => m.ratingKey)
      .filter((k): k is string => typeof k === "string" && k.length > 0);
    partialCache = { keys, at: Date.now() };
    res.json({ configured: true, ratingKeys: keys });
  } catch (err) {
    console.error("[Seerr] partial error:", err);
    res.status(502).json({ error: "Failed to reach Seerr" });
  }
});

export default router;
