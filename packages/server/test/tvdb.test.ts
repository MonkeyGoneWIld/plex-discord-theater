/**
 * TheTVDB episode lists: paged, and kept for six hours once read.
 *
 * Against a fake TVDB that pages a series' episodes the way the real one does,
 * one page per request, each with a link to the next while there is more.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       expected ${e}\n       got      ${a}`); }
}

/** Series 1: season 1 on page 0, season 2 on page 1. */
const pages = [
  [{ number: 1, seasonNumber: 1, name: "One" }, { number: 2, seasonNumber: 1, name: "Two" }],
  [{ number: 1, seasonNumber: 2, name: "Three" }],
];
/** Asks for page 1 still to be answered with a 500. */
let failPage1 = 0;
/** The pages asked for. */
const asked: number[] = [];

const tvdb = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/login") return res.end(JSON.stringify({ data: { token: "t" } }));
  if (url.pathname === "/series/1/episodes/default") {
    const page = Number(url.searchParams.get("page"));
    asked.push(page);
    if (page === 1 && failPage1 > 0) {
      failPage1--;
      res.statusCode = 500;
      return res.end("{}");
    }
    const next = page + 1 < pages.length ? `/series/1/episodes/default?page=${page + 1}` : null;
    return res.end(JSON.stringify({ data: { episodes: pages[page] ?? [] }, links: { next } }));
  }
  res.statusCode = 404;
  res.end("{}");
});
await new Promise<void>((r) => tvdb.listen(0, "127.0.0.1", r));
process.env.TVDB_API_BASE = `http://127.0.0.1:${(tvdb.address() as AddressInfo).port}`;
process.env.TVDB_API_KEY = "test-key";

const { tvdbSeasonEpisodes } = await import("../src/services/tvdb.js");
const names = (eps: Array<{ name: string }> | null) => eps?.map((e) => e.name) ?? null;

console.log("\n— a series whose second page fails —");
failPage1 = 1;
check("the first page's season is shown", names(await tvdbSeasonEpisodes(1, 1)), ["One", "Two"]);
check("asked again, TVDB is read again and the second page's season comes in",
  names(await tvdbSeasonEpisodes(1, 2)), ["Three"]);

console.log("\n— a series read whole —");
asked.length = 0;
check("is kept: asked again, TVDB isn't", [names(await tvdbSeasonEpisodes(1, 1)), asked], [["One", "Two"], []]);

tvdb.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
