/**
 * The admin page's history (admin/recorder.ts): a play of a title in a room,
 * from its start to its end; who watched it, for how long, and what data each
 * got from the bot, Discord's cache and other viewers; their buffering and
 * errors; every stream it made, why, and each restart; what each viewer
 * changed; who launched the Activity where; who asked for which title. And
 * that the rooms, the players' logs and Seerr requests reach it.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

process.env.THUMB_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "admin-rec-test-"));
process.env.LOG_TO_FILE = "0";
process.env.LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "admin-rec-logs-"));
process.env.PLEX_TOKEN = "test-token";
process.env.SEERR_URL = "http://seerr.test";
process.env.PLEX_URL = "http://127.0.0.1:9";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       expected ${e}\n       got      ${a}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { Recorder, flowSeries } = await import("../src/admin/recorder.js");
const { zoneClock } = await import("../src/admin/zone.js");
const { setAdminHooks, adminHooks } = await import("../src/services/admin-hooks.js");
type Overview = import("../src/admin/data.js").Overview;
type Inst = { hostUserId: string; guildId: string | null; channelId: string | null; createdAt: number };
const Database = (await import("better-sqlite3")).default;

// ─── A room as the Now playing page has it, made up ──────────────
let t = 1_800_000_000_000;
type Any = Record<string, unknown>;
const client = (userId: string, username: string, o: Any = {}) => ({
  userId, username, role: "viewer", connected: true, watching: true, away: false, loading: false,
  joinedAt: t, variantKey: "v0", subtitleStreamId: 0, quality: 0, caps: [], av1Encode: false, ...o,
});
const stream = (variantKey: string, hlsSessionId: string, o: Any = {}) => ({
  variantKey, hlsSessionId, audioStreamId: 1, subtitleStreamId: 0, quality: 0, ownerUserId: null,
  sessionOffset: 0, idleS: null, viewers: [] as string[], isHostStream: variantKey === "v0", engine: "ffmpeg",
  decision: null, reason: null, summary: "Starting: details pending", kbps: null, kbpsSource: null,
  plexTranscodeKey: null, plexClientId: null, notes: {}, notesAt: null, ...o,
});
const R1: Any = {
  id: "R1", ratingKey: "58860", title: "Ghost Stories", playing: true, positionS: 0, waiting: false,
  hostWaiting: false, stateAgeS: 0, hostHeartbeatAgeS: 0, hostVariantKey: "v0", hostSubtitleId: 0, coHostIds: [],
  queue: [], heldFor: null, away: [],
  discord: { guildId: "G1", channelId: "C1", hostUserId: "111", startedAt: t },
  clients: [client("111", "alex", { role: "host" })],
  streams: [stream("v0", "S1", { viewers: ["111"] })],
};
let rooms: Any[] = [];
const source = () => ({ at: t, totals: {}, rooms }) as unknown as Overview;
const instances = new Map<string, Inst>([["OLD", { hostUserId: "999", guildId: "G0", channelId: "C0", createdAt: t - 5_000 }]]);

const dbPath = path.join(process.env.THUMB_CACHE_DIR, "admin.sqlite");
const rec = new Recorder({ dbPath, now: () => t, source, instances: () => instances });
const started = t;
const transport = (o: Any) => rec.transport({
  at: t, roomId: "R1", type: "play", userId: "111", username: "alex", role: "host", fromS: 0, toS: 0,
  ratingKey: "58860", title: "Ghost Stories", ...o,
} as Parameters<typeof rec.transport>[0]);
const step = (ms: number) => { t += ms; rec.tick(t); };
const kinds = (playId: number) => rec.play(playId)!.events.map((e) => e.kind);
const eventsOf = (playId: number, kind: string) => rec.play(playId)!.events.filter((e) => e.kind === kind);

console.log("\n— a launch, and a play starting —");
instances.set("R1", { hostUserId: "111", guildId: "G1", channelId: "C1", createdAt: t + 10 });
t += 60_000;
transport({ type: "play" });
rooms = [R1];
rec.tick(t);
const usage0 = rec.usage();
check("a launch of the Activity is logged once, with its server, channel and host; one from before the recorder isn't",
  usage0.filter((u) => u.kind === "launch").map((u) => [u.roomId, u.guildId, u.channelId, u.userId]),
  [["R1", "G1", "C1", "111"]]);
check("  and the host's joining the room, by name",
  usage0.filter((u) => u.kind === "join").map((u) => [u.userId, u.username, u.guildId]), [["111", "alex", "G1"]]);
const play1 = rec.history()[0];
check("the host's play opens a play of the title, where it is in Discord",
  [play1.title, play1.ratingKey, play1.roomId, play1.guildId, play1.channelId, play1.hostUserId, play1.endedAt],
  ["Ghost Stories", "58860", "R1", "G1", "C1", "111", null]);
check("  with what happened, in order", kinds(play1.id), ["play", "joined", "stream started"]);

console.log("\n— watching, and a viewer joining —");
step(2_000);
(R1.clients as Any[]).push(client("222", "robin"));
(R1.streams as Any[])[0] = stream("v0", "S1", { viewers: ["111", "222"] });
step(2_000);
check("watched time counts while the room plays", rec.play(play1.id)!.viewers.map((v) => [v.userId, v.watchedS]),
  [["111", 4], ["222", 0]]);
R1.playing = false;
step(4_000);
check("  and not while it is paused", rec.play(play1.id)!.viewers.map((v) => v.watchedS), [4, 0]);
R1.playing = true;
step(4_000);
check("  each viewer's own", rec.play(play1.id)!.viewers.map((v) => v.watchedS), [8, 4]);
check("the most watching at once", rec.history()[0].peakViewers, 2);

console.log("\n— a stream's details, its restarts —");
(R1.streams as Any[])[0] = stream("v0", "S1", {
  viewers: ["111", "222"], decision: "transcode", reason: "10-bit picture: frames dropped on this player",
  summary: "Transcode: 10-bit picture: frames dropped on this player", kbps: 4000,
  notes: { engine: "ffmpeg", video: "transcode", reason: "10-bit picture: frames dropped on this player" }, notesAt: t,
});
step(2_000);
const s1 = rec.play(play1.id)!.streams[0];
check("why a stream is re-encoded, when its playlist says", [s1.hlsSessionId, s1.decision, s1.reason, s1.kbps, s1.notes.video],
  ["S1", "transcode", "10-bit picture: frames dropped on this player", 4000, "transcode"]);
check("  and the line saying it started says it too",
  (eventsOf(play1.id, "stream started")[0].detail as Any).summary, "Transcode: 10-bit picture: frames dropped on this player");
(R1.streams as Any[])[0] = { ...(R1.streams as Any[])[0], sessionOffset: 600 };
R1.positionS = 600;
step(2_000);
check("a stream started again further on, after a seek",
  eventsOf(play1.id, "stream restarted").map((e) => [(e.detail as Any).fromOffsetS, (e.detail as Any).toOffsetS]), [[0, 600]]);

console.log("\n— what a viewer changes —");
(R1.clients as Any[])[1] = client("222", "robin", { subtitleStreamId: 3, quality: 2, variantKey: "v1" });
(R1.streams as Any[])[0] = { ...(R1.streams as Any[])[0], viewers: ["111"] };
(R1.streams as Any[])[1] = stream("v1", "S2", { ownerUserId: "222", audioStreamId: 2, subtitleStreamId: 3, viewers: ["222"] });
step(2_000);
check("their stream, subtitles and quality, each from what to what",
  rec.play(play1.id)!.events.filter((e) => e.userId === "222" && ["stream changed", "subtitles", "quality"].includes(e.kind))
    .map((e) => [e.kind, (e.detail as Any).from, (e.detail as Any).to]),
  [["stream changed", "v0", "v1"], ["subtitles", 0, 3], ["quality", 0, 2]]);
check("  and the stream of their own that it made, by whom", eventsOf(play1.id, "stream started").map((e) => [(e.detail as Any).variant, e.username]),
  [["v0", null], ["v1", "robin"]]);
(R1.streams as Any[])[1] = stream("v1", "S3", { ownerUserId: "222", viewers: ["222"] });
step(2_000);
check("a stream back under a new session is a restart, not an end",
  [eventsOf(play1.id, "stream restarted").map((e) => (e.detail as Any).replaced ?? null), eventsOf(play1.id, "stream ended").length],
  [[null, "S2"], 0]);
check("  and the old session's row is ended", rec.play(play1.id)!.streams.map((s) => [s.hlsSessionId, s.endedAt !== null]),
  [["S1", false], ["S2", true], ["S3", false]]);

console.log("\n— what each player got, and from where —");
const health = (o: Any, at: number) => ({ t: at, level: "LOG", tag: "Health", msg: "sample", data: { session: "S3", ...o } });
rec.clientLog({ at: t, userId: "222", clientId: "pageA", entries: [
  health({ httpMB: 4, p2pMB: 1, edge: "3/4 HIT", edgeHitMB: "1.0", edgeMB: "3.0" }, t),
  health({ httpMB: 10, p2pMB: 3, edgeHitMB: "4.0", edgeMB: "8.0" }, t + 10_000),
  // A new player (another stream): its counters start again, Discord's cache's too.
  health({ session: "S9", httpMB: 2, p2pMB: 0, edgeHitMB: "0.0", edgeMB: "1.0" }, t + 20_000),
] });
// The host's player was playing before the recorder began: its first sample
// only says where its counters stand.
rec.clientLog({ at: t, userId: "111", clientId: "pageH", entries: [
  health({ session: "S1", httpMB: 500, p2pMB: 0 }, started + 5_000),
  health({ session: "S1", httpMB: 502, p2pMB: 0 }, started + 15_000),
] });
step(2_000);
const v222 = rec.play(play1.id)!.viewers.find((v) => v.userId === "222")!;
check("a viewer's data, by the change in their player's counters, across a new player",
  [v222.httpBytes, v222.p2pBytes, v222.edgeBytes, v222.edgeHitBytes, v222.botBytes], [12e6, 3e6, 9e6, 4e6, 8e6]);
const v111 = rec.play(play1.id)!.viewers.find((v) => v.userId === "111")!;
check("  a player from before the recorder: only what came after", v111.httpBytes, 2e6);

console.log("\n— buffering and errors —");
const video = (msg: string, at: number, o: Any = {}) => ({ t: at, level: msg.startsWith("waiting") ? "WARN" : "LOG", tag: "Video", msg,
  data: { posS: 640, paused: false, seeking: false, ...o } });
// A batch's lines are from the seconds before it came.
const b = t - 12_000;
rec.clientLog({ at: t, userId: "222", clientId: "pageA", entries: [
  // Playing since they joined, six and a half seconds before: what follows
  // is a stall, not the start loading.
  video("playing", b - 5_000),
  video("waiting (buffer starved)", b + 500),
  video("playing", b + 2_000),
  video("waiting (buffer starved)", b + 5_000, { seeking: true }),
  video("playing", b + 5_800),
  video("waiting (buffer starved)", b + 7_000, { paused: true }),
  video("playing", b + 9_000),
  video("waiting (buffer starved)", b + 10_000),
  video("playing", b + 10_100),
  { t: b + 11_000, level: "ERROR", tag: "HLS", msg: "fatal network error", data: { posS: 650 } },
] });
step(2_000);
const v222b = rec.play(play1.id)!.viewers.find((v) => v.userId === "222")!;
check("a stall is counted with how long it lasted; loading after a seek, a pause or a blink isn't",
  [v222b.stalls, v222b.stalledMs, v222b.errors], [1, 1500, 1]);
check("  each is in the history", rec.play(play1.id)!.events
  .filter((e) => ["buffering", "loaded after seek", "player error"].includes(e.kind))
  .map((e) => [e.kind, e.posS, (e.detail as Any).ms ?? (e.detail as Any).msg]),
  [["buffering", 640, 1500], ["loaded after seek", 640, 800], ["player error", 650, "fatal network error"]]);

console.log("\n— live, on the Now playing page —");
const ov = rec.annotate({ at: t, totals: {}, rooms: [structuredClone(R1)] } as unknown as Overview);
const live222 = ov.rooms[0].clients.find((c) => c.userId === "222")?.data;
check("each viewer's play so far", [ov.rooms[0].playId, live222?.httpBytes, live222?.botBytes, live222?.stalls, live222?.watchedS],
  [play1.id, 12e6, 8e6, 1, 16]);
const flow = ov.rooms[0].flow;
check("  and the room's delivery over the last minutes: a point every 10 s, the server, Discord's cache and peers each",
  [flow?.stepS, flow?.windowS, (flow?.points.length ?? 0) > 0, flow?.points.every((p) => p.length === 4 && p.every((n) => n >= 0))],
  [10, 30, true, true]);
{
  // 11 November: "Streams held for viewers who left moments ago:
  // <their Discord ID> (<stream key>)". Who left is not among the room's clients.
  const empty = structuredClone(R1);
  empty.clients = [];
  empty.held = true;
  empty.heldFor = { hostUserId: "111", guildId: "G1", channelId: "C1" };
  empty.away = [{ userId: "222", ratingKey: "58860", variantKey: "v1", quality: 0 }, { userId: "404", ratingKey: "58860", variantKey: "v2", quality: 0 }];
  const names = rec.annotate({ at: t, totals: {}, rooms: [empty] } as unknown as Overview).rooms[0].names;
  check("  and the names of those who have left it: its host, and who a stream is kept for (nobody it never saw)",
    names, { 111: "alex", 222: "robin" });
  check("  nobody named twice: those in the room have their names there", ov.rooms[0].names, {});
}
{
  // 1 Mbps from the server and 2 Mbps from Discord's cache, said every 10 s.
  const base = 1_800_000_000_000;
  const samples = [0, 10, 20, 30, 40].map((s) => ({ t: base + s * 1000, bot: s * 125_000, hit: s * 250_000, p2p: 0 }));
  const series = flowSeries(samples, base + 43_000).points;
  check("  a rate is the change in what players have had, averaged over half a minute",
    [series.length, series[0], series[series.length - 1]],
    [5, [base, 0, 0, 0], [base + 40_000, 1_000_000, 2_000_000, 0]]);
  check("  nothing said yet: no points", flowSeries([], base).points, []);
}

console.log("\n— seeks, the room waiting, leaving, the end —");
transport({ type: "seek", fromS: 100, toS: 400 });
R1.waiting = true;
step(2_000);
R1.waiting = false;
step(2_000);
(R1.clients as Any[])[1] = client("222", "robin", { away: true, subtitleStreamId: 3, quality: 2, variantKey: "v1" });
step(2_000);
(R1.clients as Any[])[1] = client("222", "robin", { connected: false, away: true, subtitleStreamId: 3, quality: 2, variantKey: "v1" });
step(2_000);
check("a seek from where to where, by whom", eventsOf(play1.id, "seek").map((e) => [e.username, (e.detail as Any).fromS, (e.detail as Any).toS]),
  [["alex", 100, 400]]);
check("  the room holding everybody, for how long", eventsOf(play1.id, "room waited").map((e) => (e.detail as Any).ms), [2000]);
check("  away from Discord, then gone", rec.play(play1.id)!.events.filter((e) => e.userId === "222").slice(-2).map((e) => e.kind),
  ["away from Discord", "left"]);
transport({ type: "stop", fromS: 700 });
const ended = rec.play(play1.id)!;
check("a stop ends the play: by whom, where, and every stream with it",
  [ended.play.endReason, ended.play.endBy, ended.play.endedAt === t, ended.streams.every((s) => s.endedAt !== null), kinds(play1.id).slice(-2)],
  ["stopped", "alex", true, true, ["stop", "ended"]]);
R1.ratingKey = null;
R1.title = null;
step(2_000);
check("  and a room with nothing playing opens none", rec.history().length, 1);

console.log("\n— another title, a room closing —");
transport({ type: "play", ratingKey: "70001", title: "Paprika" });
transport({ type: "play", ratingKey: "70002", title: "Perfect Blue" });
check("a play of another title ends the one before",
  rec.history().map((p) => [p.title, p.endReason]), [["Perfect Blue", null], ["Paprika", "another title"], ["Ghost Stories", "stopped"]]);
rooms = [];
step(2_000);
check("  a room gone ends its play", rec.history()[0].endReason, "room closed");

console.log("\n— the history's list —");
const list = rec.history();
check("newest first: viewers by name, streams, re-encoded ones, data and stalls",
  [list[2].names, list[2].streams, list[2].reencoded, list[2].bytes, list[2].stalls],
  [["alex", "robin"], 3, 1, 2e6 + 15e6, 1]);
check("  and where its data came from: the server, Discord's cache, other viewers",
  [list[2].botBytes + list[2].cacheBytes + list[2].p2pBytes === list[2].bytes, list[2].cacheBytes > 0, list[2].p2pBytes],
  [true, true, rec.play(list[2].id)!.viewers.reduce((s, v) => s + v.p2pBytes, 0)]);
check("  found by a viewer's name, or a title", [rec.history({ q: "robi" }).map((p) => p.title), rec.history({ q: "paprika" }).map((p) => p.title)],
  [["Ghost Stories"], ["Paprika"]]);
check("  a page at a time", rec.history({ limit: 1, before: list[0].id }).map((p) => p.title), ["Paprika"]);
check("  a search's wildcards are only characters", rec.history({ q: "%" }).length, 0);

console.log("\n— title requests —");
let named: (v: string | null) => void = () => {};
rec.request({ at: t, userId: "222", mediaType: "movie", tmdbId: 129, seasons: null, outcome: "requested", status: 2, error: null,
  title: new Promise((r) => { named = r; }) });
rec.request({ at: t + 1, userId: "333", mediaType: "tv", tmdbId: 1399, seasons: [1, 2], outcome: "already requested", status: 409, error: null });
named("Spirited Away");
await sleep(10);
check("who asked for what, and what came of it; its name looked up after",
  rec.requests().map((r) => [r.username ?? r.userId, r.mediaType, r.tmdbId, r.seasons, r.outcome, r.status, r.title]),
  [["333", "tv", 1399, [1, 2], "already requested", 409, null], ["robin", "movie", 129, null, "requested", 2, "Spirited Away"]]);

console.log("\n— people, places, Discord's cache —");
const everyone = rec.people();
// robin's request is the latest anybody was seen; Paprika and Perfect
// Blue were played with no room behind them, so hosted, but watched by nobody.
check("everybody seen, the latest first: what they watched, hosted, launched and asked for",
  everyone.map((p) => [p.userId, p.username, p.plays, p.hosted, p.launches, p.requests]),
  [["222", "robin", 1, 0, 0, 1], ["111", "alex", 1, 3, 1, 0]]);
check("  with what they had, all of it", [everyone[0].httpBytes, everyone[0].edgeHitBytes, everyone[0].botBytes, everyone[0].stalls, everyone[0].lastTitle],
  [12e6, 4e6, 8e6, 1, "Ghost Stories"]);
check("  found by a name or an ID; a page at a time; wildcards only characters",
  [rec.people({ q: "robi" }).map((p) => p.userId), rec.people({ q: "111" }).map((p) => p.userId),
    rec.people({ limit: 1, offset: 1 }).map((p) => p.userId), rec.people({ q: "%" }).length],
  [["222"], ["111"], ["111"], 0]);
const robin = rec.person("222")!;
check("one person: each play they were in, as what, with their own data; what they asked for; where",
  [robin.plays.map((p) => [p.title, p.role, p.httpBytes, p.hostName]), robin.requests.map((r) => r.title),
    robin.places.map((p) => [p.guildId, p.channelId, p.launches, p.joins])],
  [[["Ghost Stories", "viewer", 12e6, "alex"]], ["Spirited Away"], [["G1", "C1", 0, 1]]]);
check("  and nobody by an ID never seen", rec.person("404"), null);
const places = rec.places();
check("each server, and each of its channels: launches, joins, who, plays",
  places.map((g) => [g.guildId, g.launches, g.joins, g.people, g.plays,
    g.channels.map((c) => [c.channelId, c.launches, c.joins, c.names.map((n) => n.username), c.plays])]),
  [["G1", 1, 2, 2, 3, [["C1", 1, 2, ["robin", "alex"], 3]]]]);
const dc = rec.discordCache();
check("what Discord's cache handed players, of all they fetched, and what the bot sent",
  [dc.all.httpBytes, dc.all.edgeHitBytes, dc.all.botBytes, dc.all.p2pBytes, dc.all.hitShare, dc.all.plays],
  [14e6, 4e6, 10e6, 3e6, 4 / 9, 1]);
check("  by title, the most first", dc.titles.map((x) => [x.title, x.httpBytes, x.plays]).slice(0, 1), [["Ghost Stories", 14e6, 1]]);
const later = rec.discordCache(t + 2 * 86_400_000);
check("  over the last day and week, by when each play began", [later.day.httpBytes, later.day.hitShare, later.week.httpBytes],
  [0, null, 14e6]);
check("the titles and plays it knows, for the caches page",
  [[...rec.titles(["58860", "nope"])], [...rec.sessions(["S1", "nope"])].map(([k, v]) => [k, v.title])],
  [[["58860", "Ghost Stories"]], [["S1", "Ghost Stories"]]]);
check("title requests found by title, name or TMDB ID",
  [rec.requests({ q: "spirited" }).map((r) => r.tmdbId), rec.requests({ q: "1399" }).map((r) => r.tmdbId), rec.requests({ q: "robi" }).length],
  [[129], [1399], 1]);
rec.request({ at: t, userId: "444", mediaType: "movie", tmdbId: 4977, seasons: null, outcome: "requested", status: 2, error: null });
rec.clientLog({ at: t, userId: "444", clientId: "pageN", entries: [] });
(R1.clients as Any[]).push(client("444", "nightowl"));
rooms = [R1];
step(2_000);
check("  one from somebody not yet seen is named once they are",
  [rec.requests()[0].username, rec.requests({ q: "nightowl" }).map((r) => r.tmdbId)], ["nightowl", [4977]]);
(R1.clients as Any[]).pop();
rooms = [];
step(2_000);

console.log("\n— the server stopping, and one that died —");
rooms = [{ ...structuredClone(R1), id: "R2", ratingKey: "80001", title: "Tokyo Godfathers" }];
step(2_000);
rec.close();
const ro = new Database(dbPath, { readonly: true });
check("stopping the server ends what is open", ro.prepare("SELECT title, end_reason FROM plays ORDER BY id DESC LIMIT 1").get(),
  { title: "Tokyo Godfathers", end_reason: "server stopped" });
ro.close();
check("  and a stopped recorder hears nothing more", (() => { try { transport({ type: "pause" }); rec.tick(); return "quiet"; } catch (e) { return String(e); } })(), "quiet");

const crashPath = path.join(process.env.THUMB_CACHE_DIR, "crash.sqlite");
const died = new Recorder({ dbPath: crashPath, now: () => t, source, instances: () => new Map() });
rooms = [{ ...structuredClone(R1), id: "R3", ratingKey: "80002", title: "Millennium Actress" }];
died.tick(t);
const lastSeen = t;
t += 3_600_000;
const next = new Recorder({ dbPath: crashPath, now: () => t, source: () => ({ at: t, totals: {}, rooms: [] }) as unknown as Overview, instances: () => new Map() });
const after = next.history()[0];
check("a play a crashed server never ended ends where it was last seen",
  [after.title, after.endReason, after.endedAt === lastSeen], ["Millennium Actress", "server restarted", true]);
next.close();

console.log("\n— a new stream's counters, Discord's cache's too —");
{
  // A player's Discord cache figures start again with each stream. Its next
  // stream had fetched more by its first sample than the last had in all:
  // counted whole, not as the difference.
  let at = t;
  const one = { ...structuredClone(R1), id: "RC", ratingKey: "70001", title: "Solo", playing: true, clients: [client("777", "soloist", { role: "host" })], streams: [stream("v0", "SC1", { viewers: ["777"] })],
    discord: { guildId: "G5", channelId: "C5", hostUserId: "777", startedAt: at } };
  const solo = new Recorder({ dbPath: path.join(process.env.THUMB_CACHE_DIR, "counters.sqlite"), now: () => at, instances: () => new Map(),
    source: () => ({ at, totals: {}, rooms: [one] }) as unknown as Overview });
  solo.tick(at);
  const say = (session: string, o: Any, when: number) => ({ t: when, level: "LOG", tag: "Health", msg: "sample", data: { session, p2pMB: 0, ...o } });
  solo.clientLog({ at, userId: "777", clientId: "pageS", entries: [
    say("SC1", { httpMB: 0, edgeHitMB: "0.0", edgeMB: "0.0" }, at),
    say("SC1", { httpMB: 4, edgeHitMB: "2.0", edgeMB: "4.0" }, at + 10_000),
    say("SC2", { httpMB: 1, edgeHitMB: "3.0", edgeMB: "6.0" }, at + 20_000),
  ] });
  at += 2_000;
  solo.tick(at);
  const v = solo.play(solo.history()[0].id)!.viewers[0];
  check("each stream's Discord cache figures are counted whole", [v.httpBytes, v.edgeBytes, v.edgeHitBytes], [5e6, 10e6, 5e6]);
  solo.close();
}

console.log("\n— graphs, the history file, removing old history —");
// A recorder of its own, on a clock of its own: a play 40 days back, one
// still going since then, and two plays of one title on two days.
const DAY = 86_400_000;
const D = Math.floor(t / DAY) + 10;
let g = (D - 40) * DAY + 12 * 3_600_000;
let gRooms: Any[] = [];
const gInst = new Map<string, Inst>();
const graphPath = path.join(process.env.THUMB_CACHE_DIR, "graphs.sqlite");
const gr = new Recorder({ dbPath: graphPath, now: () => g, instances: () => gInst,
  source: () => ({ at: g, totals: {}, rooms: gRooms }) as unknown as Overview });
const gStep = (ms: number) => { g += ms; gr.tick(g); };
const room = (id: string, ratingKey: string, title: string, guildId: string, people: Array<[string, string]>, streams: Any[]): Any => ({
  ...structuredClone(R1), id, ratingKey, title, positionS: 0,
  discord: { guildId, channelId: `${guildId}-c`, hostUserId: people[0][0], startedAt: g },
  clients: people.map(([id, name], i) => client(id, name, { role: i === 0 ? "host" : "viewer" })),
  streams,
});
const open = (r: Any) => { gInst.set(r.id as string, { hostUserId: (r.discord as Any).hostUserId as string, guildId: (r.discord as Any).guildId as string,
  channelId: (r.discord as Any).channelId as string, createdAt: g }); gRooms.push(r); gStep(10); };
const close = (id: string) => { gRooms = gRooms.filter((r) => r.id !== id); gStep(2_000); };

open(room("GP", "P1", "Paprika", "G7", [["555", "oldtimer"]], [stream("v0", "S60", { viewers: ["555"], decision: "copy" })]));
open(room("GB", "B1", "Perfect Blue", "G9", [["666", "nightlight"]], [stream("v0", "S61", { viewers: ["666"], decision: "copy" })]));
for (let i = 0; i < 3; i++) gStep(2_000);
close("GP");
const paprikaId = gr.history({ q: "paprika" })[0].id;

// Day D, 20:00 UTC: two watching, a re-encode and a copy, and their data.
g = D * DAY + 20 * 3_600_000;
gr.tick(g);
open(room("GA", "A1", "Akira", "G7", [["111", "alex"], ["222", "robin"]], [
  stream("v0", "S70", { viewers: ["111"], decision: "transcode", reason: "Their player can't play HEVC" }),
  stream("v1", "S71", { viewers: ["222"], decision: "copy" }),
]));
for (let i = 0; i < 5; i++) gStep(2_000);
const gHealth = (o: Any, at: number) => ({ t: at, level: "LOG", tag: "Health", msg: "sample", data: { session: "S71", ...o } });
gr.clientLog({ at: g, userId: "222", clientId: "pageG", entries: [
  gHealth({ httpMB: 0, p2pMB: 0, edgeHitMB: "0", edgeMB: "0" }, g - 8_000),
  gHealth({ httpMB: 6, p2pMB: 1, edgeHitMB: "2.0", edgeMB: "4.0" }, g),
] });
gStep(2_000);
close("GA");

// Day D + 1, 03:00 UTC: the same title somewhere else, and a request.
g = (D + 1) * DAY + 3 * 3_600_000;
gr.tick(g);
open(room("GC", "A1", "Akira", "G8", [["333", "owlet"]], [stream("v0", "S72", { viewers: ["333"], decision: "copy" })]));
for (let i = 0; i < 2; i++) gStep(2_000);
close("GC");
gr.request({ at: g, userId: "333", mediaType: "movie", tmdbId: 149, seasons: null, outcome: "requested", status: 2, error: null });

const week = gr.graphs({ days: 7 });
const dayOf = (d: number) => week.daily.find((x) => x.day === d * DAY)!;
check("graphs: a day for each of the last 7, UTC, the last one today",
  [week.days, week.daily.length, week.daily[6].day, week.from, week.to], [7, 7, (D + 1) * DAY, (D - 5) * DAY, (D + 2) * DAY]);
check("  each play on the day it began: plays, people, launches, streams and how",
  [dayOf(D), dayOf(D + 1)].map((x) => [x.plays, x.people, x.peakViewers, x.launches, x.streams, x.copies, x.reencodes, x.requests]),
  [[1, 2, 2, 1, 2, 1, 1, 0], [1, 1, 1, 1, 1, 1, 0, 1]]);
check("  each viewer's watching, and their data and where it came from",
  [dayOf(D).watchedS, dayOf(D).httpBytes, dayOf(D).edgeBytes, dayOf(D).edgeHitBytes, dayOf(D).botBytes, dayOf(D).p2pBytes],
  [gr.play(gr.history({ q: "robin" })[0].id)!.viewers.reduce((s, v) => s + v.watchedS, 0), 6e6, 4e6, 2e6, 4e6, 1e6]);
check("  the days without any, all naught", week.daily.slice(0, 5).every((x) => x.plays === 0 && x.launches === 0), true);
check("  the totals: plays, people, launches, requests, Discord's share",
  [week.totals.plays, week.totals.people, week.totals.launches, week.totals.requests, week.totals.hitShare, week.totals.reencodes],
  [2, 3, 2, 1, 0.5, 1]);
check("  by hour and weekday, UTC",
  [week.hours.filter((h) => h.plays).map((h) => h.hour), week.weekdays.filter((w) => w.plays).map((w) => w.weekday)],
  [[3, 20], [new Date(D * DAY).getUTCDay(), new Date((D + 1) * DAY).getUTCDay()].sort()]);
check("  the most watched titles, people and servers; why streams were re-encoded",
  [week.titles.map((x) => [x.ratingKey, x.title, x.plays, x.people]), week.people.map((x) => x.userId).sort(),
    week.servers.map((x) => x.guildId).sort(), week.reasons],
  [[["A1", "Akira", 2, 3]], ["111", "222", "333"], ["G7", "G8"], [{ reason: "Their player can't play HEVC", streams: 1 }]]);
const all = gr.graphs({ days: 0 });
check("  all of it: from the first day anything happened",
  [all.days, all.daily.length, all.daily[0].day, all.totals.plays, all.titles.map((x) => x.title).sort()],
  [0, 42, (D - 40) * DAY, 4, ["Akira", "Paprika", "Perfect Blue"]]);
check("  a period not a number is 30 days; one too long, ten years",
  [gr.graphs({ days: "lots" }).days, gr.graphs({ days: -3 }).days, gr.graphs({ days: 99_999 }).days, gr.graphs({ days: 99_999 }).daily.length],
  [30, 30, 3650, 3650]);

// 12 November: the dashboard's days and hours were UTC's wherever it was
// opened. Akira began on day D at 20:00 UTC and on day D + 1 at 03:00 UTC, and
// it is 03:00 UTC on day D + 1 now.
check("graphs: UTC unless a time zone is given, or what is given isn't one",
  [week.zone, gr.graphs({ days: 7, zone: "Mars/Olympus" }).zone, gr.graphs({ days: 7, zone: "'; DROP TABLE plays" }).zone,
    gr.graphs({ days: 7, zone: ["Asia/Tokyo"] }).zone, gr.graphs({ days: 7, zone: "Mars/Olympus" }).daily[6].day],
  ["UTC", "UTC", "UTC", "UTC", (D + 1) * DAY]);
const tokyo = gr.graphs({ days: 7, zone: "Asia/Tokyo" });
check("  in Tokyo, nine hours ahead: both on day D + 1, at 05:00 and 12:00, and the week is Tokyo's",
  [tokyo.zone, tokyo.daily.filter((x) => x.plays).map((x) => [x.day, x.plays, x.people, x.launches, x.requests]),
    tokyo.hours.filter((h) => h.plays).map((h) => h.hour), tokyo.weekdays.filter((w) => w.plays).map((w) => [w.weekday, w.plays]),
    tokyo.daily[6].day, tokyo.from, tokyo.to],
  ["Asia/Tokyo", [[(D + 1) * DAY, 2, 3, 2, 1]], [5, 12], [[new Date((D + 1) * DAY).getUTCDay(), 2]],
    (D + 1) * DAY, (D - 5) * DAY - 9 * 3_600_000, (D + 2) * DAY - 9 * 3_600_000]);
const phoenix = gr.graphs({ days: 7, zone: "America/Phoenix" });
check("  in Phoenix, seven hours behind: both on day D, at 13:00 and 20:00, and today is still day D",
  [phoenix.daily.filter((x) => x.plays).map((x) => [x.day, x.plays]), phoenix.hours.filter((h) => h.plays).map((h) => h.hour),
    phoenix.daily[6].day, phoenix.from, phoenix.to, phoenix.totals.plays],
  [[[D * DAY, 2]], [13, 20], D * DAY, (D - 6) * DAY + 7 * 3_600_000, (D + 1) * DAY + 7 * 3_600_000, 2]);
check("  in Kolkata, five and a half hours ahead: at 01:30 and 08:30",
  gr.graphs({ days: 7, zone: "Asia/Kolkata" }).hours.filter((h) => h.plays).map((h) => h.hour), [1, 8]);
{
  // New York's clocks went back at 06:00 UTC on 1 November 2026.
  const ny = zoneClock("America/New_York");
  const H = 3_600_000;
  const back = Date.UTC(2026, 10, 1, 6);
  const nov1 = Date.UTC(2026, 10, 1) / DAY;
  check("a time zone's clock: its summer and winter offsets, and UTC's none",
    [ny.offset(Date.UTC(2026, 6, 1)) / H, ny.offset(Date.UTC(2026, 0, 15)) / H, ny.offset(back - 1000) / H, ny.offset(back) / H,
      zoneClock(undefined).offset(back), zoneClock("UTC").zone, zoneClock("Etc/UTC").offset(back)],
    [-4, -5, -4, -5, 0, "UTC", 0]);
  check("  the day an instant is on, and when a day begins: the day the clocks go back is 25 hours long",
    [ny.day(Date.UTC(2026, 10, 1, 3, 59)) - nov1, ny.day(Date.UTC(2026, 10, 1, 4)) - nov1,
      ny.dayStart(nov1) - Date.UTC(2026, 10, 1, 4), ny.dayStart(nov1 + 1) - Date.UTC(2026, 10, 2, 5)],
    [-1, 0, 0, 0]);
  check("  as SQL: each side of a change by its own offset; none in the period, one offset; UTC, the column",
    [ny.sql("at", Date.UTC(2026, 9, 25), Date.UTC(2026, 10, 8)), ny.sql("at", Date.UTC(2026, 10, 2), Date.UTC(2026, 10, 8)),
      zoneClock("UTC").sql("at", 0, Date.UTC(2026, 10, 8))],
    [`(at + CASE WHEN at < ${back} THEN ${-4 * H} ELSE ${-5 * H} END)`, `(at + ${-5 * H})`, "at"]);

  // A history across that change: 23:30 in New York on 31 October (03:30 UTC
  // on 1 November, summer time) and 23:30 on 1 November (04:30 UTC on the
  // 2nd, winter time). By today's offset alone the first would be at 22:30.
  const dstPath = path.join(process.env.THUMB_CACHE_DIR!, "dst.sqlite");
  let dn = Date.UTC(2026, 10, 1, 3, 30);
  const dst = new Recorder({ dbPath: dstPath, now: () => dn, instances: () => new Map(),
    source: () => ({ at: dn, totals: {}, rooms: [] }) as unknown as Overview });
  for (const at of [dn, Date.UTC(2026, 10, 2, 4, 30)]) {
    dn = at;
    dst.request({ at, userId: "333", mediaType: "movie", tmdbId: 149, seasons: null, outcome: "requested", status: 2, error: null });
  }
  dn = Date.UTC(2026, 10, 3, 12);
  const across = dst.graphs({ days: 7, zone: "America/New_York" });
  check("  graphs across a clock change: each request on the day it was by the clock then",
    across.daily.filter((x) => x.requests).map((x) => [new Date(x.day).toISOString().slice(0, 10), x.requests]),
    [["2026-10-31", 1], ["2026-11-01", 1]]);
  dst.close();
}

const sum0 = gr.summary();
check("the history file: where, how big, what it holds, from when",
  [sum0.path, sum0.bytes > 0, sum0.plays, sum0.open, sum0.people, sum0.requests, sum0.first, sum0.last],
  [graphPath, true, 4, 1, 5, 1, (D - 40) * DAY + 12 * 3_600_000, g]);
const cutoff = (D - 30) * DAY;
const preview = gr.trimPreview(cutoff);
const paprikaLines = gr.play(paprikaId)!.events.length;
check("what removing the history before a day would remove: a play that ended before it, its lines, its people",
  [preview.plays, preview.events === paprikaLines && paprikaLines > 0, preview.usage, preview.requests, preview.people],
  [1, true, 4, 0, 1]);
check("  and nothing is gone yet", gr.summary().plays, 4);
const trimmed = gr.trim(cutoff);
check("removing it removes just that, and says how big the file was and is",
  [trimmed.plays, trimmed.people, trimmed.bytesBefore > 0, trimmed.bytesAfter > 0, gr.play(paprikaId), gr.person("555")],
  [1, 1, true, true, null, null]);
check("  a play still going is kept, from however long ago, and its people",
  [gr.history().map((p) => p.title).sort(), gr.person("666")?.person.userId, gr.summary().plays, gr.summary().open],
  [["Akira", "Akira", "Perfect Blue"], "666", 3, 1]);
check("  the launches and joins from before it are gone, the rest kept",
  [gr.usage().every((u) => u.at >= cutoff), gr.usage().length > 0], [true, true]);
gRooms.push(room("GQ", "P1", "Paprika", "G7", [["555", "oldtimer"]], [stream("v0", "S62", { viewers: ["555"], decision: "copy" })]));
gStep(2_000);
check("  somebody removed is written again when next seen", gr.person("555")?.person.username, "oldtimer");

const snap = gr.snapshot();
const snapPath = path.join(process.env.THUMB_CACHE_DIR, "snap.sqlite");
fs.writeFileSync(snapPath, snap);
const sdb = new Database(snapPath, { readonly: true });
check("a copy of the whole history file, as it is: it opens, with every play",
  [snap.subarray(0, 15).toString("latin1"), (sdb.prepare("SELECT COUNT(*) AS n FROM plays").get() as Any).n], ["SQLite format 3", 4]);
sdb.close();
gr.close();

console.log("\n— loading the start, buffering, a seek; the host changing the audio; where in the title —");
{
  // 17 November: everybody joining was "buffering" while their player loaded
  // the start, on Now Playing and in the history; "switched" to the stream
  // they started on; and moved with the host's change of audio with nothing
  // to say it was the host's.
  let n = 1_900_000_000_000;
  const G = "123456789012345678";
  const C = "223456789012345678";
  const nInst = new Map<string, Inst>([["RN", { hostUserId: "711", guildId: G, channelId: C, createdAt: n }]]);
  const rn: Any = { ...structuredClone(R1), id: "RN", ratingKey: "90001", title: "Verity", playing: true, positionS: 0, waiting: false,
    hostVariantKey: "1:0", discord: { guildId: G, channelId: C, hostUserId: "711", startedAt: n },
    clients: [client("711", "hostess", { role: "host", variantKey: "1:0" })],
    streams: [stream("1:0", "SN1", { viewers: ["711"], kbps: 8000 })] };
  const nPath = path.join(process.env.THUMB_CACHE_DIR!, "now.sqlite");
  const nr = new Recorder({ dbPath: nPath, now: () => n, instances: () => nInst,
    source: () => ({ at: n, totals: {}, rooms: [rn] }) as unknown as Overview });
  const nStep = (ms: number) => { n += ms; if (rn.playing) rn.positionS = (rn.positionS as number) + ms / 1000; nr.tick(n); };
  const vid = (msg: string, at: number, o: Any = {}) => ({ t: at, level: msg.startsWith("waiting") ? "WARN" : "LOG", tag: "Video", msg,
    data: { posS: rn.positionS, paused: false, seeking: false, readyState: 3, ...o } });
  const say = (userId: string, ...entries: Any[]) => nr.clientLog({ at: n, userId, clientId: `page${userId}`,
    entries: entries as unknown as Parameters<typeof nr.clientLog>[0]["entries"] });
  const liveOf = (userId: string) => nr.annotate({ at: n, totals: {}, rooms: [structuredClone(rn)] } as unknown as Overview)
    .rooms[0].clients.find((c) => c.userId === userId)?.player;
  const evs = () => nr.play(pid)!.events;
  nr.transport({ at: n, roomId: "RN", type: "play", userId: "711", username: "hostess", role: "host", fromS: 0, toS: 0,
    ratingKey: "90001", title: "Verity" });
  nr.tick(n);
  const pid = nr.history()[0].id;
  for (let i = 0; i < 10; i++) nStep(2_000);

  // A viewer joins: their page has no stream yet, then the one with their own subtitles.
  (rn.clients as Any[]).push(client("722", "latecomer", { variantKey: null, subtitleStreamId: 0 }));
  nStep(2_000);
  const joinedAt = n;
  (rn.clients as Any[])[1] = client("722", "latecomer", { variantKey: "1:3", subtitleStreamId: 3 });
  (rn.streams as Any[]).push(stream("1:3", "SN2", { viewers: ["722"], subtitleStreamId: 3, ownerUserId: "722" }));
  nStep(2_000);
  check("somebody joining starts on a stream: not a switch from one, nor a change of subtitles",
    evs().filter((e) => e.userId === "722" && ["joined", "stream changed", "subtitles"].includes(e.kind))
      .map((e) => [e.kind, (e.detail as Any | null)?.from ?? null]),
    [["joined", null], ["stream changed", null]]);

  say("722", vid("waiting (buffer starved)", n - 1_500, { readyState: 0 }));
  check("  their player loading the start is that on Now Playing, not buffering", liveOf("722"), { stall: "start", sinceMs: 1_500 });
  nStep(2_000);
  say("722", vid("playing", n - 500));
  check("  and playing, nothing", liveOf("722"), { stall: null, sinceMs: null });
  for (let i = 0; i < 10; i++) nStep(2_000);
  say("722", vid("waiting (buffer starved)", n - 2_000));
  check("  a stall well after: buffering, and for how long so far", liveOf("722"), { stall: "buffering", sinceMs: 2_000 });
  nStep(2_000);
  say("722", vid("playing", n - 1_000));
  nr.transport({ at: n, roomId: "RN", type: "seek", userId: "711", username: "hostess", role: "host", fromS: rn.positionS as number,
    toS: 1_200, ratingKey: "90001", title: "Verity" });
  rn.positionS = 1_200;
  say("722", vid("waiting (buffer starved)", n + 1_000, { posS: 1_200 }));
  nStep(2_000);
  check("  one just after the host's seek, though their player didn't say it seeked: loading after a seek", liveOf("722")?.stall, "seek");
  say("722", vid("playing", n + 500, { posS: 1_200 }));
  nStep(2_000);
  const v722 = nr.play(pid)!.viewers.find((v) => v.userId === "722")!;
  check("  only the stall is counted as buffering", [v722.stalls, v722.stalledMs], [1, 3_000]);
  check("  and each is in the history as what it was",
    evs().filter((e) => ["loaded at start", "buffering", "loaded after seek"].includes(e.kind)).map((e) => [e.kind, e.username, (e.detail as Any).ms]),
    [["loaded at start", "latecomer", 3_000], ["buffering", "latecomer", 3_000], ["loaded after seek", "latecomer", 1_500]]);
  check("  a player not heard from in a while: not said", (() => { const at = n; n += 31_000; const p = liveOf("722"); n = at; return p; })(), null);

  // Somebody on the host's stream; then the host changes the audio.
  (rn.clients as Any[]).push(client("733", "sidekick", { variantKey: "1:0" }));
  (rn.streams as Any[])[0] = stream("1:0", "SN1", { viewers: ["711", "733"], kbps: 8000 });
  nStep(2_000);
  Object.assign(rn, { waiting: true, waitingWhy: "the host's stream is being rebuilt", switching: "audio" });
  (rn.clients as Any[])[0] = client("711", "hostess", { role: "host", variantKey: "2:0" });
  (rn.streams as Any[])[0] = stream("2:0", "SN3", { viewers: ["711"], audioStreamId: 2, kbps: 8000 });
  nStep(2_000);
  (rn.clients as Any[])[2] = client("733", "sidekick", { variantKey: "2:0" });
  (rn.streams as Any[])[0] = stream("2:0", "SN3", { viewers: ["711", "733"], audioStreamId: 2, kbps: 8000 });
  nStep(2_000);
  Object.assign(rn, { waiting: false, waitingWhy: null, switching: null });
  nStep(2_000);
  check("the host changing the audio: their own change, and who moved with them, and why",
    evs().filter((e) => e.kind === "stream changed" && (e.detail as Any).to === "2:0")
      .map((e) => [e.username, (e.detail as Any).from, (e.detail as Any).host ?? null, (e.detail as Any).why ?? null]),
    [["hostess", "1:0", null, "audio"], ["sidekick", "1:0", "hostess", "audio"]]);
  check("  the room waiting for the host's picture: how long, why, and the change behind it",
    evs().filter((e) => e.kind === "room waited").map((e) => e.detail), [{ ms: 4_000, why: "the host's stream is being rebuilt", switching: "audio" }]);

  // Where in the title: the room's track, and a viewer's own from their player.
  const hs = (posS: number, at: number) => ({ t: at, level: "LOG", tag: "Health", msg: "sample",
    data: { session: "SN2", httpMB: 0, p2pMB: 0, posS, paused: false, playedS: 10 } });
  say("722", hs(1_300, n - 20_000), hs(1_310, n - 10_000), hs(1_320, n));
  const where = nr.play(pid)!;
  check("where in the title it played: the room's track; each viewer's from their own player, or the room's while they were there",
    [where.track.length > 4, where.track.some((p) => p[1] === 1_200), where.watched["722"], where.watched["711"].map(([a]) => a)],
    [true, true, [[1_300, 1_320]], [0, 1_200]]);

  // Names: a server's from the sign-in that saw it; a channel's from the
  // Activity running in it, and no other.
  nr.place({ at: n, kind: "guild", id: G, name: "  Film\nClub  " });
  nr.place({ at: n, kind: "guild", id: "not-an-id", name: "Nope" });
  nr.place({ at: n, kind: "guild", id: "323456789012345678", name: "   " });
  say("722", { t: n, level: "LOG", tag: "Discord", msg: "channel", data: { channelId: C, guildId: G, name: "Movie Night" } },
    { t: n, level: "LOG", tag: "Discord", msg: "channel", data: { channelId: "423456789012345678", guildId: G, name: "Elsewhere" } });
  check("the names of servers and channels: cleaned; nothing for a bad ID, an empty name, or a channel no Activity runs in",
    nr.placeNames(), { guilds: { [G]: "Film Club" }, channels: { [C]: "Movie Night" } });

  // 17 November: the host's subtitles were each viewer's own change in the
  // events; a stream "ended" with nothing to say why; a skip of the intro was
  // a seek; a rebuild of the stream "started playback"; and how a title ended
  // was "playback was stopped", whatever had happened.
  check("a stream the host's change left: ended because of it",
    evs().filter((e) => e.kind === "stream ended").map((e) => [(e.detail as Any).variant, (e.detail as Any).host ?? null, (e.detail as Any).switching ?? null]),
    [["1:0", "hostess", "audio"]]);
  (rn.clients as Any[])[0] = client("711", "hostess", { role: "host", variantKey: "2:0", subtitleStreamId: 5 });
  (rn.clients as Any[])[2] = client("733", "sidekick", { variantKey: "2:0", subtitleStreamId: 5 });
  nStep(2_000);
  check("the host changing the subtitles: theirs, and theirs carried to who follows them; not one on subtitles of their own",
    evs().filter((e) => e.kind === "subtitles").map((e) => [e.username, (e.detail as Any).to, (e.detail as Any).byHost ?? null, (e.detail as Any).host ?? null]),
    [["hostess", 5, true, null], ["sidekick", 5, null, "hostess"]]);
  (rn.streams as Any[])[1] = stream("1:3", "SN2", { viewers: [], subtitleStreamId: 3, ownerUserId: "722" });
  nStep(2_000);
  (rn.streams as Any[]).splice(1, 1);
  nStep(2_000);
  check("  a stream nobody was on any more: ended because of that",
    evs().filter((e) => e.kind === "stream ended").map((e) => [(e.detail as Any).variant, (e.detail as Any).unwatched ?? null]).at(-1), ["1:3", true]);

  const cmd = (o: Any) => nr.transport({ at: n, roomId: "RN", userId: "711", username: "hostess", role: "host", fromS: rn.positionS as number,
    toS: rn.positionS as number, ratingKey: "90001", title: "Verity", ...o } as Parameters<typeof nr.transport>[0]);
  cmd({ type: "seek", toS: 1_500, cause: "skip intro" });
  rn.positionS = 1_500;
  const plays = evs().filter((e) => e.kind === "play").length;
  cmd({ type: "play", rebuild: true });
  nStep(2_000);
  check("a seek says what it came from", evs().filter((e) => e.kind === "seek").map((e) => (e.detail as Any).cause ?? null).at(-1), "skip intro");
  check("  a play that only rebuilt the stream is no start", evs().filter((e) => e.kind === "play").length, plays);

  // Who sent whom what: each player's key from its own sample, what it sent from its own.
  const up = (session: string, key: string, upMB: number, upTo: Any | null, at: number) => ({ t: at, level: "LOG", tag: "Health", msg: "sample",
    data: { session, httpMB: 0, p2pMB: 0, peerKey: key, ...(upTo ? { upMB, upTo } : {}), posS: rn.positionS, paused: false } });
  say("711", up("SN3", "Hostessk", 0, null, n));
  say("733", up("SN3", "Sidekick", 0, null, n - 10_000), up("SN3", "Sidekick", 3, { Latecome: 2, Hostessk: 1 }, n));
  nStep(2_000);
  check("what a player sent the others: in all, and to whom once their player has said who it is",
    [nr.play(pid)!.viewers.find((v) => v.userId === "733")!.upBytes, nr.play(pid)!.shares], [3e6, [{ from: "733", to: "711", bytes: 1e6 }]]);
  say("722", up("SN2", "Latecome", 0, null, n));
  say("733", up("SN3", "Sidekick", 5, { Latecome: 3, Hostessk: 2 }, n + 10_000));
  nStep(2_000);
  check("  and what was kept back for a player not known yet, once it is",
    nr.play(pid)!.shares, [{ from: "733", to: "722", bytes: 3e6 }, { from: "733", to: "711", bytes: 2e6 }]);
  check("  on Now Playing too", nr.annotate({ at: n, totals: {}, rooms: [structuredClone(rn)] } as unknown as Overview).rooms[0].shares,
    [{ from: "733", to: "722", bytes: 3e6 }, { from: "733", to: "711", bytes: 2e6 }]);
  say("733", up("SN4", "Sidekick", 1, { Latecome: 1 }, n + 20_000));
  nStep(2_000);
  check("  a new stream's counters start again", [nr.play(pid)!.viewers.find((v) => v.userId === "733")!.upBytes, nr.play(pid)!.shares[0]],
    [6e6, { from: "733", to: "722", bytes: 4e6 }]);
  const sideP = nr.person("733")!;
  check("  a person's: in all, and to whom", [sideP.person.upBytes, sideP.sentTo.map((s) => [s.username, s.bytes]), nr.person("722")!.gotFrom.map((s) => s.username)],
    [6e6, [["latecomer", 4e6], ["hostess", 2e6]], ["sidekick"]]);
  const g = nr.graphs({ days: 0 }, n);
  check("  in the statistics: who sent the most, and between whom",
    [g.sharers.map((s) => [s.username, s.upBytes]), g.pairs.map((p) => [p.fromName, p.toName, p.bytes])],
    [[["sidekick", 6e6]], [["sidekick", "latecomer", 4e6], ["sidekick", "hostess", 2e6]]]);

  // The end: the break it was ended at, then the host closing the finished title.
  say("711", { t: n, level: "LOG", tag: "HLS", msg: "reached the break, ending the title", data: { breakAtS: 7_002.5, posS: 7_001.9 } });
  say("722", { t: n, level: "LOG", tag: "Video", msg: "ended", data: { posS: 7_002 } });
  nStep(2_000);
  cmd({ type: "stop", cause: "finished" });
  const done = nr.play(pid)!;
  check("reaching the end: said once, where, and that the stream ended it short of the file's end",
    done.events.filter((e) => e.kind === "reached the end").map((e) => [e.username, e.posS, e.detail]),
    [["hostess", 7_001.9, { early: true, breakAtS: 7_002.5 }]]);
  check("  a stop says how: the title finishing", [done.play.endCause, done.events.at(-1)!.detail],
    ["finished", { reason: "stopped", cause: "finished", reachedEnd: true }]);

  // The next episode, and a title a co-host asked for.
  rn.ratingKey = "90002";
  cmd({ type: "play", ratingKey: "90002", title: "Verity 2", cause: "next episode" });
  cmd({ type: "play", ratingKey: "90003", title: "Verity 3", cause: "co-host", askedBy: "sidekick" });
  const [third, second] = nr.history();
  check("a title ended by the next: how, by whom, and what came next",
    nr.play(second.id)!.events.at(-1)!.detail, { reason: "another title", cause: "co-host", next: "Verity 3", askedBy: "sidekick" });
  check("  and the start of the next says what started it", nr.play(third.id)!.events.find((e) => e.kind === "play")!.detail,
    { role: "host", cause: "co-host", askedBy: "sidekick" });
  nr.close();

  // The same history as the recorder before wrote it: the start load was
  // buffering, and counted; a viewer at a new episode had switched from the
  // stream of the one before, and changed subtitles with it.
  const old = new Database(nPath);
  const add = old.prepare("INSERT INTO events (play_id, room_id, at, kind, user_id, username, pos_s, detail) VALUES (?, 'RN', ?, ?, ?, ?, 0, ?)");
  add.run(pid, joinedAt + 3_000, "buffering", "722", "latecomer", JSON.stringify({ ms: 2_500 }));
  old.prepare("UPDATE play_viewers SET stalls = stalls + 1, stalled_ms = stalled_ms + 2500 WHERE play_id = ? AND user_id = '722'").run(pid);
  add.run(pid, joinedAt + 40_000, "stream changed", "733", "sidekick", JSON.stringify({ from: "9:9", to: "1:0" }));
  add.run(pid, joinedAt + 40_000, "subtitles", "733", "sidekick", JSON.stringify({ from: 4, to: 0 }));
  add.run(pid, joinedAt + 2_000, "subtitles", "722", "latecomer", JSON.stringify({ from: 0, to: 3 }));
  old.pragma("user_version = 1");
  old.close();
  const mended = new Recorder({ dbPath: nPath, now: () => n, instances: () => new Map(),
    source: () => ({ at: n, totals: {}, rooms: [] }) as unknown as Overview });
  const m = mended.play(pid)!;
  check("history from before, put right on the update: the start load isn't buffering, nor counted",
    [m.events.filter((e) => e.kind === "buffering").length, m.events.filter((e) => e.kind === "loaded at start").length,
      m.viewers.find((v) => v.userId === "722")!.stalls, m.viewers.find((v) => v.userId === "722")!.stalledMs], [1, 2, 1, 3_000]);
  check("  a stream of the title before is nobody's switch, and the subtitles that came with it no change",
    [m.events.filter((e) => e.userId === "733" && e.kind === "stream changed").map((e) => (e.detail as Any).from),
      // Of the subtitles put in above; the host's real change since stays.
      m.events.filter((e) => e.kind === "subtitles" && !(e.detail as Any).byHost).length], [["1:0", null], 0]);
  mended.close();
  const again = new Database(nPath, { readonly: true });
  check("  once: the history file says it was", again.pragma("user_version", { simple: true }), 2);
  again.close();
}

console.log("\n— which client each viewer is on —");
{
  // 18 November: History named no viewer's client, nor one moving from their
  // computer to their phone part way through.
  let w = 1_950_000_000_000;
  const DESK = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) discord/1.0.9268 Chrome/138.0 Electron/44.0.0 Safari/537.36";
  const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
  const wInst = new Map<string, Inst>([["RW", { hostUserId: "911", guildId: "G9", channelId: "C9", createdAt: w }]]);
  const rw: Any = { ...structuredClone(R1), id: "RW", ratingKey: "90002", title: "Moving", discord: { guildId: "G9", channelId: "C9", hostUserId: "911", startedAt: w },
    clients: [client("911", "host9", { role: "host", device: DESK }), client("922", "mover", { device: DESK, caps: ["hevc"], av1Encode: true })],
    streams: [stream("v0", "SW1", { viewers: ["911", "922"] })] };
  const wr = new Recorder({ dbPath: path.join(process.env.THUMB_CACHE_DIR!, "clients.sqlite"), now: () => w, instances: () => wInst,
    source: () => ({ at: w, totals: {}, rooms: [rw] }) as unknown as Overview });
  wr.transport({ at: w, roomId: "RW", type: "play", userId: "911", username: "host9", role: "host", fromS: 0, toS: 0, ratingKey: "90002", title: "Moving" });
  wr.tick(w);
  const wid = wr.history()[0].id;
  const wStep = (ms: number) => { w += ms; wr.tick(w); };
  const name = (ua: unknown) => (ua === DESK ? "desk" : ua === PHONE ? "phone" : null);
  const theirs = () => wr.play(wid)!.events.filter((e) => e.userId === "922" && ["joined", "came back", "switched client", "left"].includes(e.kind))
    .map((e) => { const d = (e.detail ?? {}) as Any; return [e.kind, name(d.device), name(d.from), name(d.to)]; });
  wStep(2_000);
  const joined = wr.play(wid)!.events.find((e) => e.userId === "922" && e.kind === "joined")?.detail as Any | undefined;
  check("joining: on which client, and what its player plays", [name(joined?.device), joined?.caps, joined?.av1Encode], ["desk", ["hevc"], true]);
  (rw.clients as Any[])[1] = client("922", "mover", { device: PHONE });
  wStep(2_000);
  wStep(2_000);
  check("  on their phone instead, still connected: a switch, from which to which, said once",
    theirs(), [["joined", "desk", null, null], ["switched client", null, "desk", "phone"]]);
  (rw.clients as Any[])[1] = client("922", "mover", { device: PHONE, connected: false });
  wStep(2_000);
  (rw.clients as Any[])[1] = client("922", "mover", { device: DESK });
  wStep(2_000);
  check("  gone, then back on the computer: back on it, and a switch to it",
    theirs().slice(2), [["left", null, null, null], ["came back", "desk", null, null], ["switched client", null, "phone", "desk"]]);
  (rw.clients as Any[])[0] = client("911", "host9", { role: "host" });
  wStep(2_000);
  check("  a client that gives no agent: nothing said", wr.play(wid)!.events.filter((e) => e.userId === "911" && e.kind === "switched client").length, 0);
  wr.close();
}

console.log("\n— the host before the session, and how the host changed —");
{
  // 18 November: the host joins before they choose a title, so their client
  // and what it plays were in no session, and History said "Not recorded";
  // and a change of host said who, never how.
  let l = 1_960_000_000_000;
  const DESK = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) discord/1.0.9268 Chrome/138.0 Electron/44.0.0 Safari/537.36";
  const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
  const lInst = new Map<string, Inst>([["RL", { hostUserId: "941", guildId: "G8", channelId: "C8", createdAt: l }]]);
  const rl: Any = { ...structuredClone(R1), id: "RL", ratingKey: null, title: null, playing: false, roleWhy: null,
    discord: { guildId: "G8", channelId: "C8", hostUserId: "941", startedAt: l },
    clients: [client("941", "early", { role: "host", device: DESK, caps: ["hevc", "eac3"] })], streams: [] };
  const lr = new Recorder({ dbPath: path.join(process.env.THUMB_CACHE_DIR!, "roles.sqlite"), now: () => l, instances: () => lInst,
    source: () => ({ at: l, totals: {}, rooms: [rl] }) as unknown as Overview });
  const lStep = (ms: number) => { l += ms; lr.tick(l); };
  lStep(2_000);
  // In the room before a title: a viewer comes in, and is made co-host.
  (rl.clients as Any[]).push(client("952", "second", { device: PHONE }));
  lStep(2_000);
  rl.roleWhy = { at: l, why: "co-host given", by: "early", to: "second" };
  (rl.clients as Any[])[1] = client("952", "second", { role: "co-host", device: PHONE });
  lStep(2_000);
  // Then a title.
  Object.assign(rl, { ratingKey: "90003", title: "Roles", playing: true, streams: [stream("v0", "SL1", { viewers: ["941", "952"] })] });
  lr.transport({ at: l, roomId: "RL", type: "play", userId: "941", username: "early", role: "host", fromS: 0, toS: 0, ratingKey: "90003", title: "Roles" });
  lStep(2_000);
  const lid = lr.history()[0].id;
  const detail = () => lr.play(lid)!;
  check("the session has nobody joining: they were in the room before it",
    detail().events.filter((e) => e.kind === "joined").length, 0);
  check("  what each did in the room before it comes with it: joined on what, playing what, and made co-host",
    detail().lead.map((e) => [e.username, e.kind, (e.detail as Any)?.device === DESK ? "desk" : (e.detail as Any)?.device === PHONE ? "phone" : null,
      (e.detail as Any)?.caps ?? null, (e.detail as Any)?.why ?? null]),
    [["early", "joined", "desk", ["hevc", "eac3"], null], ["second", "joined", "phone", [], null], ["second", "role", null, null, "co-host given"]]);
  check("  the co-host given: by whom", (detail().lead.at(-1)!.detail as Any).by, "early");

  // The host hands over.
  rl.roleWhy = { at: l, why: "handed over", by: "early", to: "second" };
  (rl.clients as Any[])[0] = client("941", "early", { role: "co-host", device: DESK });
  (rl.clients as Any[])[1] = client("952", "second", { role: "host", device: PHONE });
  lStep(2_000);
  const roles = () => detail().events.filter((e) => e.kind === "role").map((e) => {
    const d = e.detail as Any;
    return [e.username, d.from, d.to, d.why ?? null, d.by ?? null, d.target ?? null];
  });
  check("handing over: both changes say how, who had it, and who got it", roles(),
    [["early", "host", "co-host", "handed over", "early", "second"], ["second", "co-host", "host", "handed over", "early", "second"]]);
  // A change long after the room last said why is put down to nothing.
  l += 30_000;
  (rl.clients as Any[])[0] = client("941", "early", { role: "viewer", device: DESK });
  lStep(2_000);
  check("  a change the room said nothing of lately: no reason given", roles().at(-1), ["early", "co-host", "viewer", null, null, null]);
  // On their phone instead, still in: the switch says what that client plays.
  (rl.clients as Any[])[0] = client("941", "early", { role: "viewer", device: PHONE, caps: ["av1"] });
  lStep(2_000);
  const sw = detail().events.find((e) => e.kind === "switched client")?.detail as Any | undefined;
  check("a switch of client: what the new one plays", sw?.caps, ["av1"]);
  // Back in time as host, after the connection dropped.
  (rl.clients as Any[])[1] = client("952", "second", { role: "host", device: PHONE, connected: false });
  lStep(2_000);
  rl.roleWhy = { at: l, why: "host back", by: null, to: "second" };
  (rl.clients as Any[])[1] = client("952", "second", { role: "host", device: PHONE });
  lStep(2_000);
  check("  the host reconnecting in time: says so", (detail().events.filter((e) => e.kind === "came back").at(-1)?.detail as Any)?.why, "host back");
  lr.close();
}

console.log("\n— what the bot's port sent, for the qBittorrent manager —");
{
  // Six minutes of one stream at 8 Mbps: four with one viewer, the bot
  // sending 10 Mbps, then two with two, sending 15.
  const M0 = 1_950_000_000_000 - (1_950_000_000_000 % 60_000);
  let u = M0;
  const ur: Any = { ...structuredClone(R1), id: "RU", ratingKey: "90002", title: "Upload", playing: true, positionS: 0, waiting: false,
    discord: { guildId: "G6", channelId: "C6", hostUserId: "811", startedAt: u },
    clients: [client("811", "one", { role: "host" })], streams: [stream("v0", "SU1", { viewers: ["811"], kbps: 8000 })] };
  const up = new Recorder({ dbPath: path.join(process.env.THUMB_CACHE_DIR!, "upload.sqlite"), now: () => u, instances: () => new Map(),
    source: () => ({ at: u, totals: {}, rooms: [ur] }) as unknown as Overview });
  up.transport({ at: u, roomId: "RU", type: "play", userId: "811", username: "one", role: "host", fromS: 0, toS: 0, ratingKey: "90002", title: "Upload" });
  for (let i = 0; i < 36; i++) {
    u = M0 + i * 10_000;
    if (i === 24) {
      (ur.clients as Any[]).push(client("822", "two"));
      (ur.streams as Any[])[0] = stream("v0", "SU1", { viewers: ["811", "822"], kbps: 8000 });
    }
    up.tick(u);
    up.sent({ at: u, bytes: i < 24 ? 12_500_000 : 18_750_000 });
  }
  up.sent({ at: u, bytes: 0 });
  const hour = up.graphs({ hours: 1 }, u + 1_000).upload;
  check("all it sent, on average while playing, at the 95th percentile, at its busiest and when",
    [hour.sentBytes, hour.avgKbps, hour.p95Kbps, hour.peakKbps, hour.peakAt, hour.minutes, hour.allMinutes, hour.since],
    [4 * 75e6 + 2 * 112.5e6, 11_667, 15_000, 15_000, M0 + 4 * 60_000, 6, 6, M0]);
  check("  by how many watched: what it sent over the stream's bitrate, over whole minutes of it",
    hour.byViewers.map((b) => [b.viewers, b.minutes, b.avgKbps, b.perStream, b.perStreamMinutes]),
    [[1, 4, 10_000, 1.25, 3], [2, 2, 15_000, 1.88, 1], [3, 0, null, null, 0], [4, 0, null, null, 0]]);
  const g2 = up.graphs({ from: M0 + 60_000, to: M0 + 3 * 60_000 }, u + 1_000);
  check("a period of its own, from one time to another: by the hour, just what was sent in it",
    [g2.bucket, g2.lastHours, g2.from, g2.to, g2.upload.sentBytes, g2.totals.sentBytes], ["hour", null, M0 + 60_000, M0 + 3 * 60_000, 150e6, 150e6]);
  const last = up.graphs({ hours: 6 }, u + 1_000);
  check("  the last so many hours; by the hour up to three days, by the day after",
    [last.lastHours, last.bucket, last.to - last.from, up.graphs({ hours: 72 }, u).bucket, up.graphs({ hours: 73 }, u).bucket,
      up.graphs({ days: 3 }, u).bucket, up.graphs({ days: 7 }, u).bucket, last.daily.reduce((s, d) => s + d.sentBytes, 0), Math.max(...last.daily.map((d) => d.peakKbps))],
    [6, "hour", 6 * 3_600_000, "hour", "day", "hour", "day", 525e6, 15_000]);
  up.trim(M0 + 3 * 60_000);
  check("removing old history removes what was sent then too", up.graphs({ hours: 1 }, u + 1_000).upload.sentBytes, 75e6 + 2 * 112.5e6);
  up.close();
}
{
  // The bot's port: what each socket wrote since the last count, and those
  // that closed in between.
  const { meterUpload } = await import("../src/services/upload-meter.js");
  const { EventEmitter } = await import("node:events");
  const said: Any[] = [];
  setAdminHooks({ sent: (e) => said.push(e as unknown as Any) });
  const port = new EventEmitter();
  const sock = () => Object.assign(new EventEmitter(), { bytesWritten: 0 });
  const stop = meterUpload(port as never, 3_600_000, () => 42);
  const a = sock();
  const b = sock();
  port.emit("connection", a);
  port.emit("connection", b);
  a.bytesWritten = 1_000;
  b.bytesWritten = 500;
  b.emit("close");
  stop();
  a.bytesWritten = 1_600;
  const stop2 = meterUpload(port as never, 3_600_000, () => 43);
  stop2();
  check("the bot's port: what its sockets wrote, those closed since too, said once", said, [{ at: 42, bytes: 1_500 }]);
  setAdminHooks(null);
}

// ─── What reaches it ─────────────────────────────────────────────
const express = (await import("express")).default;
const { createSession, requireAuth } = await import("../src/middleware/auth.js");
const logRoutes = (await import("../src/routes/logs.js")).default;
const seerrRoutes = (await import("../src/routes/seerr.js")).default;
const { attachWebSocketServer, closeWebSocketServer, adminRooms } = await import("../src/services/sync.js");
const { instanceHosts } = await import("../src/routes/discord.js");
const { WebSocket } = await import("ws");

const heard: { transport: Any[]; clientLog: Any[]; request: Any[] } = { transport: [], clientLog: [], request: [] };
const app = express();
app.use(express.json());
app.use("/api/logs", requireAuth, logRoutes);
app.use("/api/seerr", requireAuth, seerrRoutes);
const server = http.createServer(app);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const token = createSession("222", null);
const post = (p: string, body: unknown) => fetch(origin + p, {
  method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
});

console.log("\n— a player's log lines —");
await post("/api/logs/client", { clientId: "pageZ", sentAt: Date.now(), entries: [{ t: Date.now(), level: "log", tag: "Health", msg: "sample", data: { httpMB: 1 } }] });
check("nothing is built for a recorder that isn't there", heard.clientLog.length, 0);
setAdminHooks({
  transport: (e) => heard.transport.push(e as unknown as Any),
  clientLog: (e) => heard.clientLog.push(e as unknown as Any),
  request: (e) => heard.request.push(e as unknown as Any),
});
const sentAt = Date.now();
await post("/api/logs/client", { clientId: "pageZ", sentAt, entries: [
  { t: sentAt - 60_000, level: "warn", tag: "Video", msg: "waiting (buffer starved)", data: { posS: 12, paused: false } },
] });
const batch = heard.clientLog[0] as { userId: string; clientId: string; entries: Array<Any> } | undefined;
check("the recorder hears them: whose they are, from their session, on the server's clock",
  [batch?.userId, batch?.clientId, batch?.entries[0]?.tag, batch?.entries[0]?.msg, batch?.entries[0]?.level,
    (batch?.entries[0]?.data as Any | undefined)?.posS, Math.abs(Number(batch?.entries[0]?.t) - (sentAt - 60_000)) < 5_000],
  ["222", "pageZ", "Video", "waiting (buffer starved)", "WARN", 12, true]);

console.log("\n— title requests through Seerr —");
const realFetch = globalThis.fetch;
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("http://seerr.test")) return realFetch(input, init);
  const p = url.slice("http://seerr.test/api/v1".length);
  if (p === "/auth/plex") return reply({}, 200, { "Set-Cookie": "connect.sid=s1; Path=/" });
  if (p === "/request") {
    const body = JSON.parse(String(init?.body)) as { mediaId: number };
    return body.mediaId === 1399 ? reply({ message: "exists" }, 409) : reply({ media: { status: 3 } });
  }
  if (p === "/movie/129") return reply({ title: "Spirited Away" });
  if (p === "/tv/1399") return reply({ name: "Game of Thrones" });
  return reply({}, 404);
}) as typeof fetch;
const made = await post("/api/seerr/request", { tmdbId: 129, mediaType: "movie" });
const again = await post("/api/seerr/request", { tmdbId: 1399, mediaType: "tv", seasons: [1, 2] });
check("the Activity's answers are as they were", [made.status, await made.json(), again.status, await again.json()],
  [200, { ok: true, status: 3 }, 409, { error: "Already requested" }]);
const reqs = heard.request as Array<Any & { title?: Promise<string | null> }>;
check("the recorder hears who asked for what, and what came of it",
  reqs.map((r) => [r.userId, r.mediaType, r.tmdbId, r.seasons, r.outcome, r.status]),
  [["222", "movie", 129, null, "requested", 3], ["222", "tv", 1399, [1, 2], "already requested", 409]]);
check("  with each title's name", await Promise.all(reqs.map((r) => r.title)), ["Spirited Away", "Game of Thrones"]);
globalThis.fetch = realFetch;

console.log("\n— a room's commands —");
attachWebSocketServer(server);
const roomId = `rec-${crypto.randomUUID()}`;
instanceHosts.set(roomId, { hostUserId: "111", guildId: "999000", channelId: "888000", createdAt: Date.now() });
const sockets: InstanceType<typeof WebSocket>[] = [];
async function join(userId: string, username: string) {
  const tok = createSession(userId, null);
  const ws = new WebSocket(`${origin.replace(/^http/, "ws")}/ws?token=${tok}`);
  sockets.push(ws);
  const seen: Array<{ type: string }> = [];
  ws.on("message", (d) => seen.push(JSON.parse(String(d))));
  await new Promise<void>((r, j) => { ws.once("open", () => r()); ws.once("error", j); });
  ws.send(JSON.stringify({ type: "join", sessionToken: tok, instanceId: roomId, userId, username }));
  for (let i = 0; i < 80 && !seen.some((m) => m.type === "state"); i++) await sleep(25);
  return (m: Record<string, unknown>) => ws.send(JSON.stringify(m));
}
const host = await join("111", "alex");
const viewer = await join("222", "robin");
host({ type: "watching", value: true });
host({ type: "play", ratingKey: "58860", title: "Ghost Stories", subtitles: false, hlsSessionId: crypto.randomUUID(),
  position: 0, sessionOffset: 0, audioStreamId: 0, subtitleStreamId: 0 });
await sleep(150);
viewer({ type: "pause", position: 5 });
host({ type: "seek", position: 300, cause: "skip intro" });
await sleep(150);
host({ type: "seek", position: 320, cause: "<script>" });
await sleep(150);
host({ type: "stop", cause: "finished" });
for (let i = 0; i < 40 && !heard.transport.some((e) => e.type === "stop"); i++) await sleep(25);
check("the recorder hears what the room acted on, by whom; not a viewer's pause it refused",
  heard.transport.map((e) => [e.type, e.username, e.role, e.ratingKey]),
  [["play", "alex", "host", "58860"], ["seek", "alex", "host", "58860"], ["seek", "alex", "host", "58860"], ["stop", "alex", "host", "58860"]]);
const seek = heard.transport.find((e) => e.type === "seek");
check("  a seek: to where", seek?.toS, 300);
check("  what each came from, as the player said; nothing for a cause it doesn't know",
  heard.transport.map((e) => e.cause ?? null), [null, "skip intro", null, "finished"]);
check("  a stop: the title it stopped", heard.transport.at(-1)?.title, "Ghost Stories");

setAdminHooks({ transport: () => { throw new Error("a bug in the recorder"); } });
host({ type: "play", ratingKey: "58861", title: "Ghost Stories 2", subtitles: false, hlsSessionId: crypto.randomUUID(),
  position: 0, sessionOffset: 0, audioStreamId: 0, subtitleStreamId: 0 });
const warned = console.warn;
console.warn = () => {};
for (let i = 0; i < 40 && adminRooms().find((r) => r.id === roomId)?.ratingKey !== "58861"; i++) await sleep(25);
console.warn = warned;
check("a recorder that throws costs the room nothing", [adminHooks.on, adminRooms().find((r) => r.id === roomId)?.title],
  [true, "Ghost Stories 2"]);
setAdminHooks(null);

for (const ws of sockets) ws.terminate();
closeWebSocketServer();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
