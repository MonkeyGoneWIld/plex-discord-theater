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
const { WebSocket } = await import("ws");
const { requireAuth, createSession } = await import("../src/middleware/auth.js");
const plexRoutes = (await import("../src/routes/plex.js")).default;
const { attachWebSocketServer, closeWebSocketServer } = await import("../src/services/sync.js");
const { instanceHosts } = await import("../src/routes/discord.js");

const app = express();
app.use("/api/plex", requireAuth, plexRoutes);
const server = await new Promise<http.Server>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
attachWebSocketServer(server);
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

console.log("\n— who may start a stream —");
{
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Somebody signed in, in the room `inst` if one is named. */
  async function person(userId: string, inst?: string) {
    const tok = createSession(userId, []);
    let ws: InstanceType<typeof WebSocket> | null = null;
    if (inst) {
      ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws?token=${tok}`);
      await new Promise<void>((r) => ws!.once("open", () => r()));
      ws.send(JSON.stringify({ type: "join", sessionToken: tok, instanceId: inst, userId, username: userId }));
      await sleep(80);
    }
    return {
      send: (m: object) => ws?.send(JSON.stringify(m)),
      close: () => ws?.close(),
      /** Ask for a stream's playlist: refused, or let through to Plex. */
      async start(ratingKey: string, sessionId: string) {
        asked.length = 0;
        const r = await fetch(`${base}/api/plex/hls/${ratingKey}/${sessionId}/master.m3u8?mediaIndex=0`, {
          headers: { Authorization: `Bearer ${tok}` },
        });
        await r.arrayBuffer();
        return r.status === 403 && asked.length === 0 ? "refused" : "let through";
      },
    };
  }
  const uuid = () => crypto.randomUUID();
  instanceHosts.set("inst-start", { hostUserId: "u-host", guildId: null, channelId: null, createdAt: Date.now() });

  const outsider = await person("u-outsider");
  check("somebody signed in but in no room is refused, and Plex never asked", await outsider.start("100", uuid()), "refused");

  const host = await person("u-host", "inst-start");
  const hostSid = uuid();
  check("the host of a room starts a title", await host.start("100", hostSid), "let through");
  host.send({ type: "play", ratingKey: "100", title: "A Film", hlsSessionId: hostSid, position: 0, sessionOffset: 0, audioStreamId: 1, subtitleStreamId: 0 });
  await sleep(80);
  check("and anything else it likes — the next title", await host.start("200", uuid()), "let through");

  const viewer = await person("u-viewer", "inst-start");
  check("a viewer following the room takes up its stream", await viewer.start("100", hostSid), "let through");
  check("but starts no stream of its own while it drives none", await viewer.start("100", uuid()), "refused");
  viewer.send({ type: "set-tracks", audioStreamId: 2, subtitleStreamId: 0 });
  await sleep(80);
  check("driving its own stream of the title, it starts that", await viewer.start("100", uuid()), "let through");
  check("but not one of another title", await viewer.start("200", uuid()), "refused");
  check("and somebody else's room's stream is nobody else's to start", await outsider.start("100", hostSid), "refused");

  viewer.close();
  await sleep(150);
  check("dropped and coming back in time, its own stream is still its to start", await viewer.start("100", uuid()), "let through");
  host.close();
  await sleep(150);
  closeWebSocketServer();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
server.close();
plex.close();
process.exit(fail === 0 ? 0 : 1);
