/**
 * Plex API client. All requests are authenticated server-side.
 */

const PLEX_HEADERS = {
  Accept: "application/json",
  "X-Plex-Client-Identifier": "plex-discord-theater",
  "X-Plex-Product": "Plex Discord Theater",
  "X-Plex-Version": "1.0.0",
};

export function plexUrl(path: string, params?: Record<string, string>): string {
  const base = process.env.PLEX_URL!.replace(/\/$/, "");
  // Use string concatenation to avoid URL constructor mishandling colon-containing Plex paths
  const url = new URL(`${base}${path.startsWith("/") ? "" : "/"}${path}`);
  url.searchParams.set("X-Plex-Token", process.env.PLEX_TOKEN!);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

const PLEX_TIMEOUT_MS = 15_000;

export async function plexFetch(
  path: string,
  params?: Record<string, string>,
  extraHeaders?: Record<string, string>,
  method?: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLEX_TIMEOUT_MS);
  try {
    return await fetch(plexUrl(path, params), {
      method,
      headers: extraHeaders ? { ...PLEX_HEADERS, ...extraHeaders } : PLEX_HEADERS,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

const PLEX_SEGMENT_TIMEOUT_MS = 8_000;

export async function plexFetchSegment(
  path: string,
  params?: Record<string, string>,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLEX_SEGMENT_TIMEOUT_MS);
  try {
    return await fetch(plexUrl(path, params), {
      headers: PLEX_HEADERS,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function plexJSON<T = unknown>(
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const res = await plexFetch(path, params);
  if (!res.ok) {
    // Include Plex's error body — its 403s carry a code/message (e.g. an XML
    // <Response code="1080" status="A valid server token is required."/>) that
    // distinguishes a permission problem from a degraded server-claim state.
    let detail = "";
    try {
      detail = (await res.text()).replace(/\s+/g, " ").trim().slice(0, 300);
    } catch { /* body unreadable — status alone */ }
    throw new Error(`Plex API error: ${res.status}${detail ? ` — ${detail}` : ""}`);
  }
  return res.json() as Promise<T>;
}
