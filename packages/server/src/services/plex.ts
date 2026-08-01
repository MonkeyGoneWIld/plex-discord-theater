/**
 * Plex API client. All requests are authenticated server-side.
 */

const PLEX_HEADERS = {
  Accept: "application/json",
  "X-Plex-Client-Identifier": "plex-discord-theater",
  "X-Plex-Product": "Plex Discord Theater",
  "X-Plex-Version": "1.0.0",
};

/**
 * @param token Overrides the server token. A few endpoints — notably
 *   /status/sessions/terminate — reject the server token with 403 and need the
 *   plex.tv *account* token instead.
 */
export function plexUrl(
  path: string,
  params?: Record<string, string>,
  token?: string,
): string {
  const base = process.env.PLEX_URL!.replace(/\/$/, "");
  // Use string concatenation to avoid URL constructor mishandling colon-containing Plex paths
  const url = new URL(`${base}${path.startsWith("/") ? "" : "/"}${path}`);
  url.searchParams.set("X-Plex-Token", token || process.env.PLEX_TOKEN!);
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
  /** See plexUrl — for endpoints the server token can't reach. */
  token?: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLEX_TIMEOUT_MS);
  try {
    return await fetch(plexUrl(path, params, token), {
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

/**
 * Race a body read against a deadline.
 *
 * plexFetch clears its abort timer as soon as the *headers* land, which is
 * deliberate — it also serves plexFetchSegment, where killing the timer is what
 * lets a body stream for as long as it needs. The cost is that reading a JSON
 * body had no deadline at all: a Plex that accepts the connection and then stops
 * sending left the request hanging forever, holding a socket and whichever
 * route awaited it. Callers see the same rejection they would from a timeout on
 * the request itself.
 */
async function withBodyTimeout<T>(work: Promise<T>, path: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Plex body read timed out after ${PLEX_TIMEOUT_MS}ms: ${path}`)),
          PLEX_TIMEOUT_MS,
        );
      }),
    ]);
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
      detail = (await withBodyTimeout(res.text(), path)).replace(/\s+/g, " ").trim().slice(0, 300);
    } catch { /* body unreadable — status alone */ }
    throw new Error(`Plex API error: ${res.status}${detail ? ` — ${detail}` : ""}`);
  }
  return withBodyTimeout(res.json() as Promise<T>, path);
}
