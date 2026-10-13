/**
 * The bot's P2P tracker keeps each player's connection to it from going quiet,
 * and lets go of a player that has gone (services/tracker.ts): real WebSockets
 * against the real tracker, and the players' own tracker library reading what
 * the bot sends to keep a connection going.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";

process.env.THUMB_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-keepalive-"));
const PING_MS = 150;
process.env.PDT_TRACKER_PING_MS = String(PING_MS);

const { attachWebSocketServer, closeWebSocketServer } = await import("../src/services/sync.js");
const { createSession } = await import("../src/middleware/auth.js");

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
const url = () => `ws://127.0.0.1:${port}/tracker?token=${createSession(`u-${crypto.randomUUID()}`, null)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Twenty characters, as the tracker library sends a stream's and a player's ids. */
const id20 = (s: string) => s.padEnd(20, "-").slice(0, 20);
const SWARM = id20("swarm-a");

interface Player { ws: WebSocket; seen: Array<Record<string, unknown>>; pings: number; closed: boolean }

async function player(answersPings = true): Promise<Player> {
  const ws = new WebSocket(url(), { autoPong: answersPings });
  const p: Player = { ws, seen: [], pings: 0, closed: false };
  ws.on("message", (d) => p.seen.push(JSON.parse(String(d))));
  ws.on("ping", () => { p.pings++; });
  ws.on("close", () => { p.closed = true; });
  await new Promise<void>((r, j) => { ws.once("open", () => r()); ws.once("error", j); });
  return p;
}

/** Into the swarm, as a player starting a stream does — without offers, which need WebRTC. */
async function announce(p: Player, peer: string): Promise<Record<string, unknown>> {
  const before = p.seen.length;
  p.ws.send(JSON.stringify({ action: "announce", event: "started", info_hash: SWARM, peer_id: id20(peer), numwant: 0, uploaded: 0, downloaded: 0, left: 1 }));
  for (let i = 0; i < 40 && !p.seen.slice(before).some((m) => m.info_hash === SWARM); i++) await sleep(25);
  return p.seen.slice(before).find((m) => m.info_hash === SWARM) ?? {};
}

console.log("\n— a player that is there —");
const a = await player();
await announce(a, "peer-a");
await sleep(PING_MS * 4);
check("is pinged while it stays connected", a.pings >= 2, true);
check("and sent something its tracker library puts aside, for something going the other way",
  a.seen.filter((m) => m.info_hash === "pdt:keep-alive" && m.action === "announce").length >= 2, true);
check("and stays connected", a.closed, false);

console.log("\n— a player that has gone without saying so —");
const b = await player(false);
await announce(b, "peer-b");
const withB = await announce(await player(), "peer-c");
check("was in the swarm", withB.incomplete, 3);
await sleep(PING_MS * 4);
check("is let go of", b.closed, true);
const d = await player();
const without = await announce(d, "peer-d");
check("and is no longer offered to anybody joining as somebody to connect to", without.incomplete, 3);

console.log("\n— what the players' tracker library makes of the bot's keep-alive —");
{
  const { default: WebSocketTracker } = await import("bittorrent-tracker/websocket-tracker");
  const warnings: unknown[] = [];
  const fake = Object.assign(new (await import("node:events")).EventEmitter(), {
    _infoHashBinary: SWARM,
    _peerIdBinary: id20("peer-lib"),
    _defaultAnnounceOpts: (o: Record<string, unknown> = {}) => ({ numwant: 0, ...o }),
  });
  fake.on("warning", (w) => warnings.push(w));
  fake.on("error", (e) => warnings.push(e));
  const lib = new WebSocketTracker(fake, url()) as unknown as {
    socket: { connected: boolean; once: (e: string, f: () => void) => void } | null;
    destroyed: boolean;
    reconnecting: boolean;
    destroy: (cb?: () => void) => void;
  };
  await new Promise<void>((r) => { if (lib.socket?.connected) r(); else lib.socket?.once("connect", () => r()); });
  await sleep(PING_MS * 4);
  check("nothing it takes for the tracker failing", warnings.map(String), []);
  check("so it keeps its connection, rather than dropping it to try again", [lib.destroyed, lib.reconnecting], [false, false]);
  lib.destroy();
}

a.ws.close();
d.ws.close();
await sleep(50);
closeWebSocketServer?.();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
