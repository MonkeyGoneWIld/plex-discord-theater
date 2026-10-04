/**
 * The cache warmer's limits: WARM_CACHE_MAX_ITEMS=all, and stopping its
 * artwork short of a full image cache.
 *
 * In a file of its own because both are read from the environment once, when
 * the modules load. A Plex of 601 films, one more than the default limit, and
 * an image cache of 1 KB that each 200-byte poster fills a fifth of.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

process.env.THUMB_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cache-warmer-limits-"));
process.env.PLEX_TOKEN = "test-token";
process.env.WARM_CACHE_DELAY_MS = "0";
process.env.WARM_CACHE_MAX_ITEMS = "all";
process.env.WARM_CACHE_EPISODES = "0";
process.env.THUMB_CACHE_MAX_SIZE = "1K";
delete process.env.TMDB_API_KEY;
delete process.env.TVDB_API_KEY;
delete process.env.WARM_CACHE_ARTWORK;

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

const films = Array.from({ length: 601 }, (_, i) => ({
  ratingKey: String(1000 + i), title: `Film ${i}`, type: "movie", updatedAt: 1, addedAt: 601 - i,
  thumb: `/library/metadata/${1000 + i}/thumb/1`,
}));
const built = new Set<string>();
const transcodes: string[] = [];

const plex = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://plex");
  const send = (body: unknown) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ MediaContainer: body }));
  };
  const p = url.pathname;
  if (p === "/photo/:/transcode") {
    transcodes.push(url.searchParams.get("url") ?? "");
    res.writeHead(200, { "Content-Type": "image/jpeg" });
    res.end(Buffer.alloc(200, 1));
    return;
  }
  if (p === "/library/sections") return send({ Directory: [{ key: "1", type: "movie" }] });
  if (p === "/library/sections/1/all") return send({ Metadata: films, totalSize: films.length });
  const film = /^\/library\/metadata\/(\d+)$/.exec(p);
  const one = film && films.find((f) => f.ratingKey === film[1]);
  if (one) {
    if (!url.searchParams.has("includeCollections")) built.add(one.ratingKey);
    return send({ Metadata: [one] });
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((r) => plex.listen(0, "127.0.0.1", r));
process.env.PLEX_URL = `http://127.0.0.1:${(plex.address() as AddressInfo).port}`;

const express = (await import("express")).default;
const plexRoutes = (await import("../src/routes/plex.js")).default;
const { runWarmPass } = await import("../src/services/cache-warmer.js");
const thumbCache = await import("../src/services/thumb-cache.js");

const app = express();
app.use("/api/plex", plexRoutes);
const api = http.createServer(app);
await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));

await runWarmPass((api.address() as AddressInfo).port);

console.log("— WARM_CACHE_MAX_ITEMS=all —");
check("every title's details are built, past the default 600", built.size, 601);

console.log("— a nearly full image cache —");
check("THUMB_CACHE_MAX_SIZE takes a unit", thumbCache.usage().maxBytes, 1024);
check("posters stop once the cache is 90% full: five of 200 bytes in 1 KB", transcodes.length, 5);
check("…so nothing was pushed out to make room", thumbCache.usage().bytes, 1000);

api.close();
plex.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
process.exit(0);
