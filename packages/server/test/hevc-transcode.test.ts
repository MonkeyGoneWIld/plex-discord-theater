/**
 * HEVC transcodes and the picture size asked of Plex.
 *
 * The sizing rule is pure. The HEVC half runs against a real sync server, the
 * same way variant-sync.test.ts does: real WebSockets and room state, no Plex.
 * What is checked is who gets told to rebuild their stream, and when — the
 * transcode that rebuild starts is decided by mayStartHevc, checked directly.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";

process.env.THUMB_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hevc-transcode-"));

// After THUMB_CACHE_DIR, for the same reason as variant-sync.test.ts: the stores
// open their databases as they load.
const { attachWebSocketServer, closeWebSocketServer, mayStart, mayStartHevc, sessionHostUserId } = await import("../src/services/sync.js");
const {
  recordSessionVideoCodec, recordHevcWithheld, isHevcSession, recordSessionAudioNeeds, recordWithheld, sessionNeeds,
  recordSessionHdr, recordSessionTenBit, recordSessionUhd,
} = await import("../src/routes/plex.js");
const { plexReencodeKbps, transcodeFrame } = await import("../src/services/media-versions.js");
const { createSession } = await import("../src/middleware/auth.js");
const { instanceHosts } = await import("../src/routes/discord.js");

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

console.log("\n— the picture size asked of Plex —");
check("1080p stays 1080p", transcodeFrame({ width: 1920, height: 1080 }), "1920x1080");
check("a 1088-row x265 encode keeps its rows", transcodeFrame({ width: 1920, height: 1088 }), "1920x1088");
check("16:10 is let through", transcodeFrame({ width: 1920, height: 1200 }), "1920x1200");
check("2K DCI scope is let through", transcodeFrame({ width: 2048, height: 858 }), "2048x1080");
check("smaller files are never upscaled", transcodeFrame({ width: 1280, height: 720 }), "1920x1080");
check("1440p stays 1440p", transcodeFrame({ width: 2560, height: 1440 }), "2560x1440");
check("4K stays 4K", transcodeFrame({ width: 3840, height: 2160 }), "3840x2160");
check("unknown size gets a 4K box, never upscaled into", transcodeFrame({}), "3840x2160");
check("for a player that can't decode 4K smoothly: 1440p and 4K come down to 1080p",
  [transcodeFrame({ width: 2560, height: 1440 }, false), transcodeFrame({ width: 3840, height: 2160 }, false), transcodeFrame({}, false)],
  ["1920x1080", "1920x1080", "1920x1080"]);
check("  and a 1088-row encode still keeps its rows", transcodeFrame({ width: 1920, height: 1088 }, false), "1920x1088");

console.log("\n— 4K copied for a player that decodes it —");
{
  const { planCopy, copyNeeds } = await import("../src/services/ffmpeg/plan.js");
  const uhdFile = {
    container: "mkv", width: 3840, height: 2160, bitrateKbps: 40000, durationS: 100,
    streams: [
      { streamType: 1, index: 0, codec: "hevc", bitDepth: 10, profile: "main 10", colorTrc: "bt709" },
      { streamType: 2, index: 1, id: 2, codec: "aac", channels: 2, selected: true },
    ],
  } as unknown as Parameters<typeof planCopy>[0];
  const yes = planCopy(uhdFile, { audioStreamId: null, hevcOk: true, uhdOk: true });
  check("copied at its own size", yes.ok && [yes.width, yes.height], [3840, 2160]);
  check("  and the stream needs 4K of its players", yes.ok && copyNeeds(yes).includes("uhd"), true);
  const no = planCopy(uhdFile, { audioStreamId: null, hevcOk: true, uhdOk: false });
  check("not for a player that can't decode it smoothly", no.ok ? "copied" : no.why, "Above 1080p: this player can't decode it smoothly");
}

console.log("\n— what Plex is asked to re-encode at —");
// Part H, 4 November: Rain Man's 8.9 Mbps Dolby Vision for a screen in SDR,
// asked at 20 Mbps like everything else on the Plex engine.
const rainMan = { width: 1920, height: 1080, bitrate: 8900, videoCodec: "hevc" };
check("an HEVC file in H.264: what its picture needs, not the most there is",
  plexReencodeKbps(20000, rainMan, transcodeFrame(rainMan), "h264"), 14240);
check("in HEVC, its own rate", plexReencodeKbps(20000, rainMan, transcodeFrame(rainMan), "hevc"), 8900);
check("a viewer's lower ceiling is still the most", plexReencodeKbps(8000, rainMan, transcodeFrame(rainMan), "h264"), 8000);
check("an H.264 file with a subtitle burned in: its own rate",
  plexReencodeKbps(20000, { width: 1920, height: 800, bitrate: 12000, videoCodec: "h264" }, "1920x1080", "h264"), 12000);
check("a 4K file made 1080p needs about a third, here still the most",
  plexReencodeKbps(20000, { width: 3840, height: 2160, bitrate: 60000, videoCodec: "hevc" }, "1920x1080", "h264"), 20000);
check("a DVD isn't given bits it never had",
  plexReencodeKbps(20000, { width: 720, height: 480, bitrate: 6000, videoCodec: "mpeg2video" }, "1920x1080", "h264"), 3000);
check("with its bitrate unknown, what was asked",
  plexReencodeKbps(20000, { width: 1920, height: 1080, bitrate: null, videoCodec: "hevc" }, "1920x1080", "h264"), 20000);

const server = http.createServer();
attachWebSocketServer(server);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Msg = Record<string, any>;

class Client {
  ws!: WebSocket;
  seen: Msg[] = [];
  constructor(readonly userId: string, readonly name: string, readonly hevc: boolean, readonly more: Msg = {}) {}

  async connect(instanceId: string) {
    const token = createSession(this.userId, null);
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    await new Promise<void>((r, j) => { this.ws.once("open", () => r()); this.ws.once("error", j); });
    this.ws.on("message", (d) => this.seen.push(JSON.parse(String(d))));
    this.send({ type: "join", sessionToken: token, instanceId, userId: this.userId, username: this.name, hevc: this.hevc, ...this.more });
    await sleep(60);
  }
  send(m: Msg) { this.ws.send(JSON.stringify(m)); }
  /** "Your stream has no transcode, start one" — the rebuild instruction. */
  toldToRebuild() {
    return this.seen.some((m) => m.type === "variant" && m.isOwner === true && m.hlsSessionId === null);
  }
  clear() { this.seen = []; }
  close() { this.ws.close(); }
}

async function join(instanceId: string, userId: string, name: string, hevc: boolean, more: Msg = {}) {
  const c = new Client(userId, name, hevc, more);
  await c.connect(instanceId);
  return c;
}

function newRoom(id: string) {
  instanceHosts.set(id, { hostUserId: "u-host", guildId: null, channelId: null, createdAt: Date.now() });
}

async function startPlayback(host: Client, codec: string) {
  const sid = crypto.randomUUID();
  recordSessionVideoCodec(sid, codec);
  host.send({
    type: "play", ratingKey: "100", title: "A Film", subtitles: false,
    hlsSessionId: sid, position: 0, sessionOffset: 0,
    audioStreamId: 1, subtitleStreamId: 0,
  });
  await sleep(60);
  return sid;
}

console.log("\n— who may be sent HEVC —");
{
  newRoom("hevc-1");
  const host = await join("hevc-1", "u-host", "host", true);
  const a = await join("hevc-1", "u-a", "a", true);
  check("a player that can decode it may start HEVC", mayStartHevc("u-host"), true);
  check("asked by any of them", mayStartHevc("u-a"), true);
  const b = await join("hevc-1", "u-b", "b", false);
  check("a viewer who can't leaves the others' answer alone", mayStartHevc("u-host"), true);
  check("and is H.264 themselves", mayStartHevc("u-b"), false);
  b.close();
  await sleep(60);
  check("somebody in no room gets H.264", mayStartHevc("u-nobody"), false);
  [host, a].forEach((c) => c.close());
}

console.log("\n— someone who can't decode HEVC joins an HEVC room —");
{
  newRoom("hevc-2");
  const host = await join("hevc-2", "u-host", "host", true);
  const a = await join("hevc-2", "u-a", "a", true);
  const sid = await startPlayback(host, "hevc");
  check("the session counts as HEVC", isHevcSession(sid), true);
  [host, a].forEach((c) => c.clear());

  const b = await join("hevc-2", "u-b", "b", false);
  await sleep(60);
  check("the host's stream is left as it is", host.toldToRebuild(), false);
  check("the other viewer hears nothing", a.seen.filter((m) => m.type === "variant").length, 0);
  const bState = b.seen.find((m) => m.type === "state")?.variant;
  check("the newcomer lands on a stream of its own", bState?.variantKey, "1:0/h264");
  check("which it brings up itself", [bState?.isOwner, bState?.hlsSessionId], [true, null]);
  check("in H.264", mayStartHevc("u-b"), false);

  const twinSid = crypto.randomUUID();
  recordSessionVideoCodec(twinSid, "h264");
  b.send({ type: "variant-session", hlsSessionId: twinSid, sessionOffset: 30 });
  await sleep(60);
  check("bringing it up moves nobody else", [host.toldToRebuild(), a.seen.filter((m) => m.type === "variant").length], [false, 0]);

  const c = await join("hevc-2", "u-c", "c", false);
  await sleep(60);
  const cState = c.seen.find((m) => m.type === "state")?.variant;
  check("a second one who can't follows the first one's stream", [cState?.variantKey, cState?.hlsSessionId, cState?.isOwner], ["1:0/h264", twinSid, false]);

  // The host restarts its stream — a far seek, say — and the ones who can't stay on theirs.
  [b, c].forEach((x) => x.clear());
  const sid2 = crypto.randomUUID();
  recordSessionVideoCodec(sid2, "hevc");
  host.send({
    type: "play", ratingKey: "100", title: "A Film", subtitles: false,
    hlsSessionId: sid2, position: 300, sessionOffset: 300,
    audioStreamId: 1, subtitleStreamId: 0,
  });
  await sleep(60);
  check("the viewer who can follows the host's restart", a.seen.filter((m) => m.type === "variant").at(-1)?.hlsSessionId, sid2);
  check("the ones who can't aren't sent it", [b, c].map((x) => x.seen.some((m) => m.type === "variant" && m.hlsSessionId === sid2)), [false, false]);

  // A new title: everybody on the host's, and whoever can't play it a stream of their own again.
  [a, b, c].forEach((x) => x.clear());
  const sid3 = crypto.randomUUID();
  recordSessionVideoCodec(sid3, "hevc");
  host.send({
    type: "play", ratingKey: "200", title: "Another Film", subtitles: false,
    hlsSessionId: sid3, position: 0, sessionOffset: 0,
    audioStreamId: 5, subtitleStreamId: 0,
  });
  await sleep(60);
  check("a new title puts the viewer who can on the host's stream", a.seen.filter((m) => m.type === "variant").at(-1)?.hlsSessionId, sid3);
  const bNew = b.seen.filter((m) => m.type === "variant").at(-1);
  check("and the ones who can't on one of their own for it", [bNew?.ratingKey, bNew?.variantKey, bNew?.hlsSessionId], ["200", "5:0/h264", null]);
  check("one of them bringing it up", [b, c].filter((x) => x.seen.filter((m) => m.type === "variant").at(-1)?.isOwner).length, 1);
  [host, a, b, c].forEach((x) => x.close());
}

console.log("\n— a joiner who can decode it changes nothing —");
{
  newRoom("hevc-3");
  const host = await join("hevc-3", "u-host", "host", true);
  await startPlayback(host, "hevc");
  host.clear();
  const a = await join("hevc-3", "u-a", "a", true);
  await sleep(60);
  check("no rebuild", host.toldToRebuild(), false);
  check("on the host's stream", a.seen.find((m) => m.type === "state")?.variant?.variantKey, "1:0");
  [host, a].forEach((c) => c.close());
}

console.log("\n— a viewer whose player fails to decode HEVC withdraws —");
{
  newRoom("hevc-4");
  const host = await join("hevc-4", "u-host", "host", true);
  const a = await join("hevc-4", "u-a", "a", true);
  await startPlayback(host, "hevc");
  host.clear();
  a.clear();
  a.send({ type: "caps", hevc: false });
  await sleep(60);
  check("the host is left alone", host.toldToRebuild(), false);
  check("the viewer is given a stream of its own to bring up", a.toldToRebuild(), true);
  check("and the host may still start HEVC", mayStartHevc("u-host"), true);
  a.clear();
  a.send({ type: "caps", hevc: false });
  await sleep(60);
  check("saying it twice does nothing more", a.seen.length, 0);
  a.send({ type: "caps", hevc: true });
  await sleep(60);
  check("and a client can't talk itself back into HEVC", mayStartHevc("u-a"), false);
  [host, a].forEach((c) => c.close());
}

console.log("\n— a host whose player turns out not to decode HEVC —");
{
  newRoom("hevc-6");
  const host = await join("hevc-6", "u-host", "host", true);
  const a = await join("hevc-6", "u-a", "a", true);
  const sid = await startPlayback(host, "hevc");
  [host, a].forEach((c) => c.clear());
  host.send({ type: "caps", hevc: false });
  await sleep(60);
  check("the host is given an H.264 stream of its own to bring up", host.toldToRebuild(), true);
  check("as H.264", mayStartHevc("u-host"), false);
  const aOn = a.seen.filter((m) => m.type === "variant").at(-1);
  check("the viewer stays on the copy, driving it now", [aOn?.variantKey, aOn?.hlsSessionId, aOn?.isOwner], ["1:0", sid, true]);
  check("and may still start HEVC", mayStartHevc("u-a"), true);
  [host, a].forEach((c) => c.close());
}

console.log("\n— a host who can't decode HEVC starting an HEVC film —");
{
  newRoom("hevc-7");
  const host = await join("hevc-7", "u-host", "host", false);
  const a = await join("hevc-7", "u-a", "a", true);
  [host, a].forEach((c) => c.clear());
  // The host's start: re-encoded for want of HEVC, a copy being possible.
  const sid = crypto.randomUUID();
  recordSessionVideoCodec(sid, "h264");
  recordHevcWithheld(sid);
  host.send({
    type: "play", ratingKey: "100", title: "A Film", subtitles: false,
    hlsSessionId: sid, position: 0, sessionOffset: 0,
    audioStreamId: 1, subtitleStreamId: 0,
  });
  await sleep(60);
  const aOn = a.seen.filter((m) => m.type === "variant").at(-1);
  check("the viewer who can play HEVC is given a copy of its own to bring up", [aOn?.variantKey, aOn?.isOwner, aOn?.hlsSessionId], ["1:0", true, null]);
  check("and may start it as HEVC", mayStartHevc("u-a"), true);
  check("the host stays on its own", host.seen.some((m) => m.type === "variant" && m.hlsSessionId === null), false);
  const copySid = crypto.randomUUID();
  recordSessionVideoCodec(copySid, "hevc");
  a.send({ type: "variant-session", hlsSessionId: copySid, sessionOffset: 0 });
  await sleep(60);
  check("bringing it up moves nobody else", host.seen.filter((m) => m.type === "variant").some((m) => m.hlsSessionId === copySid), false);

  const b = await join("hevc-7", "u-b", "b", true);
  await sleep(60);
  const bState = b.seen.find((m) => m.type === "state")?.variant;
  check("another who can play HEVC, joining, follows the copy", [bState?.variantKey, bState?.hlsSessionId, bState?.isOwner], ["1:0", copySid, false]);
  const c = await join("hevc-7", "u-c", "c", false);
  await sleep(60);
  const cState = c.seen.find((m) => m.type === "state")?.variant;
  check("one who can't follows the host's", [cState?.variantKey, cState?.hlsSessionId], ["1:0/h264", sid]);

  // The host restarts — a far seek — on its own stream, not the copy.
  [a, b].forEach((x) => x.clear());
  const sid2 = crypto.randomUUID();
  recordSessionVideoCodec(sid2, "h264");
  recordHevcWithheld(sid2);
  host.send({
    type: "play", ratingKey: "100", title: "A Film", subtitles: false,
    hlsSessionId: sid2, position: 300, sessionOffset: 300,
    audioStreamId: 1, subtitleStreamId: 0,
  });
  await sleep(60);
  check("the host's restart leaves the copy alone", [a, b].map((x) => x.seen.some((m) => m.type === "variant" && m.hlsSessionId === sid2)), [false, false]);
  check("and goes to whoever follows the host's", c.seen.filter((m) => m.type === "variant").at(-1)?.hlsSessionId, sid2);
  [host, a, b, c].forEach((x) => x.close());
}

console.log("\n— a host short of HEVC and E-AC3, viewers short of one (Rain Man, 2 November) —");
{
  newRoom("hevc-9");
  const host = await join("hevc-9", "u-host", "host", false);
  const early = await join("hevc-9", "u-e", "e", true);
  // The host's start: HEVC re-encoded, E-AC3 made AAC, a copy being possible.
  const sid = crypto.randomUUID();
  recordSessionVideoCodec(sid, "h264");
  recordWithheld(sid, ["hevc", "eac3"]);
  host.send({
    type: "play", ratingKey: "100", title: "A Film", subtitles: false,
    hlsSessionId: sid, position: 0, sessionOffset: 0,
    audioStreamId: 1, subtitleStreamId: 0,
  });
  await sleep(60);
  const eOn = early.seen.filter((m) => m.type === "variant").at(-1);
  check("one who plays HEVC but not E-AC3, there at the start, gets a copy of its own", [eOn?.variantKey, eOn?.isOwner, eOn?.hlsSessionId], ["1:0", true, null]);
  early.close();
  await sleep(60);
  const a = await join("hevc-9", "u-a", "a", true);
  await sleep(60);
  const aState = a.seen.find((m) => m.type === "state")?.variant;
  check("one who plays HEVC but not E-AC3, joining, gets a copy of its own to bring up", [aState?.variantKey, aState?.isOwner, aState?.hlsSessionId], ["1:0", true, null]);
  const b = await join("hevc-9", "u-b", "b", false, { eac3: true });
  await sleep(60);
  const bState = b.seen.find((m) => m.type === "state")?.variant;
  check("one who plays E-AC3 but not HEVC shares the host's re-encode", [bState?.variantKey, bState?.hlsSessionId], ["1:0/h264", sid]);
  [host, a, b].forEach((x) => x.close());
}

console.log("\n— a viewer moving from a player that can't decode HEVC to one that can —");
{
  newRoom("hevc-8");
  const host = await join("hevc-8", "u-host", "host", true);
  const sid = await startPlayback(host, "hevc");
  const firefox = await join("hevc-8", "u-m", "m", false);
  await sleep(60);
  check("on Firefox, on an H.264 stream of its own", firefox.seen.find((m) => m.type === "state")?.variant?.variantKey, "1:0/h264");
  const twinSid = crypto.randomUUID();
  recordSessionVideoCodec(twinSid, "h264");
  recordHevcWithheld(twinSid);
  firefox.send({ type: "variant-session", hlsSessionId: twinSid, sessionOffset: 0 });
  await sleep(60);
  // Discord for Windows, the same person: the Firefox connection is replaced.
  const windows = await join("hevc-8", "u-m", "m", true);
  await sleep(60);
  const wState = windows.seen.find((m) => m.type === "state")?.variant;
  check("on Windows, on the host's copy", [wState?.variantKey, wState?.hlsSessionId], ["1:0", sid]);
  check("and the H.264 stream nobody is on now goes", sessionHostUserId(twinSid), null);
  [host, firefox, windows].forEach((c) => c.close());
}

console.log("\n— a viewer's own stream —");
{
  newRoom("hevc-5");
  const host = await join("hevc-5", "u-host", "host", true);
  const a = await join("hevc-5", "u-a", "a", true);
  await startPlayback(host, "h264");
  // a forks onto other audio and brings up an HEVC transcode for it.
  a.send({ type: "set-tracks", audioStreamId: 2, subtitleStreamId: 0 });
  await sleep(60);
  const forkSid = crypto.randomUUID();
  recordSessionVideoCodec(forkSid, "hevc");
  a.send({ type: "variant-session", hlsSessionId: forkSid, sessionOffset: 0 });
  await sleep(60);
  [host, a].forEach((c) => c.clear());

  const b = await join("hevc-5", "u-b", "b", false);
  await sleep(60);
  check("someone who can't, joining the host's H.264 stream, moves nobody", [a.toldToRebuild(), host.toldToRebuild()], [false, false]);
  check("and shares it", b.seen.find((m) => m.type === "state")?.variant?.variantKey, "1:0");
  b.clear();
  b.send({ type: "set-tracks", audioStreamId: 2, subtitleStreamId: 0 });
  await sleep(60);
  const bOn = b.seen.filter((m) => m.type === "variant").at(-1);
  check("choosing the HEVC fork's tracks gives them an H.264 one of those", [bOn?.variantKey, bOn?.isOwner, bOn?.hlsSessionId], ["2:0/h264", true, null]);
  check("and leaves the fork's driver alone", a.toldToRebuild(), false);
  b.clear();
  b.send({ type: "set-tracks", audioStreamId: 2, subtitleStreamId: 0 });
  await sleep(60);
  check("asking again moves nothing", b.seen.length, 0);
  b.send({ type: "rejoin-host" });
  await sleep(60);
  check("and back on the host's", b.seen.filter((m) => m.type === "variant").at(-1)?.variantKey, "1:0");
  [host, a, b].forEach((c) => c.close());
}

console.log("\n— AV1, Opus and FLAC, by what each player decodes —");
{
  newRoom("caps-1");
  const all = { av1: true, opus: true, flac: true, av1Encode: true };
  const none = { hevc: false, av1: false, opus: false, flac: false, ac3: false, eac3: false, hdr: false, tenBit: false, uhd: false, hi10: false, vp9: false, av1Encode: false };
  const host = await join("caps-1", "u-host", "host", true, all);
  const a = await join("caps-1", "u-a", "a", true, all);
  check("what a player decodes, a stream it starts may use", mayStart("u-host"),
    { hevc: true, av1: true, opus: true, flac: true, ac3: false, eac3: false, hdr: false, tenBit: true, uhd: true, hi10: false, vp9: false, av1Encode: true });
  const phone = await join("caps-1", "u-p", "p", false, { opus: true, av1Encode: true, hdr: true });
  check("each player's own, AV1 on the GPU only with AV1 at all, HDR kept for a screen showing it", mayStart("u-p"),
    { ...none, opus: true, hdr: true, tenBit: true, uhd: true });
  check("leaving the others' alone", mayStart("u-a").av1, true);
  check("somebody in no room gets H.264 and AAC", mayStart("u-nobody"), none);
  phone.close();
  await sleep(60);

  // An AV1 copy with its Opus.
  const sid = crypto.randomUUID();
  recordSessionVideoCodec(sid, "av1");
  recordSessionAudioNeeds(sid, ["opus"]);
  check("an AV1 copy with its Opus needs both", sessionNeeds(sid), ["av1", "opus"]);
  const vp9Sid = crypto.randomUUID();
  recordSessionVideoCodec(vp9Sid, "vp9");
  check("a VP9 copy needs VP9, and isn't HEVC", [sessionNeeds(vp9Sid), isHevcSession(vp9Sid)], [["vp9"], false]);
  const hi10Sid = crypto.randomUUID();
  recordSessionVideoCodec(hi10Sid, "h264");
  recordSessionTenBit(hi10Sid, true);
  check("a copy of 10-bit H.264 needs 10-bit H.264", sessionNeeds(hi10Sid), ["hi10", "tenBit"]);
  // What the dashboard is told a re-encode is sent as.
  const { videoOutText, COPY_LIMIT_KBPS, TRANSCODE_PEAK_KBPS } = await import("../src/routes/plex.js");
  check("left unset, files averaging up to 100 Mbps are sent unchanged, and a re-encode may peak at 200",
    [process.env.DIRECT_STREAM_MAX_KBPS, process.env.VIDEO_PEAK_BITRATE_KBPS, COPY_LIMIT_KBPS, TRANSCODE_PEAK_KBPS],
    [undefined, undefined, 100_000, 200_000]);
  check("a re-encode's output, for the dashboard: the codec it is sent in, not the file's",
    [videoOutText("av1", false, 1860, 1044), videoOutText("hevc", true, 3840, 2160), videoOutText("hevc", false, 1440, 1080),
      videoOutText("h264", false), videoOutText("av1", true, 1920, 1080), videoOutText("unknown", false), videoOutText(undefined, false)],
    ["AV1 \u00b7 1860\u00d71044", "HEVC Main 10 \u00b7 3840\u00d72160", "HEVC Main \u00b7 1440\u00d71080", "H.264", "AV1 \u00b7 10-bit \u00b7 1920\u00d71080", null, null]);
  check("and isn't HEVC", isHevcSession(sid), false);
  host.send({
    type: "play", ratingKey: "100", title: "A Film", subtitles: false,
    hlsSessionId: sid, position: 0, sessionOffset: 0, audioStreamId: 1, subtitleStreamId: 0,
  });
  await sleep(60);
  [host, a].forEach((c) => c.clear());
  const b = await join("caps-1", "u-b", "b", true, { opus: true, flac: true });
  await sleep(60);
  const bState = b.seen.find((m) => m.type === "state")?.variant;
  check("someone who can't decode AV1 but decodes HEVC lands on a stream of their own to bring up",
    [bState?.variantKey, bState?.isOwner, bState?.hlsSessionId], ["1:0/hevc", true, null]);
  check("in HEVC, with the sound they decode", mayStart("u-b"), { ...none, hevc: true, opus: true, flac: true, tenBit: true, uhd: true });
  check("the host's stream is left as it is", [host.toldToRebuild(), a.seen.filter((m) => m.type === "variant").length], [false, 0]);
  const hevcSid = crypto.randomUUID();
  recordSessionVideoCodec(hevcSid, "hevc");
  recordSessionTenBit(hevcSid, true);
  recordWithheld(hevcSid, ["av1"]);
  b.send({ type: "variant-session", hlsSessionId: hevcSid, sessionOffset: 0 });
  await sleep(60);
  const c = await join("caps-1", "u-c", "c", false, { av1: true });
  await sleep(60);
  check("someone who decodes AV1 but not Opus follows the twin",
    c.seen.find((m) => m.type === "state")?.variant?.variantKey, "1:0/h264");
  const d = await join("caps-1", "u-d", "d", false, { av1: true, opus: true });
  await sleep(60);
  check("someone who decodes both shares the host's copy",
    [d.seen.find((m) => m.type === "state")?.variant?.variantKey, d.seen.find((m) => m.type === "state")?.variant?.hlsSessionId],
    ["1:0", sid]);

  // A player that said AV1 and then couldn't.
  a.clear();
  a.send({ type: "caps", av1: false });
  await sleep(60);
  check("withdrawing AV1 moves that viewer onto the HEVC of their own that b drives",
    a.seen.filter((m) => m.type === "variant").at(-1)?.variantKey, "1:0/hevc");
  check("for good, and AV1 re-encodes with it", [mayStart("u-a").av1, mayStart("u-a").av1Encode], [false, false]);
  a.send({ type: "caps", av1: true });
  await sleep(60);
  check("a client can't talk itself back into AV1", mayStart("u-a").av1, false);
  check("the host may still", mayStart("u-host").av1, true);

  // Frames dropped on 10 bits of HEVC, then on 8.
  [a, b].forEach((x) => x.clear());
  a.send({ type: "caps", tenBit: false });
  await sleep(60);
  check("withdrawing 10 bits moves that viewer onto 8-bit HEVC of their own",
    a.seen.filter((m) => m.type === "variant").at(-1)?.variantKey, "1:0/8bit");
  check("which is HEVC Main, in SDR, never AV1", [mayStart("u-a").hevc, mayStart("u-a").tenBit, mayStart("u-a").hdr, mayStart("u-a").av1],
    [true, false, false, false]);
  check("leaving b on theirs", b.seen.filter((m) => m.type === "variant").length, 0);
  const eightSid = crypto.randomUUID();
  recordSessionVideoCodec(eightSid, "hevc");
  recordSessionTenBit(eightSid, false);
  recordWithheld(eightSid, ["av1", "tenBit"]);
  a.send({ type: "variant-session", hlsSessionId: eightSid, sessionOffset: 0 });
  await sleep(60);
  a.clear();
  a.send({ type: "caps", hevc: false });
  await sleep(60);
  check("and withdrawing HEVC after that, onto H.264", a.seen.filter((m) => m.type === "variant").at(-1)?.variantKey, "1:0/h264");
  [host, a, b, c, d].forEach((x) => x.close());
}

console.log("\n— 10-bit H.264 and VP9, by what each player says it decodes —");
{
  newRoom("caps-hi10");
  const host = await join("caps-hi10", "u-host", "host", true, { hi10: true, vp9: true });
  check("a player that says it decodes them may start copies of them",
    [mayStart("u-host").hi10, mayStart("u-host").vp9], [true, true]);
  const sid = crypto.randomUUID();
  recordSessionVideoCodec(sid, "h264");
  recordSessionTenBit(sid, true);
  host.send({
    type: "play", ratingKey: "500", title: "An Anime", subtitles: false,
    hlsSessionId: sid, position: 0, sessionOffset: 0, audioStreamId: 1, subtitleStreamId: 0,
  });
  await sleep(60);
  const stateOf = async (userId: string, caps: Record<string, unknown>) => {
    const c = await join("caps-hi10", userId, userId, false, caps);
    await sleep(60);
    const v = c.seen.find((m) => m.type === "state")?.variant;
    c.close();
    return v?.variantKey;
  };
  check("one that decodes it shares the host's copy", await stateOf("u-same", { hi10: true }), "1:0");
  check("one that doesn't, but decodes HEVC, gets HEVC of its own", await stateOf("u-hevc", { hevc: true }), "1:0/hevc");
  check("one that decodes neither gets 8-bit H.264 of its own", await stateOf("u-plain", { hevc: false }), "1:0/h264");
  host.close();
}

{
  // A 4K copy: whoever can't decode 4K smoothly gets 1080p of their own.
  newRoom("caps-4k");
  const host = await join("caps-4k", "u-host", "host", true, {});
  const sid = crypto.randomUUID();
  recordSessionVideoCodec(sid, "hevc");
  recordSessionUhd(sid, true);
  check("a 4K copy needs 4K of its players", sessionNeeds(sid), ["hevc", "uhd"]);
  host.send({
    type: "play", ratingKey: "400", title: "A 4K Film", subtitles: false,
    hlsSessionId: sid, position: 0, sessionOffset: 0, audioStreamId: 1, subtitleStreamId: 0,
  });
  await sleep(60);
  const a = await join("caps-4k", "u-a", "a", true, {});
  const b = await join("caps-4k", "u-b", "b", true, { uhd: false });
  await sleep(60);
  const stateOf = (c: Client) => c.seen.find((m) => m.type === "state")?.variant?.variantKey;
  check("a player that says nothing of 4K shares the copy; one that can't, HEVC of its own",
    [stateOf(a), stateOf(b)], ["1:0", "1:0/hevc"]);
  check("  at 1080p", mayStart("u-b").uhd, false);
  a.clear();
  a.send({ type: "caps", uhd: false });
  await sleep(60);
  check("frames dropped on 4K: onto that 1080p stream", a.seen.filter((m) => m.type === "variant").at(-1)?.variantKey, "1:0/hevc");
  [host, a, b].forEach((x) => x.close());
}

{
  // FLAC copied only for whoever decodes it: a host who can't starts the
  // film with its picture copied and AAC sound, FLAC held back.
  newRoom("caps-2");
  const host = await join("caps-2", "u-host", "host", true, { opus: true });
  const a = await join("caps-2", "u-a", "a", true, { flac: true });
  [host, a].forEach((x) => x.clear());
  const sid = crypto.randomUUID();
  recordSessionVideoCodec(sid, "h264");
  recordWithheld(sid, ["flac"]);
  host.send({
    type: "play", ratingKey: "100", title: "A Film", subtitles: false,
    hlsSessionId: sid, position: 0, sessionOffset: 0, audioStreamId: 1, subtitleStreamId: 0,
  });
  await sleep(60);
  const aOn = a.seen.filter((m) => m.type === "variant").at(-1);
  check("a viewer who decodes FLAC is given a copy of its own to bring up",
    [aOn?.variantKey, aOn?.isOwner, aOn?.hlsSessionId], ["1:0", true, null]);
  check("with FLAC", mayStart("u-a").flac, true);
  const b = await join("caps-2", "u-b", "b", true, {});
  await sleep(60);
  check("one who doesn't follows the host's", b.seen.find((m) => m.type === "state")?.variant?.hlsSessionId, sid);
  [host, a, b].forEach((x) => x.close());
}

{
  // An HDR picture copied only for a screen that shows it. A screen in SDR
  // gets a copy made for it — on the ffmpeg engine the HEVC labelled for the
  // browser to map — not the twin's H.264 the server tone-mapped: Windows HDR
  // switched off mid-film on 29 October moved its viewer there (run 30, A2).
  newRoom("caps-3");
  const host = await join("caps-3", "u-host", "host", true, { hdr: true });
  const a = await join("caps-3", "u-a", "a", true, { hdr: true });
  check("a screen that shows HDR may be sent it", mayStart("u-host").hdr, true);
  const sid = crypto.randomUUID();
  recordSessionVideoCodec(sid, "hevc");
  recordSessionHdr(sid, true);
  check("an HDR copy needs HEVC and a screen that shows HDR", sessionNeeds(sid), ["hevc", "hdr"]);
  host.send({
    type: "play", ratingKey: "100", title: "A Film", subtitles: false,
    hlsSessionId: sid, position: 0, sessionOffset: 0, audioStreamId: 1, subtitleStreamId: 0,
  });
  await sleep(60);
  [host, a].forEach((c) => c.clear());
  const b = await join("caps-3", "u-b", "b", true, {});
  await sleep(60);
  const bState = b.seen.find((m) => m.type === "state")?.variant;
  check("someone whose screen is in SDR lands on a stream of their own to bring up",
    [bState?.variantKey, bState?.isOwner, bState?.hlsSessionId], ["1:0/sdr", true, null]);
  check("in HEVC, made for a screen in SDR", [mayStart("u-b").hevc, mayStart("u-b").hdr], [true, false]);
  check("the host's stream is left as it is", [host.toldToRebuild(), a.seen.filter((m) => m.type === "variant").length], [false, 0]);
  a.send({ type: "caps", hdr: false });
  await sleep(60);
  check("a screen that leaves HDR moves its viewer onto the SDR copy, not the twin",
    a.seen.filter((m) => m.type === "variant").at(-1)?.variantKey, "1:0/sdr");
  a.send({ type: "caps", hdr: true });
  await sleep(60);
  check("and coming back doesn't bring HDR back before they join again", mayStart("u-a").hdr, false);
  // The copy brought up, labelled: it needs HEVC only, and stays the copy.
  const labelled = crypto.randomUUID();
  recordSessionVideoCodec(labelled, "hevc");
  recordSessionHdr(labelled, false);
  recordWithheld(labelled, ["hdr"]);
  b.send({ type: "variant-session", hlsSessionId: labelled, sessionOffset: 0 });
  await sleep(60);
  check("nobody on the SDR copy is moved once it runs",
    [a, b].map((c) => c.seen.filter((m) => m.type === "variant").at(-1)?.variantKey), ["1:0/sdr", "1:0/sdr"]);
  [a, b].forEach((c) => c.clear());
  b.send({ type: "caps", hevc: false });
  await sleep(60);
  check("a player on it that can't decode HEVC goes onto the twin",
    b.seen.filter((m) => m.type === "variant").at(-1)?.variantKey, "1:0/h264");
  // An SDR stream made for a host whose screen is in SDR: needs HEVC, not
  // HDR, so a viewer whose screen shows HDR shares it — SDR. No player has
  // said its screen shows HDR yet (October's logs), so no third stream for it.
  const sdrSid = crypto.randomUUID();
  recordSessionVideoCodec(sdrSid, "hevc");
  recordSessionHdr(sdrSid, false);
  check("a tone-mapped HEVC stream needs HEVC only", sessionNeeds(sdrSid), ["hevc"]);
  [host, a, b].forEach((x) => x.close());
}

console.log("\n— the host's screen leaves HDR mid-film —");
{
  newRoom("caps-4");
  const host = await join("caps-4", "u-host", "host", true, { hdr: true });
  const v = await join("caps-4", "u-v", "v", true, { hdr: true });
  const sid = crypto.randomUUID();
  recordSessionVideoCodec(sid, "hevc");
  recordSessionHdr(sid, true);
  host.send({
    type: "play", ratingKey: "100", title: "A Film", subtitles: false,
    hlsSessionId: sid, position: 0, sessionOffset: 0, audioStreamId: 1, subtitleStreamId: 0,
  });
  await sleep(60);
  [host, v].forEach((c) => c.clear());
  host.send({ type: "caps", hdr: false });
  await sleep(60);
  const told = host.seen.filter((m) => m.type === "variant").at(-1);
  check("the host goes onto an SDR copy of their own to bring up",
    [told?.variantKey, told?.isOwner, told?.hlsSessionId], ["1:0/sdr", true, null]);
  check("in HEVC, made for a screen in SDR", [mayStart("u-host").hevc, mayStart("u-host").hdr], [true, false]);
  const kept = v.seen.filter((m) => m.type === "variant").at(-1);
  check("the viewer whose screen shows HDR keeps the HDR copy, now driving it",
    [kept?.variantKey, kept?.isOwner, kept?.hlsSessionId], ["1:0", true, sid]);
  const labelled = crypto.randomUUID();
  recordSessionVideoCodec(labelled, "hevc");
  recordSessionHdr(labelled, false);
  recordWithheld(labelled, ["hdr"]);
  [host, v].forEach((c) => c.clear());
  host.send({
    type: "play", ratingKey: "100", title: "A Film", subtitles: false,
    hlsSessionId: labelled, position: 0, sessionOffset: 0, audioStreamId: 1, subtitleStreamId: 0,
  });
  await sleep(60);
  check("the host's restart stays on the SDR copy",
    host.seen.filter((m) => m.type === "variant").at(-1)?.variantKey, "1:0/sdr");
  check("and leaves the HDR copy as it was",
    v.seen.some((m) => m.type === "variant" && m.hlsSessionId === labelled), false);
  const s = await join("caps-4", "u-s", "s", true, {});
  const sState = s.seen.find((m) => m.type === "state")?.variant;
  check("someone joining on a screen in SDR shares the host's SDR copy",
    [sState?.variantKey, sState?.isOwner, sState?.hlsSessionId], ["1:0/sdr", false, labelled]);
  // Other audio and back, the HDR copy gone meanwhile: HDR again, not the SDR copy.
  v.send({ type: "set-tracks", audioStreamId: 2, subtitleStreamId: 0 });
  await sleep(60);
  v.clear();
  v.send({ type: "set-tracks", audioStreamId: 1, subtitleStreamId: 0 });
  await sleep(60);
  const back = v.seen.filter((m) => m.type === "variant").at(-1);
  check("a screen that shows HDR back on those tracks gets a copy of its own, not the SDR one",
    [back?.variantKey, back?.isOwner, back?.hlsSessionId], ["1:0", true, null]);
  [host, v, s].forEach((x) => x.close());
}

console.log(`\n${pass} passed, ${fail} failed\n`);
closeWebSocketServer();
server.close();
process.exit(fail === 0 ? 0 : 1);
