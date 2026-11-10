import type { LogFile, LogResult, Overview, SettingsView } from "./types";

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
  logFiles: () => call<{ files: LogFile[] }>("/api/logs/files"),
  logs: (q: { file?: string; q?: string; level?: string; tag?: string; limit?: number }) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
    return call<LogResult>(`/api/logs?${p}`);
  },
  settings: () => call<SettingsView>("/api/settings"),
};
