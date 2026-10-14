/**
 * What the segment and thumbnail proxies will ask Plex for, against a Plex of
 * our own that records every request. Both used to pass any path under them
 * to Plex with the bot's token — its settings, who is watching what, a library
 * scan — and hand the answer back.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

type Answer = { type: string; body: string };
const answers = new Map<string, Answer>();
const asked: string[] = [];
const plex = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://plex");
  u.searchParams.delete("X-Plex-Token");
  asked.push(`${u.pathname}${u.search}`);
  const a = answers.get(u.pathname) ?? { type: "application/json", body: JSON.stringify({ path: u.pathname }) };
  res.setHeader("Content-Type", a.type);
  res.end(a.body);
});
await new Promise<void>((r) => plex.listen(0, "127.0.0.1", r));

process.env.PLEX_URL = `http://127.0.0.1:${(plex.address() as AddressInfo).port}`;
process.env.PLEX_TOKEN = "test-token";
process.env.THUMB_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-paths-"));
process.env.LOG_TO_FILE = "0";

const express = (await import("express")).default;
const { requireAuth, createSession } = await import("../src/middleware/auth.js");
const plexRoutes = (await import("../src/routes/plex.js")).default;

const app = express();
app.use("/api/plex", requireAuth, plexRoutes);
const server = await new Promise<http.Server>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const token = createSession("u-test", []);

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

/** One request: its status, content type, and what Plex was asked for. */
async function get(url: string) {
  asked.length = 0;
  const r = await fetch(base + url, { headers: { Authorization: `Bearer ${token}` } });
  await r.arrayBuffer();
  return { status: r.status, type: r.headers.get("content-type")?.split(";")[0] ?? null, asked: [...asked] };
}
const seg = (p: string) => `/api/plex/hls/seg?p=${encodeURIComponent(p)}`;

const SESSION = "/video/:/transcode/universal/session/0b1a3841-1c2d-4e5f-8a9b-0c1d2e3f4a5b/base";
answers.set(`${SESSION}/00012.ts`, { type: "video/MP2T", body: "segment" });
answers.set(`${SESSION}/index.m3u8`, { type: "application/vnd.apple.mpegurl", body: "#EXTM3U\n#EXTINF:3,\n00012.ts\n" });

console.log("\n— the segment proxy —");
{
  const ts = await get(seg(`${SESSION}/00012.ts`));
  check("a segment of a transcode is passed on", [ts.status, ts.asked], [200, [`${SESSION}/00012.ts`]]);
  const m3u8 = await get(seg(`${SESSION}/index.m3u8`));
  check("and its playlist", [m3u8.status, m3u8.asked], [200, [`${SESSION}/index.m3u8`]]);
  for (const p of ["/:/prefs", "/status/sessions", "/library/sections/1/refresh?force=1", "/library/sections"]) {
    const r = await get(seg(p));
    check(`${p} is refused, and Plex never asked`, [r.status, r.asked], [400, []]);
  }
  const query = await get(seg(`${SESSION}/00012.ts?download=1`));
  check("nor a segment carrying a query of its own", [query.status, query.asked], [400, []]);
  const other = await get(seg("/video/:/transcode/universal/decision"));
  check("nor anything else under the transcoder", [other.status, other.asked], [400, []]);
}

console.log("\n— the thumbnail proxy —");
{
  answers.set("/library/metadata/1/thumb/2", { type: "image/jpeg", body: "jpeg" });
  const poster = await get("/api/plex/thumb/library/metadata/1/thumb/2");
  check("a poster is passed on", [poster.status, poster.type, poster.asked], [200, "image/jpeg", ["/library/metadata/1/thumb/2"]]);
  const scan = await get("/api/plex/thumb/library/sections/1/refresh%3Fforce%3D1");
  check("a path hiding a query is refused, and Plex never asked", [scan.status, scan.asked], [400, []]);
  const twice = await get("/api/plex/thumb/library/sections/1/refresh%253Fforce%253D1");
  check("however many times it is encoded", [twice.status, twice.asked], [400, []]);
  const listing = await get("/api/plex/thumb/library/sections");
  check("a reply that isn't an image is not passed on", listing.status, 502);
  const again = await get("/api/plex/thumb/library/sections");
  check("nor kept to be served later", [again.status, again.asked], [502, ["/library/sections"]]);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
server.close();
plex.close();
process.exit(fail === 0 ? 0 : 1);
