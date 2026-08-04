import { Router, type Request, type Response } from "express";
import { plexFetch, plexJSON } from "../services/plex.js";
import {
  ensureSession,
  ensureSegment,
  pingSession,
  subtitlePending,
  stopSession,
  stopAllSessions,
} from "../services/ffmpeg-hls.js";
import * as thumbCache from "../services/thumb-cache.js";
import { logEvent } from "../services/logger.js";
import { sessionHostUserId } from "../services/sync.js";
import { getSessionUserId } from "../middleware/auth.js";
import { LruMap } from "../services/lru.js";

const router = Router();

/** The Discord user behind this request, from the session token requireAuth
 *  already validated. Null for the VPS relay key, which carries no user. */
function sessionUserId(req: Request): string | null {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ")
    ? header.slice(7)
    : typeof req.query.token === "string"
      ? req.query.token
      : undefined;
  return token ? getSessionUserId(token) : null;
}
// Verbose HLS logging. On outside production, or force it in a production
// container by setting DEBUG=1 (e.g. in docker-compose) without flipping
// NODE_ENV and its other production behaviour.
const DEBUG = process.env.DEBUG === "1" || process.env.NODE_ENV !== "production";

const NUMERIC_RE = /^\d+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PROXY_PATH_LENGTH = 500;

/** Stable Plex client identifier for all requests this server makes. */
const OUR_CLIENT_ID = "plex-discord-theater";

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

// VPS relay config — when set, HLS segment URLs point to the VPS
// instead of proxying through this Express server.
const VPS_RELAY_URL = process.env.VPS_RELAY_URL?.replace(/\/$/, "");
const VPS_RELAY_KEY = process.env.VPS_RELAY_KEY;

/** Parse a positive-integer env var, falling back to a default. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

// Transcode bitrate (kbps). The target is what Plex aims for on average; the
// peak bounds spikes. Per-viewer bandwidth scales linearly with this, so it's
// the single biggest bandwidth lever — 12000/20000 is visually solid 1080p
// H.264 while costing 40%+ less than the old hardcoded 20000/100000.
const VIDEO_BITRATE_KBPS = envInt("VIDEO_BITRATE_KBPS", 12000);
const VIDEO_PEAK_BITRATE_KBPS = envInt(
  "VIDEO_PEAK_BITRATE_KBPS",
  Math.max(20000, VIDEO_BITRATE_KBPS),
);

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
  /**
   * "sd" when Plex has generated BIF video preview thumbnails for this part,
   * i.e. when /library/parts/<id>/indexes/sd/<offsetMs> will resolve. Absent
   * when the library has preview generation disabled (the default) or the item
   * hasn't been indexed yet.
   */
  indexes?: string;
  Stream?: PlexStream[];
}

interface PlexMedia {
  Part?: PlexPart[];
}

/**
 * Raw Plex intro/credits marker. Offsets are in MILLISECONDS.
 * `type` is left as a plain string because Plex has added marker types over
 * time (e.g. "commercial") — a narrow union would turn an unknown type into a
 * compile error rather than a harmless runtime no-op in mapMarkers().
 */
interface PlexMarker {
  id?: number;
  type: string;
  startTimeOffset?: number;
  endTimeOffset?: number;
}

/** Normalized marker sent to the client. Times are SECONDS (video.currentTime units). */
interface SkipMarker {
  type: "intro" | "credits";
  start: number;
  end: number;
}

interface PlexMetadataItem {
  ratingKey: string;
  title: string;
  year?: number;
  type: string;
  thumb?: string;
  summary?: string;
  duration?: number;
  /** Movie cut/edition label, e.g. "Director's Cut", "Extended Edition",
   *  "IMAX Edition". Set on the file's edition in Plex; absent on a plain
   *  theatrical release. */
  editionTitle?: string;
  art?: string;
  Genre?: Array<{ tag: string }>;
  Media?: PlexMedia[];
  Marker?: PlexMarker[];
  index?: number;
  parentIndex?: number;
  parentTitle?: string;
  // Plex sends these; they're declared here for next-episode resolution only and
  // deliberately NOT forwarded by mapItem(), so existing responses are unchanged.
  parentRatingKey?: string;
  grandparentRatingKey?: string;
  grandparentTitle?: string;
  grandparentThumb?: string;
  leafCount?: number;
  childCount?: number;
  // Present on items that live in a local library section; absent on online
  // (Discover) results returned when /hubs/search is called with includeExternal.
  librarySectionID?: number;
  guid?: string;
  contentRating?: string;
  /** External ids, e.g. { id: "imdb://tt123" }, { id: "tmdb://456" }. */
  Guid?: Array<{ id?: string }>;
  /** Collections this item belongs to (present with includeCollections=1). The
   *  `tag` is the collection's title; used to find the real collection (with its
   *  ratingKey/childCount) in the section's collection list. */
  Collection?: Array<{ tag: string; id?: number }>;
  /** Cast, in Plex's billing order. `tag` is the actor, `role` the character. */
  Role?: PlexTag[];
  Director?: PlexTag[];
  Writer?: PlexTag[];
}

/** A credited person. `thumb` is a full remote URL (TMDB), not a Plex path. */
interface PlexTag {
  /** Plex's own tag id. Filtering a section by `?actor=<id>` / `?director=<id>`
   *  gives exactly the library items this person appears in, which is what the
   *  person page is built from. */
  id?: number;
  tag: string;
  role?: string;
  thumb?: string;
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
 * GET /api/plex/home
 * Returns the Plex "homepage" hubs — Continue Watching, Recently Added,
 * and any Collections/other hubs configured to show on Home — the same
 * data the official Plex homepage renders (via /hubs), as opposed to
 * /sections/:id/all which only returns one library's raw item list.
 */
interface PlexHub {
  hubIdentifier: string;
  title: string;
  type: string;
  Metadata?: PlexMetadataItem[];
}

router.get("/home", async (_req: Request, res: Response) => {
  try {
    const data = await plexJSON<{ MediaContainer: { Hub?: PlexHub[] } }>(
      "/hubs",
      // Items per hub row on the Home page.
      { count: "50" },
    );

    const hubs = (data.MediaContainer.Hub || [])
      // Only keep hubs relevant to movie/show libraries and drop empty ones
      // (this app only supports "movie" and "show" sections — see
      // ALLOWED_SECTION_TYPES above — so music/photo hubs are filtered out).
      // "Continue Watching" / "On Deck" are dropped in favour of this app's own
      // history (see services/watch-history.ts): Plex's hubs track the single
      // shared Plex account, so every host would see everyone else's progress.
      .filter((h) => h.Metadata && h.Metadata.length > 0)
      .filter((h) => !h.hubIdentifier?.startsWith("home.continue"))
      .filter((h) => !h.hubIdentifier?.startsWith("home.ondeck"))
      .filter((h) => h.title !== "On Deck")
      .filter((h) => h.title !== "Recently Released Episodes")
      .filter((h) => !h.hubIdentifier?.includes("recentlyaired"))
      .map((h) => ({
        hubIdentifier: h.hubIdentifier,
        title: h.title,
        type: h.type,
        items: h.Metadata!.map(mapItem),
      }));

    res.json({ hubs });
  } catch (err) {
    console.error("Home hubs error:", err);
    res.status(502).json({ error: "Failed to fetch home hubs" });
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
  "audienceRating:desc",
]);

router.get("/sections/:id/all", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (!NUMERIC_RE.test(id)) {
    res.status(400).json({ error: "Invalid section ID" });
    return;
  }

  const start = Math.max(0, parseInt(req.query.start as string, 10) || 0);
  const size = Math.min(200, Math.max(1, parseInt(req.query.size as string, 10) || 50));

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
    // Local library search, plus Plex's online Discover catalog in parallel.
    // Discover is best-effort — if it fails, local results still return.
    const [data, discover] = await Promise.all([
      plexJSON<{
        MediaContainer: {
          Hub?: Array<{
            hubIdentifier?: string;
            type?: string;
            Metadata?: PlexMetadataItem[];
            /** People hubs carry Directory entries rather than Metadata — the
             *  name is `tag` here, not `title`. */
            Directory?: Array<{
              tag?: string;
              title?: string;
              thumb?: string;
              type?: string;
              /** Present on library objects (collections, titles); absent on tags. */
              ratingKey?: string;
            }>;
          }>;
        };
      }>("/hubs/search", { query: q, limit: "30" }),
      searchDiscover(q),
    ]);

    const hubs = data.MediaContainer.Hub || [];
    const items: Array<ReturnType<typeof mapItem> & { inLibrary: boolean; guid?: string }> = [];
    const localGuids = new Set<string>();
    // Cast and crew whose names match, collected separately from the titles.
    //
    // Which container Plex puts these in has changed across versions — some put
    // people in `Directory` under a role-named hub, some in `Metadata` with a
    // tag type — and the hub identifier is spelled differently again ("actor"
    // vs "search.actor"). Rather than pin one shape, this accepts a person from
    // either container whenever the hub or the entry looks person-shaped.
    const people: Array<{ name: string; thumb: string | null }> = [];
    const seenPeople = new Set<string>();
    const addPerson = (name?: string, thumb?: string) => {
      if (!name || seenPeople.has(name)) return;
      seenPeople.add(name);
      people.push({
        name,
        thumb: thumb
          ? thumb.startsWith("http") ? externalThumbUrl(thumb) : `/api/plex/thumb${thumb}`
          : null,
      });
    };

    for (const hub of hubs) {
      // Only the hub identifier decides this. An entry's own `type` is "tag" for
      // people, genres and collections alike, so testing it can't tell them
      // apart — that's what put a collection in the People row.
      const peopleHub = PERSON_HUB_RE.test(hub.hubIdentifier ?? "");
      for (const d of hub.Directory ?? []) {
        // A ratingKey means a library object (a collection, a title), not a
        // person tag — a second guard in case a build files people elsewhere.
        if (peopleHub && d.ratingKey == null) addPerson(d.tag ?? d.title, d.thumb);
      }
      if (!hub.Metadata) continue;
      for (const m of hub.Metadata) {
        // Some builds return people as Metadata rather than Directory.
        if (peopleHub) {
          addPerson(m.title, m.thumb);
          continue;
        }
        // Titles only. Episodes and seasons matched on their own names, which
        // buried the show they belong to under a list of its parts.
        if (m.type !== "movie" && m.type !== "show") continue;
        if (m.guid) localGuids.add(m.guid);
        items.push({ ...mapItem(m), inLibrary: true });
      }
    }

    // Append online results the user doesn't already own. Only movies/shows —
    // the client can't do anything with a bare person/etc — and only ones with
    // a poster (no art usually means a low-value stub).
    const candidates = discover.filter(
      (m) => (m.type === "movie" || m.type === "show") && !!m.thumb,
    );
    // Ownership: an item is owned if it appeared in the local search OR a library
    // guid lookup finds it. Discover surfaces titles the local text search misses
    // (e.g. "spiderman brand" → owned Spider-Man), so the local results alone
    // don't dedup. Lookups are cached, so as-you-type stays cheap.
    const owned = await Promise.all(
      candidates.map((m) =>
        !m.guid ? Promise.resolve(false)
          : localGuids.has(m.guid) ? Promise.resolve(true)
            : isGuidInLibrary(m.guid),
      ),
    );

    candidates.forEach((m, i) => {
      if (owned[i]) return;
      items.push({
        ...mapItem(m),
        // Online items may have no local ratingKey; the client uses this as a
        // list key, so fall back to the (unique) guid.
        ratingKey: m.ratingKey ?? m.guid ?? m.title,
        // Carry the guid so the client can fetch Discover detail metadata for it.
        guid: m.guid,
        inLibrary: false,
        thumb: externalThumbUrl(m.thumb),
      });
    });

    res.json({ items, people });
  } catch (err) {
    console.error("Search error:", err);
    res.status(502).json({ error: "Failed to search Plex" });
  }
});

/**
 * Hub identifiers Plex uses for people — "actor", "search.director", "writers".
 *
 * Anchored to the role word as a whole token, because Plex labels every
 * tag-shaped hub with `type: "tag"` — genres, moods, labels *and collections*
 * all share it. Matching "tag" swept collections into the People row, so a
 * collection named "The Space Odyssey Series" was offered as a person. The hub
 * identifier is the only field that actually names the role.
 */
const PERSON_HUB_RE = /(^|\.)(actor|director|writer|producer)s?$/i;

/**
 * GET /api/plex/discover/meta?guid=plex://movie/<id>
 * Detail metadata for an online (Discover) title the user doesn't own — summary,
 * genres, runtime, rating. Comes from Plex's cloud provider since there's no
 * local library item. Fields degrade gracefully when the provider omits them.
 */
router.get("/discover/meta", async (req: Request, res: Response) => {
  const guid = req.query.guid;
  if (typeof guid !== "string" || !guid.startsWith("plex://")) {
    res.status(400).json({ error: "Invalid or missing guid" });
    return;
  }
  const id = guid.split("/").pop();
  if (!id) {
    res.status(400).json({ error: "Invalid guid" });
    return;
  }
  try {
    const m = await fetchDiscoverMeta(id);
    if (!m) {
      res.status(404).json({ error: "Details not available" });
      return;
    }
    res.json({
      title: m.title,
      year: m.year ?? null,
      summary: m.summary ?? null,
      genres: (m.Genre || []).map((g) => g.tag),
      duration: m.duration ?? null,
      contentRating: m.contentRating ?? null,
      type: m.type,
      thumb: m.thumb ? externalThumbUrl(m.thumb) : null,
      // TMDB id (for requesting via Seerr), pulled from the external id list.
      tmdbId: tmdbIdFromGuids(m.Guid),
      // Credits, when Plex's online catalog carries them for this title.
      cast: mapCredits(m.Role),
      directors: mapCredits(m.Director, 10, "Director"),
      writers: mapCredits(m.Writer, 10, "Writer"),
    });
  } catch (err) {
    console.error("Discover meta error:", err);
    res.status(502).json({ error: "Failed to fetch details" });
  }
});

/** Plex's online catalog lives on separate cloud hosts from the local server.
 *  Discover = search/hubs (thin records); metadata = fuller detail (summary, …). */
const DISCOVER_BASE = "https://discover.provider.plex.tv";
const METADATA_BASE = "https://metadata.provider.plex.tv";

/**
 * Token for plex.tv provider (Discover) calls. The local PLEX_TOKEN is a *server*
 * token, which the cloud provider rejects with "Invalid token" on endpoints that
 * validate (metadata) — search happens to be lenient. Set PLEX_ACCOUNT_TOKEN to
 * your plex.tv account token for details to work; falls back to PLEX_TOKEN.
 */
function providerToken(): string | undefined {
  return process.env.PLEX_ACCOUNT_TOKEN || process.env.PLEX_TOKEN;
}

// Cache of guid → in-library, so repeated ownership checks (search-as-you-type)
// don't re-hit Plex for the same title.
//
// LruMap, like every other cache in this file. They were plain Maps that
// checked a TTL when read and never removed anything, so they grew with the
// number of distinct titles, searches, people and TMDB ids the process had ever
// seen and only shrank on restart — a stale entry stopped being *returned* but
// went on being *held*. The caps below are generous (a big library's worth) and
// exist to bound the worst case, not to make anything miss.
const ownedGuidCache = new LruMap<string, { owned: boolean; at: number }>(2_000);
const OWNED_GUID_TTL_MS = 10 * 60 * 1000;

/**
 * Whether a plex:// guid exists in any local library section. Used to dedup
 * Discover results the local text search didn't surface (it matches differently
 * than Discover). Errors resolve to false — show the online result rather than
 * risk hiding a real one.
 */
async function isGuidInLibrary(guid: string): Promise<boolean> {
  const hit = ownedGuidCache.get(guid);
  if (hit && Date.now() - hit.at < OWNED_GUID_TTL_MS) return hit.owned;
  let owned = false;
  try {
    const data = await plexJSON<{ MediaContainer: { size?: number } }>("/library/all", { guid });
    owned = (data.MediaContainer.size ?? 0) > 0;
  } catch {
    owned = false;
  }
  ownedGuidCache.set(guid, { owned, at: Date.now() });
  return owned;
}

/**
 * Fetch a single title's metadata from the Discover cloud provider by its id
 * (the trailing segment of a plex:// guid). Best-effort: null on any failure.
 */
/** Pull the IMDb id out of a metadata item's external id list (e.g. "imdb://tt0111161"). */
function imdbIdFromGuids(guids?: Array<{ id?: string }>): string | null {
  const hit = guids?.find((g) => g.id?.startsWith("imdb://"));
  const id = hit?.id?.slice("imdb://".length);
  return id && /^tt\d{5,10}$/.test(id) ? id : null;
}

/** Pull the TMDB id out of a metadata item's external id list (e.g. "tmdb://550"). */
function tmdbIdFromGuids(guids?: Array<{ id?: string }>): number | null {
  const hit = guids?.find((g) => g.id?.startsWith("tmdb://"));
  if (!hit?.id) return null;
  const n = parseInt(hit.id.slice("tmdb://".length), 10);
  return Number.isFinite(n) ? n : null;
}

// Local library items don't always carry a tmdb:// guid — older metadata agents
// only store tvdb/imdb ids. When the direct lookup misses, resolve via Plex's
// metadata provider using the item's plex:// guid (the same path Discover uses),
// so Seerr season requests still work. Cached per ratingKey (incl. misses).
const tmdbIdCache = new LruMap<string, number | null>(2_000);

async function resolveTmdbId(m: PlexMetadataItem): Promise<number | null> {
  const direct = tmdbIdFromGuids(m.Guid);
  if (direct != null) return direct;
  // Only shows need the provider fallback for season requests; movies that lack a
  // tmdb guid are rare and not season-requestable anyway.
  if (m.type !== "show") return null;
  const key = String(m.ratingKey ?? "");
  if (key && tmdbIdCache.has(key)) return tmdbIdCache.get(key)!;
  // plex://show/<providerId> — the provider metadata endpoint keys on <providerId>.
  const providerId = /^plex:\/\/[^/]+\/(.+)$/.exec(m.guid ?? "")?.[1] ?? null;
  let resolved: number | null = null;
  if (providerId) {
    const pm = await fetchDiscoverMeta(providerId);
    resolved = pm ? tmdbIdFromGuids(pm.Guid) : null;
  }
  if (key) tmdbIdCache.set(key, resolved);
  return resolved;
}

async function fetchProviderMeta(base: string, id: string, token: string): Promise<PlexMetadataItem | null> {
  const url = new URL(`${base}/library/metadata/${encodeURIComponent(id)}`);
  // The metadata endpoint reads the X-Plex-* identity from the QUERY STRING, not
  // headers (unlike search), and 401s without the full set. Mirror what the Plex
  // web client sends.
  const params: Record<string, string> = {
    "X-Plex-Token": token,
    "X-Plex-Client-Identifier": OUR_CLIENT_ID,
    "X-Plex-Product": "Plex Discord Theater",
    "X-Plex-Version": "1.0.0",
    "X-Plex-Platform": "Web",
    "X-Plex-Provider-Version": "7.2",
    "X-Plex-Language": "en",
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn("[Discover] meta failed:", new URL(base).host, res.status);
      return null;
    }
    const data = (await res.json()) as { MediaContainer?: { Metadata?: PlexMetadataItem[] } };
    return data.MediaContainer?.Metadata?.[0] ?? null;
  } catch (err) {
    console.warn("[Discover] meta error:", new URL(base).host, err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchDiscoverMeta(id: string): Promise<PlexMetadataItem | null> {
  const token = providerToken();
  if (!token) return null;
  // Prefer the metadata provider (fuller detail — has the summary Plex shows);
  // fall back to the discover provider if it returns nothing/no summary.
  const meta = await fetchProviderMeta(METADATA_BASE, id, token);
  if (meta?.summary) return meta;
  const discover = await fetchProviderMeta(DISCOVER_BASE, id, token);
  return discover?.summary ? discover : (meta ?? discover);
}

/**
 * Search Plex's online Discover catalog (titles not necessarily in the library),
 * authenticated with the plex.tv account token. Separate cloud host, so it can't
 * go through plexFetch. Best-effort: returns [] on any failure so search still
 * works from local results alone.
 */
async function searchDiscover(query: string): Promise<PlexMetadataItem[]> {
  const token = providerToken();
  if (!token) return [];
  const url = new URL(`${DISCOVER_BASE}/library/search`);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", "15");
  url.searchParams.set("searchTypes", "movies,tv");
  url.searchParams.set("searchProviders", "discover");
  url.searchParams.set("X-Plex-Token", token);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Plex-Client-Identifier": OUR_CLIENT_ID,
        "X-Plex-Product": "Plex Discord Theater",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn("[Discover] search failed:", res.status);
      return [];
    }
    const data = (await res.json()) as { MediaContainer?: Record<string, unknown> };
    return extractDiscoverItems(data);
  } catch (err) {
    console.warn("[Discover] search error:", err);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull Metadata items out of the Discover response, tolerating shape variants
 * across Plex versions (Metadata[] directly, SearchResult[].Metadata, or
 * SearchResults[].SearchResult[].Metadata).
 */
function extractDiscoverItems(data: { MediaContainer?: Record<string, unknown> }): PlexMetadataItem[] {
  const mc = data.MediaContainer;
  if (!mc) return [];
  const out: PlexMetadataItem[] = [];
  const push = (m: unknown) => {
    if (m && typeof m === "object" && "title" in m) out.push(m as PlexMetadataItem);
  };
  if (Array.isArray(mc.Metadata)) mc.Metadata.forEach(push);
  if (Array.isArray(mc.SearchResult)) {
    mc.SearchResult.forEach((r: unknown) => push((r as { Metadata?: unknown })?.Metadata));
  }
  if (Array.isArray(mc.SearchResults)) {
    for (const group of mc.SearchResults as Array<{ SearchResult?: unknown }>) {
      if (Array.isArray(group?.SearchResult)) {
        group.SearchResult.forEach((r: unknown) => push((r as { Metadata?: unknown })?.Metadata));
      }
    }
  }
  return out;
}

/**
 * Same-origin proxy URL for an online (Discover) result's artwork.
 *
 * The image lives on Plex's cloud rather than the local server, so it's routed
 * through the /thumb handler's `url=` fetch (the local photo transcoder pulls and
 * resizes it). Returns null when absent; the client falls back to a placeholder.
 *
 * VERIFY: the exact form of an external result's thumb (absolute URL vs Plex path)
 * is version-dependent — confirm against a real response and adjust if needed.
 */
function externalThumbUrl(thumb: string | undefined): string | null {
  if (!thumb) return null;
  // No w/h here — the client's card helper appends those (and the token), so
  // adding them would duplicate the params.
  return `/api/plex/thumb/photo/:/transcode?url=${encodeURIComponent(thumb)}`;
}

/** How many cast members the detail pages show. Plex's own list is unbounded and
 *  the tail is bit parts with no headshots, which make for a poor row. */
const MAX_CAST = 30;

/**
 * Map Plex's Role/Director/Writer tags to the client's credit shape.
 *
 * Person thumbs are absolute URLs on Plex's own metadata CDN rather than local
 * library paths, so they go through the same external-image proxy the Discover
 * posters use — the client never talks to that CDN directly.
 */
function mapCredits(tags: PlexTag[] | undefined, limit = MAX_CAST, roleFallback?: string) {
  return (tags || []).slice(0, limit).map((t) => ({
    id: t.id ?? null,
    name: t.tag,
    // Plex sets `role` (the character) on cast only — a Director/Writer tag has
    // none, so without the fallback those entries render with a blank subtitle.
    role: t.role ?? roleFallback ?? null,
    thumb: t.thumb
      ? t.thumb.startsWith("http")
        ? externalThumbUrl(t.thumb)
        : `/api/plex/thumb${t.thumb}`
      : null,
  }));
}

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
    const payload = await buildMeta(ratingKey);
    if (!payload) {
      res.status(404).json({ error: "Item not found" });
      return;
    }
    res.json(payload);
  } catch (err) {
    console.error("Metadata error:", err);
    res.status(502).json({ error: "Failed to fetch metadata" });
  }
});

/**
 * The /meta payload, memoised.
 *
 * Assembling it costs a Plex metadata call plus TMDB id resolution, and the
 * detail page can't paint without it — so the result is cached and the cache is
 * pre-warmed at startup (see services/cache-warmer.ts). Exported for the warmer.
 *
 * Returns null when Plex has no such item, which the route turns into a 404.
 * Nulls are deliberately not cached: a 404 here usually means the library is
 * mid-scan, and pinning that answer for an hour would outlast the cause.
 */
export async function buildMeta(ratingKey: string): Promise<Record<string, unknown> | null> {
  const hit = metaCache.get(ratingKey);
  if (hit && Date.now() - hit.at < META_CACHE_TTL_MS) return hit.payload;

  const payload = await buildMetaUncached(ratingKey);
  if (payload) metaCache.set(ratingKey, { payload, at: Date.now() });
  return payload;
}

const metaCache = new LruMap<string, { payload: Record<string, unknown>; at: number }>(2_000);
const META_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** The /collections response: the item's collections plus TMDB recommendations. */
export interface RelatedPayload {
  collections: unknown[];
  recommendations: unknown[];
}

const relatedCache = new LruMap<string, { payload: RelatedPayload; at: number }>(2_000);
const RELATED_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — this rarely changes

/** A fresh cached /collections payload, or null. Exported for the warmer, which
 *  uses it to skip anything already warm. */
export function getRelatedCached(ratingKey: string): RelatedPayload | null {
  const hit = relatedCache.get(ratingKey);
  return hit && Date.now() - hit.at < RELATED_CACHE_TTL_MS ? hit.payload : null;
}

async function buildMetaUncached(ratingKey: string): Promise<Record<string, unknown> | null> {
    const data = await plexJSON<{ MediaContainer: { Metadata?: PlexMetadataItem[] } }>(
      `/library/metadata/${ratingKey}`,
      // includeGuids so the external-id list (tmdb://…) is present — needed to
      // offer Seerr season requests for library shows.
      { includeMarkers: "1", includeGuids: "1" },
    );
    const metadata = data.MediaContainer.Metadata;
    if (!metadata || metadata.length === 0) return null;
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

    const tmdbId = await resolveTmdbId(m);
    // IMDb id (when Plex stored one) — the preferred key for external ratings.
    const imdbId = imdbIdFromGuids(m.Guid);

    return {
      ratingKey: m.ratingKey,
      title: m.title,
      year: m.year,
      summary: m.summary,
      duration: m.duration,
      // Cut/edition label ("Director's Cut", "Extended Edition", …) when this
      // file is a special edition; null for a plain theatrical release.
      editionTitle: m.editionTitle ?? null,
      thumb: m.thumb ? `/api/plex/thumb${m.thumb}` : null,
      // Show (grandparent) poster for episodes — lets clients prefer the portrait
      // show art over the landscape episode still. Null for movies.
      showThumb: m.grandparentThumb ? `/api/plex/thumb${m.grandparentThumb}` : null,
      art: m.art ? `/api/plex/thumb${m.art}` : null,
      genres: (m.Genre || []).map((g) => g.tag),
      type: m.type,
      // Episode ancestry, carried the same way mapItem does it.
      //
      // A viewer's player is built entirely from a ratingKey and a title — sync
      // state has nothing else — so without these an episode arrives typed as a
      // film with no show behind it: it renders as a bare episode name, and
      // reaching the end drops the viewer back on the episode rather than on the
      // show. Absent for movies, so nothing else changes.
      ...(m.index != null && { index: m.index }),
      ...(m.parentIndex != null && { parentIndex: m.parentIndex }),
      ...(m.parentTitle != null && { parentTitle: m.parentTitle }),
      ...(m.parentRatingKey != null && { parentRatingKey: m.parentRatingKey }),
      ...(m.grandparentRatingKey != null && { grandparentRatingKey: m.grandparentRatingKey }),
      ...(m.grandparentTitle != null && { showTitle: m.grandparentTitle }),
      partId: part?.id ?? null,
      /** Whether hover-preview frames exist for this part (see PlexPart.indexes). */
      previewThumbs: part?.indexes === "sd",
      audioTracks,
      subtitleTracks,
      markers: mapMarkers(m.Marker),
      // TMDB id — lets the client offer Seerr season requests for library shows.
      tmdbId,
      // IMDb id — used by the client to look up external ratings. Null when
      // Plex's metadata agent never stored one.
      imdbId,
      // Credits for the detail page's Cast & Crew row. Episodes carry their own
      // guest cast; shows carry the series regulars.
      cast: mapCredits(m.Role),
      directors: mapCredits(m.Director, 10, "Director"),
      writers: mapCredits(m.Writer, 10, "Writer"),
    };
}

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
 * Largest a collection may be to appear on an item's detail page. Curated sets
 * fit under this and render as "also in this collection" rows; sprawling
 * auto-collections like "Trending" (40+ items) are filtered out so they don't
 * take over the page. Inclusive — a collection of exactly this many still shows.
 *
 * Movies get a higher cap than shows: film franchises/box sets run large (e.g.
 * a 20+ Marvel or Bond collection) and are still worth showing, whereas a show's
 * collections are typically small and a big one is more likely noise.
 */
const COLLECTION_MAX_ITEMS_MOVIE = 30;
const COLLECTION_MAX_ITEMS_SHOW = 10;

/** The size cap for a given item type. */
function collectionMaxItems(type: string): number {
  return type === "movie" ? COLLECTION_MAX_ITEMS_MOVIE : COLLECTION_MAX_ITEMS_SHOW;
}

// ─── TMDB collections ───────────────────────────────────────────
//
// A Plex library collection only contains items you own, so it can't show the
// franchise films you're missing. TMDB knows the full membership, so when a
// TMDB_API_KEY is configured we fetch the movie's TMDB collection and render the
// whole franchise — owned films playable, the rest as "Not in library" cards
// that open the existing request flow. Movies only; TMDB has no TV equivalent.
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_API_BASE = "https://api.themoviedb.org/3";

interface TmdbPart {
  id: number;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
}

// Cache movie→collection and collection→parts (both including misses) so
// browsing detail pages doesn't re-hit TMDB for the same title.
const tmdbMovieCollectionCache = new LruMap<number, { id: number; name: string } | null>(2_000);
const tmdbCollectionCache = new LruMap<number, { name: string; parts: TmdbPart[] } | null>(1_000);

async function tmdbGet<T>(path: string, params?: Record<string, string>): Promise<T | null> {
  if (!TMDB_API_KEY) return null;
  const url = new URL(`${TMDB_API_BASE}${path}`);
  url.searchParams.set("api_key", TMDB_API_KEY);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
    if (!res.ok) {
      console.warn("[TMDB] request failed:", path, res.status);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn("[TMDB] request error:", path, err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Map a TMDB cast/crew array to the same credit shape the Plex path produces,
 * so the client renders one component for library and Discover titles alike.
 */
function tmdbCredits<T extends { name?: string; profile_path?: string | null }>(
  people: T[] | undefined,
  limit: number,
  roleOf: (p: T) => string | undefined,
) {
  return (people ?? [])
    .filter((p) => p.name)
    .slice(0, limit)
    .map((p) => ({
      name: p.name as string,
      role: roleOf(p) || null,
      thumb: p.profile_path
        ? externalThumbUrl(`https://image.tmdb.org/t/p/w185${p.profile_path}`)
        : null,
    }));
}

/** The TMDB collection a movie belongs to, or null when it's a standalone film
 *  (or TMDB has no key/entry). Cached, misses included. */
async function tmdbMovieCollection(tmdbId: number): Promise<{ id: number; name: string } | null> {
  if (tmdbMovieCollectionCache.has(tmdbId)) return tmdbMovieCollectionCache.get(tmdbId)!;
  const data = await tmdbGet<{ belongs_to_collection?: { id: number; name: string } | null }>(
    `/movie/${tmdbId}`,
  );
  const coll = data?.belongs_to_collection ?? null;
  tmdbMovieCollectionCache.set(tmdbId, coll);
  return coll;
}

/** Every film in a TMDB collection, or null on failure. Cached, misses included. */
async function tmdbCollectionParts(collectionId: number): Promise<{ name: string; parts: TmdbPart[] } | null> {
  if (tmdbCollectionCache.has(collectionId)) return tmdbCollectionCache.get(collectionId)!;
  const data = await tmdbGet<{ name?: string; parts?: TmdbPart[] }>(`/collection/${collectionId}`);
  const result =
    data && Array.isArray(data.parts) ? { name: data.name ?? "Collection", parts: data.parts } : null;
  tmdbCollectionCache.set(collectionId, result);
  return result;
}

/** Loose title key for matching a TMDB part to a library item — case- and
 *  punctuation-insensitive, so "Spider-Man: Homecoming" == "spidermanhomecoming". */
function collectionTitleKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Release year of a TMDB part, or null. */
function tmdbPartYear(part: TmdbPart): number | undefined {
  const y = part.release_date ? parseInt(part.release_date.slice(0, 4), 10) : NaN;
  return Number.isFinite(y) ? y : undefined;
}

/** A collection member sent to the client. Extends a mapped library item with
 *  the two fields an out-of-library (TMDB) member needs: the inLibrary=false
 *  flag MovieCard keys off, and the tmdbId that drives its request flow. */
type CollectionItem = ReturnType<typeof mapItem> & { inLibrary?: boolean; tmdbId?: number };

/** TMDB "recommendations" results for a movie or show (same shape as parts,
 *  plus the alternate date/name fields TV uses). */
async function tmdbRecommendations(kind: "movie" | "tv", tmdbId: number): Promise<TmdbPart[]> {
  const data = await tmdbGet<{ results?: TmdbPart[] }>(`/${kind}/${tmdbId}/recommendations`);
  return Array.isArray(data?.results) ? data!.results! : [];
}

/** Release/air year of a TMDB result (movies use release_date, TV first_air_date). */
function tmdbResultYear(part: TmdbPart): number | undefined {
  const raw = part.release_date ?? part.first_air_date;
  const y = raw ? parseInt(raw.slice(0, 4), 10) : NaN;
  return Number.isFinite(y) ? y : undefined;
}

// Cache tmdbId → the library item that matches it (or null), so recommendation
// rows don't re-resolve the same title on every visit. Keyed by type since a
// movie and a show can share a tmdbId across their separate id spaces.
const libraryMatchCache = new LruMap<string, PlexMetadataItem | null>(5_000);

/**
 * The library item matching a TMDB result, or null when it isn't owned. Resolved
 * via Plex search (not the `?guid=tmdb://…` filter, which only matches an item's
 * *primary* plex:// guid and so misses owned titles whose TMDB id is a secondary
 * guid). Among the search hits it prefers, in order:
 *   1. an exact TMDB-id match (the search asks for guids) — authoritative, and
 *      immune to naming differences;
 *   2. an exact normalised-title match within a year;
 *   3. a title that is a prefix/suffix of the other within the same year — so
 *      Plex's "Daredevil" still matches TMDB's "Marvel's Daredevil".
 */
async function findLibraryMatch(part: TmdbPart, type: string): Promise<PlexMetadataItem | null> {
  const title = part.title ?? part.name ?? "";
  const key = `${type}:${part.id}`;
  if (libraryMatchCache.has(key)) return libraryMatchCache.get(key)!;
  let found: PlexMetadataItem | null = null;
  if (title) {
    try {
      const data = await plexJSON<{ MediaContainer: { Hub?: Array<{ Metadata?: PlexMetadataItem[] }> } }>(
        "/hubs/search",
        { query: title, limit: "12", includeGuids: "1" },
      );
      const wantKey = collectionTitleKey(title);
      const year = tmdbResultYear(part);
      // Library hits of the right type (a section id means it's owned, not an
      // online Discover result).
      const candidates = (data.MediaContainer.Hub || [])
        .flatMap((h) => h.Metadata || [])
        .filter((c) => c.type === type && c.librarySectionID != null && c.title != null);

      const yearOk = (c: PlexMetadataItem) =>
        year == null || c.year == null || Math.abs(c.year - year) <= 1;
      const keyOf = (c: PlexMetadataItem) => collectionTitleKey(c.title!);

      found =
        // 1. Exact TMDB id — authoritative regardless of how the title is spelled.
        candidates.find((c) => tmdbIdFromGuids(c.Guid) === part.id) ??
        // 2. Exact normalised title within a year.
        candidates.find((c) => keyOf(c) === wantKey && yearOk(c)) ??
        // 3. Prefix/suffix title (e.g. "daredevil" ⊂ "marvelsdaredevil"), same
        //    year — a studio prefix TMDB adds shouldn't drop the match. Guard on
        //    a real year so a short title can't loosely match an unrelated one.
        candidates.find(
          (c) =>
            year != null &&
            c.year === year &&
            (keyOf(c).includes(wantKey) || wantKey.includes(keyOf(c))),
        ) ??
        null;
    } catch {
      found = null;
    }
  }
  libraryMatchCache.set(key, found);
  return found;
}

/**
 * GET /api/plex/collections/:ratingKey
 * The (small) collections this library item belongs to, each with its members —
 * for the "also in this collection" rows on a movie/show detail page. The item
 * itself is kept in each row (as Plex does on its own detail pages), and
 * collections larger than the per-type cap (movies 30, shows 10) are dropped
 * entirely.
 *
 * For movies, when a TMDB_API_KEY is set, the film's TMDB collection supplies
 * the *full* franchise: owned films render as playable cards, missing ones as
 * "Not in library" cards (inLibrary=false + tmdbId) that open the request flow —
 * so the row shows the whole set, not only what's owned. The matching owned-only
 * Plex collection is dropped in favour of this fuller row; any unrelated Plex
 * collections (e.g. a personal "Christmas Movies") are kept as-is.
 *
 * Also returns `recommendations` — TMDB's "you might also like" list for the
 * "More Like This" row — computed here (rather than in its own endpoint) so it
 * can exclude anything already shown in a collection above. See
 * buildRecommendations for the library-first, fill-to-target ordering.
 *
 * Returns { collections: [], recommendations: [] } (never an error) when there's
 * nothing to show, so the client can render each row or nothing.
 */
router.get("/collections/:ratingKey", async (req: Request, res: Response) => {
  const ratingKey = req.params.ratingKey as string;
  if (!NUMERIC_RE.test(ratingKey)) {
    res.status(400).json({ error: "Invalid rating key" });
    return;
  }

  const cached = getRelatedCached(ratingKey);
  if (cached) {
    res.json(cached);
    return;
  }
  // Every success path goes through here so the answer is cached once, wherever
  // it was produced. Assembling it costs several Plex calls plus a TMDB
  // recommendations lookup, which is why these rows lagged the rest of the page.
  const send = (payload: RelatedPayload) => {
    relatedCache.set(ratingKey, { payload, at: Date.now() });
    res.json(payload);
  };

  try {
    // Which collections does this item belong to? Plex only lists them on the
    // item's own metadata (as Collection tags), and only with includeCollections.
    // includeGuids brings the external-id list (tmdb://…) needed to resolve the
    // TMDB collection below.
    const metaData = await plexJSON<{ MediaContainer: { Metadata?: PlexMetadataItem[] } }>(
      `/library/metadata/${ratingKey}`,
      { includeCollections: "1", includeGuids: "1" },
    );
    const m = metaData.MediaContainer.Metadata?.[0];
    if (!m) {
      res.status(404).json({ error: "Item not found" });
      return;
    }

    const sectionId = m.librarySectionID;
    // Not a local library item (online result) — nothing to show.
    if (sectionId == null) {
      send({ collections: [], recommendations: [] });
      return;
    }

    // Size cap depends on the item type — movies allow larger sets than shows.
    const maxItems = collectionMaxItems(m.type);
    // Resolved once — used for the movie's TMDB franchise row and for the
    // recommendations row below. Null when there's no TMDB id (or no key).
    const itemTmdbId = TMDB_API_KEY ? await resolveTmdbId(m) : null;

    // ── Owned rows: the small Plex collections this item is in ──────────
    // Each carries its owned members (used both to render the row and, below, to
    // tell which TMDB franchise films are already in the library).
    const memberTitles = new Set((m.Collection || []).map((c) => c.tag).filter(Boolean));
    const plexRows: Array<{ ratingKey: string; title: string; children: PlexMetadataItem[] }> = [];
    if (memberTitles.size > 0) {
      // The item's Collection tags carry only titles — the ratingKey (to list
      // members) and childCount (to size-filter) live on the section's
      // collection list, matched back by title.
      const collData = await plexJSON<{
        MediaContainer: { Metadata?: PlexMetadataItem[]; Directory?: PlexMetadataItem[] };
      }>(`/library/sections/${sectionId}/collections`);
      const sectionCollections =
        collData.MediaContainer.Metadata || collData.MediaContainer.Directory || [];

      // Only the small collections this item is in — sized down here so a large
      // collection (Trending) is skipped without ever fetching its members.
      const matched = sectionCollections.filter(
        (c) =>
          memberTitles.has(c.title) &&
          (c.childCount ?? 0) > 0 &&
          (c.childCount ?? 0) <= maxItems,
      );
      for (const c of matched) {
        const childrenData = await plexJSON<{ MediaContainer: { Metadata?: PlexMetadataItem[] } }>(
          `/library/collections/${c.ratingKey}/children`,
        );
        const children = childrenData.MediaContainer.Metadata || [];
        if (children.length > 0) plexRows.push({ ratingKey: String(c.ratingKey), title: c.title, children });
      }
    }

    // ── Franchise row: the full TMDB collection, owned + missing (movies) ──
    let tmdbRow: { ratingKey: string; title: string; items: CollectionItem[] } | null = null;
    let consumedPlexRatingKey: string | null = null;
    if (m.type === "movie" && TMDB_API_KEY) {
      const coll = itemTmdbId != null ? await tmdbMovieCollection(itemTmdbId) : null;
      const collParts = coll ? await tmdbCollectionParts(coll.id) : null;
      // Same size cap as Plex collections (movie cap) — skip a sprawling
      // franchise entirely.
      if (coll && collParts && collParts.parts.length > 0 && collParts.parts.length <= maxItems) {
        // Everything the library owns that could be a franchise film: this movie
        // plus every member of the matched Plex collections, keyed by loose title.
        const ownedByTitle = new Map<string, PlexMetadataItem>();
        const addOwned = (item: PlexMetadataItem) => {
          if (item.title) ownedByTitle.set(collectionTitleKey(item.title), item);
        };
        addOwned(m);
        for (const row of plexRows) for (const child of row.children) addOwned(child);

        // Chronological, but undated films (typically unreleased entries with no
        // year, always out-of-library) sort to the very end rather than the front
        // — an empty release_date would otherwise sort before every real date.
        const parts = [...collParts.parts].sort((a, b) =>
          (a.release_date || "9999-99-99").localeCompare(b.release_date || "9999-99-99"),
        );
        const items: CollectionItem[] = await Promise.all(
          parts.map(async (part) => {
            const partTitle = part.title ?? part.name ?? "";
            // Prefer the item from the movie's Plex collection (no lookup needed);
            // otherwise search the library, so a franchise film that's owned but
            // not in any Plex collection still resolves as owned instead of
            // wrongly showing "Not in library".
            const owned =
              ownedByTitle.get(collectionTitleKey(partTitle)) ?? (await findLibraryMatch(part, "movie"));
            if (owned) return mapItem(owned);
            // Missing from the library — a non-playable, requestable card. Poster
            // is proxied the same way as Discover search results.
            return {
              ratingKey: `tmdb:${part.id}`,
              title: partTitle,
              year: tmdbPartYear(part),
              type: "movie",
              thumb: part.poster_path
                ? externalThumbUrl(`https://image.tmdb.org/t/p/w500${part.poster_path}`)
                : null,
              inLibrary: false,
              tmdbId: part.id,
            } as CollectionItem;
          }),
        );
        tmdbRow = { ratingKey: `tmdb-collection:${coll.id}`, title: coll.name, items };

        // Drop the Plex collection that is this same franchise so the page doesn't
        // show two near-identical rows; unrelated personal collections stay. The
        // TMDB row already holds those owned films (resolved to their library
        // ratingKeys), so a Plex collection whose every member appears in the TMDB
        // row is the duplicate. Matching on ratingKey — not title — survives films
        // Plex and TMDB name differently (e.g. the regional "Salazar's Revenge" vs
        // "Dead Men Tell No Tales"), which a title match would miss, leaving both
        // rows on screen.
        const tmdbOwnedKeys = new Set(
          items.filter((it) => it.inLibrary !== false).map((it) => String(it.ratingKey)),
        );
        const franchiseRow = plexRows.find(
          (row) =>
            row.children.length > 0 &&
            row.children.every((child) => tmdbOwnedKeys.has(String(child.ratingKey))),
        );
        if (franchiseRow) consumedPlexRatingKey = franchiseRow.ratingKey;
      }
    }

    // Franchise row first, then the remaining (unrelated) owned collections. The
    // item being viewed stays in every row — Plex keeps it on its own detail
    // pages too.
    const collections: Array<{ ratingKey: string; title: string; items: CollectionItem[] }> = [];
    const seenTitles = new Set<string>();
    // Never emit two rows with the same collection name. The ratingKey dedup above
    // drops the Plex collection matching the TMDB franchise, but as a safety net
    // this also collapses an identically-named Plex collection it missed (or a
    // duplicate collection in the library), so "Pirates of the Caribbean
    // Collection" can't render twice. First one wins — the TMDB row leads.
    const add = (row: { ratingKey: string; title: string; items: CollectionItem[] }) => {
      const key = collectionTitleKey(row.title);
      if (seenTitles.has(key)) return;
      seenTitles.add(key);
      collections.push(row);
    };
    if (tmdbRow) add(tmdbRow);
    for (const row of plexRows) {
      if (row.ratingKey === consumedPlexRatingKey) continue;
      add({ ratingKey: row.ratingKey, title: row.title, items: row.children.map(mapItem) });
    }

    // ── "More Like This": TMDB recommendations, minus collection items ──
    const recommendations = await buildRecommendations(m, itemTmdbId, collections);

    send({ collections, recommendations });
  } catch (err) {
    console.error("Collections error:", err);
    res.status(502).json({ error: "Failed to fetch collections" });
  }
});

// How many TMDB recommendations to resolve ownership for (bounds the per-title
// Plex searches), and the size the row is topped up to with out-of-library
// suggestions when the library doesn't supply enough on its own.
const RECOMMENDATIONS_POOL = 20;
const RECOMMENDATIONS_MIN_TOTAL = 8;

/**
 * Build the "More Like This" row for a movie/show from TMDB recommendations.
 *
 * Titles already shown in one of the page's collection rows are excluded (no
 * repeats). What's left is split into library titles and out-of-library ones;
 * every library title is shown, and out-of-library titles top the row up only
 * until it reaches RECOMMENDATIONS_MIN_TOTAL. So a library-rich list shows all
 * of its owned matches and nothing external, while a sparse one is filled with
 * requestable suggestions to the target size.
 *
 * Empty without a TMDB key / id, for episodes-and-the-like, or on any failure —
 * the row is a nicety, never allowed to break the page.
 */
async function buildRecommendations(
  m: PlexMetadataItem,
  itemTmdbId: number | null,
  collections: Array<{ items: CollectionItem[] }>,
): Promise<CollectionItem[]> {
  if (!TMDB_API_KEY || itemTmdbId == null || (m.type !== "movie" && m.type !== "show")) return [];
  try {
    // Everything already on the page (in a collection row) — excluded so a
    // suggestion never duplicates a collection entry. Keyed loosely by title,
    // plus by tmdbId for the out-of-library collection members that carry one.
    const shownTitleKeys = new Set<string>();
    const shownTmdbIds = new Set<number>();
    for (const coll of collections)
      for (const it of coll.items) {
        if (it.title) shownTitleKeys.add(collectionTitleKey(it.title));
        if (it.tmdbId != null) shownTmdbIds.add(it.tmdbId);
      }

    const kind = m.type === "show" ? "tv" : "movie";
    const recs = (await tmdbRecommendations(kind, itemTmdbId))
      // Needs a poster to render a card and an id to resolve/request; drop any
      // that's already shown in a collection above.
      .filter((r) => r.id != null && !!r.poster_path)
      .filter(
        (r) =>
          !shownTmdbIds.has(r.id) &&
          !shownTitleKeys.has(collectionTitleKey(r.title ?? r.name ?? "")),
      )
      .slice(0, RECOMMENDATIONS_POOL);

    // Resolve library ownership for each in parallel — owned ones become
    // playable cards, the rest requestable "not in library" cards.
    const resolved = await Promise.all(
      recs.map(async (r) => {
        const owned = await findLibraryMatch(r, m.type);
        if (owned) return { inLibrary: true, item: mapItem(owned) as CollectionItem };
        const external: CollectionItem = {
          ratingKey: `tmdb:${r.id}`,
          title: r.title ?? r.name ?? "",
          year: tmdbResultYear(r),
          type: m.type,
          thumb: externalThumbUrl(`https://image.tmdb.org/t/p/w500${r.poster_path}`),
          inLibrary: false,
          tmdbId: r.id,
        };
        return { inLibrary: false, item: external };
      }),
    );

    // A search-resolved owned title can still turn out to be a collection member
    // (the pre-filter keys off the TMDB title, the match off Plex's) — drop those.
    const libraryRecs = resolved
      .filter((r) => r.inLibrary)
      .map((r) => r.item)
      .filter((it) => !it.title || !shownTitleKeys.has(collectionTitleKey(it.title)));
    const externalRecs = resolved.filter((r) => !r.inLibrary).map((r) => r.item);

    // Show every library suggestion; fill with out-of-library ones only up to
    // the target total.
    const fill = Math.max(0, RECOMMENDATIONS_MIN_TOTAL - libraryRecs.length);
    return [...libraryRecs, ...externalRecs.slice(0, fill)];
  } catch (err) {
    console.error("Recommendations error:", err);
    return [];
  }
}

/**
 * GET /api/plex/tmdb/meta?tmdbId=123&type=movie|show
 * Full detail metadata for an out-of-library collection/recommendation member.
 * Those carry a TMDB id but no plex:// guid, so /discover/meta (which keys off
 * the guid) can't resolve them — their detail page would otherwise show no
 * description. Returns the same shape as /discover/meta so ExternalDetail renders
 * it identically. Requires TMDB_API_KEY.
 */
router.get("/tmdb/meta", async (req: Request, res: Response) => {
  const tmdbId = String(req.query.tmdbId ?? "");
  const type = String(req.query.type ?? "movie");
  if (!NUMERIC_RE.test(tmdbId) || (type !== "movie" && type !== "show")) {
    res.status(400).json({ error: "Invalid tmdbId or type" });
    return;
  }
  if (!TMDB_API_KEY) {
    res.status(404).json({ error: "Details not available" });
    return;
  }
  try {
    const data = await tmdbGet<{
      title?: string;
      name?: string;
      overview?: string;
      release_date?: string;
      first_air_date?: string;
      runtime?: number;
      episode_run_time?: number[];
      poster_path?: string | null;
      genres?: Array<{ name?: string }>;
      credits?: {
        cast?: Array<{ name?: string; character?: string; profile_path?: string | null }>;
        crew?: Array<{ name?: string; job?: string; profile_path?: string | null }>;
      };
    }>(
      `/${type === "show" ? "tv" : "movie"}/${tmdbId}`,
      // Credits ride along on the detail request rather than costing a second
      // round trip — the cast row is rendered with the rest of the page.
      { append_to_response: "credits" },
    );
    if (!data) {
      res.status(404).json({ error: "Details not available" });
      return;
    }
    const yearStr = (data.release_date ?? data.first_air_date ?? "").slice(0, 4);
    // Movie runtime is a single value; TV reports a per-episode array.
    const runtimeMin = data.runtime ?? data.episode_run_time?.[0] ?? null;
    res.json({
      title: data.title ?? data.name ?? "",
      year: yearStr ? Number(yearStr) : null,
      summary: data.overview || null,
      genres: (data.genres ?? []).map((g) => g.name).filter(Boolean),
      duration: runtimeMin != null ? runtimeMin * 60000 : null,
      contentRating: null,
      type,
      thumb: data.poster_path
        ? externalThumbUrl(`https://image.tmdb.org/t/p/w500${data.poster_path}`)
        : null,
      tmdbId: Number(tmdbId),
      // Same credit shape the library meta endpoint returns, so the detail pages
      // render one Cast & Crew component regardless of where the title came from.
      cast: tmdbCredits(data.credits?.cast, MAX_CAST, (c) => c.character),
      directors: tmdbCredits(
        (data.credits?.crew ?? []).filter((c) => c.job === "Director"), 10, (c) => c.job,
      ),
      writers: tmdbCredits(
        (data.credits?.crew ?? []).filter((c) => c.job === "Writer" || c.job === "Screenplay"),
        10,
        (c) => c.job,
      ),
    });
  } catch (err) {
    console.error("TMDB meta error:", err);
    res.status(502).json({ error: "Failed to fetch details" });
  }
});

/**
 * GET /api/plex/person?name=<name>
 *
 * A cast/crew member's page: their biography and photo, plus everything in the
 * library they worked on, split into movies and shows.
 *
 * The filmography comes from Plex rather than TMDB, by filtering each section on
 * the person's tag id (`?actor=` / `?director=`). That is one request per
 * section and, by construction, returns only titles that are actually in the
 * library — which is what the page is meant to show. Asking TMDB for their
 * credits and then testing each one for ownership would be both slower and
 * wrong at the edges.
 *
 * The biography has no Plex equivalent, so it comes from TMDB, matched by name.
 * It's optional: with no TMDB key, or no match, the page still lists the
 * filmography and simply omits the prose.
 */
router.get("/person", async (req: Request, res: Response) => {
  const name = typeof req.query.name === "string" ? req.query.name.trim().slice(0, 200) : "";
  if (!name) {
    res.status(400).json({ error: "Missing name" });
    return;
  }

  try {
    const person = await tmdbPerson(name);
    if (!person) {
      // No TMDB key, or nobody by that name. The page still renders — it just
      // has nothing to show, which is a truthful answer rather than an error.
      res.json({ name, thumb: null, biography: null, birthday: null, deathday: null,
                 placeOfBirth: null, knownFor: null, movies: [], shows: [] });
      return;
    }

    const credits = await tmdbGet<{
      cast?: TmdbCredit[];
      crew?: TmdbCredit[];
    }>(`/person/${person.tmdbId}/combined_credits`);

    // Acting roles plus directing credits — the two kinds the cast row links
    // from. Other crew jobs would pad the page with titles nobody associates
    // with the person.
    const all = [
      ...(credits?.cast ?? []),
      ...(credits?.crew ?? []).filter((c) => c.job === "Director"),
    ];

    // Most-known first, so the per-title library lookups below are spent on the
    // credits actually worth showing.
    const rank = (c: TmdbCredit) => c.popularity ?? 0;
    const pick = (mediaType: string) => {
      const byId = new Map<number, TmdbCredit>();
      for (const c of all) {
        if (c.media_type !== mediaType || c.id == null) continue;
        if (!byId.has(c.id)) byId.set(c.id, c);
      }
      return [...byId.values()].sort((a, b) => rank(b) - rank(a)).slice(0, MAX_PERSON_CREDITS);
    };

    // Only what's actually here. findLibraryMatch is the same ownership check the
    // recommendation rows use, and it's cached, so a second visit is nearly free.
    const resolve = async (credits: TmdbCredit[], type: string) => {
      const matches = await Promise.all(
        credits.map(async (c) => {
          const owned = await findLibraryMatch(c, type);
          return owned ? mapItem(owned) : null;
        }),
      );
      return matches.filter((m): m is ReturnType<typeof mapItem> => m !== null);
    };

    const [movies, shows] = await Promise.all([
      resolve(pick("movie"), "movie"),
      resolve(pick("tv"), "show"),
    ]);

    const byYear = (a: { year?: number }, b: { year?: number }) => (b.year ?? 0) - (a.year ?? 0);
    movies.sort(byYear);
    shows.sort(byYear);

    res.json({
      name: person.name,
      thumb: person.thumb,
      biography: person.biography,
      birthday: person.birthday,
      deathday: person.deathday,
      placeOfBirth: person.placeOfBirth,
      knownFor: person.knownFor,
      movies,
      shows,
    });
  } catch (err) {
    console.error("Person error:", err);
    res.status(502).json({ error: "Failed to fetch person" });
  }
});

/** Credits to test for ownership per kind. Beyond this the tail is bit parts
 *  and guest spots, and each one costs a library lookup. */
const MAX_PERSON_CREDITS = 40;

/** A TMDB combined-credits entry. Extends TmdbPart so it can be handed straight
 *  to findLibraryMatch, which is the same ownership test the related rows use. */
interface TmdbCredit extends TmdbPart {
  media_type?: string;
  job?: string;
  popularity?: number;
}

/** TMDB person lookup by name, cached (misses included — a name TMDB doesn't
 *  know won't start knowing it on the next page view). */
const tmdbPersonCache = new LruMap<string, TmdbPerson | null>(2_000);

interface TmdbPerson {
  tmdbId: number;
  name: string;
  thumb: string | null;
  biography: string | null;
  birthday: string | null;
  deathday: string | null;
  placeOfBirth: string | null;
  knownFor: string | null;
}

async function tmdbPerson(name: string): Promise<TmdbPerson | null> {
  const key = name.toLowerCase();
  if (tmdbPersonCache.has(key)) return tmdbPersonCache.get(key)!;

  const search = await tmdbGet<{ results?: Array<{ id: number }> }>("/search/person", {
    query: name,
  });
  const id = search?.results?.[0]?.id;
  let result: TmdbPerson | null = null;
  if (id != null) {
    const p = await tmdbGet<{
      name?: string;
      biography?: string;
      birthday?: string | null;
      deathday?: string | null;
      place_of_birth?: string | null;
      known_for_department?: string | null;
      profile_path?: string | null;
    }>(`/person/${id}`);
    if (p) {
      result = {
        tmdbId: id,
        name: p.name ?? name,
        thumb: p.profile_path
          ? externalThumbUrl(`https://image.tmdb.org/t/p/w500${p.profile_path}`)
          : null,
        biography: p.biography || null,
        birthday: p.birthday || null,
        deathday: p.deathday || null,
        placeOfBirth: p.place_of_birth || null,
        knownFor: p.known_for_department || null,
      };
    }
  }
  tmdbPersonCache.set(key, result);
  return result;
}

/**
 * GET /api/plex/siblings/:ratingKey
 * Resolve the episodes either side of this one: { prev, next }, each nullable.
 *
 * Uses /allLeaves, which returns every episode of a show already ordered by
 * season then episode — so "the elements either side of mine" give season
 * rollover (S1E10 → S2E1, and back) for free, with no extra request and no
 * boundary special case. Both directions come from one pass, so previous costs
 * nothing on top of next.
 *
 * Returns 200 with nulls — rather than an error — for movies, the first/last
 * episode, and anything unresolvable, since "there is no episode that way" is a
 * normal answer the client renders as a disabled button.
 *
 * Note: a show with a Season 0 has its specials in allLeaves (usually first), so
 * the last special rolls into S1E1. Rare, and filtering would need a rule about
 * whether the current episode is itself a special.
 */
router.get("/siblings/:ratingKey", async (req: Request, res: Response) => {
  const ratingKey = req.params.ratingKey as string;
  if (!NUMERIC_RE.test(ratingKey)) {
    res.status(400).json({ error: "Invalid rating key" });
    return;
  }

  try {
    const data = await plexJSON<{ MediaContainer: { Metadata?: PlexMetadataItem[] } }>(
      `/library/metadata/${ratingKey}`,
    );
    const m = data.MediaContainer.Metadata?.[0];
    if (!m) {
      res.status(404).json({ error: "Item not found" });
      return;
    }

    if (m.type !== "episode" || !m.grandparentRatingKey) {
      res.json({ prev: null, next: null });
      return;
    }

    const leavesData = await plexJSON<{ MediaContainer: { Metadata?: PlexMetadataItem[] } }>(
      `/library/metadata/${m.grandparentRatingKey}/allLeaves`,
    );
    const leaves = (leavesData.MediaContainer.Metadata || []).filter((e) => e.type === "episode");
    const i = leaves.findIndex((e) => e.ratingKey === ratingKey);
    // -1 covers merged/split shows where the leaf list doesn't contain our key.
    if (i === -1) {
      res.json({ prev: null, next: null });
      return;
    }

    res.json({
      prev: i > 0 ? mapItem(leaves[i - 1]) : null,
      next: i < leaves.length - 1 ? mapItem(leaves[i + 1]) : null,
    });
  } catch (err) {
    console.error("Sibling episode error:", err);
    res.status(502).json({ error: "Failed to resolve sibling episodes" });
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
    // Every cached /meta payload carries `selected` flags on its audio and
    // subtitle tracks, which this call just changed. Only one item's entry is
    // actually stale, but the mapping from partId back to ratingKey isn't
    // tracked — and this fires once per playback start, so clearing the lot
    // costs a single re-fetch rather than serving a wrong track list.
    metaCache.clear();
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

  // External (Discover) artwork: a ?url= pointing at a cloud poster (TMDB or
  // Plex CDN). Host-allowlisted so this can't become an open image proxy. When
  // present, the server fetches this URL directly (see below) rather than the
  // local library path — the local Plex server doesn't have these images.
  const externalUrl = typeof req.query.url === "string" ? req.query.url : undefined;
  if (req.query.url !== undefined) {
    if (externalUrl === undefined || imagePath !== "/photo/:/transcode" || !isAllowedExternalImage(externalUrl)) {
      res.status(400).end();
      return;
    }
  }

  const transcodeSource = externalUrl ?? imagePath;
  // External images always render at a fixed size via images.plex.tv regardless
  // of the client's w/h, so key them on the source alone — otherwise the same
  // image caches under multiple keys and a stale low-res copy can linger. The
  // "ext:" prefix also abandons pre-fix entries (e.g. the old ~120px ones).
  const cacheKey = externalUrl
    ? `ext:${externalUrl}`
    : w && h ? `${transcodeSource}:${w}x${h}` : transcodeSource;

  // Check server-side cache first
  const cached = thumbCache.get(cacheKey);
  if (cached) {
    res.setHeader("Content-Type", cached.contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(cached.data);
    return;
  }

  try {
    // External artwork is fetched directly (Plex's transcoder won't reliably
    // pull non-Plex CDNs like TMDB). Local images use the photo transcoder when
    // resizing, otherwise a raw local fetch.
    const plexRes = externalUrl
      ? await fetchExternalImage(externalUrl)
      : (w && h)
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

// ─── HLS streaming (ffmpeg) ─────────────────────────────────────
//
// Video is produced by our own ffmpeg, not Plex's transcoder — see
// services/ffmpeg-hls.ts. The client is handed a whole-timeline VOD playlist and
// requests segments by global index; the session manager runs (and transparently
// restarts) ffmpeg to satisfy those requests, so a seek is just a segment fetch.
// Plex is still the source: ffmpeg reads each file over its direct-file URL.

/** A numeric query param, or undefined when absent/malformed. */
function numQuery(v: unknown): number | undefined {
  const n = typeof v === "string" ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * A VOD media playlist covering the entire runtime. Pure arithmetic — no encode
 * has to have started yet. Segment URLs are same-origin; hls.js attaches the
 * session Bearer token to them, and a `token` query is added for the
 * <video>/native path that can't set a header.
 */
function buildMasterPlaylist(
  sessionId: string,
  durationSec: number,
  segSeconds: number,
  segmentCount: number,
  token?: string,
): string {
  const tokenSuffix = token ? `?token=${encodeURIComponent(token)}` : "";
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXT-X-TARGETDURATION:${Math.ceil(segSeconds)}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-INDEPENDENT-SEGMENTS",
  ];
  for (let i = 0; i < segmentCount; i++) {
    // The final segment runs to the end of the file, so it's whatever's left over.
    const dur = i === segmentCount - 1 ? Math.max(0, durationSec - i * segSeconds) : segSeconds;
    lines.push(`#EXTINF:${dur.toFixed(3)},`);
    lines.push(`/api/plex/hls/seg/${sessionId}/${i}.ts${tokenSuffix}`);
  }
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
}

/**
 * GET /api/plex/hls/:ratingKey/:sessionId/master.m3u8
 * Start (or reuse) an ffmpeg HLS session and return the whole-timeline playlist.
 * The client generates the sessionId (UUID) and passes it in the URL; viewers in
 * a room reuse the host's, so a single ffmpeg serves the whole party.
 *
 * Track selection rides on the query: subtitles=burn|none, and optional
 * audioStreamId / subtitleStreamId (Plex stream ids). There is no `offset` — a
 * seek is a plain segment fetch against the fixed playlist, so resume/seek is the
 * client setting video.currentTime, not a manifest restart.
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

    const subMode = req.query.subtitles === "burn" ? "burn" : "none";

    try {
      const { durationSec, segSeconds, segmentCount } = await ensureSession(
        sessionId,
        ratingKey,
        {
          subMode,
          audioStreamId: numQuery(req.query.audioStreamId),
          subtitleStreamId: numQuery(req.query.subtitleStreamId),
        },
      );
      const token = typeof req.query.token === "string" ? req.query.token : undefined;
      logEvent("HLS", "session started", {
        session: sessionId.substring(0, 8),
        ratingKey,
        durationS: Math.round(durationSec),
        segments: segmentCount,
        subtitles: subMode,
      });
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-cache");
      res.send(buildMasterPlaylist(sessionId, durationSec, segSeconds, segmentCount, token));
    } catch (err) {
      console.error("[HLS] session start failed:", err);
      res.status(502).json({ error: "Failed to start HLS session" });
    }
  },
);

/**
 * GET /api/plex/hls/seg/:sessionId/:seg
 * Serve segment <idx>.ts, transcoding it on demand (see ensureSegment). A 404
 * means the index isn't (yet) producible — hls.js retries, which is the right
 * behaviour while a fresh encode after a seek fills toward the requested index.
 */
router.get("/hls/seg/:sessionId/:seg", async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const seg = req.params.seg as string;
  if (!UUID_RE.test(sessionId)) {
    res.status(400).end();
    return;
  }
  const m = seg.match(/^(\d+)\.ts$/);
  if (!m) {
    res.status(400).end();
    return;
  }
  const idx = parseInt(m[1], 10);

  try {
    const file = await ensureSegment(sessionId, idx);
    res.setHeader("Content-Type", "video/MP2T");
    // Short cache, and NOT immutable: a segment's bytes can change when a burned
    // subtitle becomes ready and the run is re-encoded, so the client must be able
    // to re-fetch the subtitled version instead of pinning the first one it saw.
    // A few seconds still covers hls.js recovery refetches and multi-viewer fan-out.
    res.setHeader("Cache-Control", "public, max-age=5");
    res.sendFile(file, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  } catch (err) {
    if (DEBUG) console.log("[HLS seg]", sessionId.substring(0, 8), idx, "unavailable:", String(err));
    res.status(404).end();
  }
});

/**
 * GET /api/plex/hls/ping/:sessionId
 * Client keep-alive. Refreshes the session's idle timer so an actively-watched
 * stream isn't reaped during a quiet stretch. The time/playing/buffer query
 * params are accepted for compatibility with the client's existing loop.
 */
router.get("/hls/ping/:sessionId", (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  if (!UUID_RE.test(sessionId)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }
  const alive = pingSession(sessionId);
  // subsPending lets the client auto-reload once a background subtitle extraction
  // finishes, so embedded subtitles appear without the viewer having to seek.
  res.json({ ok: true, alive, subsPending: subtitlePending(sessionId) });
});

/**
 * DELETE /api/plex/hls/session/:sessionId
 * Stop a session's ffmpeg and delete its segments. Idempotent.
 */
router.delete("/hls/session/:sessionId", async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  if (!UUID_RE.test(sessionId)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }
  const reason = typeof req.query.reason === "string" ? req.query.reason.slice(0, 64) : "unspecified";

  // Refuse a teardown from anyone who isn't the room's current host. Handing the
  // host role over and then closing the tab must not kill the stream the incoming
  // host just adopted; the host authority lives in sync.ts (sessionHostUserId).
  const stopper = sessionUserId(req);
  const owner = sessionHostUserId(sessionId);
  if (owner && stopper && owner !== stopper) {
    logEvent("HLS", "Stop refused — requester is not the host", {
      session: sessionId.substring(0, 8),
      reason,
      stopper,
      host: owner,
    });
    // 200, not an error: the caller is tearing down correctly by its own reckoning.
    res.json({ ok: true, ignored: "not-host" });
    return;
  }

  logEvent("HLS", "Stop requested", { session: sessionId.substring(0, 8), reason });
  await stopSession(sessionId);
  res.json({ ok: true });
});

/**
 * DELETE /api/plex/hls/sessions
 * Kill ALL ffmpeg sessions on this server — a flush for stuck state. Gated to
 * loopback or the admin secret, since it tears down every watch party at once.
 */
router.delete("/hls/sessions", async (req: Request, res: Response) => {
  const adminSecret = process.env.ADMIN_SECRET;
  const peer = req.socket.remoteAddress ?? "";
  const fromLoopback =
    peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  const hasSecret = !!adminSecret && req.headers["x-admin-secret"] === adminSecret;
  if (!fromLoopback && !hasSecret) {
    logEvent("HLS", "kill-all refused", {
      peer: peer || "unknown",
      adminSecretConfigured: !!adminSecret,
    });
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  await stopAllSessions();
  res.json({ ok: true });
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
    // Ancestor keys — let the client build a full breadcrumb path (show/season)
    // for episodes reached without walking through those views (search, etc.).
    ...(m.parentRatingKey != null && { parentRatingKey: m.parentRatingKey }),
    ...(m.grandparentRatingKey != null && { grandparentRatingKey: m.grandparentRatingKey }),
    ...(m.grandparentTitle != null && { showTitle: m.grandparentTitle }),
    ...(m.grandparentThumb != null && { showThumb: `/api/plex/thumb${m.grandparentThumb}` }),
    ...(m.leafCount != null && { leafCount: m.leafCount }),
    ...(m.childCount != null && { childCount: m.childCount }),
    ...(m.summary != null && { summary: m.summary }),
    ...(m.duration != null && { duration: m.duration }),
  };
}

const SKIPPABLE_MARKER_TYPES = new Set(["intro", "credits"]);

/**
 * Normalize Plex markers for the client: keep only skippable types and convert
 * millisecond offsets to seconds, so the client can compare directly against
 * video.currentTime and seek without any unit arithmetic of its own.
 *
 * Always returns an array — libraries without intro detection simply yield [],
 * which the client renders as "no button" with no null handling. Degenerate
 * zero-length markers are dropped so the button can't flash on and instantly off.
 */
function mapMarkers(markers: PlexMarker[] | undefined): SkipMarker[] {
  if (!markers) return [];
  return markers
    .filter((m) => SKIPPABLE_MARKER_TYPES.has(m.type))
    .map((m) => ({
      type: m.type as "intro" | "credits",
      start: (m.startTimeOffset ?? 0) / 1000,
      end: (m.endTimeOffset ?? 0) / 1000,
    }))
    .filter((m) => Number.isFinite(m.start) && Number.isFinite(m.end) && m.end > m.start)
    .sort((a, b) => a.start - b.start);
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
 * Guard for the external-artwork `?url=` on the thumb proxy — prevents it from
 * becoming an open image proxy. Relative Plex paths are resolved by the local
 * server (same safety as a normal thumb); absolute URLs must be Plex-hosted.
 *
 * VERIFY: if online results carry artwork on a non-Plex CDN, add its host here.
 */
function isAllowedExternalImage(u: string): boolean {
  if (u.startsWith("/")) return isAllowedThumbPath(u);
  try {
    // Any https source is fine: external art is fetched via images.plex.tv (see
    // fetchExternalImage), so our server only ever connects to that one host —
    // the source URL is just a param Plex's proxy resolves. This avoids an
    // ever-growing per-CDN allowlist while keeping our own SSRF surface to one host.
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
}

/** Downsize TMDB's multi-MB "original" posters before proxying, so Plex isn't
 *  asked to pull a huge source. Other CDNs already serve poster-sized art. */
function sizedExternalImage(url: string): string {
  return url.replace(/(image\.tmdb\.org\/t\/p\/)(original|w\d+)(\/)/, "$1w500$3");
}

/**
 * Fetch an external poster through Plex's public image proxy (images.plex.tv),
 * which fetches + resizes the source. This means one host handles every source
 * CDN (TMDB, TheTVDB, Amazon, fanart, …) — no per-CDN allowlist to chase — and
 * our server only ever connects to images.plex.tv. Sized to 320x480 to match
 * local library posters. No auth needed.
 */
async function fetchExternalImage(url: string): Promise<globalThis.Response> {
  const proxied =
    `https://images.plex.tv/photo?width=320&height=480&minSize=1&upscale=1` +
    `&url=${encodeURIComponent(sizedExternalImage(url))}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    return await fetch(proxied, {
      headers: { Accept: "image/*" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tear down every ffmpeg session on graceful shutdown. Kept under this name so
 * the existing index.ts shutdown hook (which dynamic-imports it) is unchanged.
 */
export async function stopAllActiveSessions(): Promise<void> {
  await stopAllSessions();
}

export default router;
