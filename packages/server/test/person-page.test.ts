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
// TMDB is stubbed at the fetch boundary below rather than skipped, because the
// half of the page it supplies — everything the library *doesn't* have — is
// half of what is being tested.
process.env.TMDB_API_KEY = "test-key";

// ── a TMDB that answers for one person and nobody else ───────────
const tmdbAsked: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  // All three shapes fetch accepts. The server passes a URL object, which has
  // no `.url` — reading one gave "undefined" and quietly let every TMDB call
  // through to the real thing.
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : String(input.url);
  if (!url.startsWith("https://api.themoviedb.org/")) return realFetch(input, init);
  const path = new URL(url).pathname.replace("/3", "");
  tmdbAsked.push(path);
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

  if (path === "/search/person") {
    const q = new URL(url).searchParams.get("query") ?? "";
    return json({ results: q.toLowerCase() === "sam bottoms" ? [{ id: 7 }] : [] });
  }
  if (path === "/person/7") {
    return json({ id: 7, name: "Sam Bottoms", biography: "An actor.", profile_path: "/p.jpg",
                  birthday: "1955-10-17", deathday: "2008-12-16",
                  place_of_birth: "Santa Barbara", known_for_department: "Acting" });
  }
  if (path === "/person/7/combined_credits") {
    return json({
      cast: [
        // Owned, by guid — must not appear twice.
        { id: 101, media_type: "movie", title: "Apocalypse Now", release_date: "1979-08-15", poster_path: "/a.jpg" },
        // Owned, but with no tmdb guid on the Plex side: caught by title.
        { id: 999, media_type: "movie", title: "The Last Picture Show", release_date: "1971-10-22", poster_path: "/l.jpg" },
        // Not owned. Deliberately out of date order, and one has no poster.
        { id: 201, media_type: "movie", title: "Bronco Billy", release_date: "1980-06-11", poster_path: "/b.jpg" },
        { id: 202, media_type: "movie", title: "Class of '44", release_date: "1973-04-01", poster_path: "/c.jpg" },
        { id: 203, media_type: "movie", title: "A Stub", release_date: "1999-01-01", poster_path: null },
        { id: 204, media_type: "tv", name: "Murder, She Wrote", first_air_date: "1990-01-01", poster_path: "/m.jpg" },
        // A duplicate id, which TMDB does return when someone is credited twice.
        { id: 201, media_type: "movie", title: "Bronco Billy", release_date: "1980-06-11", poster_path: "/b.jpg" },
      ],
      crew: [
        { id: 205, media_type: "movie", title: "Directed This", release_date: "1985-01-01", poster_path: "/d.jpg", job: "Director" },
        { id: 206, media_type: "movie", title: "Gaffed This", release_date: "1986-01-01", poster_path: "/g.jpg", job: "Gaffer" },
      ],
    });
  }
  return json({});
}) as typeof fetch;

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

function movie(ratingKey: string, title: string, year: number, tmdbId?: number) {
  return {
    ratingKey, title, year, type: "movie", thumb: `/t/${ratingKey}`,
    ...(tmdbId ? { Guid: [{ id: `tmdb://${tmdbId}` }] } : {}),
  };
}
function show(ratingKey: string, title: string, year: number, tmdbId?: number) {
  return {
    ratingKey, title, year, type: "show", thumb: `/t/${ratingKey}`,
    ...(tmdbId ? { Guid: [{ id: `tmdb://${tmdbId}` }] } : {}),
  };
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
        movie("10", "Apocalypse Now", 1979, 101),
        // No guid on this one, on purpose: the title has to carry the match.
        movie("11", "The Last Picture Show", 1971),
      ] } });
    }
    if (url.searchParams.get("director") === "42") {
      // Also credited as director on one he acted in — the page lists it once.
      return send({ MediaContainer: { Metadata: [movie("10", "Apocalypse Now", 1979, 101)] } });
    }
    return send({ MediaContainer: { Metadata: [] } });
  }

  if (url.pathname === "/library/sections/2/all") {
    if (url.searchParams.get("actor") === "42") {
      return send({ MediaContainer: { Metadata: [show("20", "East of Eden", 1981, 301)] } });
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
  check("what the library has comes first, newest first",
    body.movies.slice(0, 2).map((m: any) => m.title), ["Apocalypse Now", "The Last Picture Show"]);
  check("and is marked as playable", body.movies.slice(0, 2).every((m: any) => m.inLibrary !== false), true);
  check("a title they both acted in and directed is listed once",
    body.movies.filter((m: any) => m.title === "Apocalypse Now").length, 1);

  // The rest of the career, behind it, in the same order.
  const rest = body.movies.slice(2);
  check("then the rest of their films, newest first",
    rest.map((m: any) => m.title), ["Directed This", "Bronco Billy", "Class of '44"]);
  check("all of them requestable", rest.every((m: any) => m.inLibrary === false), true);
  check("carrying the id the request flow needs", rest.every((m: any) => typeof m.tmdbId === "number"), true);
  check("a credit with no poster is not a card",
    body.movies.some((m: any) => m.title === "A Stub"), false);
  check("crew jobs other than directing are left out",
    body.movies.some((m: any) => m.title === "Gaffed This"), false);
  check("a credit listed twice appears once",
    body.movies.filter((m: any) => m.title === "Bronco Billy").length, 1);
  check("a film the library has under no tmdb guid is not offered again",
    body.movies.filter((m: any) => m.title === "The Last Picture Show").length, 1);

  check("shows work the same way",
    body.shows.map((m: any) => [m.title, m.inLibrary !== false]),
    [["East of Eden", true], ["Murder, She Wrote", false]]);
  check("the biography still arrives", body.biography, "An actor.");

  // One search to find the person, one section list, then one filter per
  // section per role. Nothing per credit, and nothing off-server.
  check("one search resolves the person", asked.filter((p) => p === "/hubs/search").length, 1);
  check("the section list is fetched once", asked.filter((p) => p === "/library/sections").length, 1);
  check("music is not searched for actors",
    asked.some((p) => p.startsWith("/library/sections/3/")), false);
  check("the whole page costs a handful of Plex requests", asked.length <= 7, true);
  check("and three TMDB calls, not one per credit",
    tmdbAsked.length, 3);

  // The regression this replaces: a Plex search per TMDB credit.
  check("no per-credit searches", asked.filter((p) => p === "/hubs/search").length <= 1, true);
}

console.log("\n— and it is cheap the second time —");
{
  asked.length = 0;
  tmdbAsked.length = 0;
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
  check("and no biography", body.biography, null);
}

console.log(`\n${pass} passed, ${fail} failed`);
api.close();
plex.close();
process.exit(fail === 0 ? 0 : 1);
