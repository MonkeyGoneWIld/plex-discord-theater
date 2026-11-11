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

const { Recorder } = await import("../src/admin/recorder.js");
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
  decision: null, reason: null, summary: "Starting — no details yet", kbps: null, kbpsSource: null,
  plexTranscodeKey: null, plexClientId: null, notes: {}, notesAt: null, ...o,
});
const R1: Any = {
  id: "R1", ratingKey: "58860", title: "Ghost Stories", playing: true, positionS: 0, waiting: false,
  hostWaiting: false, stateAgeS: 0, hostHeartbeatAgeS: 0, hostVariantKey: "v0", hostSubtitleId: 0, coHostIds: [],
  queue: [], heldFor: null, away: [],
  discord: { guildId: "G1", channelId: "C1", hostUserId: "111", startedAt: t },
  clients: [client("111", "artemidorus", { role: "host" })],
  streams: [stream("v0", "S1", { viewers: ["111"] })],
};
let rooms: Any[] = [];
const source = () => ({ at: t, totals: {}, rooms }) as unknown as Overview;
const instances = new Map<string, Inst>([["OLD", { hostUserId: "999", guildId: "G0", channelId: "C0", createdAt: t - 5_000 }]]);

const dbPath = path.join(process.env.THUMB_CACHE_DIR, "admin.sqlite");
const rec = new Recorder({ dbPath, now: () => t, source, instances: () => instances });
const started = t;
const transport = (o: Any) => rec.transport({
  at: t, roomId: "R1", type: "play", userId: "111", username: "artemidorus", role: "host", fromS: 0, toS: 0,
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
  usage0.filter((u) => u.kind === "join").map((u) => [u.userId, u.username, u.guildId]), [["111", "artemidorus", "G1"]]);
const play1 = rec.history()[0];
check("the host's play opens a play of the title, where it is in Discord",
  [play1.title, play1.ratingKey, play1.roomId, play1.guildId, play1.channelId, play1.hostUserId, play1.endedAt],
  ["Ghost Stories", "58860", "R1", "G1", "C1", "111", null]);
check("  with what happened, in order", kinds(play1.id), ["play", "joined", "stream started"]);

console.log("\n— watching, and a viewer joining —");
step(2_000);
(R1.clients as Any[]).push(client("222", "crispymage"));
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
  summary: "Re-encoded: 10-bit picture: frames dropped on this player", kbps: 4000,
  notes: { engine: "ffmpeg", video: "transcode", reason: "10-bit picture: frames dropped on this player" }, notesAt: t,
});
step(2_000);
const s1 = rec.play(play1.id)!.streams[0];
check("why a stream is re-encoded, when its playlist says", [s1.hlsSessionId, s1.decision, s1.reason, s1.kbps, s1.notes.video],
  ["S1", "transcode", "10-bit picture: frames dropped on this player", 4000, "transcode"]);
check("  and the line saying it started says it too",
  (eventsOf(play1.id, "stream started")[0].detail as Any).summary, "Re-encoded: 10-bit picture: frames dropped on this player");
(R1.streams as Any[])[0] = { ...(R1.streams as Any[])[0], sessionOffset: 600 };
R1.positionS = 600;
step(2_000);
check("a stream started again further on, after a seek",
  eventsOf(play1.id, "stream restarted").map((e) => [(e.detail as Any).fromOffsetS, (e.detail as Any).toOffsetS]), [[0, 600]]);

console.log("\n— what a viewer changes —");
(R1.clients as Any[])[1] = client("222", "crispymage", { subtitleStreamId: 3, quality: 2, variantKey: "v1" });
(R1.streams as Any[])[0] = { ...(R1.streams as Any[])[0], viewers: ["111"] };
(R1.streams as Any[])[1] = stream("v1", "S2", { ownerUserId: "222", audioStreamId: 2, subtitleStreamId: 3, viewers: ["222"] });
step(2_000);
check("their stream, subtitles and quality, each from what to what",
  rec.play(play1.id)!.events.filter((e) => e.userId === "222" && ["stream changed", "subtitles", "quality"].includes(e.kind))
    .map((e) => [e.kind, (e.detail as Any).from, (e.detail as Any).to]),
  [["stream changed", "v0", "v1"], ["subtitles", 0, 3], ["quality", 0, 2]]);
check("  and the stream of their own that it made, by whom", eventsOf(play1.id, "stream started").map((e) => [(e.detail as Any).variant, e.username]),
  [["v0", null], ["v1", "crispymage"]]);
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
  // A new player (another stream): its counters start again.
  health({ session: "S9", httpMB: 2, p2pMB: 0, edgeHitMB: "4.0", edgeMB: "9.0" }, t + 20_000),
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
  video("waiting (buffer starved)", b),
  video("playing", b + 1_500),
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

console.log("\n— seeks, the room waiting, leaving, the end —");
transport({ type: "seek", fromS: 100, toS: 400 });
R1.waiting = true;
step(2_000);
R1.waiting = false;
step(2_000);
(R1.clients as Any[])[1] = client("222", "crispymage", { away: true, subtitleStreamId: 3, quality: 2, variantKey: "v1" });
step(2_000);
(R1.clients as Any[])[1] = client("222", "crispymage", { connected: false, away: true, subtitleStreamId: 3, quality: 2, variantKey: "v1" });
step(2_000);
check("a seek from where to where, by whom", eventsOf(play1.id, "seek").map((e) => [e.username, (e.detail as Any).fromS, (e.detail as Any).toS]),
  [["artemidorus", 100, 400]]);
check("  the room holding everybody, for how long", eventsOf(play1.id, "room waited").map((e) => (e.detail as Any).ms), [2000]);
check("  away from Discord, then gone", rec.play(play1.id)!.events.filter((e) => e.userId === "222").slice(-2).map((e) => e.kind),
  ["away from Discord", "left"]);
transport({ type: "stop", fromS: 700 });
const ended = rec.play(play1.id)!;
check("a stop ends the play: by whom, where, and every stream with it",
  [ended.play.endReason, ended.play.endBy, ended.play.endedAt === t, ended.streams.every((s) => s.endedAt !== null), kinds(play1.id).slice(-2)],
  ["stopped", "artemidorus", true, true, ["stop", "ended"]]);
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
  [["artemidorus", "crispymage"], 3, 1, 2e6 + 15e6, 1]);
check("  found by a viewer's name, or a title", [rec.history({ q: "crispy" }).map((p) => p.title), rec.history({ q: "paprika" }).map((p) => p.title)],
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
  [["333", "tv", 1399, [1, 2], "already requested", 409, null], ["crispymage", "movie", 129, null, "requested", 2, "Spirited Away"]]);

console.log("\n— people, places, Discord's cache —");
const everyone = rec.people();
// crispymage's request is the latest anybody was seen; Paprika and Perfect
// Blue were played with no room behind them, so hosted, but watched by nobody.
check("everybody seen, the latest first: what they watched, hosted, launched and asked for",
  everyone.map((p) => [p.userId, p.username, p.plays, p.hosted, p.launches, p.requests]),
  [["222", "crispymage", 1, 0, 0, 1], ["111", "artemidorus", 1, 3, 1, 0]]);
check("  with what they had, all of it", [everyone[0].httpBytes, everyone[0].edgeHitBytes, everyone[0].botBytes, everyone[0].stalls, everyone[0].lastTitle],
  [12e6, 4e6, 8e6, 1, "Ghost Stories"]);
check("  found by a name or an ID; a page at a time; wildcards only characters",
  [rec.people({ q: "crispy" }).map((p) => p.userId), rec.people({ q: "111" }).map((p) => p.userId),
    rec.people({ limit: 1, offset: 1 }).map((p) => p.userId), rec.people({ q: "%" }).length],
  [["222"], ["111"], ["111"], 0]);
const crispy = rec.person("222")!;
check("one person: each play they were in, as what, with their own data; what they asked for; where",
  [crispy.plays.map((p) => [p.title, p.role, p.httpBytes, p.hostName]), crispy.requests.map((r) => r.title),
    crispy.places.map((p) => [p.guildId, p.channelId, p.launches, p.joins])],
  [[["Ghost Stories", "viewer", 12e6, "artemidorus"]], ["Spirited Away"], [["G1", "C1", 0, 1]]]);
check("  and nobody by an ID never seen", rec.person("404"), null);
const places = rec.places();
check("each server, and each of its channels: launches, joins, who, plays",
  places.map((g) => [g.guildId, g.launches, g.joins, g.people, g.plays,
    g.channels.map((c) => [c.channelId, c.launches, c.joins, c.names.map((n) => n.username), c.plays])]),
  [["G1", 1, 2, 2, 3, [["C1", 1, 2, ["crispymage", "artemidorus"], 3]]]]);
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
  [rec.requests({ q: "spirited" }).map((r) => r.tmdbId), rec.requests({ q: "1399" }).map((r) => r.tmdbId), rec.requests({ q: "crispy" }).length],
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
open(room("GA", "A1", "Akira", "G7", [["111", "artemidorus"], ["222", "crispymage"]], [
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
  [gr.play(gr.history({ q: "crispymage" })[0].id)!.viewers.reduce((s, v) => s + v.watchedS, 0), 6e6, 4e6, 2e6, 4e6, 1e6]);
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
const host = await join("111", "artemidorus");
const viewer = await join("222", "crispymage");
host({ type: "watching", value: true });
host({ type: "play", ratingKey: "58860", title: "Ghost Stories", subtitles: false, hlsSessionId: crypto.randomUUID(),
  position: 0, sessionOffset: 0, audioStreamId: 0, subtitleStreamId: 0 });
await sleep(150);
viewer({ type: "pause", position: 5 });
host({ type: "seek", position: 300 });
await sleep(150);
host({ type: "stop" });
for (let i = 0; i < 40 && !heard.transport.some((e) => e.type === "stop"); i++) await sleep(25);
check("the recorder hears what the room acted on, by whom; not a viewer's pause it refused",
  heard.transport.map((e) => [e.type, e.username, e.role, e.ratingKey]),
  [["play", "artemidorus", "host", "58860"], ["seek", "artemidorus", "host", "58860"], ["stop", "artemidorus", "host", "58860"]]);
const seek = heard.transport.find((e) => e.type === "seek");
check("  a seek: to where", seek?.toS, 300);
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
