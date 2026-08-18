/**
 * TheTVDB v4 — the episode list Sonarr actually works from.
 *
 * TMDB and TVDB disagree about how some shows are split into seasons, and the
 * disagreement is not rare: specials folded in differently, a two-part premiere
 * counted as one episode on one side, a "season 3" that TVDB numbers as 4. The
 * missing-episode list is diffed against Plex's own numbering, and Sonarr — the
 * thing that would actually fetch anything missing — is numbered by TVDB. So
 * when a show is scraped from TVDB, TMDB's list produces episodes that belong
 * to a different season entirely.
 *
 * Optional, like every other integration here: with no TVDB_API_KEY the caller
 * falls back to TMDB and the feature carries on working, slightly less
 * accurately, exactly as it did before this existed.
 */
import { LruMap } from "./lru.js";

// Overridable so the integration can be exercised against a stand-in; there is
// no reason to change it in a real deployment.
const BASE = process.env.TVDB_API_BASE?.replace(/\/$/, "") || "https://api4.thetvdb.com/v4";
const TIMEOUT_MS = 8000;
/** Bounds a pathological series (or a `next` link that never terminates). */
const MAX_PAGES = 12;

const API_KEY = process.env.TVDB_API_KEY?.trim();
/** Only user-supported subscriber keys need a PIN; project keys don't. */
const PIN = process.env.TVDB_PIN?.trim();

export function isTvdbConfigured(): boolean {
  return !!API_KEY;
}

/** One episode, reduced to what the season list renders. Same shape the TMDB
 *  path produces, so callers don't branch on the source. */
export interface TvdbEpisode {
  episodeNumber: number;
  name: string;
  overview: string | null;
  /** ISO date, or null when TVDB has the episode listed but unscheduled. */
  airDate: string | null;
  /** Absolute artwork URL, or null. */
  image: string | null;
  /** Minutes. */
  runtime: number | null;
}

// Bearer token from /login. TVDB's are good for a month; re-minted on a 401 and
// on TTL, so a rotated key recovers without a restart.
let token: string | null = null;
let tokenAt = 0;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

async function login(): Promise<string | null> {
  if (!API_KEY) return null;
  try {
    const res = await fetch(`${BASE}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(PIN ? { apikey: API_KEY, pin: PIN } : { apikey: API_KEY }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn("[TVDB] login failed:", res.status);
      return null;
    }
    const body = (await res.json()) as { data?: { token?: string } };
    token = body.data?.token ?? null;
    tokenAt = Date.now();
    if (!token) console.warn("[TVDB] login returned no token");
    return token;
  } catch (err) {
    console.warn("[TVDB] login error:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function authed(path: string): Promise<unknown | null> {
  if (!API_KEY) return null;
  let t = token && Date.now() - tokenAt < TOKEN_TTL_MS ? token : await login();
  if (!t) return null;
  const call = (bearer: string) =>
    fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  try {
    let res = await call(t);
    if (res.status === 401) {
      token = null;
      t = await login();
      if (!t) return null;
      res = await call(t);
    }
    if (!res.ok) {
      console.warn("[TVDB] request failed:", path, res.status);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn("[TVDB] request error:", path, err instanceof Error ? err.message : err);
    return null;
  }
}

/** The raw episode shape, read defensively — every field is optional here so a
 *  change on TVDB's side degrades a row rather than throwing. */
interface RawEpisode {
  number?: number;
  seasonNumber?: number;
  name?: string | null;
  overview?: string | null;
  aired?: string | null;
  image?: string | null;
  runtime?: number | null;
}

function toEpisode(e: RawEpisode): TvdbEpisode | null {
  if (typeof e.number !== "number") return null;
  return {
    episodeNumber: e.number,
    name: e.name || `Episode ${e.number}`,
    overview: e.overview || null,
    airDate: e.aired || null,
    image: e.image || null,
    runtime: typeof e.runtime === "number" ? e.runtime : null,
  };
}

/** Whole-series episode lists, keyed by TVDB series id. Stable metadata, and
 *  one season page would otherwise re-paginate the entire series. */
const seriesCache = new LruMap<number, { at: number; bySeason: Map<number, TvdbEpisode[]> }>(300);
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Every episode of a series in aired order, grouped by season.
 *
 * "default" is TVDB's aired order, which is what Sonarr monitors unless it has
 * been switched to absolute or DVD ordering — matching the common case is the
 * whole point, since the answer is only useful if it agrees with the thing that
 * would fetch the episode.
 */
async function fetchSeries(tvdbId: number): Promise<Map<number, TvdbEpisode[]> | null> {
  const hit = seriesCache.get(tvdbId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.bySeason;

  const bySeason = new Map<number, TvdbEpisode[]>();
  let found = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = (await authed(`/series/${tvdbId}/episodes/default?page=${page}`)) as
      | { data?: { episodes?: RawEpisode[] }; links?: { next?: string | null } }
      | null;
    const episodes = body?.data?.episodes;
    if (!Array.isArray(episodes)) break;
    found = true;
    for (const raw of episodes) {
      const ep = toEpisode(raw);
      if (!ep || typeof raw.seasonNumber !== "number") continue;
      const list = bySeason.get(raw.seasonNumber) ?? [];
      list.push(ep);
      bySeason.set(raw.seasonNumber, list);
    }
    if (!body?.links?.next) break;
  }
  if (!found) return null;

  for (const list of bySeason.values()) list.sort((a, b) => a.episodeNumber - b.episodeNumber);
  seriesCache.set(tvdbId, { at: Date.now(), bySeason });
  return bySeason;
}

/** One season's episodes, or null when TVDB is unconfigured / has nothing. */
export async function tvdbSeasonEpisodes(
  tvdbId: number,
  seasonNumber: number,
): Promise<TvdbEpisode[] | null> {
  const bySeason = await fetchSeries(tvdbId);
  return bySeason?.get(seasonNumber) ?? null;
}
