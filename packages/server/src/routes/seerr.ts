import { Router, type Request, type Response } from "express";

/**
 * Requesting non-library titles via a Seerr instance (Overseerr / Jellyseerr).
 * Configured with SEERR_URL + SEERR_API_KEY; disabled (configured: false) when
 * either is missing. All calls use the X-Api-Key header and TMDB ids.
 */
const router = Router();

const MEDIA_TYPES = new Set(["movie", "tv"]);
const SEERR_TIMEOUT_MS = 8000;

function seerrConfig(): { url: string; apiKey: string } | null {
  const url = process.env.SEERR_URL?.replace(/\/$/, "");
  const apiKey = process.env.SEERR_API_KEY;
  return url && apiKey ? { url, apiKey } : null;
}

async function seerrFetch(cfg: { url: string; apiKey: string }, path: string, init?: RequestInit) {
  return fetch(`${cfg.url}/api/v1${path}`, {
    ...init,
    headers: {
      "X-Api-Key": cfg.apiKey,
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    signal: AbortSignal.timeout(SEERR_TIMEOUT_MS),
  });
}

/**
 * GET /api/seerr/status?tmdbId=123&mediaType=movie
 * Availability/request status for a title. Returns { configured, status } where
 * status is Seerr's MediaStatus (2=pending, 3=processing, 4=partial, 5=available)
 * or null when the title hasn't been requested.
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
    if (!r.ok) {
      // Not found in Seerr yet just means "not requested".
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
 * POST /api/seerr/request  { tmdbId, mediaType }
 * Create a request. TV requests cover all seasons. Returns { ok, status }.
 */
router.post("/request", async (req: Request, res: Response) => {
  const cfg = seerrConfig();
  if (!cfg) {
    res.status(503).json({ error: "Requests are not configured" });
    return;
  }
  const { tmdbId, mediaType } = (req.body ?? {}) as { tmdbId?: unknown; mediaType?: unknown };
  if (!Number.isInteger(tmdbId) || typeof mediaType !== "string" || !MEDIA_TYPES.has(mediaType)) {
    res.status(400).json({ error: "Invalid tmdbId or mediaType" });
    return;
  }
  try {
    const body: Record<string, unknown> = { mediaType, mediaId: tmdbId };
    if (mediaType === "tv") body.seasons = "all";
    const r = await seerrFetch(cfg, "/request", { method: "POST", body: JSON.stringify(body) });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.warn("[Seerr] request failed:", r.status, text.slice(0, 200));
      // 409 = already exists — treat as "already requested" rather than an error.
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

export default router;
