/**
 * The cache warmer's artwork and episode passes.
 *
 * Run against a Plex with one film and one show of two episodes, which records
 * every request it is sent, and a TMDB and image CDN faked behind `fetch`.
 * The images have to land under the exact keys the image proxy looks up, or
 * the warmer fills a cache nobody reads. So the proof here is the proxy serving
 * them without asking Plex again, not the warmer's own account of what it did.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import sharp from "sharp";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-warmer-"));
process.env.THUMB_CACHE_DIR = dataDir;
process.env.PLEX_TOKEN = "test-token";
process.env.TMDB_API_KEY = "test-key";
process.env.WARM_CACHE_DELAY_MS = "0";
delete process.env.TVDB_API_KEY;
delete process.env.WARM_CACHE_ARTWORK;
delete process.env.WARM_CACHE_EPISODES;
delete process.env.WARM_CACHE_MAX_ITEMS;
delete process.env.THUMB_CACHE_MAX_SIZE;
delete process.env.THUMB_CACHE_MAX_MB;

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

// ── TMDB and Plex's image CDN, behind fetch ──────────────────────
const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#808080" } }).jpeg().toBuffer();
const tmdbRequests: string[] = [];
const cdnRequests: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname === "api.themoviedb.org") {
    const p = url.pathname.replace(/^\/3/, "");
    tmdbRequests.push(p);
    const body =
      p === "/movie/1/recommendations" ? { results: [{ id: 77, title: "Rec", poster_path: "/rec.jpg", release_date: "2020-01-01" }] }
      : p === "/tv/2/season/1" ? { episodes: [1, 2, 3].map((n) => ({ episode_number: n, name: `Episode ${n}`, air_date: "2020-01-01" })) }
      : p.endsWith("/recommendations") ? { results: [] }
      : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.hostname === "images.plex.tv") {
    cdnRequests.push(url.searchParams.get("url") ?? "");
    return new Response(jpeg, { status: 200, headers: { "Content-Type": "image/jpeg" } });
  }
  return realFetch(input, init);
}) as typeof fetch;

// ── a Plex with a film and a two-episode show ────────────────────
const person = (n: number) => ({ id: n, tag: `Actor ${n}`, role: `Role ${n}`, thumb: `/library/metadata/9${n}/thumb/1` });
const film = {
  ratingKey: "100", title: "Film", type: "movie", updatedAt: 10, addedAt: 2, librarySectionID: 1,
  thumb: "/library/metadata/100/thumb/1", art: "/library/metadata/100/art/1",
  Guid: [{ id: "tmdb://1" }],
  Collection: [{ tag: "Saga" }],
  Director: [{ id: 50, tag: "Director", thumb: "/library/metadata/950/thumb/1" }],
  // Fourteen cast, one sharing the director's photo: twelve distinct portraits
  // are warmed, the director's first.
  Role: [{ id: 51, tag: "Also Director", thumb: "/library/metadata/950/thumb/1" }, ...Array.from({ length: 13 }, (_, i) => person(i + 10))],
};
// In the film's collection, but not in the library listing: only its row warms it.
const sequel = { ratingKey: "101", title: "Sequel", type: "movie", librarySectionID: 1, thumb: "/library/metadata/101/thumb/1" };
const show = {
  ratingKey: "200", title: "Show", type: "show", updatedAt: 10, addedAt: 1, librarySectionID: 2,
  thumb: "/library/metadata/200/thumb/1", art: "/library/metadata/200/art/1",
  Guid: [{ id: "tmdb://2" }],
};
const season = { ratingKey: "201", title: "Season 1", type: "season", index: 1, parentRatingKey: "200", thumb: "/library/metadata/201/thumb/1" };
const episodes = [
  {
    ratingKey: "202", title: "One", type: "episode", index: 1, updatedAt: 20, thumb: "/library/metadata/202/thumb/1",
    Role: [{ id: 60, tag: "Guest", thumb: "/library/metadata/960/thumb/1" }],
  },
  { ratingKey: "203", title: "Two", type: "episode", index: 2, updatedAt: 20, thumb: "/library/metadata/203/thumb/1" },
];
// Outside the warmed set, for the age of saved details.
const old = { ratingKey: "500", title: "Old, as Plex has it now", type: "movie" };

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
    res.end(jpeg);
    return;
  }
  if (p === "/library/sections") {
    sectionScans.push(Date.now());
    return send({ Directory: [{ key: "1", type: "movie" }, { key: "2", type: "show" }] });
  }
  if (p === "/library/sections/1/all") return send({ Metadata: [film], totalSize: 1 });
  if (p === "/library/sections/2/all") return send({ Metadata: [show], totalSize: 1 });
  if (p === "/library/sections/1/collections") return send({ Metadata: [{ ratingKey: "300", title: "Saga", childCount: 2 }] });
  if (p === "/library/collections/300/children") return send({ Metadata: [film, sequel] });
  if (p === "/library/metadata/200/children") return send({ Metadata: [season] });
  if (p === "/library/metadata/201/children") return send({ Metadata: episodes });
  if (p === "/library/metadata/200/allLeaves") return send({ Metadata: episodes });
  if (p === "/library/metadata/600") {
    // Plex failing: the saved details are all there is.
    res.writeHead(500);
    res.end();
    return;
  }
  const one = [film, sequel, show, season, ...episodes, old].find((m) => p === `/library/metadata/${m.ratingKey}`);
  if (one) {
    metadataRequests.push(one.ratingKey);
    return send({ Metadata: [one] });
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((r) => plex.listen(0, "127.0.0.1", r));
process.env.PLEX_URL = `http://127.0.0.1:${(plex.address() as AddressInfo).port}`;

// Imported only now: the router reads PLEX_URL and TMDB_API_KEY at module load.
const express = (await import("express")).default;
const plexModule = await import("../src/routes/plex.js");
const { runWarmPass, portraitUrls, relatedPosterUrls } = await import("../src/services/cache-warmer.js");
const { writeDetailCache } = await import("../src/services/detail-cache.js");
const sizes = await import("../src/services/artwork-sizes.js");

const app = express();
app.use("/api/plex", plexModule.default);
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
  check("episode-list stills", [constant("EPISODE_THUMB_W"), constant("EPISODE_THUMB_H")], [sizes.EPISODE_STILL_SIZE.w, sizes.EPISODE_STILL_SIZE.h]);
  check("end-card stills", [constant("STILL_THUMB_W"), constant("STILL_THUMB_H")], [sizes.END_CARD_STILL_SIZE.w, sizes.END_CARD_STILL_SIZE.h]);
  check("portraits per title", constant("DETAIL_CAST_PREFETCH_LIMIT"), sizes.WARM_PORTRAITS_PER_TITLE);
}

console.log("— which images —");
check("portraits: directors first, no repeats, twelve at most",
  portraitUrls({
    directors: [{ thumb: "/d" }],
    cast: [{ thumb: "/d" }, { thumb: null }, ...Array.from({ length: 20 }, (_, i) => ({ thumb: `/c${i}` }))],
  }),
  ["/d", ...Array.from({ length: 11 }, (_, i) => `/c${i}`)]);
check("no metadata, no portraits", portraitUrls(null), []);
check("related posters: every row, an episode as its show, no repeats",
  relatedPosterUrls({
    collections: [{ items: [{ type: "movie", thumb: "/a" }, { type: "episode", thumb: "/still", showThumb: "/show" }] }],
    recommendations: [{ type: "movie", thumb: "/a" }, { type: "show", thumb: "/b" }, { type: "movie", thumb: null }],
  }),
  ["/a", "/show", "/b"]);
check("no related rows, no posters", relatedPosterUrls(null), []);

console.log("— the first pass —");
await runWarmPass(apiPort);
check("Plex resizes posters and backdrops first, then portraits, related posters, and the show's seasons and episodes", transcodes, [
  "/library/metadata/100/thumb/1 400x600",
  "/library/metadata/100/art/1 240x135",
  "/library/metadata/200/thumb/1 400x600",
  "/library/metadata/200/art/1 240x135",
  "/library/metadata/950/thumb/1 320x320",
  ...Array.from({ length: 11 }, (_, i) => `/library/metadata/9${i + 10}/thumb/1 320x320`),
  "/library/metadata/101/thumb/1 400x600",
  "/library/metadata/201/thumb/1 400x600",
  "/library/metadata/202/thumb/1 400x225",
  "/library/metadata/203/thumb/1 400x225",
  "/library/metadata/202/thumb/1 400x600",
  "/library/metadata/203/thumb/1 400x600",
  "/library/metadata/202/thumb/1 880x495",
  "/library/metadata/203/thumb/1 880x495",
  "/library/metadata/960/thumb/1 320x320",
]);
check("a recommendation outside the library comes through the image CDN", cdnRequests.length, 1);
check("both episodes' details are built", ["202", "203"].every((k) => metadataRequests.includes(k)), true);
check("the season's episode list is looked up", tmdbRequests.filter((p) => p === "/tv/2/season/1").length, 1);

console.log("— the proxy answers from what was warmed —");
const before = transcodes.length;
const cdnBefore = cdnRequests.length;
const recPoster = `/photo/:/transcode?url=${encodeURIComponent("https://image.tmdb.org/t/p/w500/rec.jpg")}&w=400&h=600`;
for (const [image, query] of [
  ["/library/metadata/100/thumb/1", "w=400&h=600"],
  ["/library/metadata/100/art/1", "w=240&h=135"],
  ["/library/metadata/950/thumb/1", "w=320&h=320"],
  ["/library/metadata/101/thumb/1", "w=400&h=600"],
  ["/library/metadata/202/thumb/1", "w=400&h=225"],
  ["/library/metadata/202/thumb/1", "w=400&h=600"],
  ["/library/metadata/202/thumb/1", "w=880&h=495"],
  ["/library/metadata/960/thumb/1", "w=320&h=320"],
]) {
  const res = await fetch(`${base}/thumb${image}?${query}`);
  await res.arrayBuffer();
  check(`${image}?${query} is served`, res.status, 200);
}
{
  const res = await fetch(`${base}/thumb${recPoster}`);
  await res.arrayBuffer();
  check("the recommendation's poster is served", res.status, 200);
}
check("…without asking Plex again", transcodes.length, before);
check("…or the image CDN", cdnRequests.length, cdnBefore);
const seasonListRequests = tmdbRequests.length;
const list = await (await fetch(`${base}/season-episodes/201`)).json() as { source: string; episodes: unknown[] };
check("the season's episode list is served", [list.source, list.episodes.length], ["tmdb", 3]);
check("…without asking TMDB again", tmdbRequests.length, seasonListRequests);

console.log("— a second pass over a warm cache —");
const episodeRequests = () => metadataRequests.filter((k) => k === "202" || k === "203").length;
const episodeRequestsBefore = episodeRequests();
const tmdbBefore = tmdbRequests.length;
await runWarmPass(apiPort);
check("fetches no images", [transcodes.length, cdnRequests.length], [before, cdnBefore]);
check("rebuilds no unchanged episode", episodeRequests(), episodeRequestsBefore);
check("leaves a fresh season list alone", tmdbRequests.length, tmdbBefore);

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

console.log("— saved details age —");
{
  const db = new Database(path.join(dataDir, "detail-cache.sqlite"));
  const age = (ratingKey: string, days: number) =>
    db.prepare("UPDATE detail_cache SET cached_at = ? WHERE rating_key = ?").run(Date.now() - days * 86_400_000, ratingKey);
  const saved = (title: string, version: number | undefined = plexModule.META_PAYLOAD_VERSION) =>
    ({ payloadVersion: version, ratingKey: "500", title, type: "movie" });
  writeDetailCache("meta", "500", saved("Old, as saved"));
  age("500", 6);
  check("under a week old, a saved title is answered from disk",
    (await plexModule.buildMeta("500"))?.title, "Old, as saved");
  plexModule.invalidateTitleDetailCaches("500");
  writeDetailCache("meta", "500", saved("Old, as saved"));
  age("500", 8);
  check("over a week old, it is rebuilt from Plex", (await plexModule.buildMeta("500"))?.title, "Old, as Plex has it now");
  plexModule.invalidateTitleDetailCaches("500");
  writeDetailCache("meta", "500", saved("Old, as saved", 1));
  check("saved in an older shape, it is rebuilt however new it is",
    (await plexModule.buildMeta("500"))?.title, "Old, as Plex has it now");
  writeDetailCache("meta", "600", { ratingKey: "600", title: "Kept", type: "movie" });
  age("600", 8);
  check("…unless Plex fails, when the old copy is still the answer", (await plexModule.buildMeta("600"))?.title, "Kept");
  db.close();
}

console.log("— what the warmer refuses —");
check("a path outside Plex's artwork", await plexModule.warmThumb("/api/plex/thumb/etc/passwd", 400, 600), "failed");
check("a URL that isn't the thumb proxy", await plexModule.warmThumb("/elsewhere/library/metadata/1/thumb/1", 400, 600), "failed");
check("an already-warm image", await plexModule.warmThumb("/api/plex/thumb/library/metadata/100/thumb/1", 400, 600), "cached");

api.close();
plex.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
process.exit(0);
