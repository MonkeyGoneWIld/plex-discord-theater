/**
 * Manager integration regressions against real authenticated WebSockets and
 * live room state. Plex HTTP calls are stubbed; no transcode or external server
 * is needed. Set DATA_DIR to an isolated test directory before running.
 */
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";

process.env.DATA_DIR ||= mkdtempSync(join(tmpdir(), "theater-qbt-test-"));
process.env.THUMB_CACHE_DIR = process.env.DATA_DIR;
process.env.PLEX_URL = "http://plex.invalid";
process.env.PLEX_TOKEN = "qbt-integration-test-plex-token";
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ MediaContainer: { machineIdentifier: "server-1" } }), {
  status: 200, headers: { "Content-Type": "application/json" },
});

// Dynamic imports ensure SQLite services use the isolated directory above.
const { attachWebSocketServer, closeWebSocketServer, getQbtManagerStreams } =
  await import("../src/services/sync.js");
const { createSession } = await import("../src/middleware/auth.js");
const { instanceHosts } = await import("../src/routes/discord.js");

type Msg = Record<string, any>;
const { default: integrationRouter } = await import("../src/routes/qbt-manager.js");
const app = express();
app.use("/api/integrations/qbt-manager", integrationRouter);
const server = http.createServer(app);
attachWebSocketServer(server);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
const endpoint = `http://127.0.0.1:${port}/api/integrations/qbt-manager/state`;
const authorized = () => originalFetch(endpoint, { headers: { Authorization: "Bearer integration-test-secret" } });
delete process.env.QBT_MANAGER_API_KEY;
assert.equal((await originalFetch(endpoint)).status, 503);
process.env.QBT_MANAGER_API_KEY = "integration-test-secret";
assert.equal((await originalFetch(endpoint)).status, 401);
assert.equal((await originalFetch(endpoint, { headers: { Authorization: "Bearer wrong" } })).status, 401);
const firstResponse = await authorized();
assert.equal(firstResponse.headers.get("cache-control"), "no-store");
const first = await firstResponse.json() as Msg;
const second = await (await authorized()).json() as Msg;
assert.equal(first.schema_version, 1);
assert.equal(first.plex_server_id, "server-1");
assert.equal(second.sequence, first.sequence + 1);
assert.equal(second.instance_id, first.instance_id);
assert.equal(first.delivery_mode, "direct_p2p");
assert.equal(JSON.stringify(first).includes("secret") || JSON.stringify(first).includes("token"), false);
process.env.VPS_RELAY_URL = "https://relay.invalid";
assert.equal(((await (await authorized()).json()) as Msg).delivery_mode, "vps_relay");
delete process.env.VPS_RELAY_URL;
const clients: Client[] = [];
let passed = 0;
let failed = 0;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(description: string, predicate: () => boolean, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out: ${description}`);
    await sleep(10);
  }
}

function check(description: string, actual: unknown, expected: unknown) {
  try {
    assert.deepEqual(actual, expected);
    passed++;
    console.log(`  ok   ${description}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${description}`, error);
  }
}

class Client {
  ws!: WebSocket;
  seen: Msg[] = [];
  constructor(readonly userId: string) { clients.push(this); }

  async connect(roomId: string) {
    const token = createSession(this.userId, null);
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    this.ws.on("message", (raw) => this.seen.push(JSON.parse(String(raw))));
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    this.send({ type: "join", sessionToken: token, instanceId: roomId,
      userId: this.userId, username: this.userId });
    await until("join state", () => !!this.last("state"));
  }
  send(message: Msg) { this.ws.send(JSON.stringify(message)); }
  last(type: string): Msg | undefined { return this.seen.findLast((message) => message.type === type); }
  count(type: string) { return this.seen.filter((message) => message.type === type).length; }
  close() { if (this.ws?.readyState === WebSocket.OPEN) this.ws.close(); }
}

async function room(names: string[]) {
  const id = `qbt-${crypto.randomUUID()}`;
  const userId = (name: string) => `${id}-${name}`;
  instanceHosts.set(id, { hostUserId: userId("host"), guildId: null, channelId: null, createdAt: Date.now() });
  const members: Client[] = [];
  for (const name of names) {
    const client = new Client(userId(name));
    await client.connect(id);
    members.push(client);
  }
  return { id, members };
}

function streams(roomId: string) { return getQbtManagerStreams().filter((stream) => stream.room_id === roomId); }
function stream(roomId: string, variant = "1:0") {
  const current = streams(roomId).find((entry) => entry.variant_id === variant);
  assert.ok(current, `Missing live variant ${variant} in ${roomId}`);
  return current;
}

async function play(roomId: string, host: Client) {
  const sid = crypto.randomUUID();
  host.send({ type: "play", ratingKey: "100", title: "Test film", subtitles: false,
    hlsSessionId: sid, position: 0, sessionOffset: 0, audioStreamId: 1, subtitleStreamId: 0 });
  await until("live stream", () => streams(roomId).some((entry) => entry.hls_session_id === sid));
  return sid;
}

async function watching(roomId: string, member: Client, value: boolean, count: number, variant = "1:0") {
  member.send({ type: "watching", value });
  await until(`viewer count ${count}`, () => stream(roomId, variant).viewer_count === count);
}

async function transport(roomId: string, member: Client, type: "pause" | "resume") {
  const revision = stream(roomId).state_revision;
  member.send({ type, position: 12 });
  await until(type, () => stream(roomId).state_revision > revision);
  return stream(roomId);
}

async function disconnectRoom(roomId: string, members: Client[]) {
  for (const member of [...members].reverse()) {
    member.close();
    await until("socket close", () => member.ws.readyState === WebSocket.CLOSED);
  }
  await until("room streams removed", () => streams(roomId).length === 0);
}

try {
  console.log("\n— count each variant's actual player audience —");
  {
    const { id, members } = await room(["host", "a", "b", "c", "browser"]);
    const [host, a, b, c, browser] = members;
    const sid = await play(id, host);
    check("joining and being assigned a stream does not mean watching", stream(id).viewer_count, 0);
    check("session identity comes from the live variant", stream(id).hls_session_id, sid);
    check("rating key remains available for diagnosis", stream(id).rating_key, "100");
    check("unresolved Plex key is explicit", stream(id).plex_transcode_key, null);
    await watching(id, host, true, 1);
    await watching(id, a, true, 2);
    await watching(id, b, true, 3);
    const live = await (await authorized()).json() as Msg;
    check("HTTP snapshot counts live room watchers", live.streams.find((s: Msg) => s.hls_session_id === sid)?.viewer_count, 3);
    await watching(id, c, true, 4);
    c.send({ type: "set-tracks", audioStreamId: 2, subtitleStreamId: 0 });
    await until("second variant assigned", () => c.last("variant")?.variantKey === "2:0");
    const secondSid = crypto.randomUUID();
    c.send({ type: "variant-session", hlsSessionId: secondSid, sessionOffset: 0 });
    await until("second stream announced", () => streams(id).some((entry) => entry.hls_session_id === secondSid));
    check("default variant counts host and its two viewers", stream(id).viewer_count, 3);
    check("second variant counts only its own viewer", stream(id, "2:0").viewer_count, 1);
    check("a browser-only participant has an assignment", browser.last("variant")?.variantKey, "1:0");
    check("the browser-only participant is excluded", streams(id).reduce((sum, entry) => sum + entry.viewer_count, 0), 4);
    // Viewers can be buffering, hidden, or waiting for media without any observed
    // frames. Only leaving the player should make their reservation disappear.
    await sleep(60);
    check("lack of viewer heartbeats does not discard mounted players", stream(id).viewer_count, 3);
    await watching(id, a, false, 2);
    check("leaving the player updates only its variant", stream(id, "2:0").viewer_count, 1);
    await watching(id, c, false, 0, "2:0");
    check("a kept-alive zero-viewer variant stays identifiable", stream(id, "2:0").hls_session_id, secondSid);
    check("zero viewers do not erase room playback state", stream(id, "2:0").state, "playing");
    await disconnectRoom(id, members);
  }

  console.log("\n— reconnects and disconnects never count duplicate viewers —");
  {
    const { id, members } = await room(["host", "viewer"]);
    const [host, viewer] = members;
    await play(id, host);
    await watching(id, host, true, 1);
    await watching(id, viewer, true, 2);
    const replacement = new Client(viewer.userId);
    await replacement.connect(id);
    await until("previous socket evicted", () => viewer.ws.readyState === WebSocket.CLOSED);
    await watching(id, replacement, true, 2);
    check("reconnecting the same user counts once", stream(id).viewer_count, 2);
    replacement.close();
    await until("disconnected watcher removed", () => stream(id).viewer_count === 1);
    check("a closed socket is not a viewer", stream(id).viewer_count, 1);
    await disconnectRoom(id, [host, replacement]);
  }

  console.log("\n— pause revisions survive missed polls and stale host heartbeats —");
  {
    const { id, members } = await room(["host", "cohost", "viewer"]);
    const [host, cohost, viewer] = members;
    await play(id, host);
    await watching(id, host, true, 1);
    await watching(id, cohost, true, 2);
    host.send({ type: "set-cohost", userId: cohost.userId, value: true });
    await until("cohost granted", () => (cohost.last("participants")?.participants ?? [])
      .some((member: Msg) => member.userId === cohost.userId && member.isCoHost));
    const beforePause = stream(id);
    check("no host playback observation has been invented", beforePause.host_heartbeat_age_seconds, null);
    const paused = await transport(id, cohost, "pause");
    await until("sender transport acknowledgement", () => cohost.last("transport-state")?.transportRevision === paused.state_revision);
    check("cohost pause is authoritative despite Plex continuing", paused.state, "paused");
    check("the pause reaches the host with its revision", host.last("pause")?.transportRevision, paused.state_revision);
    check("the initiating cohost gets the accepted revision", cohost.last("transport-state")?.transportRevision, paused.state_revision);

    // Wait long enough to distinguish a real state-age reset from elapsed time.
    await sleep(120);
    const ageBeforeHeartbeat = stream(id).state_age_seconds;
    const heartbeatCount = viewer.count("heartbeat");
    host.send({ type: "heartbeat", position: 15, playing: true, transportRevision: beforePause.state_revision });
    // A subsequent same-socket message is a processing barrier even if the
    // server drops the stale heartbeat without broadcasting it.
    host.send({ type: "browse", context: "stale-heartbeat-barrier" });
    await until("stale heartbeat processed", () => viewer.last("browse")?.context === "stale-heartbeat-barrier");
    check("delayed pre-pause heartbeat cannot resume the room", stream(id).state, "paused");
    check("stale heartbeat cannot advance the transport revision", stream(id).state_revision, paused.state_revision);
    check("stale heartbeat cannot restart the pause grace timer", stream(id).state_age_seconds >= ageBeforeHeartbeat, true);
    if (viewer.count("heartbeat") > heartbeatCount) {
      check("any heartbeat broadcast retains authoritative paused state", viewer.last("heartbeat")?.playing, false);
    }

    host.send({ type: "heartbeat", position: 15, playing: false, transportRevision: paused.state_revision });
    await until("host observation recorded", () => stream(id).host_heartbeat_age_seconds !== null);
    check("same-state heartbeat does not reset state revision", stream(id).state_revision, paused.state_revision);
    check("same-state heartbeat does not reset state age", stream(id).state_age_seconds >= ageBeforeHeartbeat, true);
    check("heartbeat age and state age have separate clocks", stream(id).host_heartbeat_age_seconds! < stream(id).state_age_seconds, true);

    host.send({ type: "pause", position: 15 });
    host.send({ type: "browse", context: "duplicate-pause-barrier" });
    await until("duplicate pause processed", () => viewer.last("browse")?.context === "duplicate-pause-barrier");
    check("duplicate pause does not manufacture a new transition", stream(id).state_revision, paused.state_revision);
    const firstPause = stream(id);
    cohost.send({ type: "resume", position: 15 });
    cohost.send({ type: "pause", position: 15 });
    await until("second pause", () => stream(id).state === "paused" && stream(id).state_revision >= firstPause.state_revision + 2);
    const secondPause = stream(id);
    check("resume then pause between manager polls is distinguishable", secondPause.state_revision, firstPause.state_revision + 2);
    check("a second pause gets a fresh grace timer", secondPause.state_age_seconds < firstPause.state_age_seconds, true);

    host.send({ type: "heartbeat", position: 16, playing: true, transportRevision: secondPause.state_revision });
    await until("native host resume", () => stream(id).state === "playing");
    check("a current-revision native host resume is still accepted", stream(id).state_revision, secondPause.state_revision + 1);
    const nativeResume = stream(id);
    host.send({ type: "heartbeat", position: 17, playing: false, transportRevision: nativeResume.state_revision });
    await until("native host pause", () => stream(id).state === "paused");
    check("a current-revision native host pause is still accepted", stream(id).state_revision, nativeResume.state_revision + 1);
    const joiner = new Client(`${id}-late-joiner`);
    await joiner.connect(id);
    check("late joiners learn the authoritative revision", joiner.last("state")?.transportRevision, stream(id).state_revision);
    await watching(id, host, false, 1);
    await watching(id, cohost, false, 0);
    check("paused zero-viewer stream stays present for suppression", [stream(id).state, stream(id).viewer_count], ["paused", 0]);
    await disconnectRoom(id, [...members, joiner]);
  }
} catch (error) {
  failed++;
  console.error("Integration scenario failed:", error);
} finally {
  for (const client of clients) client.ws?.terminate();
  closeWebSocketServer();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  globalThis.fetch = originalFetch;
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
