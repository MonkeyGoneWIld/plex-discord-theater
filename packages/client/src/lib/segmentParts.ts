/**
 * A copied segment fetched as several downloads at once.
 *
 * Each download from the bot runs through Discord's proxy at its own pace — 7
 * to 25 Mbps, however many others run beside it — and a copied segment is a
 * whole keyframe interval at the film's own bitrate: 7 MB for The Count of
 * Monte Cristo, 28 MB for a Blu-ray. As one download, the first segment of a
 * stream took 7 to 28 seconds, and it was the one the picture waited on.
 *
 * So a segment whose size the playlist states (`n=` on its URL — the server's
 * direct-stream.ts) is asked for in parts (`part=i&parts=k`), and handed to the
 * P2P engine as the single response it asked for: the parts in order, each
 * passed on as it arrives once those before it are in.
 *
 * A segment is always split the same way, whatever else is downloading — its
 * parts' URLs are the same however it is fetched — and what changes is how
 * many of them download at once (`atOnce`). The bot's answers stay in the
 * browser's cache for five minutes, and the page that comes after this one —
 * Discord's pop-out reloads the activity — finds there what this one fetched,
 * but only under the same URLs: on 13 October each page back from a pop-out
 * asked for its first segment in eight parts where the page before had
 * fetched it in four, and had all 26 to 28 MB of it again from the bot, while
 * the segments after it came out of the cache in no time.
 */
import { keepSegment, keepingSegments, keptSegment, roomToKeep } from "./segmentKeep";

/** About how big each part is. Small enough that even a short segment is
 *  split, since every part runs at a download's pace. */
const PART_BYTES = 1_000_000;
/**
 * Parts per segment at most: as many as the bot will split one into
 * (MAX_SEGMENT_PARTS). All of them download at once for a segment fetched on
 * its own — the one a stream's picture waits on — or the one the picture
 * needs next (see Player's partsAtOnce).
 */
export const MAX_PARTS = 8;
/** Parts of a segment downloading at once beside another segment: two
 *  segments' worth is as many downloads as one on its own. */
export const PARTS_AT_ONCE_BESIDE = 4;

export function partsFor(bytes: number, most = MAX_PARTS): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 1;
  return Math.max(1, Math.min(most, Math.ceil(bytes / PART_BYTES)));
}

/** Where each part starts and ends: the split the server's segmentPart makes. */
export function partBounds(bytes: number, parts: number): Array<[number, number]> {
  return Array.from({ length: parts }, (_, i) => [
    Math.floor((bytes * i) / parts),
    Math.floor((bytes * (i + 1)) / parts),
  ]);
}

/** The size the playlist gave a segment, from its URL; null for one it didn't. */
export function segmentBytesOf(url: string): number | null {
  const m = url.match(/[?&]n=(\d+)(?:&|#|$)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function partUrl(url: string, part: number, parts: number): string {
  const hash = url.indexOf("#");
  const base = hash < 0 ? url : url.slice(0, hash);
  return `${base}${base.includes("?") ? "&" : "?"}part=${part}&parts=${parts}`;
}

/** How long the bot lets the browser keep a segment (its Cache-Control), less
 *  a little: past it, a fetch asks the bot again whatever the cache holds. */
const KEPT_FOR_MS = 280_000;

/**
 * Whether the browser holds the whole of `url`, a segment, without asking the
 * bot for any of it: kept by this page or the one before (lib/segmentKeep),
 * or in its own cache as this page would fetch it — every part of one fetched
 * in parts. A page back from Discord's pop-out finds there what the page
 * before fetched, for five minutes, unless the cache has let some of it go:
 * on 14 October three pages back found their first 30 to 40 seconds there,
 * and one found nothing.
 */
export async function inBrowserCache(url: string, fetchFn: Fetch = (i, o) => fetch(i, o)): Promise<boolean> {
  const kept = await keptSegment(url);
  if (kept) {
    kept.body?.cancel().catch(() => {});
    return true;
  }
  const bytes = segmentBytesOf(url);
  const parts = bytes === null ? 1 : partsFor(bytes);
  const urls = parts > 1 ? Array.from({ length: parts }, (_, i) => partUrl(url, i, parts)) : [url];
  const held = await Promise.all(urls.map(async (u) => {
    try {
      const r = await fetchFn(u, { cache: "only-if-cached", mode: "same-origin" });
      r.body?.cancel().catch(() => {});
      // Held, but kept past what the bot allows is asked for again.
      const at = Date.parse(r.headers.get("date") ?? "");
      return r.ok && !(Date.now() - at > KEPT_FOR_MS);
    } catch {
      return false;
    }
  }));
  return held.every(Boolean);
}

/** How a download in parts is going, all parts together. */
export interface PartsProgress {
  received: number;
  total: number;
  /** performance.now() when it began. */
  startedAt: number;
}

/** How many of a download's parts may run at once — asked again whenever it
 *  could start another. Anything over its parts is all of them. */
export type PartsAtOnce = () => number;

const marked = new WeakMap<Request, { key: string; bytes: number; parts: number; atOnce?: PartsAtOnce }>();
/** Requests for a whole segment, to be answered from what is kept and kept — see keepLater. */
const keepable = new WeakSet<Request>();
const progress = new Map<string, PartsProgress>();
/** Every download in parts under way: each one's way of starting more of its parts — see pumpSegmentParts. */
const pumps = new Set<() => void>();

/**
 * Have `fetch` — once installSegmentParts has wrapped it — fetch this request
 * in parts, `atOnce` of them at a time (all of them, unless it says). `key`
 * names the segment for segmentProgress; the engine's own name for it, its
 * URL, is what the P2P engine patch looks it up by.
 */
export function fetchInPartsLater(request: Request, key: string, bytes: number, atOnce?: PartsAtOnce): Request {
  const parts = partsFor(bytes);
  if (parts > 1) marked.set(request, { key, bytes, parts, atOnce });
  return request;
}

/**
 * Have `fetch` — once installSegmentParts has wrapped it — answer this
 * request, a whole segment, from what this page or the one before it kept
 * (lib/segmentKeep), and keep what it fetches. Before fetchInPartsLater or
 * without it: either way it is the request that is marked.
 */
export function keepLater(request: Request): Request {
  keepable.add(request);
  return request;
}

/**
 * Start more parts of the downloads under way, wherever one may now have more
 * at once than it has — the segment beside the one the picture needed is the
 * one it needs, say. Each also looks for itself whenever a part of it is in.
 */
export function pumpSegmentParts(): void {
  for (const pump of [...pumps]) pump();
}

/** How the download of a segment in parts is going, while it runs. */
export function segmentProgress(key: string): PartsProgress | undefined {
  return progress.get(key);
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Wrap `target.fetch` so the requests fetchInPartsLater marked are fetched in
 * parts. Everything else passes straight through. Once per window.
 */
export function installSegmentParts(target: { fetch: Fetch } = window): void {
  const current = target.fetch as Fetch & { segmentParts?: true };
  if (current.segmentParts) return;
  const native = current.bind(target);
  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) => {
    const mark = input instanceof Request ? marked.get(input) : undefined;
    if (input instanceof Request && !init && keepable.has(input)) return fetchKeeping(native, input, mark);
    if (!mark || init) return native(input, init);
    return fetchInParts(native, input as Request, mark.bytes, mark.parts, mark.key, mark.atOnce);
  }) as Fetch & { segmentParts?: true };
  wrapped.segmentParts = true;
  target.fetch = wrapped;
}

/**
 * A whole segment: what is kept of it, or fetched — in parts if it is marked
 * so — and kept as it is handed on.
 */
async function fetchKeeping(
  native: Fetch,
  request: Request,
  mark: { key: string; bytes: number; parts: number; atOnce?: PartsAtOnce } | undefined,
): Promise<Response> {
  const kept = await keptSegment(request.url);
  if (kept) return kept;
  const response = mark
    ? await fetchInParts(native, request, mark.bytes, mark.parts, mark.key, mark.atOnce)
    : await native(request);
  if (response.status !== 200 || !response.body || !keepingSegments() || !roomToKeep()) return response;
  const [handedOn, toKeep] = response.body.tee();
  void keepSegment(request.url, toKeep, response.headers.get("Content-Type"), mark?.bytes ?? segmentBytesOf(request.url));
  return new Response(handedOn, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * Fetch `request`, a segment of `bytes` bytes, as `parts` downloads, `atOnce`
 * of them at a time — all of them unless it says, the next starting as one
 * before it is in — and answer as if it had been one: status and headers from
 * the first part, the body every part's bytes in order.
 *
 * A server that ignores the parts sends the whole segment to each. The first
 * part then runs past its share, and is taken as the whole: the others are
 * called off, whatever they had, and the rest never asked for.
 */
export async function fetchInParts(
  fetchFn: Fetch,
  request: Request,
  bytes: number,
  parts: number,
  key: string = request.url,
  atOnce: PartsAtOnce = () => parts,
): Promise<Response> {
  if (parts <= 1) return fetchFn(request);
  const bounds = partBounds(bytes, parts);
  // One per part: the engine calling off the request, or a part failing,
  // calls off all of them; a first part that turns out to be the whole
  // segment calls off only the rest.
  const stops = bounds.map(() => new AbortController());
  const stopAll = (reason?: unknown) => { for (const s of stops) s.abort(reason); };
  const onAbort = () => stopAll(request.signal.reason);
  if (request.signal.aborted) onAbort();
  else request.signal.addEventListener("abort", onAbort, { once: true });

  const status: PartsProgress = { received: 0, total: bytes, startedAt: performance.now() };
  progress.set(key, status);
  let pump = () => {};
  const finish = () => {
    request.signal.removeEventListener("abort", onAbort);
    pumps.delete(pump);
    if (progress.get(key) === status) progress.delete(key);
  };

  const headers = new Headers(request.headers);
  /** The parts asked for so far, in order. */
  const responses: Array<Promise<Response>> = [];
  const allowed = () => {
    const n = Math.floor(atOnce());
    return n >= 1 ? Math.min(parts, n) : 1;
  };
  /** Ask for the next part not yet asked for; its number. */
  const launch = () => {
    const i = responses.length;
    const pending = fetchFn(partUrl(request.url, i, parts), { headers, signal: stops[i].signal, cache: request.cache });
    // Nothing from one part's failure is waited on by the others.
    pending.catch(() => {});
    responses.push(pending);
    return i;
  };
  /** Parts asked for and not yet in. */
  let running = 0;
  for (const most = allowed(); responses.length < most; running++) launch();

  let first: Response;
  try {
    first = await responses[0];
  } catch (err) {
    stopAll(err);
    finish();
    throw err;
  }
  if (!first.ok || !first.body) {
    stopAll();
    finish();
    return first;
  }

  // Every part is read as fast as it comes, whatever the engine is reading:
  // a body nobody reads is a download the browser slows down.
  const queues: Uint8Array[][] = bounds.map(() => []);
  const done: boolean[] = bounds.map(() => false);
  let current = 0;
  let whole = false;
  let failed = false;
  let out!: ReadableStreamDefaultController<Uint8Array>;

  const fail = (err: unknown) => {
    if (failed) return;
    failed = true;
    stopAll(err);
    finish();
    try { out.error(err); } catch { /* already closed */ }
  };
  const drain = () => {
    if (failed) return;
    while (current < parts) {
      const queue = queues[current];
      while (queue.length) out.enqueue(queue.shift()!);
      if (!done[current]) return;
      current = whole ? parts : current + 1;
    }
    finish();
    out.close();
  };
  const read = async (i: number, response: Response) => {
    const [from, to] = bounds[i];
    if (!response.ok || !response.body) throw new Error(`part ${i + 1} of ${parts}: HTTP ${response.status}`);
    const reader = response.body.getReader();
    let got = 0;
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      got += value.byteLength;
      status.received += value.byteLength;
      // The first part running past its share is a server sending the whole
      // segment: it is the whole, and the other parts aren't wanted.
      if (i === 0 && !whole && got > to - from) {
        whole = true;
        status.received = got;
        for (let j = 1; j < parts; j++) { done[j] = true; queues[j].length = 0; stops[j].abort(); }
      }
      if (whole && i !== 0) return;
      queues[i].push(value);
      drain();
    }
    const want = i === 0 && whole ? bytes : to - from;
    if (got !== want) throw new Error(`part ${i + 1} of ${parts}: ${got} bytes, expected ${want}`);
    done[i] = true;
    running--;
    pump();
    drain();
  };
  const follow = (i: number) => {
    responses[i].then((response) => read(i, response)).catch((err) => {
      // The parts after a first part that was the whole are called off.
      if (whole && i !== 0) return;
      fail(err);
    });
  };
  pump = () => {
    if (failed || whole) return;
    for (const most = allowed(); responses.length < parts && running < most; running++) follow(launch());
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      out = controller;
      responses.forEach((_, i) => follow(i));
      pumps.add(pump);
    },
    cancel(reason) {
      failed = true;
      stopAll(reason);
      finish();
    },
  });

  const outHeaders = new Headers(first.headers);
  outHeaders.set("Content-Length", String(bytes));
  outHeaders.delete("Content-Range");
  outHeaders.delete("Content-Encoding");
  return new Response(body, { status: 200, statusText: first.statusText, headers: outHeaders });
}
