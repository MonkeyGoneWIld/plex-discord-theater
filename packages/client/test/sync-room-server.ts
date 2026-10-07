// Server for the sync-room fixture:
//   npx tsx packages/client/test/sync-room-server.ts
// then `npm run dev -w packages/client` and open /test/sync-room.html.
//
// The real room — the sync server and P2P tracker from packages/server, on
// port 3000 where the dev server's /ws, /tracker and /api proxies point — and
// a stand-in for Plex serving the media-errors fixture's two-minute stream
// (generate it once with media-errors-server.mjs). Nothing else of the app's
// server runs: every other /api call answers an empty 200.
//
// A player's segments can be held back on demand, to make one player's stream
// stall while the others' doesn't:
//   POST /api/test/stall?user=u-host&ms=6000
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

process.env.THUMB_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sync-room-"));
const { attachWebSocketServer } = await import("../../server/src/services/sync.js");
const { createSession, getSessionUserId } = await import("../../server/src/middleware/auth.js");
const { instanceHosts } = await import("../../server/src/routes/discord.js");

const PORT = 3000;
const STREAM_DIR = path.join(os.tmpdir(), "plex-theater-media-errors");
const INSTANCE = "sync-room";
if (!fs.existsSync(path.join(STREAM_DIR, "index.m3u8"))) {
  console.error(`No test stream in ${STREAM_DIR} — run media-errors-server.mjs once to generate it.`);
  process.exit(1);
}

/** Until when each user's segments are held back. */
const stallUntil = new Map<string, number>();
/**
 * How often each user may have a segment, ms — a connection only a little
 * faster than the stream, so their buffer stays short and a stall reaches
 * the picture. Unset is as fast as the disk.
 */
const paceMs = new Map<string, number>();
const nextSlot = new Map<string, number>();
/** Segments served, per user, for the checks to read. */
const served: Array<{ user: string; seg: string; at: number; heldMs: number }> = [];

const meta = (ratingKey: string) => ({
  ratingKey, title: "Sync Test", type: "movie", thumb: null, duration: 120_000,
  partId: null, markers: [], genres: [], versions: [], audioTracks: [], subtitleTracks: [],
});

function userOf(req: http.IncomingMessage, url: URL): string | null {
  const auth = req.headers.authorization?.replace(/^Bearer /, "") ?? url.searchParams.get("token");
  return auth ? getSessionUserId(auth) : null;
}

const json = (res: http.ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const user = userOf(req, url);
  const p = url.pathname;

  if (p === "/api/test/session") {
    const id = url.searchParams.get("user") ?? "u-viewer";
    instanceHosts.set(INSTANCE, { hostUserId: "u-host", guildId: null, channelId: null, createdAt: Date.now() });
    return json(res, { token: createSession(id, null), instanceId: INSTANCE });
  }
  if (p === "/api/test/stall") {
    const who = url.searchParams.get("user") ?? "u-host";
    const ms = Number(url.searchParams.get("ms") ?? 5000);
    stallUntil.set(who, Date.now() + ms);
    // The paced connection picks up from the end of the stall, not before.
    if (paceMs.has(who)) nextSlot.set(who, Math.max(nextSlot.get(who) ?? 0, Date.now() + ms));
    console.log(`[stall] ${who} for ${ms}ms`);
    return json(res, { ok: true });
  }
  if (p === "/api/test/pace") {
    const who = url.searchParams.get("user") ?? "u-host";
    const ms = Number(url.searchParams.get("ms") ?? 0);
    if (ms > 0) paceMs.set(who, ms);
    else paceMs.delete(who);
    return json(res, { ok: true });
  }
  if (p === "/api/test/reset") {
    stallUntil.clear(); paceMs.clear(); nextSlot.clear(); served.length = 0;
    p2pOn = url.searchParams.get("p2p") !== "0";
    return json(res, { ok: true, p2p: p2pOn });
  }
  if (p === "/api/test/served") return json(res, served);

  if (p === "/api/plex/config") return json(res, { vpsRelay: false });
  if (p === "/api/plex/played-threshold") return json(res, { threshold: 0.9 });
  if (p.startsWith("/api/plex/meta/")) return json(res, meta(p.split("/").pop()!));
  if (p.startsWith("/api/plex/siblings/")) return json(res, { episode: false, prev: null, next: null });

  // The stream: a media playlist straight away, as a copy of Plex's would be.
  if (/^\/api\/plex\/hls\/[^/]+\/[^/]+\/master\.m3u8$/.test(p)) {
    const playlist = fs.readFileSync(path.join(STREAM_DIR, "index.m3u8"), "utf8")
      .replace(/^(seg\d+\.ts)$/gm, "/api/test/stream/$1");
    res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
    return res.end(playlist);
  }
  const seg = p.match(/^\/api\/test\/stream\/(seg\d+\.ts)$/);
  if (seg) {
    const who = user ?? "unknown";
    const asked = Date.now();
    // Its turn on the paced connection, then — checked again and again, so a
    // stall called while it waits holds it too — past any stall.
    const pace = paceMs.get(who);
    let slot = asked;
    if (pace) {
      slot = Math.max(asked, stallUntil.get(who) ?? 0, nextSlot.get(who) ?? 0);
      nextSlot.set(who, slot + pace);
    }
    for (;;) {
      const until = Math.max(slot, stallUntil.get(who) ?? 0);
      if (Date.now() >= until) break;
      await new Promise((r) => setTimeout(r, Math.min(200, until - Date.now())));
    }
    const held = Date.now() - asked;
    served.push({ user: who, seg: seg[1], at: Date.now(), heldMs: held });
    const file = path.join(STREAM_DIR, seg[1]);
    if (!fs.existsSync(file)) return json(res, { error: "no such segment" }, 404);
    res.writeHead(200, { "Content-Type": "video/mp2t", "Content-Length": fs.statSync(file).size });
    return fs.createReadStream(file).pipe(res);
  }

  // Everything else the player calls — pings, stops, logs, previews — is
  // nothing to this fixture.
  json(res, {});
});

// Players in one browser find each other through the tracker and share
// segments, which is what a struggling host's stream is meant to be rescued by
// — and what a check on how the room behaves while the host struggles has to
// switch off: /api/test/reset?p2p=0.
let p2pOn = true;
server.prependListener("upgrade", (req, socket) => {
  if (!p2pOn && (req.url ?? "").startsWith("/tracker")) socket.destroy();
});
attachWebSocketServer(server);
server.listen(PORT, () => console.log(`sync-room server on http://localhost:${PORT} (stream from ${STREAM_DIR})`));
