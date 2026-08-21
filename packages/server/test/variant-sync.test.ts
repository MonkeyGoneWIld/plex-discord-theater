/**
 * Exercises the per-viewer track feature against a real sync server: real
 * WebSockets, real room state, real host succession. Plex is never reached —
 * nothing here starts a transcode, so the assertions are about which stream
 * each client is told to play and who is told to drive it.
 */
import http from "node:http";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { attachWebSocketServer, closeWebSocketServer, sessionHasOtherWatchers } from "../src/services/sync.js";
import { createSession } from "../src/middleware/auth.js";
import { instanceHosts } from "../src/routes/discord.js";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

const server = http.createServer();
attachWebSocketServer(server);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Msg = Record<string, any>;

class Client {
  ws!: WebSocket;
  seen: Msg[] = [];
  constructor(readonly userId: string, readonly name: string) {}

  async connect(instanceId: string) {
    const token = createSession(this.userId, null);
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    await new Promise<void>((r, j) => { this.ws.once("open", () => r()); this.ws.once("error", j); });
    this.ws.on("message", (d) => this.seen.push(JSON.parse(String(d))));
    this.send({ type: "join", sessionToken: token, instanceId, userId: this.userId, username: this.name });
    await sleep(60);
  }
  send(m: Msg) { this.ws.send(JSON.stringify(m)); }
  /** The most recent message of a type, or undefined. */
  last(type: string): Msg | undefined {
    for (let i = this.seen.length - 1; i >= 0; i--) if (this.seen[i].type === type) return this.seen[i];
    return undefined;
  }
  count(type: string) { return this.seen.filter((m) => m.type === type).length; }
  clear() { this.seen = []; }
  /** Which stream this client believes it is on, and whether it drives it. */
  stream() {
    const v = this.last("variant");
    return v ? { key: v.variantKey, session: v.hlsSessionId, owner: v.isOwner } : null;
  }
  close() { this.ws.close(); }
}

const uuid = () => crypto.randomUUID();

async function room(id: string, names: string[]) {
  instanceHosts.set(id, { hostUserId: "u-host", guildId: null, channelId: null, createdAt: Date.now() });
  const cs: Client[] = [];
  for (const n of names) {
    const c = new Client(n === "host" ? "u-host" : `u-${n}`, n);
    await c.connect(id);
    cs.push(c);
  }
  return cs;
}

/**
 * The room's position as a joiner would be told it — the only honest way to
 * read the clock from outside, since the server excludes a sender from its own
 * broadcasts and a probe has no history to colour what it is told.
 */
async function clockOf(instanceId: string): Promise<number> {
  const probe = new Client("u-probe-" + Math.random().toString(36).slice(2, 8), "probe");
  await probe.connect(instanceId);
  const pos = probe.last("state")?.position as number;
  probe.close();
  await sleep(30);
  return pos;
}

const near = (actual: number, expected: number, tol = 1.5) =>
  Math.abs(actual - expected) <= tol ? "ok" : `${actual} (wanted ~${expected})`;

/** Host starts a title on audio A(1) / subtitle none(0). */
async function startPlayback(host: Client, ratingKey = "100") {
  const sid = uuid();
  host.send({
    type: "play", ratingKey, title: "A Film", subtitles: false,
    hlsSessionId: sid, position: 0, sessionOffset: 0,
    audioStreamId: 1, subtitleStreamId: 0,
  });
  await sleep(60);
  return sid;
}

console.log("\n— everyone starts on the host's stream —");
{
  const [host, a, b] = await room("inst-1", ["host", "a", "b"]);
  const sid = await startPlayback(host);
  check("host is on its own stream", host.stream()?.key, "1:0");
  check("viewer a shares it", a.stream()?.key, "1:0");
  check("viewer b shares it", b.stream()?.key, "1:0");
  check("one Plex session between them", new Set([a.stream()?.session, b.stream()?.session]).size, 1);
  check("and it is the host's", a.stream()?.session, sid);
  check("the host drives it", host.stream()?.owner, true);
  check("viewers do not", [a.stream()?.owner, b.stream()?.owner], [false, false]);
  [host, a, b].forEach((c) => c.close());
}

console.log("\n— a viewer forks onto their own stream —");
{
  const [host, a, b] = await room("inst-2", ["host", "a", "b"]);
  const sid = await startPlayback(host);
  [host, a, b].forEach((c) => c.clear());
  a.send({ type: "set-tracks", audioStreamId: 2, subtitleStreamId: 0 });
  await sleep(60);
  check("a is on a new stream", a.stream()?.key, "2:0");
  check("with no session yet, so a must start one", a.stream()?.session, null);
  check("a drives it", a.stream()?.owner, true);
  check("the host is untouched", host.last("variant"), undefined);
  check("and so is b", b.last("variant"), undefined);

  // a brings up its transcode and reports it
  const aSid = uuid();
  a.send({ type: "variant-session", hlsSessionId: aSid, sessionOffset: 120 });
  await sleep(60);
  check("a's stream now has a session", a.stream()?.session, aSid);
  check("still nobody else's business", b.last("variant"), undefined);
  [host, a, b].forEach((c) => c.close());
}

console.log("\n— a second viewer choosing the same tracks reuses that stream —");
{
  const [host, a, b, c] = await room("inst-3", ["host", "a", "b", "c"]);
  await startPlayback(host);
  a.send({ type: "set-tracks", audioStreamId: 2, subtitleStreamId: 0 });
  await sleep(50);
  const aSid = uuid();
  a.send({ type: "variant-session", hlsSessionId: aSid, sessionOffset: 120 });
  await sleep(50);
  [host, a, b, c].forEach((x) => x.clear());

  b.send({ type: "set-tracks", audioStreamId: 2, subtitleStreamId: 0 });
  await sleep(60);
  check("b lands on the stream a already had", b.stream()?.session, aSid);
  check("no second transcode was asked for", b.stream()?.owner, false);
  check("a keeps driving it", a.stream()?.owner, true);
  check("c is still with the host", c.last("variant"), undefined);
  [host, a, b, c].forEach((x) => x.close());
}

console.log("\n— the host's change carries to their own audience only —");
{
  const [host, a, b, c] = await room("inst-4", ["host", "a", "b", "c"]);
  await startPlayback(host);
  // c forks to audio 3
  c.send({ type: "set-tracks", audioStreamId: 3, subtitleStreamId: 0 });
  await sleep(50);
  const cSid = uuid();
  c.send({ type: "variant-session", hlsSessionId: cSid, sessionOffset: 100 });
  await sleep(50);
  [host, a, b, c].forEach((x) => x.clear());

  host.send({ type: "set-tracks", audioStreamId: 5, subtitleStreamId: 0 });
  await sleep(60);
  check("the host moved", host.stream()?.key, "5:0");
  check("a came along", a.stream()?.key, "5:0");
  check("b came along", b.stream()?.key, "5:0");
  check("c did not", c.last("variant"), undefined);
  check("the host's group shares one new stream",
    new Set([host.stream()?.session, a.stream()?.session, b.stream()?.session]).size, 1);
  [host, a, b, c].forEach((x) => x.close());
}

console.log("\n— succession prefers someone on the host's stream —");
{
  const [host, a, b, c] = await room("inst-5", ["host", "a", "b", "c"]);
  await startPlayback(host);
  // b is a co-host but forks away; a stays on the host's stream as a plain viewer.
  host.send({ type: "set-cohost", userId: "u-b", value: true });
  await sleep(50);
  b.send({ type: "set-tracks", audioStreamId: 9, subtitleStreamId: 0 });
  await sleep(50);
  [a, b, c].forEach((x) => x.clear());

  host.close();
  await sleep(120);
  check("the plain viewer on the host's stream wins over the co-host who left it",
    a.last("host-promoted") !== undefined, true);
  check("the co-host is told, not promoted", b.last("host-promoted"), undefined);
  [a, b, c].forEach((x) => x.close());
}

console.log("\n— handing the role over leaves you a co-host —");
{
  const [host, a, b] = await room("inst-9b", ["host", "a", "b"]);
  await startPlayback(host);
  [host, a, b].forEach((c) => c.clear());

  host.send({ type: "promote-host", userId: "u-a" });
  await sleep(80);

  const roster = (b.last("participants")?.participants ?? []) as Array<any>;
  const role = (id: string) => {
    const p = roster.find((x) => x.userId === id);
    return p ? [p.isHost === true, p.isCoHost === true] : "missing";
  };

  check("the target is host", role("u-a"), [true, false]);
  // Passing the role is usually "you drive for a bit", not "I am done here".
  check("the outgoing host keeps transport control", role("u-host"), [false, true]);
  check("nobody else gained anything", role("u-b"), [false, false]);

  // And it is a real grant, not a label: a co-host may pause the room.
  b.clear();
  host.send({ type: "pause", position: 120 });
  await sleep(60);
  check("and can actually use it", !!b.last("pause"), true);

  // The new host outranks it and can take it away again.
  a.send({ type: "set-cohost", userId: "u-host", value: false });
  await sleep(60);
  const after = (b.last("participants")?.participants ?? []) as Array<any>;
  check("the new host can withdraw it",
    after.find((x) => x.userId === "u-host")?.isCoHost === true, false);

  [host, a, b].forEach((c) => c.close());
}

console.log("\n— a successor on another stream strands nobody —");
{
  const [host, a, b] = await room("inst-6", ["host", "a", "b"]);
  await startPlayback(host);
  // a forks; b stays with the host.
  a.send({ type: "set-tracks", audioStreamId: 7, subtitleStreamId: 0 });
  await sleep(50);
  const aSid = uuid();
  a.send({ type: "variant-session", hlsSessionId: aSid, sessionOffset: 60 });
  await sleep(50);
  // Host hands over to a deliberately, across streams.
  host.send({ type: "promote-host", userId: "u-a" });
  await sleep(80);
  [a, b].forEach((x) => x.clear());

  check("b keeps the stream it was watching", b.last("variant"), undefined);
  // The new host now changes tracks: only their own group moves, and b is not in it.
  a.send({ type: "set-tracks", audioStreamId: 8, subtitleStreamId: 0 });
  await sleep(60);
  check("the new host moves alone", a.stream()?.key, "8:0");
  check("b is still not moved", b.last("variant"), undefined);

  // Once the host joins b's stream, a later change takes b with them.
  a.send({ type: "set-tracks", audioStreamId: 1, subtitleStreamId: 0 });
  await sleep(60);
  b.clear();
  a.send({ type: "set-tracks", audioStreamId: 4, subtitleStreamId: 0 });
  await sleep(60);
  check("having joined b, the host now carries b along", b.stream()?.key, "4:0");
  [host, a, b].forEach((x) => x.close());
}

console.log("\n— the timeline stays one timeline —");
{
  const [host, a] = await room("inst-7", ["host", "a"]);
  await startPlayback(host);
  a.send({ type: "set-tracks", audioStreamId: 2, subtitleStreamId: 0 });
  await sleep(50);
  a.send({ type: "variant-session", hlsSessionId: uuid(), sessionOffset: 0 });
  await sleep(50);
  a.clear(); host.clear();

  host.send({ type: "seek", position: 900 });
  await sleep(60);
  check("a seek reaches the other stream", a.last("seek")?.position, 900);
  host.send({ type: "pause", position: 900 });
  await sleep(60);
  check("so does a pause", a.last("pause")?.position, 900);
  [host, a].forEach((x) => x.close());
}

console.log("\n— a driver leaving hands the stream on —");
{
  const [host, a, b] = await room("inst-8", ["host", "a", "b"]);
  await startPlayback(host);
  a.send({ type: "set-tracks", audioStreamId: 2, subtitleStreamId: 0 });
  await sleep(50);
  const aSid = uuid();
  a.send({ type: "variant-session", hlsSessionId: aSid, sessionOffset: 0 });
  await sleep(50);
  b.send({ type: "set-tracks", audioStreamId: 2, subtitleStreamId: 0 });
  await sleep(60);
  check("b joined a's stream", b.stream()?.session, aSid);
  // The guard that stops a departing driver taking everyone else's picture
  // with them — see sessionHasOtherWatchers and the stop route.
  check("the stream is shared, so a may not stop it",
    sessionHasOtherWatchers(aSid, "u-a"), true);
  check("b is not blocked by their own presence",
    sessionHasOtherWatchers(aSid, "u-b"), true);
  b.clear();

  a.close();
  await sleep(120);
  check("b inherits the stream rather than losing it", b.stream()?.owner, true);
  check("and stays on the same session", b.stream()?.session, aSid);
  check("with a gone, b is alone and may stop it",
    sessionHasOtherWatchers(aSid, "u-b"), false);
  [host, b].forEach((x) => x.close());
}

console.log("\n— the scenario end to end —");
{
  // Host + 3 viewers on audio A; one viewer on audio C. Host moves to B.
  const [host, v1, v2, v3, odd] = await room("inst-9", ["host", "v1", "v2", "v3", "odd"]);
  const hostSid = await startPlayback(host);          // audio A = 1
  odd.send({ type: "set-tracks", audioStreamId: 3, subtitleStreamId: 0 });   // audio C
  await sleep(50);
  const oddSid = uuid();
  odd.send({ type: "variant-session", hlsSessionId: oddSid, sessionOffset: 300 });
  await sleep(50);

  const live = () => new Set(
    [host, v1, v2, v3, odd].map((c) => c.stream()?.session).filter(Boolean));
  check("two streams for five people", live().size, 2);
  check("four of them share the host's",
    [host, v1, v2, v3].every((c) => c.stream()?.session === hostSid), true);

  [host, v1, v2, v3, odd].forEach((c) => c.clear());
  host.send({ type: "set-tracks", audioStreamId: 2, subtitleStreamId: 0 });  // audio B
  await sleep(60);
  check("the host's three came along to B",
    [v1, v2, v3].map((c) => c.stream()?.key), ["2:0", "2:0", "2:0"]);
  check("the one on C was not touched", odd.last("variant"), undefined);
  check("the host drives the new stream", host.stream()?.owner, true);

  const bSid = uuid();
  host.send({ type: "variant-session", hlsSessionId: bSid, sessionOffset: 300 });
  await sleep(60);
  check("its followers are moved onto it",
    [v1, v2, v3].every((c) => c.stream()?.session === bSid), true);
  check("still two streams, not five",
    new Set([host, v1, v2, v3].map((c) => c.stream()?.session).concat([oddSid])).size, 2);

  v3.clear();
  v3.send({ type: "set-tracks", audioStreamId: 3, subtitleStreamId: 0 });
  await sleep(60);
  check("v3 reuses the existing C stream", v3.stream()?.session, oddSid);
  check("and does not become its driver", v3.stream()?.owner, false);

  [v1, v2, v3, odd].forEach((c) => c.clear());
  host.close();
  await sleep(140);
  const promoted = [v1, v2, v3, odd].filter((c) => c.last("host-promoted"));
  check("exactly one successor", promoted.length, 1);
  check("and they were on the host's stream",
    promoted[0] === v1 || promoted[0] === v2, true);
  [v1, v2, v3, odd].forEach((c) => c.close());
}

console.log("\n— the room follows the host's playhead, both ways —");
{
  const [host, a] = await room("inst-10", ["host", "a"]);
  await startPlayback(host);
  // Put the room at a known point and let it run.
  host.send({ type: "seek", position: 1000 });
  await sleep(60);

  const clock = () => clockOf("inst-10");

  check("a seek sets the clock", near(await clock(), 1000), "ok");

  // The room's position is the host's playhead. A stalling host reports the
  // same number twice, and the room waits with it rather than walking off —
  // which is what it did when reports behind the clock were discarded, leaving
  // the room permanently ahead of the one person everyone is watching.
  host.send({ type: "heartbeat", position: 1000, playing: true });
  await sleep(60);
  await sleep(2500);
  host.send({ type: "heartbeat", position: 1000, playing: true });
  await sleep(60);
  check("a stalled host holds the room with it", near(await clock(), 1000, 0.8), "ok");

  // Forward reports are ordinary progress.
  host.send({ type: "heartbeat", position: 1400, playing: true });
  await sleep(60);
  check("a forward report moves the clock", near(await clock(), 1400), "ok");

  // Backward ones are followed too, and the small ones are the point: a host
  // half a second down on the clock is still the timeline. Discarding those was
  // the whole bug, and it hid behind a threshold big enough to look harmless.
  await sleep(1200);
  host.send({ type: "heartbeat", position: 1400.5, playing: true });
  await sleep(60);
  check("a small backward report moves it as readily",
    near(await clock(), 1400.5, 0.5), "ok");

  // Large ones too — a host that restarted somewhere else entirely.
  host.send({ type: "heartbeat", position: 1300, playing: true });
  await sleep(60);
  check("and a large one", near(await clock(), 1300), "ok");

  // Between reports it still runs, so a joiner lands where the host is now
  // rather than where it was up to five seconds ago.
  await sleep(1500);
  const ran = await clock();
  check("the clock runs on between reports",
    ran >= 1301 ? "ok" : `clock sat at ${ran}`, "ok");

  [host, a].forEach((c) => c.close());
}

console.log("\n— the clock waits for the host to really start —");
{
  const [host, a] = await room("inst-10b", ["host", "a"]);
  const clock = () => clockOf("inst-10b");

  // "play" says where a transcode was asked to begin. No frame of it exists
  // yet, and on a loaded server the host can be a dozen seconds from its first
  // one. Running the clock through that gap is how the room ends up ahead of
  // its own host for the rest of the film.
  host.send({
    type: "play", ratingKey: "100", title: "A Film", subtitles: false,
    hlsSessionId: uuid(), position: 3000, sessionOffset: 3000,
    audioStreamId: 1, subtitleStreamId: 0,
  });
  await sleep(60);
  await sleep(1500);
  check("an announced start does not run on its own", near(await clock(), 3000), "ok");

  // The first heartbeat is the moment a playhead really exists there.
  host.send({ type: "heartbeat", position: 3001, playing: true });
  await sleep(60);
  await sleep(1500);
  const after = await clock();
  check("the host's first report starts the clock",
    after >= 3002 ? "ok" : `clock sat at ${after}`, "ok");

  [host, a].forEach((c) => c.close());
}

console.log("\n— a restart does not move the room —");
{
  const [host, a] = await room("inst-11", ["host", "a"]);
  await startPlayback(host);
  host.send({ type: "seek", position: 2000 });
  await sleep(60);
  a.clear();

  // Five seconds pass while the host reloads its transcode, then it re-announces
  // with the position it had *before* the load — which is what used to rewind
  // everybody by exactly that long.
  await sleep(1500);
  host.send({
    type: "play", ratingKey: "100", title: "A Film", subtitles: false,
    hlsSessionId: uuid(), position: 2000, sessionOffset: 2000,
    audioStreamId: 1, subtitleStreamId: 0,
  });
  await sleep(60);
  const told = a.last("play")?.position as number;
  check("the re-announce carries the clock, not the stale snapshot",
    told >= 2001 ? "ok" : `told ${told}, clock had moved past 2001`, "ok");

  // A different title is a real start and does set the clock.
  host.send({
    type: "play", ratingKey: "200", title: "Another", subtitles: false,
    hlsSessionId: uuid(), position: 0, sessionOffset: 0,
    audioStreamId: 1, subtitleStreamId: 0,
  });
  await sleep(60);
  check("a new title starts its own clock", a.last("play")?.position, 0);
  [host, a].forEach((c) => c.close());
}

console.log("\n— a host that comes back behind takes the room with it —");
{
  const [host, a] = await room("inst-11b", ["host", "a"]);
  await startPlayback(host);
  host.send({ type: "seek", position: 4000 });
  await sleep(60);
  const clock = () => clockOf("inst-11b");

  // A track change: the host tears its transcode down, and while it has no
  // media it sends nothing. The clock free-runs across the gap so that everyone
  // still playing carries on undisturbed.
  await sleep(1500);
  check("the clock free-runs while the host rebuilds",
    (await clock()) >= 4001 ? "ok" : "clock stopped", "ok");

  // It comes back, and lands wherever the room got to — normally on the clock,
  // and here deliberately short of it, as a host whose new transcode could not
  // reach the target would be. Whatever it reports is where the room is: the
  // alternative is a room that sits ahead of the only playhead in it, which is
  // exactly what put a viewer twelve seconds clear of the host.
  host.send({
    type: "play", ratingKey: "100", title: "A Film", subtitles: false,
    hlsSessionId: uuid(), position: 4001, sessionOffset: 4001,
    audioStreamId: 2, subtitleStreamId: 0,
  });
  await sleep(60);
  host.send({ type: "heartbeat", position: 4001, playing: true });
  await sleep(60);
  check("the room re-anchors on the host that came back", near(await clock(), 4001), "ok");

  // And it stays there: no residue of the free-run survives to be added to the
  // next one.
  host.send({ type: "heartbeat", position: 4002, playing: true });
  await sleep(60);
  check("no lead is carried over from the rebuild", near(await clock(), 4002), "ok");

  [host, a].forEach((c) => c.close());
}

console.log("\n— the evening that broke —");
{
  const [host, a] = await room("inst-13", ["host", "a"]);
  const clock = () => clockOf("inst-13");

  // Replays a real session, compressed. The host announced 5737.8 and then
  // took 12.7 seconds to produce a frame, because Plex was transcoding two HDR
  // streams and scanning the library at the same time. The room ran through
  // that load, never came back, and sat exactly 12.73s ahead of its own host
  // for the rest of the film — with anyone who switched subtitles landing
  // neatly on the clock and therefore that far ahead of what the host was
  // watching. A pause was the only thing that ever fixed it.
  host.send({
    type: "play", ratingKey: "100", title: "A Film", subtitles: true,
    hlsSessionId: uuid(), position: 5737.8, sessionOffset: 5737.8,
    audioStreamId: 1, subtitleStreamId: 5,
  });
  await sleep(60);
  await sleep(1500);
  check("the room waits out the host's load", near(await clock(), 5737.8), "ok");

  // Frames at last, and from here the host reports as it plays.
  let pos = 5737.8;
  for (let i = 0; i < 3; i++) {
    host.send({ type: "heartbeat", position: pos, playing: true });
    await sleep(60);
    const lead = (await clock()) - pos;
    check(`the room stays with the host, report ${i + 1}`,
      lead < 1 ? "ok" : `room is ${lead.toFixed(2)}s ahead`, "ok");
    await sleep(500);
    pos += 0.5;
  }

  // The viewer drops subtitles, which forks them onto a stream of their own.
  // They start it at whatever the room says the position is, so that number
  // has to be the host's.
  a.send({ type: "watching", value: true });
  a.send({ type: "set-tracks", audioStreamId: 1, subtitleStreamId: 0 });
  await sleep(60);
  check("a fork inherits the host's position, not a runaway clock",
    near(await clock(), pos, 1.2), "ok");

  [host, a].forEach((c) => c.close());
}

console.log("\n— ending one title and starting another takes the room with you —");
{
  const [host, a, b] = await room("inst-14", ["host", "a", "b"]);
  const sid1 = await startPlayback(host);
  check("everyone starts together", [a.stream()?.session, b.stream()?.session], [sid1, sid1]);

  a.clear(); b.clear();
  host.send({ type: "stop" });
  await sleep(60);
  check("the stop reaches everyone", [!!a.last("stop"), !!b.last("stop")], [true, true]);

  // Nothing is playing, so nothing should be handed a stream — including
  // somebody who arrives now. A client that keeps the stream it was last told
  // about is holding a session id for a transcode that has been killed, and the
  // next thing it plays adopts that id instead of announcing itself: the host
  // ends up watching the new title alone while the room sits on the old one.
  const probe = new Client("u-probe-stop", "probe");
  await probe.connect("inst-14");
  check("and a joiner is told there is no stream", probe.last("state")?.variant, null);
  probe.close();
  await sleep(30);

  // Now a different title.
  a.clear(); b.clear();
  const sid2 = uuid();
  host.send({
    type: "play", ratingKey: "200", title: "Another", subtitles: false,
    hlsSessionId: sid2, position: 0, sessionOffset: 0,
    audioStreamId: 1, subtitleStreamId: 0,
  });
  await sleep(60);

  check("the viewers are told what is playing now",
    [a.last("play")?.ratingKey, b.last("play")?.ratingKey], ["200", "200"]);
  check("and which stream to play it from",
    [a.stream()?.session, b.stream()?.session], [sid2, sid2]);
  check("on the host's tracks", [a.stream()?.key, b.stream()?.key], ["1:0", "1:0"]);
  check("with the host driving", host.stream()?.owner, true);
  check("and neither of them", [a.stream()?.owner, b.stream()?.owner], [false, false]);

  [host, a, b].forEach((c) => c.close());
}

console.log("\n— stepping out of the player keeps your stream —");
{
  const [host, a] = await room("inst-12", ["host", "a"]);
  await startPlayback(host);
  a.send({ type: "watching", value: true });
  a.send({ type: "set-tracks", audioStreamId: 4, subtitleStreamId: 0 });
  await sleep(60);
  const aSid = uuid();
  a.send({ type: "variant-session", hlsSessionId: aSid, sessionOffset: 100 });
  await sleep(60);
  check("a is driving its own stream", a.stream()?.session, aSid);

  // Back out of the player, still in the room.
  a.send({ type: "watching", value: false });
  await sleep(80);
  check("the stream is held for the walk back",
    sessionHasOtherWatchers(aSid, "nobody"), true);

  // Straight back in — same session, no new transcode.
  a.clear();
  a.send({ type: "watching", value: true });
  await sleep(60);
  check("and is still theirs on return", sessionHasOtherWatchers(aSid, "nobody"), true);

  // Leaving the room for real does release it.
  a.close();
  await sleep(120);
  check("leaving the room releases it", sessionHasOtherWatchers(aSid, "nobody"), false);
  host.close();
}

console.log("\n— rejoining the host's stream on request —");
{
  const [host, a, b] = await room("inst-12", ["host", "a", "b"]);
  const hostSid = await startPlayback(host);
  // a forks onto its own tracks and brings a transcode up.
  a.send({ type: "set-tracks", audioStreamId: 4, subtitleStreamId: 0 });
  await sleep(50);
  a.send({ type: "variant-session", hlsSessionId: uuid(), sessionOffset: 100 });
  await sleep(50);
  check("a is on a stream of its own", a.stream()?.key, "4:0");
  [host, a, b].forEach((c) => c.clear());

  // Its stream can't keep up, so it asks to go back to whatever the host has.
  a.send({ type: "rejoin-host" });
  await sleep(60);
  check("a lands on the host's tracks", a.stream()?.key, "1:0");
  check("and on the host's existing transcode", a.stream()?.session, hostSid);
  check("without becoming its driver", a.stream()?.owner, false);
  check("nobody else was disturbed", b.last("variant"), undefined);

  // Asking again from the host's own stream is a no-op.
  a.clear();
  a.send({ type: "rejoin-host" });
  await sleep(60);
  check("asking twice changes nothing", a.last("variant"), undefined);
  [host, a, b].forEach((c) => c.close());
}

console.log(`\n${pass} passed, ${fail} failed\n`);
closeWebSocketServer();
server.close();
process.exit(fail === 0 ? 0 : 1);
