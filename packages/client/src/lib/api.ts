let sessionToken: string | null = null;

export function setSessionToken(token: string): void {
  sessionToken = token;
}

export function getSessionToken(): string | null {
  return sessionToken;
}

/**
 * Append the session token as a query param.
 *
 * For contexts that cannot send an Authorization header — `<img src>`,
 * `<video src>`, direct navigation. `requireAuth` accepts `?token=` as a
 * fallback for exactly this reason.
 *
 * Several components predate this and carry their own local copy with slightly
 * different signatures; they're deliberately left alone. New callers use this.
 */
export function authUrl(url: string): string {
  const token = getSessionToken();
  if (!token || !url) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

/**
 * Poster URL at the one size the whole app requests.
 *
 * The size has to be shared, because the browser caches by exact URL: a card
 * asking for w=320&h=480 and a detail page asking for the unsized original are
 * two different images, so opening a title re-downloaded a poster that was
 * already on screen a moment earlier — which is why detail posters didn't
 * appear instantly. Everything that renders poster art goes through here.
 */
export function posterThumbUrl(thumb: string): string {
  return `${authUrl(thumb)}&w=${POSTER_THUMB_W}&h=${POSTER_THUMB_H}`;
}

export const POSTER_THUMB_W = 400;
export const POSTER_THUMB_H = 600;

const BASE = "";

async function throwApiError(res: Response, path: string): Promise<never> {
  let message: string | null = null;
  try {
    const body = await res.json();
    if (body?.error && typeof body.error === "string") message = body.error;
  } catch {
    // non-JSON body — use generic message
  }
  throw new Error(message ?? `API error ${res.status}: ${path}`);
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (sessionToken) headers["Authorization"] = `Bearer ${sessionToken}`;
  return headers;
}

export async function apiGet<T = unknown>(
  path: string,
  options?: { signal?: AbortSignal },
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: authHeaders(),
    signal: options?.signal,
  });
  if (!res.ok) await throwApiError(res, path);
  return res.json();
}

// Short-lived cache for stable Plex metadata (fetchMeta, fetchChildren, …), so
// navigating back through detail views doesn't refetch what was just shown.
// Not used for anything whose answer changes with user actions (Seerr statuses,
// section listings, search).
const apiCache = new Map<string, { at: number; promise: Promise<unknown> }>();
const API_CACHE_TTL_MS = 5 * 60 * 1000;
const API_CACHE_MAX = 200;

function cachedGet<T = unknown>(path: string): Promise<T> {
  const hit = apiCache.get(path);
  if (hit && Date.now() - hit.at < API_CACHE_TTL_MS) return hit.promise as Promise<T>;
  const promise = apiGet<T>(path);
  // Failures shouldn't stick — drop the entry so the next call retries.
  promise.catch(() => apiCache.delete(path));
  apiCache.delete(path); // re-insert at the end so eviction is oldest-first
  apiCache.set(path, { at: Date.now(), promise });
  if (apiCache.size > API_CACHE_MAX) {
    const oldest = apiCache.keys().next().value;
    if (oldest !== undefined) apiCache.delete(oldest);
  }
  return promise;
}

export async function apiPost<T = unknown>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwApiError(res, path);
  return res.json();
}

export async function apiPut<T = unknown>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwApiError(res, path);
  return res.json();
}

export async function apiDelete(path: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) await throwApiError(res, path);
}

export interface PlexItem {
  ratingKey: string;
  title: string;
  year?: number;
  type: string;
  thumb: string | null;
  index?: number;
  parentIndex?: number;
  parentTitle?: string;
  /** Season rating key for episodes; show rating key for seasons. */
  parentRatingKey?: string;
  /** Show rating key for episodes. */
  grandparentRatingKey?: string;
  showTitle?: string;
  showThumb?: string | null;
  leafCount?: number;
  childCount?: number;
  summary?: string;
  duration?: number;
  /** False for online (Discover) search results that aren't in the library and
   *  can't be played here. Absent/true on everything else. */
  inLibrary?: boolean;
  /** plex:// guid — present on online (Discover) results, used to fetch their
   *  detail metadata. Absent on local library items. */
  guid?: string;
  /** TMDB id — carried on out-of-library collection members (which have no
   *  plex:// guid) so their detail page can drive ratings and the request flow
   *  directly. Absent on library items and Discover search results. */
  tmdbId?: number;
}

export interface PlexSection {
  id: string;
  title: string;
  type: string;
}

export interface Genre {
  id: string;
  title: string;
}

export interface StreamTrack {
  id: number;
  title: string;
  codec?: string | null;
  channels?: number | null;
  language?: string | null;
  languageCode?: string | null;
  selected: boolean;
}

/** A skippable intro/credits range detected by Plex. */
export interface SkipMarker {
  type: "intro" | "credits";
  /** Seconds — directly comparable to video.currentTime. */
  start: number;
  /** Seconds — the position to seek to when skipping. */
  end: number;
}

export interface PlexMeta {
  ratingKey: string;
  title: string;
  year?: number;
  /** Milliseconds (raw Plex value) — note markers below are in SECONDS. */
  duration?: number;
  summary?: string;
  /** Cut/edition label ("Director's Cut", "Extended Edition", "IMAX Edition", …)
   *  for a special edition; null/absent for a plain theatrical release. */
  editionTitle?: string | null;
  thumb: string | null;
  /** Show (grandparent) poster for episodes; null/absent for movies. Optional so
   *  a newer client served by an older server degrades to the episode thumb. */
  showThumb?: string | null;
  art: string | null;
  genres: string[];
  type: string;
  partId: number | null;
  /** Whether BIF hover-preview frames exist for this item. Optional so a newer
   *  client served by an older server degrades to "no previews". */
  previewThumbs?: boolean;
  audioTracks: StreamTrack[];
  subtitleTracks: StreamTrack[];
  /** Optional so a newer client served by an older server degrades to "no button". */
  markers?: SkipMarker[];
  /** TMDB id — for Seerr season requests on library shows. Optional/nullable. */
  tmdbId?: number | null;
  /** IMDb id (e.g. "tt0111161") — for external ratings. Optional/nullable. */
  imdbId?: string | null;
  /** Credits for the Cast & Crew row. Optional so a newer client served by an
   *  older server simply renders no row. */
  cast?: Credit[];
  directors?: Credit[];
  writers?: Credit[];
}

export interface PlexHub {
  hubIdentifier: string;
  title: string;
  type: string;
  items: PlexItem[];
}

export function fetchHome(): Promise<{ hubs: PlexHub[] }> {
  return apiGet("/api/plex/home");
}

export function fetchSections(): Promise<{ sections: PlexSection[] }> {
  return apiGet("/api/plex/sections");
}

export function fetchGenres(sectionId: string): Promise<{ genres: Genre[] }> {
  return apiGet(`/api/plex/sections/${encodeURIComponent(sectionId)}/genres`);
}

export function fetchSectionItems(
  sectionId: string,
  options?: { signal?: AbortSignal; start?: number; size?: number; genre?: string[]; sort?: string },
): Promise<{ items: PlexItem[]; totalSize: number; start: number; size: number }> {
  const params = new URLSearchParams();
  if (options?.start != null) params.set("start", String(options.start));
  if (options?.size != null) params.set("size", String(options.size));
  if (options?.genre && options.genre.length > 0) params.set("genre", options.genre.join(","));
  if (options?.sort) params.set("sort", options.sort);
  const qs = params.toString();
  return apiGet(`/api/plex/sections/${encodeURIComponent(sectionId)}/all${qs ? `?${qs}` : ""}`, options);
}

/**
 * Warm the caches for a title the user looks like they're about to open.
 *
 * Called on card hover (see MovieCard), so by the time the click lands the
 * detail page usually has its data already. Safe to call repeatedly: cachedGet
 * stores the in-flight promise, so a second call during the first request joins
 * it rather than starting another.
 *
 * Errors are swallowed on purpose — this is speculative work for a page the user
 * may never open, and the real fetch will surface any problem properly.
 */
export function prefetchDetail(item: Pick<PlexItem, "ratingKey" | "type" | "inLibrary">): void {
  // Not-in-library results resolve through a different endpoint keyed on guid or
  // tmdbId, and episodes have no related rows — neither is worth speculating on.
  if (item.inLibrary === false) return;
  void fetchMeta(item.ratingKey).catch(() => {});
  if (item.type === "movie" || item.type === "show") {
    void fetchRelated(item.ratingKey).catch(() => {});
  }
}

export function searchPlex(
  query: string,
): Promise<{ items: PlexItem[]; people?: PersonResult[] }> {
  return apiGet(`/api/plex/search?q=${encodeURIComponent(query)}`);
}

export function fetchChildren(ratingKey: string): Promise<{ items: PlexItem[] }> {
  return cachedGet(`/api/plex/children/${encodeURIComponent(ratingKey)}`);
}

/** A collection an item belongs to, with the other members to show alongside it
 *  on a detail page. Server-filtered to small collections only (see
 *  fetchRelated). */
export interface PlexCollection {
  ratingKey: string;
  title: string;
  items: PlexItem[];
}

/** Related rows for a movie/show detail page:
 *  - `collections`: the small collections it belongs to (large ones like
 *    Trending filtered out server-side; the item itself is kept in each row).
 *  - `recommendations`: TMDB's "you might also like" list (the "More Like This"
 *    row), library titles first then out-of-library ones (inLibrary=false, with
 *    a tmdbId for the request flow), excluding anything already in a collection.
 *  Both empty without a server TMDB key where they depend on it. Cached — the
 *  membership and suggestions are stable. */
export function fetchRelated(
  ratingKey: string,
): Promise<{ collections: PlexCollection[]; recommendations: PlexItem[] }> {
  return cachedGet(`/api/plex/collections/${encodeURIComponent(ratingKey)}`);
}

export function fetchMeta(ratingKey: string): Promise<PlexMeta> {
  return cachedGet(`/api/plex/meta/${encodeURIComponent(ratingKey)}`);
}

/** Drop a cached fetchMeta entry — call after mutating what it reports
 *  (e.g. setStreams changes the selected audio/subtitle tracks). */
export function invalidateMeta(ratingKey: string): void {
  apiCache.delete(`/api/plex/meta/${encodeURIComponent(ratingKey)}`);
}

/** Detail metadata for an online (Discover) title, fetched by its plex:// guid. */
export interface DiscoverMeta {
  title: string;
  year: number | null;
  summary: string | null;
  genres: string[];
  /** Runtime in milliseconds, or null. */
  duration: number | null;
  contentRating: string | null;
  type: string;
  /** Proxied poster URL, or null. */
  thumb: string | null;
  /** TMDB id for requesting via Seerr; null if unknown. */
  tmdbId: number | null;
  /** Optional so a newer client served by an older server degrades to no row. */
  cast?: Credit[];
  directors?: Credit[];
  writers?: Credit[];
}

/** One credited person on a title — an actor with their character, or a
 *  director/writer with their job. */
export interface Credit {
  /** Plex tag id — the key for this person's page. Null when Plex didn't
   *  supply one (older servers), in which case the credit isn't clickable. */
  id?: number | null;
  name: string;
  /** Character name for cast; job title for crew. Null when unknown. */
  role: string | null;
  /** Proxied headshot URL, or null when the provider has no photo. */
  thumb: string | null;
}

/** A person as returned by search — enough to render a row and open their page. */
export interface PersonResult {
  id: number;
  name: string;
  thumb: string | null;
}

/** A cast/crew member's page: their details, and what the library has of theirs. */
export interface PersonDetail {
  name: string;
  thumb: string | null;
  biography: string | null;
  /** ISO date, e.g. "1996-02-22". Null when unknown. */
  birthday: string | null;
  deathday: string | null;
  placeOfBirth: string | null;
  /** TMDB's department, e.g. "Acting" or "Directing". */
  knownFor: string | null;
  movies: PlexItem[];
  shows: PlexItem[];
}

export function fetchPerson(tagId: number, name: string): Promise<PersonDetail> {
  return cachedGet(`/api/plex/person/${tagId}?name=${encodeURIComponent(name)}`);
}

export function fetchDiscoverMeta(guid: string): Promise<DiscoverMeta> {
  return cachedGet(`/api/plex/discover/meta?guid=${encodeURIComponent(guid)}`);
}

/** Detail metadata for an out-of-library collection/recommendation member, which
 *  carries a TMDB id but no plex:// guid. Same shape as fetchDiscoverMeta so the
 *  external detail page renders it the same way. */
export function fetchTmdbMeta(tmdbId: number, type: "movie" | "show"): Promise<DiscoverMeta> {
  return cachedGet(`/api/plex/tmdb/meta?tmdbId=${tmdbId}&type=${type}`);
}

/** Seerr (Overseerr/Jellyseerr) request integration. `status` is Seerr's
 *  MediaStatus: 2=pending, 3=processing, 4=partially available, 5=available;
 *  null = not requested. `configured` is false when Seerr isn't set up. */
export interface SeerrStatus {
  configured: boolean;
  status: number | null;
}

export type SeerrMediaType = "movie" | "tv";

export function fetchSeerrStatus(tmdbId: number, mediaType: SeerrMediaType): Promise<SeerrStatus> {
  return apiGet(`/api/seerr/status?tmdbId=${tmdbId}&mediaType=${mediaType}`);
}

/**
 * External ratings for a movie/show detail page, sourced from MDBList.
 * `imdb` is 0–10; `tmdb`, `rtCritic` and `rtAudience` are 0–100 percentages.
 * Any field is null when that source has no score. `configured` is false when
 * the server has no MDBList API key set (the ratings row is then hidden).
 */
export interface Ratings {
  imdb: number | null;
  tmdb: number | null;
  rtCritic: number | null;
  rtAudience: number | null;
}

export type RatingsMediaType = "movie" | "show";

export function fetchRatings(
  opts: { imdbId?: string | null; tmdbId?: number | null; mediaType: RatingsMediaType },
): Promise<{ configured: boolean; ratings: Ratings }> {
  const params = new URLSearchParams({ mediaType: opts.mediaType });
  if (opts.imdbId) params.set("imdbId", opts.imdbId);
  if (opts.tmdbId != null) params.set("tmdbId", String(opts.tmdbId));
  // Cached (ratings are stable) so navigating back to a detail view is free.
  return cachedGet(`/api/ratings?${params.toString()}`);
}

/** A show's season with its Seerr status (2=pending, 3=processing, 4=partial,
 *  5=available, null=not requested/owned). */
export interface SeerrSeason {
  seasonNumber: number;
  name: string;
  episodeCount: number;
  status: number | null;
  /** TMDB poster file path (e.g. "/abc.jpg"), served via seerrPosterUrl. */
  posterPath?: string | null;
}

/** Same-origin proxied URL for a TMDB season poster, or null. */
export function seerrPosterUrl(posterPath: string | null | undefined): string | null {
  return posterPath ? `/api/seerr/poster?path=${encodeURIComponent(posterPath)}` : null;
}

export interface SeerrTv {
  configured: boolean;
  status: number | null;
  seasons: SeerrSeason[];
}

export function fetchSeerrTv(tmdbId: number): Promise<SeerrTv> {
  return apiGet(`/api/seerr/tv/${tmdbId}`);
}

export function seerrRequest(
  tmdbId: number,
  mediaType: SeerrMediaType,
  seasons?: number[],
): Promise<{ ok: boolean; status: number | null }> {
  return apiPost("/api/seerr/request", { tmdbId, mediaType, ...(seasons ? { seasons } : {}) });
}

/**
 * Resolve the episodes either side of this one. Either may be null — for movies,
 * the first/last episode, and anything unresolvable. All normal answers, not
 * errors. Season rollover is handled server-side (last of a season ↔ first of
 * the next), and both directions come from a single request.
 */
export function fetchSiblingEpisodes(
  ratingKey: string,
): Promise<{ prev: PlexItem | null; next: PlexItem | null }> {
  return cachedGet(`/api/plex/siblings/${encodeURIComponent(ratingKey)}`);
}

export function hlsMasterUrl(
  ratingKey: string,
  sessionId: string,
  options?: { offset?: number; subtitles?: boolean },
): string {
  const params = new URLSearchParams();
  if (options?.offset != null && options.offset > 0) params.set("offset", String(options.offset));
  params.set("subtitles", options?.subtitles ? "burn" : "none");
  const qs = params.toString();
  return `/api/plex/hls/${encodeURIComponent(ratingKey)}/${encodeURIComponent(sessionId)}/master.m3u8${qs ? `?${qs}` : ""}`;
}

export function setStreams(
  partId: number,
  options: { audioStreamID?: number; subtitleStreamID?: number },
): Promise<{ ok: boolean }> {
  return apiPut(`/api/plex/streams/${partId}`, options);
}

export async function pingSession(
  sessionId: string,
  timeMs?: number,
  playing?: boolean,
  bufferAheadS?: number,
): Promise<void> {
  const params = new URLSearchParams();
  if (timeMs != null && Number.isFinite(timeMs)) params.set("time", String(Math.round(timeMs)));
  // The server uses this to tell an intentional pause (frozen position, expected)
  // from a stall (frozen position, not expected) so it can nudge Plex's timeline
  // to keep the transcode advancing only in the latter case.
  if (playing != null) params.set("playing", playing ? "1" : "0");
  // Forward buffer in seconds — DIAGNOSTIC only, logged server-side alongside the
  // position so a drain-to-zero is visible in the same place as the transcode head.
  if (bufferAheadS != null && Number.isFinite(bufferAheadS)) {
    params.set("buffer", bufferAheadS.toFixed(1));
  }
  const qs = params.toString();
  await apiGet(`/api/plex/hls/ping/${encodeURIComponent(sessionId)}${qs ? `?${qs}` : ""}`);
}

/**
 * `reason` is diagnostic only — the server logs it so a teardown in the log can
 * be traced back to the branch of Player.tsx that asked for it, instead of just
 * showing that a DELETE arrived.
 */
export function stopSession(sessionId: string, reason?: string): Promise<void> {
  const qs = reason ? `?reason=${encodeURIComponent(reason)}` : "";
  return apiDelete(`/api/plex/hls/session/${encodeURIComponent(sessionId)}${qs}`);
}

export interface AppConfig {
  vpsRelay: boolean;
}

export function fetchConfig(): Promise<AppConfig> {
  return apiGet("/api/plex/config");
}

/**
 * A watched (or part-watched) item from the host's history. Shares its item
 * fields with PlexItem so history entries render through MovieCard unchanged;
 * the progress fields are the addition.
 */
export interface HistoryEntry {
  ratingKey: string;
  title: string;
  type: string;
  thumb: string | null;
  showThumb: string | null;
  showTitle: string | null;
  parentTitle: string | null;
  parentIndex: number | null;
  index: number | null;
  year: number | null;
  parentRatingKey: string | null;
  grandparentRatingKey: string | null;
  /** Resume position in milliseconds. */
  positionMs: number;
  /** Total runtime in milliseconds; 0 when Plex reported none. */
  durationMs: number;
  watched: boolean;
  updatedAt: number;
}

/** History entries carry nulls where PlexItem wants undefined — bridge the two. */
export function historyEntryToItem(entry: HistoryEntry): PlexItem {
  return {
    ratingKey: entry.ratingKey,
    title: entry.title,
    type: entry.type,
    thumb: entry.thumb,
    ...(entry.showThumb != null && { showThumb: entry.showThumb }),
    ...(entry.showTitle != null && { showTitle: entry.showTitle }),
    ...(entry.parentTitle != null && { parentTitle: entry.parentTitle }),
    ...(entry.parentIndex != null && { parentIndex: entry.parentIndex }),
    ...(entry.index != null && { index: entry.index }),
    ...(entry.year != null && { year: entry.year }),
    ...(entry.parentRatingKey != null && { parentRatingKey: entry.parentRatingKey }),
    ...(entry.grandparentRatingKey != null && { grandparentRatingKey: entry.grandparentRatingKey }),
  };
}

export function fetchContinueWatching(limit?: number): Promise<{ items: HistoryEntry[] }> {
  return apiGet(`/api/history/continue${limit != null ? `?limit=${limit}` : ""}`);
}

export function fetchHistory(
  options?: { limit?: number; offset?: number },
): Promise<{ items: HistoryEntry[]; total: number }> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set("limit", String(options.limit));
  if (options?.offset != null) params.set("offset", String(options.offset));
  const qs = params.toString();
  return apiGet(`/api/history${qs ? `?${qs}` : ""}`);
}

/** Saved progress for one item, or null if it's never been played. */
export function fetchProgress(ratingKey: string): Promise<{ progress: HistoryEntry | null }> {
  return apiGet(`/api/history/progress/${encodeURIComponent(ratingKey)}`);
}

/** Where to pick a show back up, or null if it's never been started or is
 *  finished. Ignores Continue Watching dismissals — see the server for why. */
export function fetchShowNextUp(showRatingKey: string): Promise<{ nextUp: HistoryEntry | null }> {
  return apiGet(`/api/history/show/${encodeURIComponent(showRatingKey)}/next-up`);
}

/** Progress for several items in one request, keyed by rating key. Items never
 *  played are absent from the map rather than null. */
export function fetchProgressMany(
  ratingKeys: string[],
): Promise<{ entries: Record<string, HistoryEntry> }> {
  return apiGet(`/api/history/progress?keys=${encodeURIComponent(ratingKeys.join(","))}`);
}

/** Forget an item outright — it leaves both History and Continue Watching. */
export function deleteHistoryEntry(ratingKey: string): Promise<void> {
  return apiDelete(`/api/history/entry/${encodeURIComponent(ratingKey)}`);
}

/** Drop an item from Continue Watching only; it stays in History, still
 *  resumable from its detail view. Watching more of it brings the row back. */
export function dismissFromContinueWatching(ratingKey: string): Promise<void> {
  return apiDelete(`/api/history/continue/${encodeURIComponent(ratingKey)}`);
}

export function clearHistory(): Promise<void> {
  return apiDelete("/api/history");
}
