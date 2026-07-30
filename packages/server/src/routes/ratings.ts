import { Router, type Request, type Response } from "express";

/**
 * External ratings for a title's detail page — IMDb, TMDB, and Rotten Tomatoes
 * (both the critic Tomatometer and the audience score).
 *
 * Rotten Tomatoes has no public API and IMDb has no free ratings API, so all
 * four numbers are sourced from MDBList (https://mdblist.com), a free aggregator
 * keyed by IMDb or TMDB id. Set MDBLIST_API_KEY to enable; left unset, the
 * endpoint reports `configured: false` and the client hides the ratings row.
 *
 * Grab a free key from https://mdblist.com/preferences (API Access section).
 */
const router = Router();

const MEDIA_TYPES = new Set(["movie", "show"]);
const MDBLIST_TIMEOUT_MS = 8000;
// Ratings drift slowly; a day-long cache keeps MDBList calls well within the
// free tier even with heavy browsing. Misses are cached too (shorter) so a
// title MDBList doesn't know isn't re-fetched on every visit.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;

const IMDB_ID_RE = /^tt\d{5,10}$/;
const TMDB_ID_RE = /^\d{1,12}$/;

function apiKey(): string | null {
  return process.env.MDBLIST_API_KEY?.trim() || null;
}

/** Display-ready scores. imdb is 0–10 (one decimal); the rest are 0–100 percentages. */
interface Ratings {
  imdb: number | null;
  tmdb: number | null;
  rtCritic: number | null;
  rtAudience: number | null;
}

interface MdblistRating {
  source?: string;
  /** Native scale (imdb 0–10, RT 0–100, …). */
  value?: number | null;
  /** Normalized 0–100. */
  score?: number | null;
}

const cache = new Map<string, { at: number; ttl: number; ratings: Ratings }>();

function cacheGet(key: string): Ratings | undefined {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.ratings;
  if (hit) cache.delete(key);
  return undefined;
}

function cacheSet(key: string, ratings: Ratings): void {
  const empty =
    ratings.imdb == null && ratings.tmdb == null &&
    ratings.rtCritic == null && ratings.rtAudience == null;
  cache.set(key, { at: Date.now(), ttl: empty ? MISS_TTL_MS : CACHE_TTL_MS, ratings });
}

function findRating(list: MdblistRating[], source: string): MdblistRating | undefined {
  return list.find((r) => r.source === source);
}

/** RT / TMDB show as a percentage — prefer the normalized 0–100 score. */
function percent(r: MdblistRating | undefined): number | null {
  if (!r) return null;
  const n = r.score ?? r.value;
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(Math.max(0, Math.min(100, n)));
}

/** IMDb shows as X.X / 10 — its native `value`, with `score` (0–100) as fallback. */
function outOfTen(r: MdblistRating | undefined): number | null {
  if (!r) return null;
  let n = r.value;
  if (n == null || !Number.isFinite(n)) n = r.score != null ? r.score / 10 : null;
  else if (n > 10) n = n / 10; // guard against a 0–100 value slipping through
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(Math.max(0, Math.min(10, n)) * 10) / 10;
}

async function fetchFromMdblist(
  key: string,
  provider: "imdb" | "tmdb",
  mediaType: string,
  id: string,
): Promise<Ratings> {
  const url = `https://api.mdblist.com/${provider}/${mediaType}/${encodeURIComponent(id)}?apikey=${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(MDBLIST_TIMEOUT_MS),
  });
  if (!r.ok) {
    console.warn("[Ratings] MDBList", provider, mediaType, id, "->", r.status);
    return { imdb: null, tmdb: null, rtCritic: null, rtAudience: null };
  }
  const body = (await r.json()) as { ratings?: MdblistRating[] };
  const list = Array.isArray(body.ratings) ? body.ratings : [];
  return {
    imdb: outOfTen(findRating(list, "imdb")),
    tmdb: percent(findRating(list, "tmdb")),
    rtCritic: percent(findRating(list, "tomatoes")),
    rtAudience: percent(findRating(list, "tomatoesaudience")),
  };
}

/**
 * GET /api/ratings?imdbId=tt123&tmdbId=456&mediaType=movie|show
 *
 * Either id may be supplied; IMDb is tried first (most reliable match), then
 * TMDB. Always 200 when configured — an unknown title just returns all-null
 * ratings, which the client renders as "no ratings" rather than an error.
 */
router.get("/", async (req: Request, res: Response) => {
  const key = apiKey();
  if (!key) {
    res.json({ configured: false, ratings: { imdb: null, tmdb: null, rtCritic: null, rtAudience: null } });
    return;
  }

  const mediaType = String(req.query.mediaType ?? "");
  if (!MEDIA_TYPES.has(mediaType)) {
    res.status(400).json({ error: "Invalid or missing mediaType (expected movie or show)" });
    return;
  }

  const imdbId = typeof req.query.imdbId === "string" && IMDB_ID_RE.test(req.query.imdbId)
    ? req.query.imdbId : null;
  const tmdbId = typeof req.query.tmdbId === "string" && TMDB_ID_RE.test(req.query.tmdbId)
    ? req.query.tmdbId : null;

  if (!imdbId && !tmdbId) {
    res.status(400).json({ error: "Missing imdbId or tmdbId" });
    return;
  }

  // Prefer IMDb; fall back to TMDB. Cache key covers whichever we actually query.
  const lookups: Array<{ provider: "imdb" | "tmdb"; id: string }> = [];
  if (imdbId) lookups.push({ provider: "imdb", id: imdbId });
  if (tmdbId) lookups.push({ provider: "tmdb", id: tmdbId });

  try {
    for (const { provider, id } of lookups) {
      const cacheKey = `${provider}:${mediaType}:${id}`;
      const cached = cacheGet(cacheKey);
      const ratings = cached ?? await fetchFromMdblist(key, provider, mediaType, id);
      if (!cached) cacheSet(cacheKey, ratings);
      const hasAny =
        ratings.imdb != null || ratings.tmdb != null ||
        ratings.rtCritic != null || ratings.rtAudience != null;
      // Got something from this source — return it. Otherwise try the next id.
      if (hasAny || provider === lookups[lookups.length - 1].provider) {
        res.json({ configured: true, ratings });
        return;
      }
    }
  } catch (err) {
    console.error("[Ratings] lookup error:", err);
    res.status(502).json({ error: "Failed to fetch ratings" });
  }
});

export default router;
