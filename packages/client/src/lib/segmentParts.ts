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
 * direct-stream.ts) is asked for in parts (`part=i&parts=k`), all at once, and
 * handed to the P2P engine as the single response it asked for: the parts in
 * order, each passed on as it arrives once those before it are in.
 */

/** About how big each part is. Small enough that even a short segment is
 *  split, since every part runs at a download's pace. */
const PART_BYTES = 1_000_000;
/** Parts per segment at most; the engine runs two segments at once. */
export const MAX_PARTS = 4;

export function partsFor(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 1;
  return Math.max(1, Math.min(MAX_PARTS, Math.ceil(bytes / PART_BYTES)));
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

/** How a download in parts is going, all parts together. */
export interface PartsProgress {
  received: number;
  total: number;
  /** performance.now() when it began. */
  startedAt: number;
}

const marked = new WeakMap<Request, { key: string; bytes: number }>();
const progress = new Map<string, PartsProgress>();

/**
 * Have `fetch` — once installSegmentParts has wrapped it — fetch this request
 * in parts. `key` names the segment for segmentProgress; the engine's own name
 * for it, its URL, is what the P2P engine patch looks it up by.
 */
export function fetchInPartsLater(request: Request, key: string, bytes: number): Request {
  if (partsFor(bytes) > 1) marked.set(request, { key, bytes });
  return request;
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
    if (!mark || init) return native(input, init);
    return fetchInParts(native, input as Request, mark.bytes, partsFor(mark.bytes), mark.key);
  }) as Fetch & { segmentParts?: true };
  wrapped.segmentParts = true;
  target.fetch = wrapped;
}

/**
 * Fetch `request`, a segment of `bytes` bytes, as `parts` downloads at once,
 * and answer as if it had been one: status and headers from the first part,
 * the body every part's bytes in order.
 *
 * A server that ignores the parts sends the whole segment to each. The first
 * part then runs past its share, and is taken as the whole: the others are
 * called off, whatever they had.
 */
export async function fetchInParts(
  fetchFn: Fetch,
  request: Request,
  bytes: number,
  parts: number,
  key: string = request.url,
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
  const finish = () => {
    request.signal.removeEventListener("abort", onAbort);
    if (progress.get(key) === status) progress.delete(key);
  };

  const headers = new Headers(request.headers);
  const responses = bounds.map((_, i) =>
    fetchFn(partUrl(request.url, i, parts), { headers, signal: stops[i].signal, cache: request.cache }));
  // Nothing from the first part's failure is waited on by the others.
  for (const r of responses) r.catch(() => {});

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
    drain();
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      out = controller;
      responses.forEach((pending, i) => {
        pending.then((response) => read(i, response)).catch((err) => {
          // The parts after a first part that was the whole are called off.
          if (whole && i !== 0) return;
          fail(err);
        });
      });
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
