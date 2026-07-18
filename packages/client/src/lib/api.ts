let sessionToken: string | null = null;

export function setSessionToken(token: string): void {
  sessionToken = token;
}

export function getSessionToken(): string | null {
  return sessionToken;
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
  leafCount?: number;
  childCount?: number;
  summary?: string;
  duration?: number;
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

export interface PlexMeta {
  ratingKey: string;
  title: string;
  year?: number;
  summary?: string;
  duration?: number;
  thumb: string | null;
  art: string | null;
  genres: string[];
  type: string;
  partId: number | null;
  audioTracks: StreamTrack[];
  subtitleTracks: StreamTrack[];
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
