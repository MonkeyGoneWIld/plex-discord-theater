import { Router, type Request, type Response } from "express";
import { plexFetch, plexFetchSegment, plexJSON, plexUrl } from "../services/plex.js";
import { playableVersionOrder, resolutionLabel, channelLabel } from "../services/media-versions.js";
import { startPrefetch, stopPrefetch, getCachedSegment, updatePrefetchPosition } from "../services/segment-prefetch.js";
import { isTvdbConfigured, tvdbSeasonEpisodes } from "../services/tvdb.js";
import * as thumbCache from "../services/thumb-cache.js";
import { logEvent } from "../services/logger.js";
import { sessionHostUserId, sessionHasOtherWatchers } from "../services/sync.js";
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
  id?: number;
  /** Plex's own bucket: "4k", "1080", "720", "480", "sd". Coarser than `height`
   *  and occasionally absent, so it is only the fallback. */
  videoResolution?: string;
  height?: number;
  width?: number;
  /** kbps. */
  bitrate?: number;
  videoCodec?: string;
  audioCodec?: string;
  audioChannels?: number;
  container?: string;
  /** The label set in Plex when the file was added as a named version. */
  title?: string;
  Part?: PlexPart[];
}

/**
 * The playable versions of an item, best first.
 *
 * Which files are worth offering, and in what order, is decided by
 * playableVersionOrder — including the rule that hides a 4K copy whenever a
 * lower-resolution one exists, since every stream is transcoded to 1080p
 * anyway. Everything here is the Plex-shaped mapping around that answer.
 *
 * `mediaIndex` is the position in Plex's own Media array: it is what the
 * transcode decision takes, so it stays tied to the original list rather than
 * to this one.
 */
interface MediaVersion {
  mediaIndex: number;
  partId: number | null;
  label: string;
  resolution: string;
  previewThumbs: boolean;
  audioTracks: ReturnType<typeof mapAudioTracks>;
  subtitleTracks: ReturnType<typeof mapSubtitleTracks>;
}

function mapVersions(media: PlexMedia[] | undefined): MediaVersion[] {
  if (!media || media.length === 0) return [];
  return playableVersionOrder(media).map((mediaIndex) => {
    const m = media[mediaIndex];
    const part = m.Part?.[0];
    const streams = part?.Stream ?? [];
    // A version Plex has a name for uses it; otherwise it is described by what
    // it is, which is what anyone choosing between two files wants to know.
    const described = [
      resolutionLabel(m),
      m.videoCodec ? m.videoCodec.toUpperCase() : null,
      channelLabel(m.audioChannels),
    ].filter(Boolean).join(" \u00b7 ");
    return {
      mediaIndex,
      partId: part?.id ?? null,
      label: m.title?.trim() || described,
      resolution: resolutionLabel(m),
      previewThumbs: part?.indexes === "sd",
      audioTracks: mapAudioTracks(streams),
      subtitleTracks: mapSubtitleTracks(streams),
    };
  });
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
              /** The tag id. Filtering a section by it is how Plex's own UI
               *  turns an actor into their filmography — see libraryCreditsFor. */
              id?: number;
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
function tvdbIdFromGuids(guids?: Array<{ id?: string }>): number | null {
  const hit = guids?.find((g) => g.id?.startsWith("tvdb://"));
  if (!hit?.id) return null;
  const n = parseInt(hit.id.slice("tvdb://".length), 10);
  return Number.isFinite(n) ? n : null;
}

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

function mapAudioTracks(streams: PlexStream[]) {
  return streams
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
}

function mapSubtitleTracks(streams: PlexStream[]) {
  return streams
    .filter((s) => s.streamType === 3)
    .map((s) => ({
      id: s.id,
      title: s.extendedDisplayTitle || s.displayTitle || s.title || "Unknown",
      codec: s.codec ?? null,
      language: s.language ?? null,
      languageCode: s.languageCode ?? null,
      selected: !!s.selected,
    }));
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
    // The versions worth offering, best first — see mapVersions. Everything the
    // player needs (part id, tracks, preview frames) is per-version, because a
    // second file of the same film is a different set of audio and subtitle
    // streams, not the same ones again.
    const versions = mapVersions(m.Media);
    const defaultVersion = versions[0] ?? null;
    const audioTracks = defaultVersion?.audioTracks ?? [];
    const subtitleTracks = defaultVersion?.subtitleTracks ?? [];

    // Cache duration for timeline stopped notifications
    if (m.duration && m.ratingKey) {
      mediaDurations.set(m.ratingKey, m.duration);
    }

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
      partId: defaultVersion?.partId ?? null,
      /** Whether hover-preview frames exist for this part (see PlexPart.indexes). */
      previewThumbs: defaultVersion?.previewThumbs ?? false,
      audioTracks,
      subtitleTracks,
      // Always sent, even for the single-file case that is nearly everything.
      // The client draws a picker only when there is more than one, but it needs
      // versions[0] regardless: that is the file the transcode has to be told to
      // play, and for a title with both a 4K and a 1080p copy it is emphatically
      // not Plex's index 0.
      versions,
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
 * The library's movie and TV sections, cached.
 *
 * The list changes about never and the person page wants it every time it
 * opens. Short-lived rather than permanent so a library added mid-session still
 * turns up without a restart.
 */
let sectionListCache: { at: number; sections: Array<{ id: string; type: string }> } | null = null;
const SECTION_LIST_TTL_MS = 5 * 60 * 1000;

async function browsableSections(): Promise<Array<{ id: string; type: string }>> {
  const now = Date.now();
  if (sectionListCache && now - sectionListCache.at < SECTION_LIST_TTL_MS) {
    return sectionListCache.sections;
  }
  const data = await plexJSON<{ MediaContainer: { Directory?: PlexDirectory[] } }>("/library/sections");
  const sections = (data.MediaContainer.Directory || [])
    .filter((d) => ALLOWED_SECTION_TYPES.has(d.type))
    .map((d) => ({ id: d.key, type: d.type }));
  sectionListCache = { at: now, sections };
  return sections;
}

/**
 * The roles a person page asks Plex about, and the filter each is spelled with.
 *
 * Writers and producers are here as well as the two the cast row links from,
 * because the question the page answers is "what have they made" and a
 * director-writer's writing credits are not a footnote. Plex ignores a filter a
 * section doesn't index, which costs one empty answer.
 */
const PERSON_FILTERS = ["actor", "director", "writer", "producer"] as const;
type PersonFilter = (typeof PERSON_FILTERS)[number];

/** name → the tag id per role, misses included. A name Plex doesn't index won't
 *  start being indexed on the next page view. */
const personTagIdCache = new LruMap<string, Map<PersonFilter, number>>(2_000);

/**
 * The ids Plex files a person's credits under — one per role, not one per person.
 *
 * This is the part that isn't obvious. Plex tags are typed: the same human is a
 * different row in the tags table as an actor and as a director, with a
 * different id in each. Filtering `?director=` with the id from the actor hub
 * matches nothing, silently — which is how a director's own films came back as
 * "not in library" on their own page while their two acting credits came back
 * fine.
 *
 * The search hubs are already split by role, so the id for each comes from the
 * hub named after it.
 *
 * Asked of Plex rather than passed down from whichever credit was clicked:
 * every surface that can open a person page would otherwise have to carry it,
 * and a previous attempt at that shipped a version where no credit carried one
 * and every cast member was silently unclickable.
 */
async function personTagIds(name: string): Promise<Map<PersonFilter, number>> {
  const key = name.toLowerCase();
  const cached = personTagIdCache.get(key);
  if (cached) return cached;
  const ids = new Map<PersonFilter, number>();
  try {
    const data = await plexJSON<{
      MediaContainer: {
        Hub?: Array<{
          hubIdentifier?: string;
          Directory?: Array<{ id?: number; tag?: string; title?: string; ratingKey?: string }>;
        }>;
      };
    }>("/hubs/search", { query: name, limit: "10" });
    for (const hub of data.MediaContainer.Hub || []) {
      // Same test the search route uses: only the hub identifier tells a person
      // apart from a genre or a collection, which share the "tag" type. The
      // captured word is the role, which is also the filter's name.
      const role = PERSON_HUB_RE.exec(hub.hubIdentifier ?? "")?.[2]?.toLowerCase();
      if (!role) continue;
      const filter = PERSON_FILTERS.find((f) => f === role);
      if (!filter || ids.has(filter)) continue;
      for (const d of hub.Directory || []) {
        // A ratingKey means a library object, not a tag.
        if (d.ratingKey != null || d.id == null) continue;
        if ((d.tag ?? d.title ?? "").toLowerCase() !== key) continue;
        ids.set(filter, d.id);
        break;
      }
    }
  } catch {
    // Leaves the map empty, which sends the caller down the TMDB path.
  }
  personTagIdCache.set(key, ids);
  return ids;
}

/**
 * Everything in the library credited to one person, asked of Plex directly.
 *
 * Plex indexes its own cast and crew: filtering a section by the person's tag
 * id returns exactly the titles they are credited on, already scoped to what is
 * actually on the shelf. A handful of requests to a server on the LAN, and
 * every one of them is the answer.
 *
 * One id per role, because Plex's tags are typed and the same human has a
 * different id as an actor than as a director — see personTagIds.
 *
 * The alternative — and what this used to do, despite the comment above it
 * saying otherwise for months — was to ask TMDB who they are, ask TMDB for
 * their complete filmography, and then test up to eighty of those credits for
 * ownership one by one. Three internet round trips and eighty lookups to
 * produce a list Plex already had, which is where the five to ten seconds went.
 */
async function libraryCreditsFor(tagIds: Map<PersonFilter, number>) {
  const sections = await browsableSections();
  const byKey = new Map<string, { item: ReturnType<typeof mapItem>; type: string }>();
  // What was found, in the two shapes a TMDB credit can be recognised by, so the
  // out-of-library half below can leave out what is already on the shelf.
  const ownedTmdbIds = new Set<number>();
  const ownedTitleKeys = new Set<string>();

  await Promise.all(
    sections.flatMap((section) =>
      [...tagIds].map(async ([filter, tagId]) => {
        try {
          const data = await plexJSON<{ MediaContainer: { Metadata?: PlexMetadataItem[] } }>(
            `/library/sections/${section.id}/all`,
            // The guids come back in the same response, which is what makes
            // matching against TMDB exact instead of a title comparison.
            { [filter]: String(tagId), includeGuids: "1" },
          );
          for (const m of data.MediaContainer.Metadata || []) {
            const item = mapItem(m);
            // Someone can be both actor and director on the same title; the
            // page lists it once either way.
            if (!byKey.has(item.ratingKey)) byKey.set(item.ratingKey, { item, type: section.type });
            const tmdbId = tmdbIdFromGuids(m.Guid);
            if (tmdbId != null) ownedTmdbIds.add(tmdbId);
            // Belt and braces: not every Plex agent files a tmdb:// guid, and a
            // title match is better than showing the same film twice.
            if (m.title) ownedTitleKeys.add(collectionTitleKey(m.title));
          }
        } catch {
          // One filter failing (an older server that doesn't index directors,
          // say) must not cost the rest of the page.
        }
      }),
    ),
  );

  const of = (type: string) =>
    [...byKey.values()].filter((e) => e.type === type).map((e) => e.item).sort(byReleaseDate);
  return { movies: of("movie"), shows: of("show"), ownedTmdbIds, ownedTitleKeys };
}

/** Newest first, which is the order both halves of a person page are shown in. */
const byReleaseDate = (a: { year?: number }, b: { year?: number }) => (b.year ?? 0) - (a.year ?? 0);

/**
 * A ceiling on the out-of-library half, which is otherwise unbounded.
 *
 * Every card loads its poster eagerly and the rows aren't virtualised, so "all
 * of them" for someone with four hundred credits is four hundred images. High
 * enough to be "all of them" for anybody with a real career.
 */
const MAX_EXTERNAL_CREDITS = 200;

/**
 * The rest of someone's filmography: what they are credited on that the library
 * doesn't have, as requestable cards.
 *
 * Same shape and same treatment as the out-of-library half of "More Like This",
 * so a card behaves identically wherever it is met.
 */
function externalCreditsFor(
  credits: TmdbCredit[],
  mediaType: string,
  type: string,
  ownedTmdbIds: Set<number>,
  ownedTitleKeys: Set<string>,
): CollectionItem[] {
  const seen = new Set<number>();
  const out: CollectionItem[] = [];
  for (const c of credits) {
    if (c.media_type !== mediaType || c.id == null) continue;
    // A poster is what makes a card; an entry without one is a stub.
    if (!c.poster_path) continue;
    if (seen.has(c.id) || ownedTmdbIds.has(c.id)) continue;
    const title = c.title ?? c.name ?? "";
    if (!title || ownedTitleKeys.has(collectionTitleKey(title))) continue;
    seen.add(c.id);
    out.push({
      ratingKey: `tmdb:${c.id}`,
      title,
      year: tmdbResultYear(c),
      type,
      thumb: externalThumbUrl(`https://image.tmdb.org/t/p/w500${c.poster_path}`),
      inLibrary: false,
      tmdbId: c.id,
    });
  }
  return out.sort(byReleaseDate).slice(0, MAX_EXTERNAL_CREDITS);
}

/**
 * Who someone is and everything they are credited on, from TMDB.
 *
 * Two round trips — the id has to be looked up before the credits can be asked
 * for — and both are optional. With no TMDB key, or a name it doesn't know, the
 * page falls back to the library half alone, which is the part that matters.
 */
async function tmdbPersonAndCredits(name: string) {
  const person = await tmdbPerson(name).catch(() => null);
  if (!person) return { person: null, credits: [] as TmdbCredit[] };
  const credits = await tmdbGet<{ cast?: TmdbCredit[]; crew?: TmdbCredit[] }>(
    `/person/${person.tmdbId}/combined_credits`,
  ).catch(() => null);
  return {
    person,
    // Parts they played plus films they directed — the two the cast row links
    // from, and the same pair the library half is filtered on. Appearances as
    // themselves are dropped: see isPerformance.
    credits: [
      ...(credits?.cast ?? []).filter(isPerformance),
      ...(credits?.crew ?? []).filter((c) => c.job === "Director"),
    ],
  };
}

/**
 * GET /api/plex/person?name=<name>
 *
 * A cast/crew member's page: their biography and photo, everything in the
 * library they worked on, and the rest of their career behind it as requestable
 * cards. Split into movies and shows.
 *
 * When Plex indexes the person the filmography comes straight from it, and the
 * only thing left to wait on is TMDB. When it doesn't — somebody credited on
 * nothing you own — it falls back to reconstructing the filmography out of TMDB
 * credits and ownership checks, which is slow and says so in the log.
 *
 * The biography has no Plex equivalent either way, so it comes from TMDB,
 * matched by name, and is fetched alongside the filmography rather than before
 * it. It's optional: with no TMDB key, or no match, the page still lists the
 * filmography and simply omits the prose.
 */
router.get("/person", async (req: Request, res: Response) => {
  const name = typeof req.query.name === "string" ? req.query.name.trim().slice(0, 200) : "";
  if (!name) {
    res.status(400).json({ error: "Missing name" });
    return;
  }
  // One id per role Plex knows this person in. Empty means Plex has never
  // heard of them, which is the only case the slow path is for.
  const tagIds = await personTagIds(name);

  if (tagIds.size > 0) {
    try {
      // Side by side: the library half is local and quick, the TMDB half is two
      // round trips, and the page wants both. Waiting for them in turn made the
      // page as slow as the sum of the two for no reason.
      const [owned, extra] = await Promise.all([
        libraryCreditsFor(tagIds),
        tmdbPersonAndCredits(name),
      ]);
      const rest = (mediaType: string, type: string) =>
        externalCreditsFor(extra.credits, mediaType, type, owned.ownedTmdbIds, owned.ownedTitleKeys);
      // What's on the shelf first, then the rest of the career behind it — the
      // same order, and the same requestable cards, as "More Like This".
      const movies = [...owned.movies, ...rest("movie", "movie")];
      const shows = [...owned.shows, ...rest("tv", "show")];
      logEvent("Person", "filmography from Plex", {
        name,
        // Which roles Plex knows them in, and under which id. A page missing
        // half a career is usually a role missing from this list.
        tags: [...tagIds].map(([role, id]) => `${role}=${id}`).join(" "),
        movies: `${owned.movies.length}+${movies.length - owned.movies.length}`,
        shows: `${owned.shows.length}+${shows.length - owned.shows.length}`,
      });
      res.json({
        name: extra.person?.name ?? name,
        thumb: extra.person?.thumb ?? null,
        biography: extra.person?.biography ?? null,
        birthday: extra.person?.birthday ?? null,
        deathday: extra.person?.deathday ?? null,
        placeOfBirth: extra.person?.placeOfBirth ?? null,
        knownFor: extra.person?.knownFor ?? null,
        movies,
        shows,
      });
      return;
    } catch (err) {
      // Plex couldn't answer — fall through to the TMDB reconstruction below
      // rather than showing an empty page.
      console.error("Person credits error (falling back to TMDB):", err);
    }
  }

  // Plex doesn't index this person, so their filmography has to be rebuilt out
  // of TMDB credits and one ownership check per credit. Slow and worth saying so.
  logEvent("Person", "no Plex tag, rebuilding from TMDB", { name });

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

    // Same rule as the fast path above: parts played and films directed. Other
    // crew jobs would pad the page with titles nobody associates with the
    // person, and appearances as themselves are not parts at all.
    const all = [
      ...(credits?.cast ?? []).filter(isPerformance),
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
  /** The part played. "Self", "Himself" and friends mean they turned up as
   *  themselves, which is not a part — see isPerformance. */
  character?: string;
  genre_ids?: number[];
}

/**
 * Characters that mean somebody appeared rather than acted.
 *
 * TMDB files a talk show sofa, a documentary interview and a clip of old
 * footage as cast credits, all with the person's own name in the character
 * field. On a page meant to answer "what have they been in", those are noise —
 * a working actor's list is otherwise half chat shows.
 */
const APPEARANCE_CHARACTER_RE =
  /^\s*(self|him\s*self|her\s*self|them\s*selves)\b|\(?\barchive footage\b/i;

/**
 * TMDB genre ids for formats nobody is cast in: talk (10767), news (10763),
 * reality (10764). The character field usually gives these away on its own;
 * this catches the ones filed with no character at all.
 */
const APPEARANCE_GENRE_IDS = new Set([10763, 10764, 10767]);

/** Whether a cast credit is a part they played, rather than an appearance. */
function isPerformance(credit: TmdbCredit): boolean {
  if (APPEARANCE_CHARACTER_RE.test(credit.character ?? "")) return false;
  return !(credit.genre_ids ?? []).some((g) => APPEARANCE_GENRE_IDS.has(g));
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
/** How many episodes of one season we'll describe. Long-running soaps aside, no
 *  real season approaches this; it bounds a hostile or broken id. */
const MAX_SEASON_EPISODES = 200;

/** A TMDB episode, as TMDB returns it. */
interface TmdbRawEpisode {
  episode_number?: number;
  name?: string;
  overview?: string;
  air_date?: string | null;
  still_path?: string | null;
  runtime?: number | null;
}

/**
 * The shape both sources are normalised into.
 *
 * `still` is already a URL this server will serve — TMDB paths through the
 * poster proxy, TVDB artwork through the external-image route — so the client
 * never has to know which source it got.
 */
interface SeasonEpisode {
  episodeNumber: number;
  name: string;
  overview: string | null;
  airDate: string | null;
  still: string | null;
  runtime: number | null;
}

async function tmdbSeasonEpisodes(tmdbId: number, season: number): Promise<SeasonEpisode[] | null> {
  if (!TMDB_API_KEY) return null;
  const data = await tmdbGet<{ episodes?: TmdbRawEpisode[] }>(`/tv/${tmdbId}/season/${season}`);
  if (!data?.episodes) return null;
  return data.episodes
    .filter((e) => typeof e.episode_number === "number")
    .slice(0, MAX_SEASON_EPISODES)
    .map((e) => ({
      episodeNumber: e.episode_number!,
      name: e.name || `Episode ${e.episode_number}`,
      overview: e.overview || null,
      airDate: e.air_date || null,
      still: e.still_path
        ? `/api/seerr/poster?w=w300&path=${encodeURIComponent(e.still_path)}`
        : null,
      runtime: typeof e.runtime === "number" ? e.runtime : null,
    }));
}

/**
 * Does this list agree with Plex about which episodes are in this season?
 *
 * The check that stops the wrong source being used. If Plex holds episode 9 and
 * the source's season 3 stops at 8, the two are not numbering the season the
 * same way — and the visible symptom is exactly the one that prompted this:
 * episodes reported missing that actually belong to a different season. Extra
 * episodes in the source are the normal case (that is what a gap *is*);
 * episodes Plex has and the source doesn't are the tell.
 */
function agreesWithPlex(episodes: SeasonEpisode[], plexNumbers: number[]): boolean {
  if (plexNumbers.length === 0) return true;
  const have = new Set(episodes.map((e) => e.episodeNumber));
  return plexNumbers.every((n) => have.has(n));
}

/**
 * GET /api/plex/season-episodes/:seasonRatingKey
 *
 * Every episode this season is supposed to contain, aired or not, so the client
 * can subtract what Plex holds and show the gaps.
 *
 * TVDB first when it is configured and the show carries a tvdb guid, because
 * that is the numbering Sonarr monitors — an episode called missing here is
 * only actionable if the thing that would fetch it agrees the episode belongs
 * to this season. TMDB is the fallback, and also wins when TVDB's numbering
 * disagrees with Plex's own: a source that can't account for episodes already
 * on disk is describing a different season.
 */
router.get("/season-episodes/:seasonRatingKey", async (req: Request, res: Response) => {
  const seasonRatingKey = req.params.seasonRatingKey as string;
  if (!NUMERIC_RE.test(seasonRatingKey)) {
    res.status(400).json({ error: "Invalid rating key" });
    return;
  }
  try {
    const seasonData = await plexJSON<{ MediaContainer: { Metadata?: PlexMetadataItem[] } }>(
      `/library/metadata/${seasonRatingKey}`,
    );
    const season = seasonData.MediaContainer.Metadata?.[0];
    const seasonNumber = season?.index;
    const showKey = season?.parentRatingKey;
    if (seasonNumber == null || !showKey) {
      res.json({ source: null, episodes: [] });
      return;
    }

    // Guids live on the series, not on the season.
    const showData = await plexJSON<{ MediaContainer: { Metadata?: PlexMetadataItem[] } }>(
      `/library/metadata/${showKey}`,
      { includeGuids: "1" },
    );
    const show = showData.MediaContainer.Metadata?.[0];
    const tvdbId = tvdbIdFromGuids(show?.Guid);
    const tmdbId = show ? await resolveTmdbId(show) : null;

    // What Plex actually holds, so the source can be checked against it.
    const childData = await plexJSON<{ MediaContainer: { Metadata?: PlexMetadataItem[] } }>(
      `/library/metadata/${seasonRatingKey}/children`,
    );
    const plexNumbers = (childData.MediaContainer.Metadata ?? [])
      .map((e) => e.index)
      .filter((n): n is number => typeof n === "number");

    let fromTvdb: SeasonEpisode[] | null = null;
    if (tvdbId != null && isTvdbConfigured()) {
      const raw = await tvdbSeasonEpisodes(tvdbId, seasonNumber);
      fromTvdb = raw
        ? raw.map((e) => ({
            episodeNumber: e.episodeNumber,
            name: e.name,
            overview: e.overview,
            airDate: e.airDate,
            // TVDB artwork is an absolute URL; the thumb route proxies any
            // https source through images.plex.tv, so this reaches nothing new.
            still: e.image ? externalThumbUrl(e.image) : null,
            runtime: e.runtime,
          }))
        : null;
    }
    const fromTmdb = tmdbId != null ? await tmdbSeasonEpisodes(tmdbId, seasonNumber) : null;

    let source: "tvdb" | "tmdb" | null = null;
    let episodes: SeasonEpisode[] = [];
    if (fromTvdb && agreesWithPlex(fromTvdb, plexNumbers)) {
      source = "tvdb";
      episodes = fromTvdb;
    } else if (fromTmdb && agreesWithPlex(fromTmdb, plexNumbers)) {
      source = "tmdb";
      episodes = fromTmdb;
      if (fromTvdb) {
        logEvent("Season", "TVDB disagrees with Plex numbering, using TMDB", {
          season: seasonRatingKey,
          seasonNumber,
          plexEpisodes: plexNumbers.length,
          tvdbEpisodes: fromTvdb.length,
        });
      }
    } else if (fromTvdb || fromTmdb) {
      // Neither accounts for everything on disk. Report nothing rather than
      // invent gaps: a wrong list is worse than no list, because it asks people
      // to request episodes they already have under a different number.
      logEvent("Season", "no source agrees with Plex numbering, reporting no gaps", {
        season: seasonRatingKey,
        seasonNumber,
        plexEpisodes: plexNumbers.length,
        tvdb: fromTvdb?.length ?? "none",
        tmdb: fromTmdb?.length ?? "none",
      });
    }

    res.json({ source, episodes: episodes.slice(0, MAX_SEASON_EPISODES) });
  } catch (err) {
    console.error("[Season] episode list error:", err);
    res.status(502).json({ error: "Failed to fetch season episodes" });
  }
});

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
/**
 * Maps our session UUID → which of the item's files it is playing.
 *
 * The host chooses a version and its index rides on the manifest request. Every
 * later request for that session — a viewer joining, a seek, a reconnect — omits
 * it, because only the host's detail page ever knew about it, so it is
 * remembered here instead of being threaded through the sync protocol. A session
 * plays one file for its whole life, which makes this a safe thing to cache.
 */
const sessionMediaIndex = new Map<string, number>();
/** Maps ratingKey → duration in ms (cached from metadata endpoint for timeline stopped). */
const mediaDurations = new LruMap<string, number>(5_000);
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
// Grace window after a transcode key is first seen during which a segment 404 is
// always treated as "ahead of the transcode head", never as a dead session. A
// fresh transcode (notably after a far-seek restart) hasn't filled its head yet
// and may not appear in /transcode/sessions, so the liveness check would false-
// negative and strand every client in a 410 buffering loop.
const TRANSCODE_DEAD_GRACE_MS = 20_000;

setInterval(() => {
  const cutoff = Date.now() - KNOWN_KEY_TTL_MS;
  for (const [key, ts] of allKnownPlexKeys) {
    if (ts < cutoff) allKnownPlexKeys.delete(key);
  }
}, 60 * 60 * 1000).unref(); // prune every hour

// Last host-reported playback position per session. `posChangedAt` is when the
// position last actually advanced — used to detect a stalled (frozen but still
// playing) timeline, distinct from the host merely going silent.
const hostPingInfo = new Map<
  string,
  { timeMs: number; at: number; posChangedAt: number; playing: boolean }
>();
const HOST_SILENT_MS = 25_000;
// How long the reported position may sit frozen (while still playing) before we
// nudge Plex's timeline forward to keep the encoder from parking.
const STALL_NUDGE_MS = 8_000;

// DIAGNOSTIC: transcode "head" per plexKey — the highest segment index Plex has
// actually delivered, and when it last advanced. Lets us log when the head
// freezes (clients requesting past a head that isn't moving = the stall).
const transcodeHead = new Map<string, { maxSeg: number; at: number; stallLogAt: number }>();
const HEAD_STALL_MS = 12_000;

/** Numeric segment index from a proxied .ts path (−1 if not a .ts). */
function segIndexOf(segPath: string): number {
  const m = segPath.match(/(\d+)\.ts(?:$|\?)/);
  return m ? parseInt(m[1], 10) : -1;
}

/** Record that Plex delivered a segment — advances the tracked head. */
function noteHeadAdvance(key: string, segPath: string): void {
  const idx = segIndexOf(segPath);
  if (idx < 0) return;
  const h = transcodeHead.get(key);
  if (!h) {
    transcodeHead.set(key, { maxSeg: idx, at: Date.now(), stallLogAt: 0 });
  } else if (idx > h.maxSeg) {
    // DIAGNOSTIC: if we'd logged this head as stalled, note that it recovered —
    // that's the signal the timeline nudge actually un-parked the encoder.
    if (h.stallLogAt > 0) {
      if (DEBUG) console.log("[HLS] Head resumed %s → seg %d (was stalled at %d)",
        key.substring(0, 8), idx, h.maxSeg);
      h.stallLogAt = 0;
    }
    h.maxSeg = idx;
    h.at = Date.now();
  }
}

/** Mark a Plex transcode key as stopped — segment requests will be rejected. */
export function markTranscodeStopped(sessionId: string): void {
  stopPrefetch(sessionId);
  transcodeControlKey.delete(sessionId);
  const plexKey = plexTranscodeKeys.get(sessionId);
  if (plexKey) {
    activeTranscodeKeys.delete(plexKey);
    transcodeHead.delete(plexKey);
  }
  plexTranscodeKeys.delete(sessionId);
  sessionRatingKeys.delete(sessionId);
  sessionMediaIndex.delete(sessionId);
  manifestCache.delete(sessionId);
  hostPingInfo.delete(sessionId);
  // DIAGNOSTIC: should trend back toward 0 between watch sessions.
  if (DEBUG) console.log("[HLS] Transcode stopped for session", sessionId.substring(0, 8),
    `— active transcodes: ${activeTranscodeKeys.size}`);
}

/**
 * Call `ping` or `stop` under /video/:/transcode/universal.
 *
 * These two take a `session` parameter, and it means the session identifier
 * *we* supplied at decision / start.m3u8 time — our own HLS session UUID — not
 * the transcode GUID Plex allocated in reply. Passing `transcodeSessionId`
 * instead gets a bare 400 and, only in Plex's own log:
 *
 *     ERROR - [Req#…/Transcode] Missing required query parameter session
 *
 * which is how this went unnoticed. Every keep-alive ping the server had ever
 * sent was rejected — 11 for 11 in the captured session — so nothing told Plex
 * a client was still watching and no transcode was ever cleanly stopped. Plex's
 * own teardown line names the session by our UUID
 * ("Terminating session 0x…:a3cbf0ac-…"), which is the confirmation that this
 * is the identifier it wants.
 *
 * `decision` and `start.m3u8` are the endpoints that take `transcodeSessionId`.
 * The asymmetry is Plex's; don't tidy these into one shape.
 */
function plexTranscodeControl(
  action: "ping" | "stop",
  sessionIdentifier: string,
  clientId: string = OUR_CLIENT_ID,
  // Inferred from plexFetch: a bare `Response` here would resolve to Express's,
  // which is imported into this module and shadows the fetch global.
): ReturnType<typeof plexFetch> {
  return plexFetch(
    `/video/:/transcode/universal/${action}`,
    { session: sessionIdentifier },
    {
      "X-Plex-Session-Identifier": sessionIdentifier,
      "X-Plex-Client-Identifier": clientId,
    },
  );
}

/**
 * Which identifier a session's ping/stop calls should carry.
 *
 * Empty until one of them has been answered with something other than a 404,
 * at which point it holds whichever identifier worked. Per session, because the
 * answer could in principle differ between them, and cleared with the session.
 */
const transcodeControlKey = new Map<string, string>();

/**
 * `ping` / `stop` for one of our sessions, trying Plex's own transcode key when
 * our session id is refused.
 *
 * The comment on plexTranscodeControl says `session` means the identifier we
 * supplied, and that passing Plex's transcode GUID is a silent 400. Plex's own
 * log says otherwise about the first half: every one of these keyed on our UUID
 * comes back 404 — 804 rejected keep-alives and every single stop in one day's
 * traffic, with matching `Completed: ... 404 GET /video/:/transcode/universal/
 * ping?session=<our-uuid>` lines on the Plex side. Nothing was keeping the
 * transcode alive (the timeline posts were doing that by accident) and nothing
 * was ever cleanly stopped, so abandoned encoders piled up until Plex timed
 * them out.
 *
 * Rather than swap one guess for another, this tries ours and falls back to the
 * mapped Plex key on a 404, then remembers whichever answered. The log says
 * which, so the next person reading it doesn't have to guess either.
 */
async function transcodeControl(
  action: "ping" | "stop",
  sessionId: string,
  clientId: string = OUR_CLIENT_ID,
): Promise<{ ok: boolean; status: number }> {
  const remembered = transcodeControlKey.get(sessionId);
  const plexKey = plexTranscodeKeys.get(sessionId);
  const candidates = remembered
    ? [remembered]
    : plexKey && plexKey !== sessionId
      ? [sessionId, plexKey]
      : [sessionId];

  let last = { ok: false, status: 0 };
  for (const candidate of candidates) {
    try {
      const res = await plexTranscodeControl(action, candidate, clientId);
      last = { ok: res.ok, status: res.status };
      if (res.ok) {
        if (!remembered) {
          transcodeControlKey.set(sessionId, candidate);
          logEvent("HLS", "transcode control identifier resolved", {
            session: sessionId.substring(0, 8),
            action,
            using: candidate === sessionId ? "our-session-id" : "plex-transcode-key",
          });
        }
        return last;
      }
      // Only a 404 is "wrong identifier". Anything else is a real failure and
      // trying the other one just doubles it.
      if (res.status !== 404) return last;
    } catch (err) {
      console.error("[HLS] transcode", action, "failed for",
        sessionId.substring(0, 8), err);
      return { ok: false, status: 0 };
    }
  }
  return last;
}

/**
 * Our session id for a Plex transcode key, while we still hold the mapping.
 * Undefined once the session has been torn down, which is exactly when a
 * transcode shows up as an orphan — see the caller for what to do then.
 */
function sessionIdForPlexKey(plexKey: string): string | undefined {
  for (const [sessionId, key] of plexTranscodeKeys) {
    if (key === plexKey) return sessionId;
  }
  return undefined;
}

/**
 * Stop one of our sessions' transcodes, whichever identifier Plex accepts.
 * Exported for sync.ts, which tears down on the WebSocket path.
 */
export async function stopTranscodeSession(
  sessionId: string,
  clientId?: string,
): Promise<{ ok: boolean; status: number }> {
  return transcodeControl("stop", sessionId, clientId);
}

/** Stop a single Plex HLS transcode, identified the way `stop` expects. */
async function stopTranscodeKey(sessionIdentifier: string): Promise<void> {
  const res = await plexTranscodeControl("stop", sessionIdentifier);
  if (!res.ok) {
    console.warn("[HLS] stopTranscodeKey", sessionIdentifier.substring(0, 8), "→", res.status);
  }
}

/**
 * POST a Plex timeline "playing" update so it knows the playback position and
 * keeps transcoding ahead (Plex throttles/stalls the encoder without one).
 */
async function postTimeline(
  sessionId: string, ratingKey: string, timeMs: number, clientId: string,
  state: "playing" | "buffering" = "playing",
): Promise<void> {
  const duration = mediaDurations.get(ratingKey);
  await plexFetch(
    "/:/timeline",
    {
      ratingKey,
      key: `/library/metadata/${ratingKey}`,
      state,
      time: String(Math.round(timeMs)),
      duration: duration ? String(duration) : "0",
      identifier: "com.plexapp.plugins.library",
    },
    { "X-Plex-Session-Identifier": sessionId, "X-Plex-Client-Identifier": clientId },
    "POST",
  );
}

/**
 * Reap orphaned transcodes: ones we started (in allKnownPlexKeys) and have
 * already marked stopped (no longer in activeTranscodeKeys) but that Plex still
 * shows running — i.e. the normal stop/terminate failed to kill them. Safe
 * across concurrent parties because a *live* transcode is always in
 * activeTranscodeKeys and therefore skipped. Runs on a timer to keep Plex from
 * accumulating zombie encoders (which eventually overloads it).
 */
async function reapOrphanTranscodes(): Promise<void> {
  // Nothing has ever been played, so there is nothing of ours to reap and no
  // reason to ask Plex about it every minute for the life of the process.
  if (plexTranscodeKeys.size === 0 && activeTranscodeKeys.size === 0) return;
  try {
    const data = await plexJSON<{
      MediaContainer: { TranscodeSession?: Array<{ key?: string; protocol?: string }> };
    }>("/transcode/sessions");
    for (const t of data.MediaContainer.TranscodeSession ?? []) {
      const keyUuid = t.key?.split("/").pop();
      if (!keyUuid || t.protocol !== "hls") continue;
      if (allKnownPlexKeys.has(keyUuid) && !activeTranscodeKeys.has(keyUuid)) {
        console.warn("[HLS] Reaping orphan transcode", keyUuid.substring(0, 8));
        await stopTranscodeKey(keyUuid).catch(() => {});
      }
    }
  } catch (err) {
    // Log rather than swallow — if /transcode/sessions is 403/unreachable the
    // reaper is silently useless, and we need to know (it's the safety net).
    console.warn("[HLS] Orphan reaper could not read /transcode/sessions:",
      err instanceof Error ? err.message : err);
  }
}
setInterval(() => { reapOrphanTranscodes(); }, 60_000).unref();

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
 * Whether the "can't read /status/sessions" warning has already been given.
 *
 * It is a configuration problem, not an event: it stays true for every teardown
 * for as long as the process lives, and repeating it buries the one teardown
 * that matters. Said once, with what to do about it.
 */
let sessionListForbidden = false;

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
      const termParams: Record<string, string> = { sessionId, reason: "Playback ended" };
      const termRes = await plexFetch(
        "/status/sessions/terminate", termParams, undefined, "POST",
      );
      if (!termRes.ok) console.warn("[HLS] Terminate returned", termRes.status);
      return;
    }

    if (DEBUG) console.log("[HLS] No matching Plex session found for terminate:", plexKey.substring(0, 8));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Plex refusing PLEX_TOKEN, which no amount of retrying changes. Listing
    // and ending sessions are owner-level calls, so a token belonging to a
    // managed or shared user is turned away here while still being perfectly
    // good for everything else the app does. Non-fatal: the transcode is
    // stopped by its own endpoint before this runs, so only Plex's "now
    // playing" entry lingers. Worth one line rather than a page of HTML on
    // every teardown — there were sixteen of those in one ten-minute session.
    if (message.includes("401") || message.includes("403")) {
      if (!sessionListForbidden) {
        sessionListForbidden = true;
        console.warn(
          `[HLS] Plex refused to list sessions (${message.includes("401") ? "401" : "403"}),`,
          "so finished ones linger in Now Playing and the orphan reaper cannot run.",
          "PLEX_TOKEN needs to be the server owner's token for those two calls.",
          "Playback is unaffected; transcodes still stop normally.",
        );
      }
      return;
    }
    console.warn("[HLS] Terminate session failed (non-fatal):", message);
  }
}

export { terminatePlexSession };

/**
 * Ping Plex to keep a transcode session alive. Called server-side per room.
 *
 * Resolves false when Plex says the session is gone, so the caller can stop
 * pinging it. Without that signal the room timer kept calling this every 30s
 * for sessions Plex had already discarded — in one evening's log, four dead
 * sessions accounted for 36 rejected keep-alives, each one a wasted round trip
 * and a misleading warning.
 */
export async function pingPlexTranscode(hlsSessionId: string): Promise<boolean> {
  let alive = true;
  try {
    // Tries our session id first and Plex's transcode key on a 404 — see
    // transcodeControl for why neither can be assumed.
    const res = await transcodeControl("ping", hlsSessionId);
    if (!res.ok) {
      // Loud, because a silently-rejected keep-alive is exactly the failure this
      // call site had for its entire life.
      logEvent("HLS", "server-side keep-alive rejected", {
        session: hlsSessionId.substring(0, 8),
        status: res.status,
      });
      // 404 is Plex saying it has no such session. Anything else (5xx, a blip)
      // is worth retrying — only "gone" means gone.
      if (res.status === 404) alive = false;
    }
  } catch (err) {
    console.error("[HLS] Server-side ping failed for", hlsSessionId.substring(0, 8), err);
  }

  // #4: keep Plex's timeline advancing ourselves when the host has gone silent
  // (e.g. backgrounded tab throttling its ping timer). Without an advancing
  // position Plex stops encoding ahead and the head freezes, stalling everyone.
  // When the host is actively pinging it drives the timeline, so we stay out.
  const host = hostPingInfo.get(hlsSessionId);
  const ratingKey = sessionRatingKeys.get(hlsSessionId);
  if (host && ratingKey && Date.now() - host.at > HOST_SILENT_MS) {
    const duration = mediaDurations.get(ratingKey);
    // Two reasons the host stops pinging, needing opposite timelines:
    //   • backgrounded tab still playing — the position was advancing right up to
    //     the silence, so extrapolate forward at ~1x to keep Plex encoding ahead.
    //   • stalled — the position was already frozen before the silence, so the
    //     client is starved; report state=buffering at the frozen position so Plex
    //     keeps producing the stuck segment instead of racing its head past it.
    const wasStalled = host.at - host.posChangedAt > STALL_NUDGE_MS;
    const estMs = host.timeMs + (Date.now() - host.at);
    const reportMs = wasStalled ? host.timeMs : (duration ? Math.min(estMs, duration) : estMs);
    try {
      await postTimeline(hlsSessionId, ratingKey, reportMs, getSessionClientId(hlsSessionId),
        wasStalled ? "buffering" : "playing");
      if (DEBUG) console.log("[HLS] Server-driven timeline for", hlsSessionId.substring(0, 8),
        "→", (reportMs / 1000).toFixed(0) + "s", wasStalled ? "(host silent, stalled)" : "(host silent)");
    } catch (err) {
      console.error("[HLS] Server-driven timeline failed for", hlsSessionId.substring(0, 8), err);
    }
  }

  return alive;
}

/**
 * Stop transcode sessions created by our app (plex-discord-theater).
 * When ratingKey is provided, only stops sessions for that specific media item
 * to avoid killing unrelated watch parties in other guilds.
 */
/**
 * Sessions a room is currently streaming, which nothing may flush.
 *
 * One item can now have several transcodes running at once — one per audio and
 * subtitle combination someone in the room has chosen — and the stale-transcode
 * flush below stops *every* transcode of an item it recognises as ours. That was
 * safe when a room had exactly one stream and anything else was by definition an
 * orphan. It is now the difference between clearing a leak and killing the
 * stream of everyone watching in another language, so the rooms register their
 * live sessions here and the flush steps over them.
 */
const protectedSessions = new Set<string>();

/** Mark a session as live. Called by the sync layer when a variant starts. */
export function protectSession(sessionId: string): void {
  protectedSessions.add(sessionId);
}

/** Drop the protection when the variant is torn down. */
export function releaseSession(sessionId: string): void {
  protectedSessions.delete(sessionId);
}

async function flushStaleTranscodes(ratingKey?: string, exceptKey?: string): Promise<number> {
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
      // Session.id is the identifier we handed Plex when the transcode started,
      // and it is what `stop` matches on — the TranscodeSession key is Plex's own
      // GUID and gets a 400. Prefer the former for the call, keep the latter for
      // the exceptKey check, which really is comparing transcode GUIDs.
      const sessionKey = s.Session?.id;
      // Live for someone else in the room — a different audio or subtitle
      // track of the same title. See protectedSessions.
      if (sessionKey && protectedSessions.has(sessionKey)) continue;
      if (key) {
        // Never stop the transcode we're currently bringing up.
        if (exceptKey && key.split("/").pop() === exceptKey) continue;
        try {
          await plexTranscodeControl("stop", sessionKey ?? key);
          stopped++;
        } catch {}
      } else if (sessionKey) {
        // Direct stream session (no TranscodeSession). These can still block new
        // transcodes on the same client identifier.
        if (DEBUG) console.log("[HLS] Stopping direct-stream session:", sessionKey);
        try {
          await plexTranscodeControl("stop", sessionKey);
          stopped++;
        } catch {}
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
      if (keyUuid && keyUuid === exceptKey) continue;
      // Never kill a transcode that's still live for someone — only orphans we
      // started and already marked stopped. Protects other concurrent parties.
      if (keyUuid && activeTranscodeKeys.has(keyUuid)) continue;
      if (t.key && t.protocol === "hls" && keyUuid && allKnownPlexKeys.has(keyUuid)) {
        if (DEBUG) console.log("[HLS] Killing orphaned HLS transcode:", t.key);
        // /transcode/sessions reports only Plex's own GUID, so `stop` can only
        // be addressed properly while we still hold the reverse mapping — and by
        // the time something is an orphan we usually don't. The call is kept as
        // a cheap best effort (it will 400 without a session id); the mechanism
        // that actually reaps these is terminatePlexSession below.
        const orphanSessionId = sessionIdForPlexKey(keyUuid);
        try {
          await plexTranscodeControl("stop", orphanSessionId ?? keyUuid);
          stopped++;
        } catch {}
        if (!orphanSessionId) {
          await terminatePlexSession(keyUuid).catch(() => {});
        }
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

// Prune stale entries every 2 minutes — but keep a manifest as long as its
// transcode is still alive, so a session's manifest outlives the TTL and can be
// reused for its whole life (the transcode is torn down via markTranscodeStopped,
// which clears the manifest). Only genuinely orphaned manifests get swept.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of manifestCache) {
    if (now - entry.createdAt <= MANIFEST_CACHE_TTL_MS) continue;
    const plexKey = plexTranscodeKeys.get(key);
    if (!plexKey || !activeTranscodeKeys.has(plexKey)) manifestCache.delete(key);
  }
}, 2 * 60 * 1000).unref();

/**
 * The file this item plays when nobody has said otherwise — the first entry of
 * the same list the picker is built from, so the two can't disagree.
 *
 * Reads through the metadata cache, which the detail page has almost always
 * filled by the time anything is played; the cold path costs one Plex lookup on
 * a request that is about to make two more. Falls back to Plex's own first file
 * if the lookup fails, which is the behaviour from before versions existed.
 */
async function defaultMediaIndex(ratingKey: string): Promise<number> {
  try {
    const meta = await buildMeta(ratingKey);
    const versions = meta?.versions as Array<{ mediaIndex?: number }> | undefined;
    return versions?.[0]?.mediaIndex ?? 0;
  } catch (err) {
    console.warn("[HLS] Couldn't resolve default version for", ratingKey, err);
    return 0;
  }
}

/**
 * Serialises "choose the tracks, then start the transcode" per item.
 *
 * Track selection in Plex is a property of the *item*, not of a session: it is a
 * PUT to /library/parts with allParts=1, and the transcode that follows reads
 * whatever the item is set to at that moment. Two people starting different
 * audio tracks of the same film at the same time would otherwise interleave
 * their PUT and their decision call, and both would get whichever selection
 * happened to land second.
 *
 * Holding a per-item lock across the pair makes each start atomic. Once a
 * transcode is running it has already captured its decision and is unaffected by
 * later changes to the item — which is precisely what allows several tracks of
 * one film to play at once.
 */
const itemStartLocks = new Map<string, Promise<void>>();

function withItemLock<T>(ratingKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = itemStartLocks.get(ratingKey) ?? Promise.resolve();
  // Runs whether the previous holder resolved or threw — a failed start must
  // not wedge the queue for the item.
  const run = prev.then(fn, fn);
  const tail = run.then(() => {}, () => {});
  itemStartLocks.set(ratingKey, tail);
  void tail.then(() => {
    if (itemStartLocks.get(ratingKey) === tail) itemStartLocks.delete(ratingKey);
  });
  return run;
}

/**
 * Point the item at one variant's tracks, immediately before its transcode
 * starts. Only meaningful inside withItemLock.
 *
 * Deliberately does NOT clear the metadata cache, unlike the standalone
 * /streams route. The `selected` flags on a track list describe whichever
 * variant started most recently, which is no longer a useful answer to "what am
 * I listening to" — each client tracks its own choice instead. Clearing the
 * cache here would also mean a metadata refetch per variant start.
 */
async function selectTracksForStart(
  ratingKey: string,
  mediaIndex: number,
  audioStreamID: number | null,
  subtitleStreamID: number | null,
): Promise<void> {
  if (audioStreamID == null && subtitleStreamID == null) return;
  try {
    const meta = await buildMeta(ratingKey);
    const versions = meta?.versions as Array<{ mediaIndex?: number; partId?: number | null }> | undefined;
    const partId =
      versions?.find((v) => v.mediaIndex === mediaIndex)?.partId ??
      (meta?.partId as number | null | undefined) ??
      null;
    if (partId == null) return;
    const params: Record<string, string> = { allParts: "1" };
    if (audioStreamID != null) params.audioStreamID = String(audioStreamID);
    if (subtitleStreamID != null) params.subtitleStreamID = String(subtitleStreamID);
    await plexFetch(`/library/parts/${partId}`, params, undefined, "PUT");
    if (DEBUG) console.log("[HLS] Tracks set for part", partId, params);
  } catch (err) {
    // A failed selection means the transcode comes up on the item's previous
    // tracks, which is wrong but playable. Failing the whole start would be worse.
    console.warn("[HLS] Couldn't set tracks before start:", err);
  }
}

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

    // Optional offset (seconds) — a real seek/restart. Parsed up front because a
    // request WITH an offset must start a fresh transcode at that position, while
    // one WITHOUT should reuse the session's existing transcode if it's alive.
    const offsetSec = Math.round(parseFloat(req.query.offset as string));
    const offset = Number.isFinite(offsetSec) && offsetSec > 0 ? String(offsetSec) : undefined;

    // Which of the item's files to play, in order of who knows best: the client
    // that chose it (the host's detail page, on its first request), then this
    // session's remembered answer, then the item's own default.
    //
    // That last fallback is not a formality. Every route into playback except
    // the detail page — the queue, auto-advance to the next episode, a viewer
    // following the room — sends nothing, and Plex's own index 0 is the *4K*
    // copy on exactly the titles this feature exists for. Defaulting to 0 there
    // would transcode 4K for a room that can only be shown 1080p, which is the
    // one outcome the whole rule is meant to prevent.
    const requestedMedia = Number(req.query.mediaIndex);
    const mediaIndex = Number.isInteger(requestedMedia) && requestedMedia >= 0
      ? requestedMedia
      : sessionMediaIndex.get(sessionId) ?? (await defaultMediaIndex(ratingKey));
    sessionMediaIndex.set(sessionId, mediaIndex);

    // Reuse the running transcode for this session rather than starting a new one.
    // A viewer joining, a reconnect, a promoted host, or a re-focus all re-request
    // this manifest; keying reuse on "is the transcode still alive" (not a 10-min
    // manifest TTL) keeps ONE transcode per session for its whole life instead of
    // orphaning the live one — which killed everyone's stream. A request with an
    // offset is a deliberate seek/restart and falls through to a fresh transcode.
    const cached = manifestCache.get(sessionId);
    const livePlexKey = plexTranscodeKeys.get(sessionId);
    if (cached && !offset && livePlexKey && activeTranscodeKeys.has(livePlexKey)) {
      if (DEBUG) console.log("[HLS] Reusing live transcode for session:", sessionId.substring(0, 8),
        "plexKey:", livePlexKey.substring(0, 8));
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

    // Subtitle mode — "none" when user explicitly disabled subtitles, otherwise "burn"
    const subtitleMode = req.query.subtitles === "burn" ? "burn" : "none";

    // The tracks this session wants. Present once a room can hold more than one
    // combination at a time: the caller owns a variant and names the audio and
    // subtitle streams it is for, and the pair is applied to the item under a
    // lock immediately before the decision call — see selectTracksForStart.
    // Absent from an older client, which then gets whatever the item is already
    // set to, exactly as before.
    const trackNum = (v: unknown): number | null => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 0 ? n : null;
    };
    const audioStreamID = trackNum(req.query.audioStreamID);
    const subtitleStreamID = trackNum(req.query.subtitleStreamID);

    console.log("[HLS] Master manifest requested for ratingKey:", ratingKey, "session:", sessionId.substring(0, 8), offset ? `offset:${offset}s` : "");

    // Core manifest fetch logic — wrapped in a promise for in-flight deduplication
    const fetchManifest = async (): Promise<string> => {
      const params: Record<string, string> = {
        hasMDE: "1",
        path: `/library/metadata/${ratingKey}`,
        mediaIndex: String(mediaIndex),
        partIndex: "0",
        protocol: "hls",
        fastSeek: "1",
        directPlay: "0",
        // Force a real video re-encode instead of a remux (copy). Direct-streaming
        // (directStream=1 → videoDecision=copy) hands the source's elementary h264
        // stream to the browser untouched, including any keyframe/timestamp
        // discontinuity the file carries. The browser's MSE cannot append across
        // such a discontinuity, so playback wedges at a fixed point mid-episode
        // (bufferStalledError, buffer stops growing) and never recovers. Re-encoding
        // produces clean, monotonic, uniformly-keyframed HLS that MSE plays through.
        // Audio copy is left on — the discontinuity is in the video stream, and
        // AAC passthrough is cheap and reliable.
        directStream: "0",
        directStreamAudio: "1",
        videoResolution: "1920x1080",
        videoBitrate: String(VIDEO_BITRATE_KBPS),
        peakBitrate: String(VIDEO_PEAK_BITRATE_KBPS),
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
        /**
         * What we can play, in Plex's profile language.
         *
         * The first directive is the transcode target: deliver HLS as h264 in
         * MPEG-TS. The second says which audio codecs that target supports, and
         * it has to be said separately — the `audioCodec` in the first names the
         * target's default, not the profile's capability, so without the second
         * Plex fell back to mp3 for anything it had to re-encode. Every stream
         * in a session came out as 151 kbps stereo mp3 from an 8-channel Atmos
         * source, which is the worst audio Plex knows how to make.
         *
         * AAC in MPEG-TS is the ordinary case for HLS and what hls.js expects;
         * mp3 was the unusual choice here. Audio that is already playable is
         * still copied untouched — see directStreamAudio.
         */
        "X-Plex-Client-Profile-Extra": [
          "add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264&audioCodec=aac)",
          "add-transcode-target-audio-codec(type=videoProfile&context=streaming&protocol=hls&audioCodec=aac)",
        ].join("+"),
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
          // What Plex settled on. Worth a place on this line because it is the
          // only cheap way to see whether the client profile above was
          // understood: the alternative is digging a codec out of the
          // transcoder statistics XML after the fact, which is where the mp3
          // audio hid for as long as it did.
          const media = (
            (mc?.Metadata as Array<Record<string, unknown>> | undefined)?.[0]
              ?.Media as Array<Record<string, unknown>> | undefined
          )?.[0];
          console.log("[HLS] Decision:", decisionRes.status,
            "code:", mc?.generalDecisionCode, mc?.generalDecisionText,
            "→", media?.videoCodec ?? "?", "+", media?.audioCodec ?? "?");
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
        let flushed = await flushStaleTranscodes(ratingKey);
        console.log("[HLS] Flushed", flushed, "stale transcode(s)");

        for (let attempt = 1; attempt <= 3 && plexRes.status === 400; attempt++) {
          const delay = flushed > 0 ? 3000 + attempt * 1500 : 2000 * attempt;
          console.log("[HLS] Retry", attempt, "in", delay, "ms");
          await new Promise((r) => setTimeout(r, delay));
          if (attempt === 2 && plexRes.status === 400) {
            const reflushed = await flushStaleTranscodes(ratingKey);
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
        console.log("[HLS] Plex transcode key:", plexKeyMatch[1].substring(0, 8),
          "for session:", sessionId.substring(0, 8),
          // DIAGNOSTIC (DEBUG only): active transcode count — climbing over a
          // session means old ones aren't being reaped (the terminate-403 /
          // stale-flush problem), which is what eventually overloads Plex.
          DEBUG ? `— active transcodes: ${activeTranscodeKeys.size}` : "");

        // Start pre-fetching segments to absorb Plex's HTTP throttle. After a
        // seek the transcode begins at `offset`, so start there (segments are
        // secondsPerSegment=3s each) — the prefetcher now bounds itself to a
        // window ahead of the head and retries near-head 404s, so it tracks the
        // head instead of racing past it and starving the seek target.
        const startSeg = offset ? Math.floor(parseInt(offset, 10) / 3) : 0;
        startPrefetch(sessionId, plexKeyMatch[1], startSeg);
      } else {
        console.error("[HLS] FATAL: Could not extract Plex transcode key from manifest for session:",
          sessionId.substring(0, 8), "— aborting session to prevent phantom state");
        try {
          await plexTranscodeControl("stop", sessionId);
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

    // Store promise in in-flight map so concurrent requests wait on it.
    // The item lock wraps the pair below it: the track selection this variant
    // needs, and the decision + start that captures it.
    const promise = withItemLock(ratingKey, async () => {
      await selectTracksForStart(ratingKey, mediaIndex, audioStreamID, subtitleStreamID);
      return fetchManifest();
    });
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
/**
 * Transcoded .ts segments are immutable for the life of a session — allow
 * clients and the VPS nginx cache to reuse them for 5 minutes so hls.js
 * recovery/retry refetches and multi-viewer fan-out don't hit Plex again.
 * Sub-manifests grow as the transcode progresses and must never be cached.
 */
function setSegmentCacheHeaders(res: Response, segPath: string): void {
  if (segPath.endsWith(".ts")) {
    res.setHeader("Cache-Control", "public, max-age=300, immutable");
  } else if (segPath.endsWith(".m3u8")) {
    res.setHeader("Cache-Control", "no-cache");
  }
}

/**
 * Check whether a Plex HLS transcode session is still alive server-side.
 *
 * A 404 on a segment is ambiguous: the transcode may have been killed (ping
 * timeout, resource pressure), OR the requested segment is simply ahead of the
 * transcode head — which happens legitimately when the viewer seeks forward,
 * since Plex transcodes linearly and hasn't produced that segment yet. Only the
 * former should mark the session dead, so we confirm against /transcode/sessions
 * before poisoning it. Marking a healthy session dead makes every subsequent
 * segment short-circuit to 410, stranding playback in a permanent buffering loop.
 */
async function isTranscodeSessionAlive(plexKey: string): Promise<boolean> {
  try {
    const data = await plexJSON<{
      MediaContainer: { TranscodeSession?: Array<{ key?: string }> };
    }>("/transcode/sessions");
    const sessions = data.MediaContainer.TranscodeSession || [];
    return sessions.some((t) => t.key?.split("/").pop() === plexKey);
  } catch {
    // If we can't tell, assume alive — don't kill a possibly-healthy session.
    return true;
  }
}

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
    setSegmentCacheHeaders(res, segPath);
    if (segPath.endsWith(".ts")) {
      res.setHeader("Content-Type", "video/MP2T");
    } else if (segPath.endsWith(".m3u8")) {
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    } else {
      res.setHeader("Content-Type", "application/octet-stream");
    }
    if (DEBUG) console.log("[HLS seg] Cache HIT:", segPath.substring(0, 80));
    if (segKeyMatch) noteHeadAdvance(segKeyMatch[1], segPath);
    res.send(cachedSeg);
    return;
  }

  try {
    const plexRes = await plexFetchSegment(segPath);

    if (!plexRes.ok) {
      // Drain the body so the underlying TCP connection is returned to the pool
      plexRes.body?.cancel().catch(() => {});

      // A 404 for a segment can mean the transcode was killed server-side
      // (ping timeout, resource pressure) OR that the segment is simply ahead of
      // the transcode head after a forward seek — Plex transcodes linearly, so a
      // far-ahead segment doesn't exist yet. Only the former should mark the
      // session dead; doing so on a healthy session poisons activeTranscodeKeys
      // and strands playback in a permanent 410 loop. Confirm the transcode is
      // actually gone before marking dead; otherwise pass the 404 through and let
      // the client restart the transcode at the seek offset.
      if (plexRes.status === 404 && segKeyMatch) {
        const key = segKeyMatch[1];
        // A just-started transcode (e.g. right after a far-seek restart) legitimately
        // 404s on segments ahead of its head, and Plex may not list it in
        // /transcode/sessions yet — so isTranscodeSessionAlive would return a false
        // negative and mark it dead. That poisons activeTranscodeKeys and short-
        // circuits every later request to 410, stranding the host AND all viewers in
        // a permanent buffering loop (worse with viewers: many concurrent ahead-of-head
        // 404s hit the window at once). Never mark a young key dead — by definition it
        // is still filling its head, not gone.
        const startedAt = allKnownPlexKeys.get(key) ?? 0;
        const ageMs = Date.now() - startedAt;
        if (ageMs > TRANSCODE_DEAD_GRACE_MS &&
            activeTranscodeKeys.has(key) && !(await isTranscodeSessionAlive(key))) {
          console.warn("[HLS seg] Transcode", key.substring(0, 8),
            "gone — marking dead");
          activeTranscodeKeys.delete(key);
          res.status(410).end();
          return;
        }
        // DIAGNOSTIC: the transcode is alive but a client wants a segment past
        // the head — if the head hasn't advanced in a while, it's frozen (Plex
        // stopped encoding forward). Log once per ~10s while it stays stuck.
        const h = transcodeHead.get(key);
        const reqSeg = segIndexOf(segPath);
        if (h && reqSeg > h.maxSeg) {
          const stalledMs = Date.now() - h.at;
          if (stalledMs > HEAD_STALL_MS && Date.now() - h.stallLogAt > 10_000) {
            h.stallLogAt = Date.now();
            if (DEBUG) console.warn("[HLS seg] Head STALLED %s at seg %d for %ss — client wants seg %d",
              key.substring(0, 8), h.maxSeg, (stalledMs / 1000).toFixed(0), reqSeg);
          }
        }
        if (DEBUG) console.log("[HLS seg] 404 for", segPath.substring(0, 80),
          ageMs <= TRANSCODE_DEAD_GRACE_MS
            ? `— transcode ${key.substring(0, 8)} young (${ageMs}ms), segment ahead of head`
            : "— transcode alive, segment ahead of head");
        res.status(404).end();
        return;
      }
      console.error("HLS seg proxy error:", plexRes.status, segPath.substring(0, 100));
      res.status(plexRes.status).end();
      return;
    }

    setSegmentCacheHeaders(res, segPath);
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

    // DIAGNOSTIC: a live .ts came back from Plex — the head reached this segment.
    if (segKeyMatch) noteHeadAdvance(segKeyMatch[1], segPath);
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
    const clientId = getSessionClientId(sessionId);

    // A ping for a session we no longer hold a transcode key for means a client
    // is still running its keep-alive loop against a stream that's already gone
    // — an orphaned interval, or a client that missed the teardown. Either way
    // it's invisible from the client side, so surface it here.
    //
    // Gated on having seen this session ping before, because the client fires
    // its first ping immediately on start to get Plex's timeline moving, and
    // that races the master-manifest request that registers the transcode key.
    // The ping won that race every time in practice, so warning on it flagged
    // every healthy session start as a fault.
    if (!plexTranscodeKeys.has(sessionId) && hostPingInfo.has(sessionId)) {
      logEvent("Ping", "for unknown/stopped session", {
        session: sessionId.substring(0, 8),
        knownRatingKey: sessionRatingKeys.has(sessionId),
      });
    }

    // Ping to keep the transcode alive — see transcodeControl for which
    // identifier this ends up using.
    const pingRes = await transcodeControl("ping", sessionId, clientId);
    if (!pingRes.ok) {
      logEvent("Ping", "Plex rejected keep-alive", {
        session: sessionId.substring(0, 8),
        status: pingRes.status,
      });
    }

    // Send timeline update so Plex knows our playback position.
    // Without this, Plex throttles HTTP segment delivery to ~1x realtime.
    const timeMs = typeof req.query.time === "string" ? parseInt(req.query.time, 10) : NaN;
    // playing=0 means an intentional pause; absent (older client) is treated as
    // playing so the nudge still helps.
    const playing = req.query.playing !== "0";
    const ratingKey = sessionRatingKeys.get(sessionId);
    if (ratingKey && Number.isFinite(timeMs)) {
      const now = Date.now();
      const prev = hostPingInfo.get(sessionId);
      const posAdvanced = !prev || Math.abs(timeMs - prev.timeMs) > 500;
      // Coming back from a pause restarts the clock even if the position hasn't
      // moved yet: the first ping after a resume arrives within milliseconds of
      // it, so the position legitimately hasn't changed — and carrying the whole
      // paused duration forward made that ping look like a multi-minute stall
      // and reported `buffering` to Plex for a stream that had just resumed.
      const resumed = !!prev && !prev.playing && playing;
      const posChangedAt = posAdvanced || resumed ? now : prev!.posChangedAt;
      const frozenMs = now - posChangedAt;

      // DIAGNOSTIC: near-zero Δpos over several seconds of wall time = frozen
      // timeline, which is what makes Plex park the encoder and stall everyone.
      // The client's forward buffer (seconds) rides along so a drain-to-zero is
      // visible right next to the position and (server-side) the transcode head.
      const wallMs = prev ? now - prev.at : 0;
      const posDeltaMs = prev ? timeMs - prev.timeMs : 0;
      // `playing` is the whole difference between a stall and a pause.
      //
      // Without it a paused stream reported "TIMELINE STALLED" every ten
      // seconds for as long as it stayed paused — 82 of them in one hour, all
      // saying nothing except that somebody had pressed pause. A diagnostic
      // that fires constantly during normal use is worse than none, because it
      // is what a real stall then hides inside.
      const stalled = !!prev && playing && wallMs > 4000 && Math.abs(posDeltaMs) < 500;
      const bufS = typeof req.query.buffer === "string" ? req.query.buffer : "?";
      if (DEBUG) console.log("[Ping] %s pos=%ss Δpos=%ss buf=%ss / %ss wall%s playing=%s",
        sessionId.substring(0, 8), (timeMs / 1000).toFixed(1),
        (posDeltaMs / 1000).toFixed(1), bufS, (wallMs / 1000).toFixed(1),
        stalled ? "  ⚠ TIMELINE STALLED" : "", playing ? "1" : "0");

      // Two conditions worth calling out even when DEBUG is off, because both
      // precede a stream dying and neither is obvious in the ping stream:
      //  - a gap far longer than the 10s cadence (client backgrounded, network
      //    dropped, or a second ping loop was killed off)
      //  - the position jumping by more than the time that passed, which means a
      //    seek happened without the transcode restarting
      //
      // Neither is about the transcode's survival. The room keeps every stream
      // it holds alive on its own thirty-second timer whether anyone is in the
      // player or not — see startSessionPing in sync.ts — so what these measure
      // is a *client* going quiet, which is a different and much smaller thing
      // than it used to sound like.
      if (prev && wallMs > 25_000) {
        logEvent("Ping", "client stopped reporting its position", {
          session: sessionId.substring(0, 8),
          gapS: wallMs / 1000,
          posS: timeMs / 1000,
        });
      }
      // Against the time that passed, not against zero. Somebody who steps out
      // of the player for a minute comes back a minute further into the film,
      // because the room went on without them: the position moved exactly as
      // much as the clock did, which is the opposite of a seek. Comparing to
      // zero called that a jump — and called it one twice per walk back.
      if (prev && Math.abs(posDeltaMs - wallMs) > 30_000) {
        logEvent("Ping", "position jumped without restart", {
          session: sessionId.substring(0, 8),
          fromS: prev.timeMs / 1000,
          toS: timeMs / 1000,
          overWallS: wallMs / 1000,
        });
      }
      if (stalled) {
        logEvent("Ping", "timeline stalled", {
          session: sessionId.substring(0, 8),
          posS: timeMs / 1000,
          frozenForS: frozenMs / 1000,
          bufferS: bufS,
        });
      }

      hostPingInfo.set(sessionId, { timeMs, at: now, posChangedAt, playing });

      // Anchor the prefetch ceiling to the viewer. Without this the prefetcher
      // hangs its window off the transcode head, which it advances itself, and
      // the whole thing runs away to the end of the file.
      updatePrefetchPosition(sessionId, timeMs / 1000);

      // If the reported position has frozen while still playing, the host's
      // playback stalled and the client is starved. Match what Plex's own web
      // client does here (verified from its HAR): report state=buffering at the
      // real, frozen position — do NOT advance it. Buffering tells Plex to keep
      // producing the segment the client is stuck on; the previous forward
      // "nudge" moved the transcode head *past* that segment, which is what
      // turned a transient encoder stall into a permanent one. A real pause
      // reports playing=false and stays a plain playing timeline at its position.
      const stalledWhilePlaying = playing && frozenMs > STALL_NUDGE_MS;
      if (stalledWhilePlaying && DEBUG) console.log(
        "[HLS] Host stalled — reporting buffering %s @ %ss",
        sessionId.substring(0, 8), (timeMs / 1000).toFixed(0));
      postTimeline(sessionId, ratingKey, timeMs, clientId,
        stalledWhilePlaying ? "buffering" : "playing").catch(() => {}); // fire-and-forget
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Ping error:", err);
    res.status(502).json({ error: "Ping failed" });
  }
});

/**
 * GET /api/plex/hls/session/:sessionId/version
 *
 * Which of the item's files this session is playing, as an index into Plex's
 * Media array. Null when the session isn't running one — it hasn't started, or
 * it has already been torn down.
 *
 * Exists because only the host's detail page ever chooses a version, and part
 * ids and stream ids belong to a file: a co-host listing the default copy's
 * subtitles while a different copy plays offers choices that quietly do
 * nothing. Everyone already knows the session id, so this is the cheapest way
 * to let everyone resolve the same file — cheaper than carrying it in room
 * state, which is a protocol change for one field.
 *
 * No race to worry about: the host registers the index by requesting the
 * manifest, and only announces the session id to the room once that manifest
 * has parsed. A client that has a session id to ask about is therefore asking
 * after the answer exists.
 */
router.get("/hls/session/:sessionId/version", (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  if (!UUID_RE.test(sessionId)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }
  res.json({ mediaIndex: sessionMediaIndex.get(sessionId) ?? null });
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

    // The client tags every teardown with the branch that asked for it. Logged
    // with the session's last known playback state so a stop that arrives
    // mid-stream can be read without guessing: which code path, how far in, how
    // much buffer was left, and how long since the last ping.
    const reason = typeof req.query.reason === "string" ? req.query.reason.slice(0, 64) : "unspecified";

    // Refuse a teardown from anyone who isn't the room's current host.
    //
    // Handing the host role over and then closing the tab immediately killed
    // the stream for the whole room: the outgoing tab unmounted before the
    // demotion message reached it, so it still believed it owned the session
    // and its cleanup DELETEd the transcode the new host had just adopted.
    // The client releases ownership optimistically now, but that is a race
    // either way — this is the check that actually settles it.
    const stopper = sessionUserId(req);
    const owner = sessionHostUserId(sessionId);
    if (owner && stopper && owner !== stopper) {
      logEvent("HLS", "Stop refused — requester is not the host", {
        session: sessionId.substring(0, 8),
        reason,
        stopper,
        host: owner,
      });
      // 200, not an error: the caller is tearing down correctly by its own
      // reckoning, and it has nothing useful to do with a failure here.
      res.json({ ok: true, ignored: "not-host" });
      return;
    }

    // Still someone's picture. The requester may well be entitled to stop it —
    // they are the one driving it — but a stream is shared by everyone on the
    // same tracks, and leaving the player is not a decision on their behalf.
    // The stream dies when the last of them goes, which the sync layer handles.
    if (sessionHasOtherWatchers(sessionId, stopper)) {
      logEvent("HLS", "Stop refused — others are still on this stream", {
        session: sessionId.substring(0, 8),
        reason,
        stopper,
      });
      res.json({ ok: true, ignored: "still-watched" });
      return;
    }

    const lastPing = hostPingInfo.get(sessionId);
    logEvent("HLS", "Stop requested", {
      session: sessionId.substring(0, 8),
      reason,
      lastPosS: lastPing ? (lastPing.timeMs / 1000).toFixed(1) : "none",
      sinceLastPingMs: lastPing ? Date.now() - lastPing.at : "none",
      ratingKey: sessionRatingKeys.get(sessionId) ?? "unknown",
      hadPlexKey: plexTranscodeKeys.has(sessionId),
    });

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
      // a stop for a session Plex has forgotten creates ghost state that blocks
      // new transcodes. The key gates the call; the *identifier* sent is our
      // session id, which is what `stop` matches on.
      if (plexKey) {
        try {
          const stopRes = await transcodeControl("stop", sessionId, OUR_CLIENT_ID);
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
          // Not just the maps: this also stops the prefetch poller and clears
          // the transcode head and host-ping entries. Deleting by hand here
          // left the poller hitting Plex every 2s with up to 100 segments
          // pinned, and — because only two prefetch sessions may run at once —
          // starved the *next* thing played of any prefetch at all.
          markTranscodeStopped(sessionId);
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
  // Kills every watch party on this Plex server, so the gate must not depend on
  // an environment variable being set correctly.
  //
  // It used to be `NODE_ENV !== "production" || matching ADMIN_SECRET`, and the
  // deployment this was written for does not set NODE_ENV — which is visible in
  // its own logs, since the DEBUG-only lines are all there. So the escape hatch
  // was wide open to any authenticated user: one request, every stream in every
  // room dead. The deployment that forgets NODE_ENV is exactly the one that
  // shouldn't be trusted with this, so the check is now positive: either the
  // request came from this machine, or it carries the secret.
  const adminSecret = process.env.ADMIN_SECRET;
  const peer = req.socket.remoteAddress ?? "";
  const fromLoopback =
    peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  const hasSecret =
    !!adminSecret && req.headers["x-admin-secret"] === adminSecret;
  if (!fromLoopback && !hasSecret) {
    logEvent("HLS", "kill-all refused", {
      peer: peer || "unknown",
      adminSecretConfigured: !!adminSecret,
    });
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
      // Same identifier rule as the reaper — `stop` matches on the session id we
      // supplied, not on Plex's transcode GUID.
      const stopId = s.Session?.id ?? key;
      if (key && stopId) {
        try {
          const stopRes = await plexTranscodeControl("stop", stopId);
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
      // Our session id — the mapping is still intact here, which is what makes a
      // clean shutdown stop actually land.
      const res = await plexTranscodeControl("stop", sessionId);
      console.log("[Shutdown] Stopped transcode:", plexKey.substring(0, 8), "→", res.status);
    } catch {}
    markTranscodeStopped(sessionId);
    await notifyPlexStopped(ratingKey, sessionId).catch(() => {});
    await terminatePlexSession(plexKey).catch(() => {});
  }
}

export default router;
