import type {
  CachesResult, LogFile, LogResult, Overview, PersonDetail, PersonSummary, PlaceGuild, PlayDetail, PlaySummary,
  SettingsView, TitleInfo, TitleRequest, UsageRow, Graphs, HistorySummary, TrimCounts
} from "./types";
import { timeZone } from "./format";

/** A query string of the values given. */
function qs(q: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Signed out: the page goes back to its sign-in. */
export class SignedOut extends Error {}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin", ...init });
  if (res.status === 401 && !url.endsWith("/login")) throw new SignedOut("Sign in first");
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  session: () => call<{ signedIn: boolean }>("/api/session"),
  login: (password: string) => call<{ ok: true }>("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  }),
  logout: () => call<{ ok: true }>("/api/logout", { method: "POST" }),
  overview: () => call<Overview>("/api/overview"),
  titles: (keys: string[]) => call<{ titles: Record<string, TitleInfo | null> }>(`/api/titles${qs({ keys: keys.join(",") })}`),
  logFiles: () => call<{ files: LogFile[] }>("/api/logs/files"),
  logs: (q: { file?: string; q?: string; level?: string; tag?: string; limit?: number }) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
    return call<LogResult>(`/api/logs?${p}`);
  },
  settings: () => call<SettingsView>("/api/settings"),
  history: (q: { q?: string; before?: number; limit?: number }) => call<{ plays: PlaySummary[] }>(`/api/history${qs(q)}`),
  play: (id: number) => call<PlayDetail>(`/api/history/${id}`),
  people: (q: { q?: string; offset?: number; limit?: number }) => call<{ people: PersonSummary[] }>(`/api/people${qs(q)}`),
  person: (id: string) => call<PersonDetail>(`/api/people/${encodeURIComponent(id)}`),
  places: () => call<{ guilds: PlaceGuild[] }>("/api/places"),
  usage: (q: { before?: number; limit?: number }) => call<{ usage: UsageRow[] }>(`/api/usage${qs(q)}`),
  requests: (q: { q?: string; before?: number; limit?: number }) => call<{ requests: TitleRequest[] }>(`/api/requests${qs(q)}`),
  caches: () => call<CachesResult>("/api/caches"),
  /** By the day, hour and weekday of this browser's time zone. */
  graphs: (days: number) => call<Graphs>(`/api/graphs${qs({ days, tz: timeZone() })}`),
  historyFile: (days?: number) => call<{ summary: HistorySummary; trim: TrimCounts | null }>(`/api/history-file${qs({ days })}`),
  trim: (days: number) => call<TrimCounts & { bytesBefore: number; bytesAfter: number }>("/api/history-file/trim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ days }),
  }),
};

/** A list as a file to download: history, people, usage or requests, as CSV or JSON, honouring a search. */
export function exportUrl(kind: "history" | "people" | "usage" | "requests", format: "csv" | "json", q?: string): string {
  return `/api/export/${kind}.${format}${qs({ q })}`;
}
