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
// and every download of a player's can be held to a speed, as each one through
// Discord's proxy is, however many run beside it:
//   POST /api/test/flow?user=u-host&kbps=6000
//
// /api/test/reset?stream=copy plays a stream shaped like a copied film instead
// — one segment per ten-second keyframe interval, ~10 MB each, made once with
// ffmpeg — whose playlist gives each segment's size, as the bot's does, so the
// players fetch them in parts (lib/segmentParts). &parts=0 leaves the sizes out.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

process.env.THUMB_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sync-room-"));
const { attachWebSocketServer } = await import("../../server/src/services/sync.js");
const { createSession, getSessionUserId } = await import("../../server/src/middleware/auth.js");
const { instanceHosts } = await import("../../server/src/routes/discord.js");

const PORT = 3000;
const SMALL_STREAM = path.join(os.tmpdir(), "plex-theater-media-errors");
const COPY_STREAM = path.join(os.tmpdir(), "plex-theater-copy-stream");
const INSTANCE = "sync-room";
if (!fs.existsSync(path.join(SMALL_STREAM, "index.m3u8"))) {
  console.error(`No test stream in ${SMALL_STREAM} — run media-errors-server.mjs once to generate it.`);
  process.exit(1);
}
if (!fs.existsSync(path.join(COPY_STREAM, "index.m3u8"))) {
  fs.mkdirSync(COPY_STREAM, { recursive: true });
  console.log("generating the copied-film stream in", COPY_STREAM);
  const made = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "120", "-c:v", "libx264", "-preset", "veryfast", "-b:v", "8M", "-maxrate", "8M", "-bufsize", "16M",
    "-g", "240", "-keyint_min", "240", "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
    "-f", "hls", "-hls_time", "10", "-hls_list_size", "0", "-hls_playlist_type", "vod",
    "-hls_segment_filename", path.join(COPY_STREAM, "seg%03d.ts"), path.join(COPY_STREAM, "index.m3u8"),
  ], { stdio: "inherit" });
  if (made.status !== 0) { console.error("ffmpeg failed — is it on the PATH?"); process.exit(1); }
}
let streamDir = SMALL_STREAM;
/** Whether the playlist gives segment sizes, for the players to fetch in parts. */
let partsOn = true;

/** Until when each user's segments are held back. */
const stallUntil = new Map<string, number>();
/**
 * How often each user may have a segment, ms — a connection only a little
 * faster than the stream, so their buffer stays short and a stall reaches
 * the picture. Unset is as fast as the disk.
 */
const paceMs = new Map<string, number>();
const nextSlot = new Map<string, number>();
/** Each user's speed per download, kbps — unset is as fast as the disk. */
const flowKbps = new Map<string, number>();
/** Segments served, per user, for the checks to read. */
const served: Array<{ user: string; seg: string; at: number; heldMs: number; part?: string; bytes?: number; ms?: number }> = [];

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
  if (p === "/api/test/flow") {
    const who = url.searchParams.get("user") ?? "u-host";
    const kbps = Number(url.searchParams.get("kbps") ?? 0);
    if (kbps > 0) flowKbps.set(who, kbps);
    else flowKbps.delete(who);
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
    stallUntil.clear(); paceMs.clear(); nextSlot.clear(); flowKbps.clear(); served.length = 0;
    p2pOn = url.searchParams.get("p2p") !== "0";
    streamDir = url.searchParams.get("stream") === "copy" ? COPY_STREAM : SMALL_STREAM;
    partsOn = url.searchParams.get("parts") !== "0";
    return json(res, { ok: true, p2p: p2pOn, stream: path.basename(streamDir), parts: partsOn });
  }
  if (p === "/api/test/served") return json(res, served);

  if (p === "/api/plex/config") return json(res, { vpsRelay: false });
  if (p === "/api/plex/played-threshold") return json(res, { threshold: 0.9 });
  if (p.startsWith("/api/plex/meta/")) return json(res, meta(p.split("/").pop()!));
  if (p.startsWith("/api/plex/siblings/")) return json(res, { episode: false, prev: null, next: null });

  // The stream: a media playlist straight away, as a copy of Plex's would be.
  if (/^\/api\/plex\/hls\/[^/]+\/[^/]+\/master\.m3u8$/.test(p)) {
    const playlist = fs.readFileSync(path.join(streamDir, "index.m3u8"), "utf8")
      .replace(/^(seg\d+\.ts)$/gm, (name) => partsOn
        ? `/api/test/stream/${name}?n=${fs.statSync(path.join(streamDir, name)).size}`
        : `/api/test/stream/${name}`);
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
    const file = path.join(streamDir, seg[1]);
    if (!fs.existsSync(file)) return json(res, { error: "no such segment" }, 404);
    // The bot's answers: a part, the rest of one from a byte on, or the lot.
    const whole = fs.readFileSync(file);
    let body = whole;
    let status = 200;
    const headers: Record<string, string | number> = { "Content-Type": "video/mp2t" };
    const parts = url.searchParams.get("parts");
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (parts) {
      const n = Number(parts);
      const i = Number(url.searchParams.get("part"));
      body = whole.subarray(Math.floor((whole.length * i) / n), Math.floor((whole.length * (i + 1)) / n));
    } else if (range) {
      const from = Number(range[1]);
      const to = range[2] ? Number(range[2]) : whole.length - 1;
      body = whole.subarray(from, to + 1);
      status = 206;
      headers["Content-Range"] = `bytes ${from}-${to}/${whole.length}`;
    }
    headers["Content-Length"] = body.length;
    res.writeHead(status, headers);
    // At this user's speed per download, if they have one.
    const kbps = flowKbps.get(who);
    const sentFrom = Date.now();
    const chunk = 16_384;
    for (let at = 0; at < body.length && !res.destroyed; at += chunk) {
      const piece = body.subarray(at, at + chunk);
      if (kbps) {
        const due = sentFrom + ((at + piece.length) * 8) / kbps;
        if (due > Date.now()) await new Promise((r) => setTimeout(r, due - Date.now()));
      }
      if (!res.write(piece)) await new Promise((r) => res.once("drain", r));
    }
    res.end();
    served.push({
      user: who, seg: seg[1], at: Date.now(), heldMs: held,
      part: parts ? `${url.searchParams.get("part")}/${parts}` : range ? `from ${range[1]}` : undefined,
      bytes: body.length, ms: Date.now() - sentFrom,
    });
    return;
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
server.listen(PORT, () => console.log(`sync-room server on http://localhost:${PORT} (streams in ${SMALL_STREAM} and ${COPY_STREAM})`));
