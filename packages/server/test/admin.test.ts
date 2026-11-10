/**
 * The admin page's server (admin/server.ts): signing in, nothing had without
 * it, the rooms it shows live and why each stream is what it is, the logs and
 * settings, and the secrets it never shows.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

process.env.THUMB_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "admin-test-"));
process.env.LOG_TO_FILE = "0";
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-logs-"));
process.env.LOG_DIR = logDir;
const PASSWORD = "correct horse battery";
const PLEX_TOKEN = "plex-token-never-shown-1234";
process.env.PLEX_TOKEN = PLEX_TOKEN;
process.env.PLEX_URL = "http://plexuser:plexpass@127.0.0.1:9/?X-Plex-Token=url-token-never-shown";
process.env.ADMIN_PASSWORD = PASSWORD;

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       expected ${e}\n       got      ${a}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

fs.writeFileSync(path.join(logDir, "theater-2026-11-10.log"), [
  "2026-11-10T23:12:18.639Z [PlexReport] showing a stream in Plex's Now Playing session=644e8377 ratingKey=58859",
  "2026-11-10T23:12:19.000Z [WARN] [HLS] Stop refused — others are still on this stream session=eec5874e",
  "2026-11-10T23:12:20.000Z [ERROR] [FFmpeg] run failed session=3552164a url=http://plex/x?X-Plex-Token=leaked-in-a-log",
  "2026-11-10T23:12:21.000Z [Auth] header Authorization: Bearer abc.def.ghi",
  "2026-11-10T23:12:22.000Z [client:pv5xdvgb] [Buffer] stall ended stalledMs=840",
  "a line from something else",
].join("\n") + "\n");
fs.writeFileSync(path.join(logDir, "notes.txt"), "not a log\n");

const { createAdminApp, startAdminServer } = await import("../src/admin/server.js");
const { AdminSessions, cookieToken } = await import("../src/admin/auth.js");
const { summaryOf } = await import("../src/admin/data.js");
const { rememberStreamNotes } = await import("../src/services/stream-notes.js");
const { attachWebSocketServer, closeWebSocketServer } = await import("../src/services/sync.js");
const { createSession } = await import("../src/middleware/auth.js");
const { instanceHosts } = await import("../src/routes/discord.js");
const { WebSocket } = await import("ws");

const emptyDist = fs.mkdtempSync(path.join(os.tmpdir(), "admin-dist-"));
const app = createAdminApp({ password: PASSWORD, distDir: emptyDist, loginsPer15Min: 6, liveEveryMs: 50 });
const server = http.createServer(app);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const login = (password: string) => fetch(`${origin}/api/login`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }),
});

console.log("\n— nothing without signing in —");
for (const p of ["/api/overview", "/api/live", "/api/logs", "/api/logs/files", "/api/settings"]) {
  const res = await fetch(origin + p);
  check(`${p}: 401`, [res.status, ((await res.json()) as { error?: string }).error], [401, "Sign in first"]);
}
const wrong = await login("not it");
check("a wrong password: 401 and no cookie", [wrong.status, wrong.headers.get("set-cookie")], [401, null]);
const forged = await fetch(`${origin}/api/overview`, { headers: { Cookie: `pdt_admin=${"a".repeat(64)}` } });
check("a cookie it never gave: 401", forged.status, 401);

console.log("\n— signing in —");
const right = await login(PASSWORD);
const setCookie = right.headers.get("set-cookie") ?? "";
check("the password: 200, an HttpOnly, SameSite=Strict session cookie, not Secure over plain HTTP",
  [right.status, /^pdt_admin=[0-9a-f]{64};/.test(setCookie), /HttpOnly/.test(setCookie), /SameSite=Strict/.test(setCookie), /Secure/.test(setCookie)],
  [200, true, true, true, false]);
const cookie = setCookie.split(";")[0];
const get = (p: string) => fetch(origin + p, { headers: { Cookie: cookie } });
check("  and the page knows it is signed in", await (await get("/api/session")).json(), { signedIn: true });
const noStore = (await get("/api/overview")).headers.get("cache-control");
check("  the API's answers are never cached", noStore, "no-store");

console.log("\n— a room, live —");
// A room as the Activity makes one: its host, a viewer, a stream whose
// playlist said it is re-encoded and why.
attachWebSocketServer(server);
const roomId = `admin-${crypto.randomUUID()}`;
instanceHosts.set(roomId, { hostUserId: "111", guildId: "999000", channelId: "888000", createdAt: 1_700_000_000_000 });
const sockets: InstanceType<typeof WebSocket>[] = [];
async function join(userId: string, username: string) {
  const token = createSession(userId, null);
  const ws = new WebSocket(`${origin.replace(/^http/, "ws")}/ws?token=${token}`);
  sockets.push(ws);
  const seen: Array<{ type: string }> = [];
  ws.on("message", (d) => seen.push(JSON.parse(String(d))));
  await new Promise<void>((r, j) => { ws.once("open", () => r()); ws.once("error", j); });
  ws.send(JSON.stringify({ type: "join", sessionToken: token, instanceId: roomId, userId, username }));
  for (let i = 0; i < 80 && !seen.some((m) => m.type === "state"); i++) await sleep(25);
  return (m: Record<string, unknown>) => ws.send(JSON.stringify(m));
}
const host = await join("111", "artemidorus");
const sid = crypto.randomUUID();
rememberStreamNotes(sid, {
  engine: "ffmpeg", video: "transcode", reason: "10-bit picture: frames dropped on this player",
  kbps: 4000, audio: "transcode", audioReason: "AC3 isn't played here", range: null,
});
host({ type: "watching", value: true });
host({ type: "play", ratingKey: "58860", title: "Ghost Stories", subtitles: false, hlsSessionId: sid,
  position: 0, sessionOffset: 0, audioStreamId: 0, subtitleStreamId: 0 });
const viewer = await join("222", "crispymage");
viewer({ type: "watching", value: true });
type Overview = {
  totals: Record<string, number>;
  rooms: Array<{
    id: string; title: string | null; discord: Record<string, unknown>;
    clients: Array<{ userId: string; username: string; role: string; watching: boolean }>;
    streams: Array<{ hlsSessionId: string; decision: string; reason: string; summary: string; viewers: string[]; isHostStream: boolean; notes: Record<string, unknown> }>;
  }>;
};
let room: Overview["rooms"][number] | undefined;
for (let i = 0; i < 80; i++) {
  const o = (await (await get("/api/overview")).json()) as Overview;
  room = o.rooms.find((r) => r.id === roomId);
  if (room?.streams[0]?.viewers.length === 2) break;
  await sleep(25);
}
check("the room: its title, and where in Discord it is",
  [room?.title, room?.discord.guildId, room?.discord.channelId, room?.discord.hostUserId],
  ["Ghost Stories", "999000", "888000", "111"]);
check("  who is in it, by name, Discord id and role",
  room?.clients.map((c) => [c.username, c.userId, c.role, c.watching]),
  [["artemidorus", "111", "host", true], ["crispymage", "222", "viewer", true]]);
const s = room?.streams[0];
check("  its stream: re-encoded, why, and who watches it",
  [s?.hlsSessionId, s?.decision, s?.reason, s?.viewers, s?.isHostStream],
  [sid, "transcode", "10-bit picture: frames dropped on this player", ["111", "222"], true]);
check("  in one line, the audio too",
  s?.summary, "Re-encoded: 10-bit picture: frames dropped on this player; audio converted (AC3 isn't played here)");
check("  the playlist's notes for the details, an empty one left out",
  [s?.notes.kbps, "range" in (s?.notes ?? {})], [4000, false]);
check("a copy, in one line", summaryOf({ video: "copy" }), "Direct copy");
check("a stream whose playlist isn't made yet", summaryOf({}), "Starting — no details yet");

const live = await fetch(`${origin}/api/live`, { headers: { Cookie: cookie } });
const reader = live.body!.getReader();
let text = "";
const started = Date.now();
while (Date.now() - started < 3000 && (text.match(/^data: /gm) ?? []).length < 2) {
  const { value, done } = await reader.read();
  if (done) break;
  text += new TextDecoder().decode(value);
}
await reader.cancel();
const events = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as Overview);
check("the live feed: an event stream, the rooms again and again",
  [live.headers.get("content-type"), events.length >= 2, events[0]?.rooms.some((r) => r.id === roomId)],
  ["text/event-stream", true, true]);

console.log("\n— logs —");
const files = (await (await get("/api/logs/files")).json()) as { files: Array<{ name: string }> };
check("only the bot's own log files are listed", files.files.map((f) => f.name), ["theater-2026-11-10.log"]);
type Logs = { lines: Array<{ level: string; tag: string | null; text: string; at: string | null }>; matched: number; scanned: number };
const all = (await (await get("/api/logs?file=theater-2026-11-10.log")).json()) as Logs;
check("every line, its level and tag read off it, a player's its own tag", all.lines.map((l) => [l.level, l.tag, l.client]),
  [["info", "PlexReport", null], ["warn", "HLS", null], ["error", "FFmpeg", null], ["info", "Auth", null],
    ["info", "Buffer", "pv5xdvgb"], ["info", null, null]]);
check("  a token in a line is never shown", [JSON.stringify(all).includes("leaked-in-a-log"), JSON.stringify(all).includes("abc.def.ghi")], [false, false]);
const warn = (await (await get("/api/logs?level=warn")).json()) as Logs;
check("warnings and errors: the newest file by default", warn.lines.map((l) => l.tag), ["HLS", "FFmpeg"]);
const found = (await (await get("/api/logs?q=EEC5874E")).json()) as Logs;
check("a search, whatever the case", [found.matched, found.scanned, found.lines[0]?.tag], [1, 6, "HLS"]);
const tagged = (await (await get("/api/logs?tag=plexreport")).json()) as Logs;
check("by tag", tagged.lines.map((l) => l.text.slice(0, 7)), ["showing"]);
const last = (await (await get("/api/logs?limit=2")).json()) as Logs;
check("the last few lines", last.lines.map((l) => l.tag), ["Buffer", null]);
for (const bad of ["../../../etc/passwd", "notes.txt", "theater-2026-11-10.log/../x", "..%2Fnotes.txt"]) {
  const res = await get(`/api/logs?file=${encodeURIComponent(bad)}`);
  check(`no file but the bot's logs: ${bad}`, res.status, 404);
}

console.log("\n— settings —");
const settingsText = await (await get("/api/settings")).text();
const settings = JSON.parse(settingsText) as { settings: Array<{ name: string; set: boolean; value: string | null; secret: boolean }>; system: Record<string, unknown> };
const named = (n: string) => settings.settings.find((x) => x.name === n);
check("every setting the server reads, set or not", ["PLEX_URL", "PLEX_TOKEN", "ADMIN_PORT", "FFMPEG_REPORT_TO_PLEX"].map((n) => !!named(n)), [true, true, true, true]);
check("  a secret: only that it is set", named("PLEX_TOKEN"), { name: "PLEX_TOKEN", set: true, value: `set · ${PLEX_TOKEN.length} characters`, secret: true });
check("  a URL: without its credentials or token", named("PLEX_URL")?.value, "http://<redacted>@127.0.0.1:9/?X-Plex-Token=<redacted>");
check("  never the password, the token, or a URL's credentials anywhere",
  [PASSWORD, PLEX_TOKEN, "plexpass", "url-token-never-shown"].map((v) => settingsText.includes(v)), [false, false, false, false]);
check("  the system: its Node.js and uptime", [settings.system.node, typeof settings.system.uptimeS], [process.version, "number"]);

console.log("\n— the page —");
const page = await fetch(`${origin}/`);
check("not built: says so", [page.status, (await page.text()).includes("isn't built")], [503, true]);
const unknown = await get("/api/nothing");
check("an API path that isn't one: 404", unknown.status, 404);
const built = fs.mkdtempSync(path.join(os.tmpdir(), "admin-built-"));
fs.writeFileSync(path.join(built, "index.html"), "<!doctype html><title>Theater admin</title>");
const builtServer = http.createServer(createAdminApp({ password: PASSWORD, distDir: built }));
await new Promise<void>((r) => builtServer.listen(0, "127.0.0.1", r));
const builtOrigin = `http://127.0.0.1:${(builtServer.address() as AddressInfo).port}`;
const deep = await fetch(`${builtOrigin}/logs`);
check("built: the page at any path, framed by nobody",
  [deep.status, (await deep.text()).includes("Theater admin"), deep.headers.get("x-frame-options"),
    /frame-ancestors 'none'/.test(deep.headers.get("content-security-policy") ?? "")],
  [200, true, "SAMEORIGIN", true]);
builtServer.close();

console.log("\n— signing out, sessions ending, guessing —");
const out = await fetch(`${origin}/api/logout`, { method: "POST", headers: { Cookie: cookie } });
check("signing out clears the cookie", /Max-Age=0/.test(out.headers.get("set-cookie") ?? ""), true);
check("  and the session is gone", (await get("/api/overview")).status, 401);
let clock = 0;
const sessions = new AdminSessions(() => clock, 1000);
const t = sessions.create();
clock = 999;
const before = sessions.valid(t);
clock = 1000;
check("a session lasts its time and no longer", [before, sessions.valid(t), sessions.size], [true, false, 0]);
const req = (c: string) => ({ headers: { cookie: c } }) as Parameters<typeof cookieToken>[0];
check("a cookie is read only as one of its own tokens",
  [cookieToken(req(`a=1; pdt_admin=${"b".repeat(64)}`)), cookieToken(req("pdt_admin=../../x")), cookieToken(req(""))],
  ["b".repeat(64), null, null]);
// 6 a window: 1 wrong and 1 right above, then these.
const tries: number[] = [];
for (let i = 0; i < 5; i++) tries.push((await login("guess")).status);
check("sign-in attempts are limited", tries, [401, 401, 401, 401, 429]);

console.log("\n— starting it —");
delete process.env.ADMIN_PASSWORD;
check("off without ADMIN_PASSWORD", startAdminServer(3000), null);
process.env.ADMIN_PASSWORD = "   ";
check("  or with a blank one", startAdminServer(3000), null);
process.env.ADMIN_PASSWORD = PASSWORD;
process.env.ADMIN_PORT = "3000";
check("off on the Activity's own port", startAdminServer(3000), null);
// A port nothing has, as ADMIN_PORT.
const probe = http.createServer();
await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
const free = (probe.address() as AddressInfo).port;
await new Promise((r) => probe.close(r));
process.env.ADMIN_PORT = String(free);
process.env.ADMIN_HOST = "127.0.0.1";
const started2 = startAdminServer(3000);
for (let i = 0; i < 40 && !started2?.listening; i++) await sleep(25);
const asked = await fetch(`http://127.0.0.1:${free}/api/session`).then((r) => r.json()).catch(() => null);
check("  on a port of its own otherwise, ADMIN_PORT", [started2?.listening, asked], [true, { signedIn: false }]);
started2?.close();
const { numberSetting } = await import("../src/services/env-settings.js");
process.env.ADMIN_PORT = "0";
check("  3050 unless ADMIN_PORT is a port", numberSetting("ADMIN_PORT", 3050, 1), 3050);

for (const ws of sockets) ws.terminate();
closeWebSocketServer();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
