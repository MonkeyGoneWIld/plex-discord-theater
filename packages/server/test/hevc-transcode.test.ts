/**
 * HEVC transcodes and the picture size asked of Plex.
 *
 * The sizing rule is pure. The HEVC half runs against a real sync server, the
 * same way variant-sync.test.ts does: real WebSockets and room state, no Plex.
 * What is checked is who gets told to rebuild their stream, and when — the
 * transcode that rebuild starts is decided by roomPlaysHevc, checked directly.
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
const { attachWebSocketServer, closeWebSocketServer, roomPlaysHevc } = await import("../src/services/sync.js");
const { recordSessionVideoCodec, isHevcSession } = await import("../src/routes/plex.js");
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
  constructor(readonly userId: string, readonly name: string, readonly hevc: boolean) {}

  async connect(instanceId: string) {
    const token = createSession(this.userId, null);
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    await new Promise<void>((r, j) => { this.ws.once("open", () => r()); this.ws.once("error", j); });
    this.ws.on("message", (d) => this.seen.push(JSON.parse(String(d))));
    this.send({ type: "join", sessionToken: token, instanceId, userId: this.userId, username: this.name, hevc: this.hevc });
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

async function join(instanceId: string, userId: string, name: string, hevc: boolean) {
  const c = new Client(userId, name, hevc);
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
  check("a room where everyone can decode it gets HEVC", roomPlaysHevc("u-host"), true);
  check("asked by any of them", roomPlaysHevc("u-a"), true);
  const b = await join("hevc-1", "u-b", "b", false);
  check("one viewer who can't puts the room on H.264", roomPlaysHevc("u-host"), false);
  b.close();
  await sleep(60);
  check("and the room may go back to HEVC once they leave", roomPlaysHevc("u-host"), true);
  check("somebody in no room gets H.264", roomPlaysHevc("u-nobody"), false);
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
  check("the host, who drives the stream, is told to rebuild it", host.toldToRebuild(), true);
  check("the other viewer keeps watching meanwhile", a.seen.filter((m) => m.type === "variant").length, 0);
  check("the newcomer is not the one asked to start anything", b.toldToRebuild(), false);

  // The host's rebuild — an H.264 transcode, since roomPlaysHevc is now false —
  // is announced the way any restart is, and everyone follows it.
  const sid2 = crypto.randomUUID();
  recordSessionVideoCodec(sid2, "h264");
  host.send({
    type: "play", ratingKey: "100", title: "A Film", subtitles: false,
    hlsSessionId: sid2, position: 30, sessionOffset: 30,
    audioStreamId: 1, subtitleStreamId: 0,
  });
  await sleep(60);
  check("the viewer is moved onto the new stream", a.seen.filter((m) => m.type === "play").at(-1)?.hlsSessionId, sid2);
  check("and so is the newcomer", b.seen.filter((m) => m.type === "play").at(-1)?.hlsSessionId, sid2);

  host.clear();
  const c = await join("hevc-2", "u-c", "c", false);
  await sleep(60);
  check("an H.264 room asks nothing of anyone", host.toldToRebuild(), false);
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
  [host, a].forEach((c) => c.close());
}

console.log("\n— a viewer whose player fails to decode HEVC withdraws —");
{
  newRoom("hevc-4");
  const host = await join("hevc-4", "u-host", "host", true);
  const a = await join("hevc-4", "u-a", "a", true);
  await startPlayback(host, "hevc");
  host.clear();
  a.send({ type: "caps", hevc: false });
  await sleep(60);
  check("the host is told to rebuild", host.toldToRebuild(), true);
  check("and the room is H.264 from now on", roomPlaysHevc("u-host"), false);
  host.clear();
  a.send({ type: "caps", hevc: false });
  await sleep(60);
  check("saying it twice does nothing more", host.toldToRebuild(), false);
  a.send({ type: "caps", hevc: true });
  await sleep(60);
  check("and a client can't talk the room back into HEVC", roomPlaysHevc("u-host"), false);
  [host, a].forEach((c) => c.close());
}

console.log("\n— a viewer's own stream is rebuilt by that viewer —");
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
  check("the fork's driver is told to rebuild it", a.toldToRebuild(), true);
  check("the host's H.264 stream is left alone", host.toldToRebuild(), false);
  [host, a, b].forEach((c) => c.close());
}

console.log(`\n${pass} passed, ${fail} failed\n`);
closeWebSocketServer();
server.close();
process.exit(fail === 0 ? 0 : 1);
