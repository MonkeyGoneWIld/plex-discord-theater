/**
 * The person page, against a stub Plex.
 *
 * The thing worth testing here is not the shape of the answer but the *cost* of
 * getting it. The page used to ask TMDB who someone was, ask TMDB for their
 * complete filmography, and then run one Plex search per credit to find out
 * which of them were on the shelf — up to eighty searches to rebuild a list
 * Plex already had, which is where five to ten seconds went. So the assertions
 * below count upstream requests.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

process.env.PLEX_TOKEN = "test-token";
// No TMDB key: tmdbGet short-circuits, so nothing here reaches the internet and
// the biography is simply absent — which is the documented degraded behaviour.
delete process.env.TMDB_API_KEY;

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

// ── a Plex that records what it was asked ────────────────────────
const asked: string[] = [];

function movie(ratingKey: string, title: string, year: number) {
  return { ratingKey, title, year, type: "movie", thumb: `/t/${ratingKey}` };
}
function show(ratingKey: string, title: string, year: number) {
  return { ratingKey, title, year, type: "show", thumb: `/t/${ratingKey}` };
}

const plex = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://plex");
  asked.push(url.pathname + (url.searchParams.get("actor") ? "?actor" : "")
                          + (url.searchParams.get("director") ? "?director" : ""));
  const send = (body: unknown) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === "/library/sections") {
    return send({ MediaContainer: { Directory: [
      { key: "1", title: "Movies", type: "movie" },
      { key: "2", title: "TV Shows", type: "show" },
      { key: "3", title: "Music", type: "artist" },
    ] } });
  }

  if (url.pathname === "/hubs/search") {
    const q = (url.searchParams.get("query") || "").toLowerCase();
    if (q === "sam bottoms") {
      return send({ MediaContainer: { Hub: [
        // A collection hub first, to prove the person test isn't just "the
        // first tag we see" — this one shares the tag shape.
        { hubIdentifier: "search.collection", Directory: [{ id: 77, tag: "Sam Bottoms Collection", ratingKey: "900" }] },
        { hubIdentifier: "search.actor", Directory: [{ id: 42, tag: "Sam Bottoms" }] },
      ] } });
    }
    return send({ MediaContainer: { Hub: [] } });
  }

  if (url.pathname === "/library/sections/1/all") {
    if (url.searchParams.get("actor") === "42") {
      return send({ MediaContainer: { Metadata: [
        movie("10", "Apocalypse Now", 1979),
        movie("11", "The Last Picture Show", 1971),
      ] } });
    }
    if (url.searchParams.get("director") === "42") {
      // Also credited as director on one he acted in — the page lists it once.
      return send({ MediaContainer: { Metadata: [movie("10", "Apocalypse Now", 1979)] } });
    }
    return send({ MediaContainer: { Metadata: [] } });
  }

  if (url.pathname === "/library/sections/2/all") {
    if (url.searchParams.get("actor") === "42") {
      return send({ MediaContainer: { Metadata: [show("20", "East of Eden", 1981)] } });
    }
    return send({ MediaContainer: { Metadata: [] } });
  }

  res.writeHead(404).end();
});
await new Promise<void>((r) => plex.listen(0, "127.0.0.1", r));
process.env.PLEX_URL = `http://127.0.0.1:${(plex.address() as AddressInfo).port}`;

// Imported only now: the router reads PLEX_URL at module load.
const express = (await import("express")).default;
const plexRoutes = (await import("../src/routes/plex.js")).default;

const app = express();
app.use("/api/plex", plexRoutes);
const api = http.createServer(app);
await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
const apiPort = (api.address() as AddressInfo).port;

const getPerson = async (name: string) => {
  const res = await fetch(`http://127.0.0.1:${apiPort}/api/plex/person?name=${encodeURIComponent(name)}`);
  return { status: res.status, body: await res.json() as Record<string, any> };
};

console.log("\n— a person page is built from Plex, not rebuilt from TMDB —");
{
  asked.length = 0;
  const { status, body } = await getPerson("Sam Bottoms");

  check("the request succeeds", status, 200);
  check("their films come back, newest first",
    body.movies.map((m: any) => m.title), ["Apocalypse Now", "The Last Picture Show"]);
  check("and their shows", body.shows.map((m: any) => m.title), ["East of Eden"]);
  check("a title they both acted in and directed is listed once",
    body.movies.filter((m: any) => m.title === "Apocalypse Now").length, 1);

  // One search to find the person, one section list, then one filter per
  // section per role. Nothing per credit, and nothing off-server.
  check("one search resolves the person", asked.filter((p) => p === "/hubs/search").length, 1);
  check("the section list is fetched once", asked.filter((p) => p === "/library/sections").length, 1);
  check("music is not searched for actors",
    asked.some((p) => p.startsWith("/library/sections/3/")), false);
  check("the whole page costs a handful of requests", asked.length <= 7, true);

  // The regression this replaces: a Plex search per TMDB credit.
  check("no per-credit searches", asked.filter((p) => p === "/hubs/search").length <= 1, true);
}

console.log("\n— and it is cheap the second time —");
{
  asked.length = 0;
  await getPerson("Sam Bottoms");
  check("the person lookup is cached", asked.filter((p) => p === "/hubs/search").length, 0);
  check("so is the section list", asked.filter((p) => p === "/library/sections").length, 0);
}

console.log("\n— somebody Plex has never heard of —");
{
  asked.length = 0;
  const { status, body } = await getPerson("Nobody At All");
  check("still answers", status, 200);
  check("with an empty filmography rather than an error", [body.movies, body.shows], [[], []]);
  check("and no biography, there being no TMDB key", body.biography, null);
}

console.log(`\n${pass} passed, ${fail} failed`);
api.close();
plex.close();
process.exit(fail === 0 ? 0 : 1);
