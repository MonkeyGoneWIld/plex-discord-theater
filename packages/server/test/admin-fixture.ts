/**
 * The admin page with made-up rooms, for working on it without a bot, Plex
 * or Discord: `npm run build -w packages/client`, then `npm run dev:admin`,
 * then http://localhost:3050 (or `npm run dev:admin -w packages/client` for
 * the page itself on 5174, rebuilt on every change). The password is
 * ADMIN_PASSWORD, or "admin-fixture" when that is unset.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

process.env.THUMB_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "admin-fixture-"));
process.env.LOG_TO_FILE = "0";
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-fixture-logs-"));
process.env.LOG_DIR = logDir;
const day = new Date().toISOString().slice(0, 10);
const at = (s: number) => new Date(Date.now() - s * 1000).toISOString();
fs.writeFileSync(path.join(logDir, `theater-${day}.log`), [
  `${at(300)} [Discord] instance registered room=i-156985 guild=999000111 channel=888000111`,
  `${at(290)} [FFmpeg] copying session=1dcef3c0 ratingKey=58861 fromS=0 video=hevc hdr=SDR bits=10 audio=ac3 2ch → aac 2ch 256k`,
  `${at(288)} [Sync] a stream of their own, by what each can play room=i-156985 from=427812:0 to=427812:0/8bit who=crispymage why=hevc+tenBit`,
  `${at(287)} [FFmpeg] re-encoding session=0e9e5924 ratingKey=58861 why=10-bit picture: frames dropped on this player video=hevc → hevc Main 4000k`,
  `${at(286)} [PlexReport] showing a stream in Plex's Now Playing session=1dcef3c0 ratingKey=58861`,
  `${at(200)} [WARN] [HLS] Stop refused — others are still on this stream session=eec5874e reason=effect-cleanup`,
  `${at(120)} [ERROR] [Plex] metadata request failed status=503 path=/library/metadata/58861`,
  `${at(60)} [client:pv5xdvgb] [Buffer] stall ended stalledMs=840 bufAheadS=12.4`,
].join("\n") + "\n");
fs.writeFileSync(path.join(logDir, "theater-2026-11-09.log"), `2026-11-09T18:00:00.000Z [Sync] yesterday's line\n`);

const password = process.env.ADMIN_PASSWORD?.trim() || "admin-fixture";
const port = Number(process.env.ADMIN_PORT) || 3050;

const { createAdminApp, adminDbPath } = await import("../src/admin/server.js");
const { Recorder } = await import("../src/admin/recorder.js");
const { setAdminHooks } = await import("../src/services/admin-hooks.js");
const { rememberStreamNotes } = await import("../src/services/stream-notes.js");
const { attachWebSocketServer } = await import("../src/services/sync.js");
const { createSession } = await import("../src/middleware/auth.js");
const { instanceHosts } = await import("../src/routes/discord.js");
const { WebSocket } = await import("ws");
const { backfill } = await import("./admin-fixture-history.js");

// Its history, recorded as on a real server, into the fixture's own folder:
// six weeks of it made up first, for the graphs.
await backfill(adminDbPath(), Date.now());
const recorder = new Recorder({ dbPath: adminDbPath() });
setAdminHooks(recorder);
recorder.start();
const server = http.createServer(createAdminApp({ password, recorder }));
attachWebSocketServer(server);
await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
const origin = `http://127.0.0.1:${port}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function join(roomId: string, userId: string, username: string) {
  const token = createSession(userId, null);
  const ws = new WebSocket(`${origin.replace(/^http/, "ws")}/ws?token=${token}`);
  const seen: Array<{ type: string }> = [];
  ws.on("message", (d) => seen.push(JSON.parse(String(d))));
  await new Promise<void>((r, j) => { ws.once("open", () => r()); ws.once("error", j); });
  ws.send(JSON.stringify({ type: "join", sessionToken: token, instanceId: roomId, userId, username }));
  for (let i = 0; i < 80 && !seen.some((m) => m.type === "state"); i++) await sleep(25);
  const send = (m: Record<string, unknown>) => ws.send(JSON.stringify(m));
  send({ type: "watching", value: true });
  return send;
}

// A room on two streams of an episode: the host's 10-bit copy, and a viewer's
// own 8-bit re-encode, their player dropping 10-bit frames.
const ghosts = "i-156985-fixture";
instanceHosts.set(ghosts, { hostUserId: "131481943547052032", guildId: "999000111", channelId: "888000111", createdAt: Date.now() - 40 * 60_000 });
const copy = crypto.randomUUID();
rememberStreamNotes(copy, {
  engine: "ffmpeg", video: "copy", kbps: 3837, quality: "Original", videoFrom: "HEVC Main 10 1440x1080", range: "SDR",
  audio: "transcode", audioFrom: "AC3 2.0", audioTo: "AAC 2.0 256 kbps", audioKbps: 256, audioReason: "AC3 isn't played by Discord's browser",
});
const host = await join(ghosts, "131481943547052032", "artemidorus");
host({ type: "play", ratingKey: "58861", title: "Ghost Stories — S01E03", subtitles: false, hlsSessionId: copy,
  position: 312, sessionOffset: 0, audioStreamId: 0, subtitleStreamId: 0 });
await join(ghosts, "402115789012345678", "u7i5lj6g");
await join(ghosts, "402115789012345679", "oyv7oikp");
const crispy = await join(ghosts, "402115789012345680", "crispymage");
crispy({ type: "set-tracks", audioStreamId: 1, subtitleStreamId: 0 });
const encode = crypto.randomUUID();
rememberStreamNotes(encode, {
  engine: "ffmpeg", encoder: "qsv", video: "transcode", reason: "10-bit picture: frames dropped on this player",
  kbps: 4000, allowed: 20000, quality: "Original", videoFrom: "HEVC Main 10 1440x1080", range: "SDR",
  audio: "copy", audioFrom: "AAC 2.0",
});
await sleep(100);
crispy({ type: "variant-session", hlsSessionId: encode, sessionOffset: 0 });

// A film, everyone on one copy.
const film = "i-204417-fixture";
instanceHosts.set(film, { hostUserId: "200000000000000001", guildId: "777000222", channelId: "666000222", createdAt: Date.now() - 55 * 60_000 });
const filmCopy = crypto.randomUUID();
rememberStreamNotes(filmCopy, {
  fallback: "", video: "copy", kbps: 18450, quality: "Original", videoFrom: "H.264 High 1920x1080", range: "SDR", audio: "copy", audioFrom: "AAC 5.1",
});
const filmHost = await join(film, "200000000000000001", "nightowl");
filmHost({ type: "play", ratingKey: "173951", title: "The Long Goodbye", subtitles: false, hlsSessionId: filmCopy,
  position: 4210, sessionOffset: 0, audioStreamId: 0, subtitleStreamId: 0 });
await join(film, "200000000000000002", "marlowe");
filmHost({ type: "pause" });

// An Activity opened with nothing chosen yet.
const idle = "i-310021-fixture";
instanceHosts.set(idle, { hostUserId: "300000000000000001", guildId: "555000333", channelId: "444000333", createdAt: Date.now() - 2 * 60_000 });
await join(idle, "300000000000000001", "lurker");

// Each viewer's player, saying every 10 seconds what it has had: some from
// the bot, some from Discord's cache, some from other viewers.
const viewers = ["131481943547052032", "402115789012345678", "402115789012345679", "402115789012345680", "200000000000000001", "200000000000000002"];
let sampled = 0;
const feed = () => {
  sampled++;
  viewers.forEach((userId, i) => {
    const mb = sampled * (3 + i);
    recorder.clientLog({ at: Date.now(), userId, clientId: `fixture${i}`, entries: [{
      t: Date.now(), level: "LOG", tag: "Health", msg: "sample",
      data: { session: "fixture", httpMB: mb, p2pMB: i % 2 ? mb / 3 : 0, edgeHitMB: (mb * 0.4).toFixed(1), edgeMB: (mb * 0.9).toFixed(1) },
    }] });
  });
  if (sampled === 3) {
    const t = Date.now();
    recorder.clientLog({ at: t, userId: "402115789012345680", clientId: "fixture3", entries: [
      { t: t - 4_000, level: "WARN", tag: "Video", msg: "waiting (buffer starved)", data: { posS: 340, paused: false, seeking: false } },
      { t: t - 1_600, level: "LOG", tag: "Video", msg: "playing", data: { posS: 340, paused: false, seeking: false } },
    ] });
  }
};
setTimeout(feed, 3_000);
setInterval(feed, 10_000);

// For the Requests and Caches pages: a few requests, and files in the caches.
recorder.request({ at: Date.now() - 30 * 60_000, userId: "402115789012345678", mediaType: "movie", tmdbId: 129,
  seasons: null, outcome: "requested", status: 2, error: null, title: Promise.resolve("Spirited Away") });
recorder.request({ at: Date.now() - 12 * 60_000, userId: "402115789012345679", mediaType: "tv", tmdbId: 95396,
  seasons: [1, 2], outcome: "already requested", status: 409, error: null, title: Promise.resolve("Severance") });
recorder.request({ at: Date.now() - 2 * 60_000, userId: "200000000000000002", mediaType: "tv", tmdbId: 1399,
  seasons: "all", outcome: "failed", status: 500, error: "Seerr: no Sonarr server is set up", title: Promise.resolve("Game of Thrones") });
const cacheDir = process.env.THUMB_CACHE_DIR!;
fs.mkdirSync(path.join(cacheDir, "previews"), { recursive: true });
fs.writeFileSync(path.join(cacheDir, "previews", "123456-320-i2.bif"), Buffer.alloc(3_400_000));
fs.mkdirSync(path.join(cacheDir, "subtitles-pgs"), { recursive: true });
fs.writeFileSync(path.join(cacheDir, "subtitles-pgs", "58860-7.sup"), Buffer.alloc(820_000));
console.log(`Admin fixture on http://localhost:${port} (password: ADMIN_PASSWORD, or the fixture's default)`);
