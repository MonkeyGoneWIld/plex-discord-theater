// The connection between a player and the bot as Discord's proxy makes it,
// for start-speed.tsx: a service worker over the test pages, answering the
// stream's segments itself.
//
// Every download its own, all of them at once, as over the proxy's HTTP/2 —
// the dev server's HTTP/1.1 lets a page six at a time, and a segment asked for
// in sixteen parts came in three goes — each with its first byte latencyMs
// after it was asked for, the rest from slowMs after that, at kbps; all of
// them together at most totalKbps. The playlist comes latencyMs late.
//
// The page sets it ({ kind: "model", model }) before each run, which starts a
// new log ({ kind: "log" } has it). Nothing is answered here until then.
// Segments are fetched from the test server whole, once each, and answered
// from memory: a part, a range from a byte on, or the lot, as the bot's are.

/** { latencyMs, slowMs, kbps, totalKbps }, or null to leave everything to the network. */
let model = null;
const files = new Map();
const log = [];
/** When the one connection everybody's downloads share is next free, ms. */
let freeAt = 0;
const SLOW_AFTER_BYTES = 16384;
const CHUNK = 16384;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("message", (e) => {
  const m = e.data;
  if (m && m.kind === "model") {
    model = m.model;
    files.clear();
    log.length = 0;
    freeAt = 0;
    e.ports[0] && e.ports[0].postMessage({ ok: true });
  } else if (m && m.kind === "log") {
    e.ports[0] && e.ports[0].postMessage(log);
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

self.addEventListener("fetch", (e) => {
  if (!model) return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/test/stream/")) e.respondWith(segment(e.request, url));
  else if (/^\/api\/plex\/hls\/.+\.m3u8$/.test(url.pathname)) e.respondWith(playlist(e.request, url));
});

async function playlist(request, url) {
  log.push({ kind: "playlist", url: url.pathname, askedAt: Date.now() });
  await sleep(model.latencyMs);
  return fetch(request);
}

function whole(path) {
  if (!files.has(path)) files.set(path, fetch(path).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status} for ${path}`)))));
  return files.get(path);
}

async function segment(request, url) {
  const asked = performance.now();
  const entry = { kind: "segment", url: url.pathname, part: url.searchParams.get("part"), parts: url.searchParams.get("parts"),
    askedAt: Date.now(), firstAt: 0, doneAt: 0, bytes: 0, cut: false };
  log.push(entry);
  const data = new Uint8Array(await whole(url.pathname));
  let body = data;
  let status = 200;
  const headers = { "Content-Type": url.pathname.endsWith(".ts") ? "video/mp2t" : "video/mp4" };
  const parts = url.searchParams.get("parts");
  const range = (request.headers.get("range") || "").match(/^bytes=(\d+)-(\d*)$/);
  if (parts) {
    const n = Number(parts);
    const i = Number(url.searchParams.get("part"));
    body = data.subarray(Math.floor((data.length * i) / n), Math.floor((data.length * (i + 1)) / n));
  } else if (range) {
    const from = Number(range[1]);
    const to = range[2] ? Number(range[2]) : data.length - 1;
    body = data.subarray(from, to + 1);
    status = 206;
    headers["Content-Range"] = `bytes ${from}-${to}/${data.length}`;
  }
  headers["Content-Length"] = String(body.length);
  entry.bytes = body.length;
  const m = model;
  await sleep(m.latencyMs - (performance.now() - asked));
  entry.firstAt = Date.now();
  let cancelled = false;
  const stream = new ReadableStream({
    async start(controller) {
      let at = 0;
      let pacedFrom = performance.now();
      let going = !m.slowMs;
      while (at < body.length && !cancelled) {
        if (!going && at >= SLOW_AFTER_BYTES) {
          going = true;
          await sleep(m.slowMs);
          pacedFrom = performance.now() - (at * 8) / m.kbps;
        }
        const end = Math.min(body.length, at + CHUNK, going ? Infinity : SLOW_AFTER_BYTES);
        const piece = body.slice(at, end);
        at = end;
        // At this download's own pace, then its turn on the connection they all share.
        await sleep(pacedFrom + (at * 8) / m.kbps - performance.now());
        if (m.totalKbps) {
          const turn = Math.max(performance.now(), freeAt);
          freeAt = turn + (piece.length * 8) / m.totalKbps;
          await sleep(turn - performance.now());
        }
        if (cancelled) break;
        controller.enqueue(piece);
      }
      entry.doneAt = Date.now();
      entry.cut = cancelled;
      if (!cancelled) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return new Response(stream, { status, headers });
}
