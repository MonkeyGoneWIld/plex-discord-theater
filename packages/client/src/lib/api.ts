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

export function searchPlex(query: string): Promise<{ items: PlexItem[] }> {
  return apiGet(`/api/plex/search?q=${encodeURIComponent(query)}`);
}

export function fetchChildren(ratingKey: string): Promise<{ items: PlexItem[] }> {
  return apiGet(`/api/plex/children/${encodeURIComponent(ratingKey)}`);
}

export function fetchMeta(ratingKey: string): Promise<PlexMeta> {
  return apiGet(`/api/plex/meta/${encodeURIComponent(ratingKey)}`);
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
}

export function fetchDiscoverMeta(guid: string): Promise<DiscoverMeta> {
  return apiGet(`/api/plex/discover/meta?guid=${encodeURIComponent(guid)}`);
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
  return apiGet(`/api/plex/siblings/${encodeURIComponent(ratingKey)}`);
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

export async function pingSession(sessionId: string, timeMs?: number): Promise<void> {
  let url = `/api/plex/hls/ping/${encodeURIComponent(sessionId)}`;
  if (timeMs != null && Number.isFinite(timeMs)) {
    url += `?time=${Math.round(timeMs)}`;
  }
  await apiGet(url);
}

export function stopSession(sessionId: string): Promise<void> {
  return apiDelete(`/api/plex/hls/session/${encodeURIComponent(sessionId)}`);
}

export interface AppConfig {
  vpsRelay: boolean;
}

export function fetchConfig(): Promise<AppConfig> {
  return apiGet("/api/plex/config");
}

export interface WatchProgressItem {
  ratingKey: string;
  title: string;
  thumb: string | null;
  type: string;
  parentTitle?: string;
  parentIndex?: number;
  index?: number;
  position: number;
  duration: number;
  updatedAt: number;
}

export function fetchProgress(): Promise<{ items: WatchProgressItem[] }> {
  return apiGet("/api/progress");
}

export function saveProgress(data: {
  ratingKey: string;
  title: string;
  thumb: string | null;
  type: string;
  parentTitle?: string;
  parentIndex?: number;
  index?: number;
  position: number;
  duration: number;
}): Promise<{ ok: boolean }> {
  return apiPut("/api/progress", data);
}

export function deleteProgressItem(ratingKey: string): Promise<void> {
  return apiDelete(`/api/progress/${encodeURIComponent(ratingKey)}`);
}
