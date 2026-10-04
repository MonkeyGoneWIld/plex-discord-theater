/**
 * The cache warmer's artwork and episode passes.
 *
 * Run against a Plex with one film and one show of two episodes, which records
 * every request it is sent. The images have to land under the exact keys the
 * image proxy looks up, or the warmer fills a cache nobody reads. So the proof
 * here is the proxy serving them without asking Plex again, not the warmer's
 * own account of what it did.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

process.env.THUMB_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cache-warmer-"));
process.env.PLEX_TOKEN = "test-token";
process.env.WARM_CACHE_DELAY_MS = "0";
delete process.env.TMDB_API_KEY;
delete process.env.WARM_CACHE_ARTWORK;
delete process.env.WARM_CACHE_EPISODES;

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

// ── a Plex with a film and a two-episode show ────────────────────
const person = (n: number) => ({ id: n, tag: `Actor ${n}`, role: `Role ${n}`, thumb: `/library/metadata/9${n}/thumb/1` });
const film = {
  ratingKey: "100", title: "Film", type: "movie", updatedAt: 10, addedAt: 2,
  thumb: "/library/metadata/100/thumb/1", art: "/library/metadata/100/art/1",
  Guid: [{ id: "tmdb://1" }],
  Director: [{ id: 50, tag: "Director", thumb: "/library/metadata/950/thumb/1" }],
  // Fourteen cast, one sharing the director's photo: twelve distinct portraits
  // are warmed, the director's first.
  Role: [{ id: 51, tag: "Also Director", thumb: "/library/metadata/950/thumb/1" }, ...Array.from({ length: 13 }, (_, i) => person(i + 10))],
};
const show = {
  ratingKey: "200", title: "Show", type: "show", updatedAt: 10, addedAt: 1,
  thumb: "/library/metadata/200/thumb/1", art: "/library/metadata/200/art/1",
  Guid: [{ id: "tmdb://2" }],
};
const season = { ratingKey: "201", title: "Season 1", type: "season", index: 1, thumb: "/library/metadata/201/thumb/1" };
const episodes = [
  { ratingKey: "202", title: "One", type: "episode", index: 1, updatedAt: 20, thumb: "/library/metadata/202/thumb/1" },
  { ratingKey: "203", title: "Two", type: "episode", index: 2, updatedAt: 20, thumb: "/library/metadata/203/thumb/1" },
];

const transcodes: string[] = [];
const metadataRequests: string[] = [];
const sectionScans: number[] = [];

const plex = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://plex");
  const send = (body: unknown) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ MediaContainer: body }));
  };
  const p = url.pathname;
  if (p === "/photo/:/transcode") {
    const q = url.searchParams;
    transcodes.push(`${q.get("url")} ${q.get("width")}x${q.get("height")}`);
    res.writeHead(200, { "Content-Type": "image/jpeg" });
    res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    return;
  }
  if (p === "/library/sections") {
    sectionScans.push(Date.now());
    return send({ Directory: [{ key: "1", type: "movie" }, { key: "2", type: "show" }] });
  }
  if (p === "/library/sections/1/all") return send({ Metadata: [film], totalSize: 1 });
  if (p === "/library/sections/2/all") return send({ Metadata: [show], totalSize: 1 });
  if (p === "/library/metadata/200/children") return send({ Metadata: [season] });
  if (p === "/library/metadata/200/allLeaves") return send({ Metadata: episodes });
  const one = [film, show, season, ...episodes].find((m) => p === `/library/metadata/${m.ratingKey}`);
  if (one) {
    metadataRequests.push(one.ratingKey);
    return send({ Metadata: [one] });
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((r) => plex.listen(0, "127.0.0.1", r));
process.env.PLEX_URL = `http://127.0.0.1:${(plex.address() as AddressInfo).port}`;

// Imported only now: the router reads PLEX_URL at module load.
const express = (await import("express")).default;
const plexRoutes = (await import("../src/routes/plex.js")).default;
const { runWarmPass, portraitUrls } = await import("../src/services/cache-warmer.js");
const sizes = await import("../src/services/artwork-sizes.js");

const app = express();
app.use("/api/plex", plexRoutes);
const api = http.createServer(app);
await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
const apiPort = (api.address() as AddressInfo).port;
const base = `http://127.0.0.1:${apiPort}/api/plex`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("— sizes match the client —");
{
  const client = fs.readFileSync(new URL("../../client/src/lib/api.ts", import.meta.url), "utf8");
  const constant = (name: string) => Number(new RegExp(`const ${name} = (\\d+)`).exec(client)?.[1]);
  check("posters", [constant("POSTER_THUMB_W"), constant("POSTER_THUMB_H")], [sizes.POSTER_SIZE.w, sizes.POSTER_SIZE.h]);
  check("backdrops", [constant("BACKDROP_THUMB_W"), constant("BACKDROP_THUMB_H")], [sizes.BACKDROP_SIZE.w, sizes.BACKDROP_SIZE.h]);
  check("portraits", [constant("PERSON_THUMB_SIZE"), constant("PERSON_THUMB_SIZE")], [sizes.PERSON_SIZE.w, sizes.PERSON_SIZE.h]);
  check("episode stills", [constant("EPISODE_THUMB_W"), constant("EPISODE_THUMB_H")], [sizes.EPISODE_STILL_SIZE.w, sizes.EPISODE_STILL_SIZE.h]);
  check("portraits per title", constant("DETAIL_CAST_PREFETCH_LIMIT"), sizes.WARM_PORTRAITS_PER_TITLE);
}

console.log("— which portraits —");
check("directors first, no repeats, twelve at most",
  portraitUrls({
    directors: [{ thumb: "/d" }],
    cast: [{ thumb: "/d" }, { thumb: null }, ...Array.from({ length: 20 }, (_, i) => ({ thumb: `/c${i}` }))],
  }),
  ["/d", ...Array.from({ length: 11 }, (_, i) => `/c${i}`)]);
check("no metadata, no portraits", portraitUrls(null), []);

console.log("— the first pass —");
await runWarmPass(apiPort);
const expected = [
  "/library/metadata/100/thumb/1 400x600",
  "/library/metadata/100/art/1 240x135",
  "/library/metadata/200/thumb/1 400x600",
  "/library/metadata/200/art/1 240x135",
  "/library/metadata/950/thumb/1 320x320",
  ...Array.from({ length: 11 }, (_, i) => `/library/metadata/9${i + 10}/thumb/1 320x320`),
  "/library/metadata/201/thumb/1 400x600",
  "/library/metadata/202/thumb/1 400x225",
  "/library/metadata/203/thumb/1 400x225",
];
check("posters and backdrops first, then portraits, then the show's season and episodes", transcodes, expected);
check("both episodes' details are built", ["202", "203"].every((k) => metadataRequests.includes(k)), true);

console.log("— the proxy answers from what was warmed —");
const before = transcodes.length;
for (const [image, query] of [
  ["/library/metadata/100/thumb/1", "w=400&h=600"],
  ["/library/metadata/100/art/1", "w=240&h=135"],
  ["/library/metadata/950/thumb/1", "w=320&h=320"],
  ["/library/metadata/202/thumb/1", "w=400&h=225"],
]) {
  const res = await fetch(`${base}/thumb${image}?${query}`);
  await res.arrayBuffer();
  check(`${image}?${query} is served`, res.status, 200);
}
check("…without asking Plex again", transcodes.length, before);

console.log("— a second pass over a warm cache —");
const episodeRequests = () => metadataRequests.filter((k) => k === "202" || k === "203").length;
const episodeRequestsBefore = episodeRequests();
await runWarmPass(apiPort);
check("fetches no images", transcodes.length, before);
check("rebuilds no unchanged episode", episodeRequests(), episodeRequestsBefore);

console.log("— an episode Plex changed —");
episodes[1].updatedAt = 21;
await runWarmPass(apiPort);
check("only that episode is rebuilt", metadataRequests.filter((k) => k === "202" || k === "203").slice(episodeRequestsBefore), ["203"]);

console.log("— while a room is playing —");
let busy = true;
const scansBefore = sectionScans.length;
const passDone = runWarmPass(apiPort, { isBusy: () => busy, busyPollMs: 10 });
await sleep(150);
check("nothing is asked of Plex", sectionScans.length, scansBefore);
busy = false;
await passDone;
check("the pass goes ahead once it stops", sectionScans.length, scansBefore + 1);

console.log("— what the warmer refuses —");
const { warmThumb } = await import("../src/routes/plex.js");
check("a path outside Plex's artwork", await warmThumb("/api/plex/thumb/etc/passwd", 400, 600), "failed");
check("a URL that isn't the thumb proxy", await warmThumb("/elsewhere/library/metadata/1/thumb/1", 400, 600), "failed");
check("an already-warm image", await warmThumb("/api/plex/thumb/library/metadata/100/thumb/1", 400, 600), "cached");

api.close();
plex.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
process.exit(0);
