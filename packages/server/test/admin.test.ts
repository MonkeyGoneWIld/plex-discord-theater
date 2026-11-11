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
for (const p of ["/api/overview", "/api/live", "/api/logs", "/api/logs/files", "/api/settings", "/api/history", "/api/history/1", "/api/usage",
  "/api/requests", "/api/people", "/api/people/111", "/api/places", "/api/caches", "/api/graphs", "/api/history-file",
  "/api/export/history.csv", "/api/export/admin.sqlite", "/api/titles?keys=1", "/api/poster/1"]) {
  const res = await fetch(origin + p);
  check(`${p}: 401`, [res.status, ((await res.json()) as { error?: string }).error], [401, "Sign in first"]);
}
const unsignedTrim = await fetch(`${origin}/api/history-file/trim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{\"days\":1}" });
check("/api/history-file/trim: 401", unsignedTrim.status, 401);
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
const noHistory = await get("/api/history");
check("  without a recorder, no history, and it says so", [noHistory.status, await noHistory.json()], [503, { error: "Nothing is recorded" }]);
check("  nor graphs, files or the history file",
  [(await get("/api/graphs")).status, (await get("/api/export/history.csv")).status, (await get("/api/history-file")).status], [503, 503, 503]);
// The caches page works without the history: a seek-bar preview on disk.
fs.mkdirSync(path.join(process.env.THUMB_CACHE_DIR, "previews"), { recursive: true });
fs.writeFileSync(path.join(process.env.THUMB_CACHE_DIR, "previews", "4021-320-i2.bif"), Buffer.alloc(1234));
type Caches = { caches: Array<{ id: string; bytes: number; items: number; list: Array<{ name: string; bytes: number }> }>; discord: unknown };
const caches = (await (await get("/api/caches")).json()) as Caches;
const previews = caches.caches.find((c) => c.id === "previews");
check("  the caches, without the history: each one, and what it holds",
  [caches.caches.map((c) => c.id), previews?.items, previews?.bytes, previews?.list.map((i) => i.name), caches.discord],
  [["stream", "ffmpeg", "art", "details", "subtitles", "pgs", "previews", "fonts"], 1, 1234, ["4021-320-i2.bif"], null]);
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
const host = await join("111", "alex");
const sid = crypto.randomUUID();
rememberStreamNotes(sid, {
  engine: "ffmpeg", video: "transcode", reason: "10-bit picture: frames dropped on this player",
  kbps: 4000, audio: "transcode", audioReason: "AC3 isn't played here", range: null,
});
host({ type: "watching", value: true });
host({ type: "play", ratingKey: "58860", title: "Ghost Stories", subtitles: false, hlsSessionId: sid,
  position: 0, sessionOffset: 0, audioStreamId: 0, subtitleStreamId: 0 });
const viewer = await join("222", "robin");
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
  [["alex", "111", "host", true], ["robin", "222", "viewer", true]]);
const s = room?.streams[0];
check("  its stream: re-encoded, why, and who watches it",
  [s?.hlsSessionId, s?.decision, s?.reason, s?.viewers, s?.isHostStream],
  [sid, "transcode", "10-bit picture: frames dropped on this player", ["111", "222"], true]);
check("  in one line, the audio too",
  s?.summary, "Transcode: 10-bit picture: frames dropped on this player; audio converted (AC3 isn't played here)");
check("  the playlist's notes for the details, an empty one left out",
  [s?.notes.kbps, "range" in (s?.notes ?? {})], [4000, false]);
check("  its bitrate: the playlist's, until it has been measured, never the server's target",
  [s?.kbps, s?.kbpsSource], [4000, "playlist"]);
check("a copy, in one line", [summaryOf({ video: "copy" }), summaryOf({ video: "copy", audio: "transcode", audioReason: "AC3" })],
  ["Direct play", "Direct stream: audio converted (AC3)"]);
check("a stream whose playlist isn't made yet", summaryOf({}), "Starting: details pending");

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

console.log("\n— the history, from the live room —");
{
  const { Recorder } = await import("../src/admin/recorder.js");
  const recorder = new Recorder({ dbPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "admin-hist-")), "admin.sqlite") });
  // Posters and running times, as Plex would give them.
  const titles = {
    info: async (k: string) => (k === "58860" ? { ratingKey: k, type: "episode", title: "The Red Paper", show: "Ghost Stories", season: 1, episode: 2,
      year: null, durationS: 1440, poster: true } : null),
    poster: async (k: string) => (k === "58860" ? { type: "image/png", body: Buffer.from([1, 2, 3]) } : null),
  };
  // What Seerr says of a requested title now: declined since.
  const requestState = async (type: string, id: number) => (type === "movie" && id === 129 ? { mediaStatus: 1, requestStatus: 3 } : null);
  const withHistory = http.createServer(createAdminApp({ password: PASSWORD, distDir: emptyDist, recorder, titles, requestState }));
  await new Promise<void>((r) => withHistory.listen(0, "127.0.0.1", r));
  const at = `http://127.0.0.1:${(withHistory.address() as AddressInfo).port}`;
  const c = ((await fetch(`${at}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }) })).headers.get("set-cookie") ?? "").split(";")[0];
  const hget = (p: string) => fetch(at + p, { headers: { Cookie: c } });
  recorder.tick();
  recorder.tick(Date.now() + 2_000);
  type Plays = { plays: Array<{ id: number; title: string; guildId: string; names: string[]; streams: number; reencoded: number }> };
  const plays = (await (await hget("/api/history")).json()) as Plays;
  const p0 = plays.plays[0];
  check("the room's play, as it goes: where, who, its streams",
    [p0?.title, p0?.guildId, p0?.names, p0?.streams, p0?.reencoded], ["Ghost Stories", "999000", ["alex", "robin"], 1, 1]);
  type Play = { viewers: Array<{ username: string; watchedS: number }>; streams: Array<{ decision: string; reason: string }>; events: Array<{ kind: string }> };
  const one = (await (await hget(`/api/history/${p0?.id}`)).json()) as Play;
  check("  the whole of it: each viewer, each stream and why", [one.viewers.map((v) => v.username), one.streams.map((s) => [s.decision, s.reason])],
    [["alex", "robin"], [["transcode", "10-bit picture: frames dropped on this player"]]]);
  check("  a play there isn't", [(await hget("/api/history/999999")).status, (await hget("/api/history/abc")).status], [404, 404]);
  type Live = { rooms: Array<{ id: string; playId: number | null; clients: Array<{ userId: string; data?: { watchedS: number } }> }> };
  const liveRoom = ((await (await hget("/api/overview")).json()) as Live).rooms.find((r) => r.id === roomId);
  check("  the Now playing page: each viewer's play so far",
    [liveRoom?.playId === p0?.id, liveRoom?.clients.map((cl) => [cl.userId, typeof cl.data?.watchedS])],
    [true, [["111", "number"], ["222", "number"]]]);
  check("  and the room's delivery, for its graph", Array.isArray((liveRoom as unknown as { flow?: { points: unknown[] } })?.flow?.points), true);
  type Titles = { titles: Record<string, { show: string; durationS: number } | null> };
  const info = (await (await hget("/api/titles?keys=58860,99,abc,58860")).json()) as Titles;
  check("a title's poster and running time, by Plex item; what isn't an item is left out",
    [Object.keys(info.titles).sort(), info.titles["58860"]?.show, info.titles["58860"]?.durationS, info.titles["99"]],
    [["58860", "99"], "Ghost Stories", 1440, null]);
  const poster = await hget("/api/poster/58860");
  check("  its poster: the picture, kept by the browser for a day",
    [poster.status, poster.headers.get("content-type"), poster.headers.get("cache-control"), (await poster.arrayBuffer()).byteLength],
    [200, "image/png", "private, max-age=86400", 3]);
  check("  none for a title without one, or what isn't an item", [(await hget("/api/poster/99")).status, (await hget("/api/poster/abc")).status], [404, 404]);
  const usage = (await (await hget("/api/usage")).json()) as { usage: Array<{ kind: string; userId: string; guildId: string }> };
  check("  who came, where", usage.usage.map((u) => [u.kind, u.userId, u.guildId]).sort(), [["join", "111", "999000"], ["join", "222", "999000"]]);
  check("  and title requests, none yet", await (await hget("/api/requests")).json(), { requests: [] });
  type People = { people: Array<{ userId: string; username: string; plays: number; hosted: number }> };
  check("  everybody seen", ((await (await hget("/api/people")).json()) as People).people.map((p) => [p.userId, p.username, p.plays, p.hosted]).sort(),
    [["111", "alex", 1, 1], ["222", "robin", 1, 0]]);
  type Person = { person: { username: string }; plays: Array<{ title: string; role: string }>; places: Array<{ guildId: string; channelId: string }> };
  const person = (await (await hget("/api/people/222")).json()) as Person;
  check("  one person: what they watched, where",
    [person.person.username, person.plays.map((p) => [p.title, p.role]), person.places.map((p) => [p.guildId, p.channelId])],
    ["robin", [["Ghost Stories", "viewer"]], [["999000", "888000"]]]);
  check("  nobody by an ID never seen, or one that isn't an ID",
    [(await hget("/api/people/404")).status, (await hget("/api/people/abc")).status], [404, 404]);
  type Places = { guilds: Array<{ guildId: string; channels: Array<{ channelId: string; joins: number; plays: number }> }> };
  check("  each server and channel",
    ((await (await hget("/api/places")).json()) as Places).guilds.map((g) => [g.guildId, g.channels.map((ch) => [ch.channelId, ch.joins, ch.plays])]),
    [["999000", [["888000", 2, 1]]]]);
  type Cached = { discord: { all: { plays: number } } | null };
  check("  and the caches, with what Discord's cache handed players", ((await (await hget("/api/caches")).json()) as Cached).discord?.all.plays, 1);

  console.log("\n— graphs, files, the history file —");
  type G = { days: number; daily: unknown[]; totals: { plays: number; people: number; reencodes: number } };
  const graphs = (await (await hget("/api/graphs?days=7")).json()) as G;
  check("graphs: a week by day, and its totals", [graphs.days, graphs.daily.length, graphs.totals.plays, graphs.totals.people, graphs.totals.reencodes],
    [7, 7, 1, 2, 1]);
  check("  a period it can't use: 30 days", ((await (await hget("/api/graphs?days=soon")).json()) as G).days, 30);
  const csv = await hget("/api/export/history.csv");
  const csvBytes = Buffer.from(await csv.arrayBuffer());
  const csvLines = csvBytes.toString("utf8").replace(/^\uFEFF/, "").split("\r\n");
  check("the history as CSV: a file to save, UTF-8 with its mark, a line a play",
    [csv.status, csv.headers.get("content-type"), /^attachment; filename="theater-history-\d{8}-\d{4}\.csv"$/.test(csv.headers.get("content-disposition") ?? ""),
      csvBytes.subarray(0, 3).toString("hex"), csvLines[0].split(",").slice(0, 4), csvLines.length],
    [200, "text/csv; charset=utf-8", true, "efbbbf", ["id", "started_utc", "ended_utc", "title"], 3]);
  check("  each play's title, where, who", [csvLines[1].split(",")[3], csvLines[1].split(",")[5], csvLines[1].split(",")[11]],
    ["Ghost Stories", "999000", "alex; robin"]);
  const none = (await (await hget("/api/export/history.csv?q=nobody")).text()).split("\r\n");
  check("  honouring the list's search", none.length, 2);
  type J = { search: string | null; truncated: boolean; plays: Array<{ title: string; viewers: unknown[]; streams: Array<{ decision: string }>; events: unknown[] }> };
  const hj = (await (await hget("/api/export/history.json")).json()) as J;
  check("the history as JSON: each play whole, its viewers, streams and lines",
    [hj.search, hj.truncated, hj.plays.map((p) => [p.title, p.viewers.length, p.streams.map((s) => s.decision), p.events.length > 0])],
    [null, false, [["Ghost Stories", 2, ["transcode"], true]]]);
  check("  people, and launches and joins, too",
    [((await (await hget("/api/export/people.json")).json()) as { people: unknown[] }).people.length,
      (await (await hget("/api/export/usage.csv")).text()).split("\r\n").filter(Boolean).length],
    [2, 3]);
  recorder.request({ at: Date.now(), userId: "222", mediaType: "movie", tmdbId: 129, seasons: null, outcome: "failed", status: 500,
    error: "=HYPERLINK(\"http://evil.test\",\"x\")" });
  const rq = (await (await hget("/api/export/requests.csv")).text()).split("\r\n")[1];
  check("  text a spreadsheet would run as a formula stays text", rq.endsWith(`"'=HYPERLINK(""http://evil.test"",""x"")"`), true);
  type Asked = { requests: Array<{ tmdbId: number; current: unknown }> };
  check("a request, with what Seerr says of it now: declined since it was made",
    ((await (await hget("/api/requests")).json()) as Asked).requests.map((r) => [r.tmdbId, r.current]),
    [[129, { mediaStatus: 1, requestStatus: 3 }]]);
  check("  and on the person's page",
    ((await (await hget("/api/people/222")).json()) as Asked).requests.map((r) => r.current), [{ mediaStatus: 1, requestStatus: 3 }]);
  check("  a file it doesn't make",
    [(await hget("/api/export/nope.csv")).status, (await hget("/api/export/history.xml")).status, await (await hget("/api/export/history")).json()],
    [404, 404, { error: "No such export" }]);
  const copy = await hget("/api/export/admin.sqlite");
  const copyBytes = Buffer.from(await copy.arrayBuffer());
  check("the whole history file, to save",
    [copy.status, copy.headers.get("content-type"), /filename="theater-admin-\d{8}-\d{4}\.sqlite"/.test(copy.headers.get("content-disposition") ?? ""),
      copyBytes.subarray(0, 15).toString("latin1")],
    [200, "application/vnd.sqlite3", true, "SQLite format 3"]);
  type F = { summary: { plays: number; open: number; requests: number; bytes: number }; trim: { before: number; plays: number; requests: number } | null };
  const file = (await (await hget("/api/history-file")).json()) as F;
  check("the history file: what it holds", [file.summary.plays, file.summary.open, file.summary.requests, file.summary.bytes > 0, file.trim],
    [1, 1, 1, true, null]);
  const askedAt = Date.now();
  const preview = ((await (await hget("/api/history-file?days=1")).json()) as F).trim;
  check("  and what removing what's older than a day would remove: none of it",
    [preview && Math.abs(preview.before - (askedAt - 86_400_000)) < 5_000, { ...preview, before: 0 }],
    [true, { before: 0, plays: 0, events: 0, usage: 0, requests: 0, people: 0 }]);
  const post = (body: string) => fetch(`${at}/api/history-file/trim`, { method: "POST", headers: { Cookie: c, "Content-Type": "application/json" }, body });
  const bad = await Promise.all(["{}", "{\"days\":0}", "{\"days\":\"x\"}", "{\"days\":1.5}", "{\"days\":4000}"].map(post));
  check("removing old history: only with how many days to keep, 1 to 3650",
    [bad.map((r) => r.status), ((await bad[0].json()) as { error: string }).error], [[400, 400, 400, 400, 400], "Say how many days to keep: 1 to 3650"]);
  const logged = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  const removed = await post("{\"days\":1}");
  console.log = logged;
  const r = (await removed.json()) as { plays: number; bytesBefore: number; bytesAfter: number };
  check("  it removes what's older, keeps what is going on, and logs it",
    [removed.status, r.plays, r.bytesBefore > 0, ((await (await hget("/api/history-file")).json()) as F).summary.plays,
      lines.some((l) => l.startsWith("[Admin] History older than 1 days removed: 0 plays"))],
    [200, 0, true, 1, true]);
  withHistory.close();
  recorder.close();
}

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
check("not built: says so", [page.status, (await page.text()).includes("has not been built")], [503, true]);
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
const { adminHooks } = await import("../src/services/admin-hooks.js");
const started2 = startAdminServer(3000);
for (let i = 0; i < 40 && !started2?.server.listening; i++) await sleep(25);
const asked = await fetch(`http://127.0.0.1:${free}/api/session`).then((r) => r.json()).catch(() => null);
check("  on a port of its own otherwise, ADMIN_PORT", [started2?.server.listening, asked], [true, { signedIn: false }]);
check("  recording its history into admin.sqlite, beside the other databases",
  [started2?.recorder !== null, adminHooks.on, fs.existsSync(path.join(process.env.THUMB_CACHE_DIR!, "admin.sqlite"))], [true, true, true]);
const unsigned = await fetch(`http://127.0.0.1:${free}/api/history`);
check("  which needs signing in too", unsigned.status, 401);
started2?.close();
check("  and stops recording when it stops", adminHooks.on, false);
const { numberSetting } = await import("../src/services/env-settings.js");
process.env.ADMIN_PORT = "0";
check("  3050 unless ADMIN_PORT is a port", numberSetting("ADMIN_PORT", 3050, 1), 3050);

for (const ws of sockets) ws.terminate();
closeWebSocketServer();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
