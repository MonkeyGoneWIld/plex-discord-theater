/**
 * What the Theater Dashboard says beyond who watched what (admin/recorder.ts,
 * admin/data.ts): each player's distance from the room and what it has
 * downloaded ahead, live; requests for host that came to nothing; a title
 * whose sound is shorter than its picture; what the players had from each
 * source minute by minute, and each viewer's own position; the clients a
 * person used and what each plays, and their time as host, co-host and
 * viewer; Statistics by client, transcode reasons over time, sessions by
 * weekday and hour, titles that needed a workaround; and a log file's lines
 * from one session's time.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.THUMB_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "admin-insights-"));
process.env.LOG_TO_FILE = "0";
process.env.LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "admin-insights-logs-"));
process.env.PLEX_TOKEN = "test-token";
process.env.PLEX_URL = "http://127.0.0.1:9";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       expected ${e}\n       got      ${a}`); }
}

const { Recorder, roleTime } = await import("../src/admin/recorder.js");
const { readLog } = await import("../src/admin/data.js");
type Overview = import("../src/admin/data.js").Overview;
type Inst = { hostUserId: string; guildId: string | null; channelId: string | null; createdAt: number };
type Any = Record<string, unknown>;

// A room as Now Playing has it, made up. Monday 13 January 2027, 20:00 UTC.
let t = Date.UTC(2027, 0, 11, 20, 0);
const DESK = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) discord/1.0.9 Chrome/124.0 Electron/30.0 Safari/537.36";
const PHONE = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36 Discord/250";
const client = (userId: string, username: string, o: Any = {}) => ({
  userId, username, role: "viewer", connected: true, watching: true, away: false, loading: false,
  joinedAt: t, variantKey: "v0", subtitleStreamId: 0, quality: 0, caps: ["h264"], av1Encode: false, device: null, ...o,
});
const stream = (variantKey: string, hlsSessionId: string, o: Any = {}) => ({
  variantKey, hlsSessionId, audioStreamId: 1, subtitleStreamId: 0, quality: 0, ownerUserId: null,
  sessionOffset: 0, idleS: null, viewers: [] as string[], isHostStream: variantKey === "v0", engine: "ffmpeg",
  decision: "copy", reason: null, summary: "Direct stream", kbps: 6000, kbpsSource: null,
  plexTranscodeKey: null, plexClientId: null, notes: {}, notesAt: null, ...o,
});
const R: Any = {
  id: "RI", ratingKey: "173916", title: "Verity", playing: true, positionS: 0, waiting: false,
  hostWaiting: false, stateAgeS: 0, hostHeartbeatAgeS: 0, hostVariantKey: "v0", hostSubtitleId: 0, coHostIds: [],
  queue: [], heldFor: null, away: [],
  discord: { guildId: "G1", channelId: "C1", hostUserId: "111", startedAt: t },
  clients: [client("111", "alex", { role: "host", device: DESK, caps: ["h264", "hevc"] })],
  streams: [stream("v0", "SI1", { viewers: ["111"] })],
};
let rooms: Any[] = [R];
const instances = new Map<string, Inst>([["RI", { hostUserId: "111", guildId: "G1", channelId: "C1", createdAt: t }]]);
const rec = new Recorder({ dbPath: path.join(process.env.THUMB_CACHE_DIR, "admin.sqlite"), now: () => t,
  source: () => ({ at: t, totals: {}, rooms }) as unknown as Overview, instances: () => instances });
const step = (ms: number) => { t += ms; if (R.playing) R.positionS = (R.positionS as number) + ms / 1000; rec.tick(t); };
const health = (session: string, o: Any) => ({ t, level: "LOG", tag: "Health", msg: "sample",
  data: { session, paused: false, posS: R.positionS, playedS: 1, ...o } });
const say = (userId: string, ...entries: Any[]) => rec.clientLog({ at: t, userId, clientId: `page${userId}`,
  entries: entries as unknown as Parameters<typeof rec.clientLog>[0]["entries"] });
const live = (userId: string) => rec.annotate({ at: t, totals: {}, rooms: [structuredClone(R)] } as unknown as Overview)
  .rooms[0].clients.find((c) => c.userId === userId)?.player;

t += 60_000;
rec.transport({ at: t, roomId: "RI", type: "play", userId: "111", username: "alex", role: "host", fromS: 0, toS: 0,
  ratingKey: "173916", title: "Verity" } as Parameters<typeof rec.transport>[0]);
rec.tick(t);
const pid = rec.history()[0].id;
step(2_000);
(R.clients as Any[]).push(client("222", "robin", { device: PHONE, caps: ["h264"] }));
(R.streams as Any[]).push(stream("v1", "SI2", { viewers: ["222"], ownerUserId: "222", decision: "transcode",
  reason: "Subtitle burn-in (image-based)", summary: "Transcode: subtitles burned in", notes: { range: "HDR10 → SDR (tone-mapped)" } }));
(R.clients as Any[])[1] = client("222", "robin", { device: PHONE, caps: ["h264"], variantKey: "v1" });
step(2_000);

console.log("\n— live: each player's distance from the room, and what it has ahead —");
say("111", health("SI1", { httpMB: 1, p2pMB: 0, driftS: "n/a(host)", downloadedAheadS: 42 }));
say("222", health("SI2", { httpMB: 1, p2pMB: 0, edgeHitMB: "0.0", edgeMB: "0.0", driftS: -0.31, downloadedAheadS: 30 }));
step(10_000);
say("222", health("SI2", { httpMB: 4, p2pMB: 1, edgeHitMB: "1.0", edgeMB: "2.0", driftS: 2.66, downloadedAheadS: 8.04 }));
step(2_000);
const r222 = live("222");
check("a viewer's distance from the room and what it has downloaded ahead, the latest and the last minutes'",
  [r222?.driftS, r222?.aheadS, r222?.health?.map((h) => [h[1], h[2]])], [2.66, 8, [[-0.31, 30], [2.66, 8]]]);
check("  the host's distance is nothing: the room follows them", [live("111")?.driftS, live("111")?.aheadS], [null, 42]);
t += 11 * 60_000;
say("222", health("SI2", { httpMB: 5, p2pMB: 1, edgeHitMB: "1.0", edgeMB: "2.0", driftS: 0, downloadedAheadS: 20 }));
check("  only the last ten minutes are kept", live("222")?.health?.map((h) => h[2]), [20]);
step(10_000);
say("222", health("SI2", { httpMB: 5, p2pMB: 1, edgeHitMB: "1.0", edgeMB: "2.0", driftS: 0, downloadedAheadS: 140 }));
step(10_000);
// 19 November: the buffer's trend on Activity ran on from the episode before.
say("222", health("SI4", { httpMB: 0, p2pMB: 0, edgeHitMB: "0.0", edgeMB: "0.0", driftS: 0.2, downloadedAheadS: 6 }));
check("  a new stream's are its own, not run on from the one before", live("222")?.health?.map((h) => h[2]), [6]);

console.log("\n— requests for host that came to nothing —");
rec.hostRequest({ at: t, roomId: "RI", outcome: "asked", userId: "222", username: "robin", hostId: "111", hostName: "alex", away: true, waitS: 30 });
rec.hostRequest({ at: t + 1, roomId: "RI", outcome: "declined", userId: "222", username: "robin", hostId: "111", hostName: "alex" });
rec.hostRequest({ at: t + 2, roomId: "RI", outcome: "ended", userId: "222", username: "robin", hostId: "111", hostName: null, why: "asker left" });
const reqs = rec.play(pid)!.events.filter((e) => ["asked for host", "request declined", "request ended"].includes(e.kind));
check("each is in the session: who asked, of whom, the host away, the time to answer, why it ended; a host gone named from before",
  reqs.map((e) => [e.kind, e.username, e.detail]),
  [["asked for host", "robin", { host: "alex", away: true, waitS: 30 }], ["request declined", "robin", { host: "alex" }],
    ["request ended", "robin", { host: "alex", why: "asker left" }]]);
check("  where the room was in the title", reqs.map((e) => typeof e.posS), ["number", "number", "number"]);

console.log("\n— a title whose sound is shorter than its picture —");
rec.streamIssue({ at: t, hlsSessionId: "SI2", ratingKey: "173916", kind: "short sound", detail: { soundEndsS: 6800.5, pictureEndsS: 6823 } });
rec.streamIssue({ at: t + 5, hlsSessionId: "SI2", ratingKey: "173916", kind: "short sound", detail: { soundEndsS: 6800.5, pictureEndsS: 6823 } });
const short = rec.play(pid)!.events.filter((e) => e.kind === "short sound");
check("written once a session, with where each ends", short.map((e) => [e.userId, e.detail]),
  [[null, { ratingKey: "173916", session: "SI2", soundEndsS: 6800.5, pictureEndsS: 6823 }]]);

console.log("\n— what the players had, minute by minute; each viewer's own position —");
// (Each "?? []" lets a recorder without these fail each check on its own.)
const d = rec.play(pid)!;
const flow = d.flow ?? [];
const positions = d.positions ?? {};
check("what came from the server, Discord's cache and other viewers, in the minute it came",
  [flow.length >= 1, flow.reduce((s, m) => s + m[1], 0), flow.reduce((s, m) => s + m[2], 0), flow.reduce((s, m) => s + m[3], 0),
    flow.every((m) => m[0] % 60_000 === 0)], [true, 5e6, 1e6, 1e6, true]);
check("  each viewer's player's positions, by viewer", [Object.keys(positions).sort(), (positions["222"]?.length ?? 0) > 0],
  [["111", "222"], true]);

console.log("\n— a person's clients and what each plays; their time by role —");
step(2_000);
(R.clients as Any[])[1] = client("222", "robin", { device: DESK, caps: ["h264", "hevc", "av1"], av1Encode: true, variantKey: "v1" });
step(10_000);
(R.clients as Any[])[1] = { ...(R.clients as Any[])[1], role: "co-host" };
step(10_000);
(R.clients as Any[])[1] = { ...(R.clients as Any[])[1], role: "host" };
(R.clients as Any[])[0] = { ...(R.clients as Any[])[0], role: "viewer" };
// Each change is seen at the next look: co-host for 10 s, then host for 10 s.
step(10_000);
step(10_000);
const robin = rec.person("222")!;
check("each client they were seen on, the latest first, with what its player plays",
  (robin.clients ?? []).map((c) => [c.device === DESK ? "desk" : "phone", c.caps, c.av1Encode, c.sessions]),
  [["desk", ["h264", "hevc", "av1"], true, 1], ["phone", ["h264"], false, 1]]);
const roles = robin.roleS ?? { host: 0, coHost: 0, viewer: 0 };
check("  their time as host, co-host and viewer", [roles.host, roles.coHost, roles.viewer > 0], [10, 10, true]);
check("roles over time: from joining, each change, leaving and coming back, inside the stretch asked",
  roleTime([{ at: 0, kind: "joined", detail: { role: "viewer" } }, { at: 10_000, kind: "role", detail: { to: "co-host" } },
    { at: 20_000, kind: "role", detail: { to: "host" } }, { at: 30_000, kind: "left", detail: {} },
    { at: 40_000, kind: "switched client", detail: {} }, { at: 45_000, kind: "came back", detail: { role: "viewer" } },
    { at: 60_000, kind: "role", detail: { to: "host" } }], 5_000, 50_000),
  { host: 10, "co-host": 10, viewer: 10 });

console.log("\n— Statistics —");
// Another title in another room: the short sound planned for it is written when its play opens.
const R2: Any = { ...structuredClone(R), id: "RJ", ratingKey: null, title: null, playing: false,
  discord: { guildId: "G1", channelId: "C2", hostUserId: "333", startedAt: t },
  clients: [client("333", "sam", { role: "host", device: PHONE })], streams: [stream("v0", "SJ1", { viewers: ["333"] })] };
instances.set("RJ", { hostUserId: "333", guildId: "G1", channelId: "C2", createdAt: t });
rooms = [R, R2];
// Its host is in the room before they choose the title, as a host is.
step(2_000);
Object.assign(R2, { ratingKey: "58855", title: "Ghost Stories", playing: true });
// Planned as the stream was set up, before the room's play opened: it waits for it, half a minute at most.
rec.streamIssue({ at: t - 40_000, hlsSessionId: "SOLD", ratingKey: "58855", kind: "short sound", detail: { soundEndsS: 1, pictureEndsS: 2 } });
rec.streamIssue({ at: t - 5_000, hlsSessionId: "SJ1", ratingKey: "58855", kind: "short sound", detail: { soundEndsS: 1700, pictureEndsS: 1740 } });
rec.transport({ at: t, roomId: "RJ", type: "play", userId: "333", username: "sam", role: "host", fromS: 0, toS: 0,
  ratingKey: "58855", title: "Ghost Stories" } as Parameters<typeof rec.transport>[0]);
step(2_000);
const pj = rec.history().find((p) => p.roomId === "RJ")!.id;
check("a short sound planned before its session opened is written to it; one planned too long before is not",
  rec.play(pj)!.events.filter((e) => e.kind === "short sound").map((e) => (e.detail as Any).soundEndsS), [1700]);
check("a host's client from before the session counts the session", (rec.person("333")!.clients ?? []).map((c) => [c.device === PHONE ? "phone" : c.device, c.sessions]),
  [["phone", 1]]);
step(2_000);
const g = rec.graphs({ days: 0, zone: "UTC" });
check("transcode reasons by day", (g.reasonDays ?? []).map((r) => [new Date(r.day).toISOString().slice(0, 10), r.reason, r.streams]),
  [["2027-01-11", "Subtitle burn-in (image-based)", 1]]);
check("sessions by weekday and hour (Sunday 0)", (g.heat ?? []).map((c) => [c.weekday, c.hour, c.plays]), [[1, 20, 2]]);
const byClient = (g.clients ?? []).map((c) => [c.device === DESK ? "desk" : c.device === PHONE ? "phone" : c.device, c.sessions, c.ownStreams, c.transcoded])
  .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
check("each viewer's session by the client they finished it on: their own streams, and those transcoded",
  byClient, [["desk", 2, 1, 1], ["phone", 1, 0, 0]]);
check("titles that needed a workaround: short sound, subtitles burned in, tone-mapped; by session",
  (g.problems ?? []).map((p) => [p.ratingKey, p.title, p.shortSound, p.burned, p.toneMapped, p.sessions]).sort(),
  [["173916", "Verity", 1, 1, 1, 1], ["58855", "Ghost Stories", 1, 0, 0, 1]]);

console.log("\n— a log file's lines from one session's time —");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-insights-log-"));
  const name = "theater-2027-01-11.log";
  fs.writeFileSync(path.join(dir, name), [
    "2027-01-11T19:59:00.000Z [Sync] before",
    "2027-01-11T20:01:00.000Z [Sync] during",
    "    at a stack line that follows it",
    "2027-01-11T20:05:00.000Z [HLS] also during",
    "2027-01-11T20:09:00.000Z [Sync] after",
    "    and its stack line",
  ].join("\n"));
  const got = await readLog(name, { from: Date.UTC(2027, 0, 11, 20, 0), to: Date.UTC(2027, 0, 11, 20, 6) }, dir);
  check("only the lines written between, and the lines without a time that follow one of them",
    got?.lines.map((l) => l.text), ["during", "    at a stack line that follows it", "also during"]);
}

console.log(`\n${pass} passed, ${fail} failed`);
rec.close();
process.exit(fail > 0 ? 1 : 0);
