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
} = await import("../src/routes/plex.js");
const { transcodeFrame } = await import("../src/services/media-versions.js");
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
check("1440p comes down to 1080p", transcodeFrame({ width: 2560, height: 1440 }), "1920x1080");
check("4K comes down to 1080p", transcodeFrame({ width: 3840, height: 2160 }), "1920x1080");
check("unknown size gets the old box", transcodeFrame({}), "1920x1080");

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
  const none = { hevc: false, av1: false, opus: false, flac: false, ac3: false, eac3: false, av1Encode: false };
  const host = await join("caps-1", "u-host", "host", true, all);
  const a = await join("caps-1", "u-a", "a", true, all);
  check("what a player decodes, a stream it starts may use", mayStart("u-host"),
    { hevc: true, av1: true, opus: true, flac: true, ac3: false, eac3: false, av1Encode: true });
  const phone = await join("caps-1", "u-p", "p", false, { opus: true, av1Encode: true });
  check("each player's own, AV1 on the GPU only with AV1 at all", mayStart("u-p"), { ...none, opus: true });
  check("leaving the others' alone", mayStart("u-a").av1, true);
  check("somebody in no room gets H.264 and AAC", mayStart("u-nobody"), none);
  phone.close();
  await sleep(60);

  // An AV1 copy with its Opus.
  const sid = crypto.randomUUID();
  recordSessionVideoCodec(sid, "av1");
  recordSessionAudioNeeds(sid, ["opus"]);
  check("an AV1 copy with its Opus needs both", sessionNeeds(sid), ["av1", "opus"]);
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
  check("someone who can't decode AV1 lands on a stream of their own to bring up",
    [bState?.variantKey, bState?.isOwner, bState?.hlsSessionId], ["1:0/h264", true, null]);
  check("in H.264 and AAC", mayStart("u-b"), none);
  check("the host's stream is left as it is", [host.toldToRebuild(), a.seen.filter((m) => m.type === "variant").length], [false, 0]);
  const twinSid = crypto.randomUUID();
  recordSessionVideoCodec(twinSid, "h264");
  recordWithheld(twinSid, ["av1", "opus"]);
  b.send({ type: "variant-session", hlsSessionId: twinSid, sessionOffset: 0 });
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
  check("withdrawing AV1 moves that viewer onto the twin", a.seen.filter((m) => m.type === "variant").at(-1)?.variantKey, "1:0/h264");
  check("for good, and AV1 re-encodes with it", [mayStart("u-a").av1, mayStart("u-a").av1Encode], [false, false]);
  a.send({ type: "caps", av1: true });
  await sleep(60);
  check("a client can't talk itself back into AV1", mayStart("u-a").av1, false);
  check("the host may still", mayStart("u-host").av1, true);
  [host, a, b, c, d].forEach((x) => x.close());
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

console.log(`\n${pass} passed, ${fail} failed\n`);
closeWebSocketServer();
server.close();
process.exit(fail === 0 ? 0 : 1);
