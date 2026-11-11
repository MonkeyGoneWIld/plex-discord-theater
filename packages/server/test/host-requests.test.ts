/**
 * Asking an away host for the role (services/hostRequests), through the sync
 * server: one request at a time, seen by everyone; a no shuts requests for a
 * while; no answer passes the role on; a host away has less time; the host it
 * was taken from can take it back; a new activity starts clean; and
 * HOST_REQUESTS=off turns it off.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";

process.env.THUMB_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "host-requests-"));
process.env.PDT_HOST_REQUEST_WAIT_MS = "600";
process.env.PDT_HOST_REQUEST_AWAY_MS = "200";

const { attachWebSocketServer, closeWebSocketServer } = await import("../src/services/sync.js");
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
  last(type: string): Msg | undefined {
    for (let i = this.seen.length - 1; i >= 0; i--) if (this.seen[i].type === type) return this.seen[i];
    return undefined;
  }
  /** This player's view: who asked, and why it can't ask (null: it may). */
  view() {
    const v = this.last("host-request");
    return v ? { asker: v.active?.requesterName ?? null, blocked: v.blocked?.why ?? null } : "none";
  }
  close() { this.ws.close(); }
}

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
const isHost = (c: Client) => c.last("participants")?.participants.find((p: Msg) => p.userId === c.userId)?.isHost === true;

console.log("\n— one request at a time, and a no —");
{
  const [host, bea, cy] = await room("hr-1", ["host", "bea", "cy"]);
  check("anyone but the host may ask", [host.view(), bea.view(), cy.view()],
    [{ asker: null, blocked: "host" }, { asker: null, blocked: null }, { asker: null, blocked: null }]);
  bea.send({ type: "host-request" });
  await sleep(60);
  check("everyone sees who asked", [host.view(), bea.view(), cy.view()],
    [{ asker: "bea", blocked: "host" }, { asker: "bea", blocked: "asked" }, { asker: "bea", blocked: "asked" }]);
  const ends = cy.last("host-request")!.active.endsAt - cy.last("host-request")!.now;
  check("  and the time left", ends > 500 && ends <= 600, true);
  cy.send({ type: "host-request" });
  await sleep(60);
  check("a second asker waits for the first", cy.view(), { asker: "bea", blocked: "asked" });
  // What a page from before 11 November sent when the host touched anything.
  host.send({ type: "host-request-answer", accept: false, present: true });
  host.send({ type: "host-request-answer" });
  await sleep(60);
  check("the host using the activity answers nothing: only their own Decline does", [bea.view(), cy.view()],
    [{ asker: "bea", blocked: "asked" }, { asker: "bea", blocked: "asked" }]);
  host.send({ type: "host-request-answer", accept: false });
  await sleep(60);
  check("declined: the asker waits longest, everyone else too", [bea.view(), cy.view()],
    [{ asker: null, blocked: "you-declined" }, { asker: null, blocked: "declined" }]);
  const v = bea.last("host-request")!;
  check("  two hours for the asker", Math.round((v.blocked.until - v.now) / 60_000), 120);
  const w = cy.last("host-request")!;
  check("  fifteen minutes for the room", Math.round((w.blocked.until - w.now) / 60_000), 15);
  await sleep(700);
  check("the host keeps the role", isHost(host), true);

  console.log("\n— a new activity starts clean —");
  const [host2, bea2] = await room("hr-2", ["host", "bea"]);
  check("the asker may ask there", bea2.view(), { asker: null, blocked: null });
  for (const c of [host, bea, cy, host2, bea2]) c.close();
  await sleep(60);
}

console.log("\n— no answer, an away host, and taking it back —");
{
  const [host, bea, cy] = await room("hr-3", ["host", "bea", "cy"]);
  host.send({ type: "activity-away", away: true });
  await sleep(30);
  bea.send({ type: "host-request" });
  await sleep(60);
  const v = bea.last("host-request")!;
  check("an away host has the short wait", v.active.endsAt - v.now <= 200, true);
  await sleep(300);
  check("no answer: the role passes to the asker", [isHost(bea), isHost(host)], [true, false]);
  check("  who is told", bea.last("host-promoted") !== undefined, true);
  check("nobody may ask the new host straight away", cy.view(), { asker: null, blocked: "protected" });
  const h = host.last("host-request")!;
  check("the old host may take it back", h.reclaimUntil !== null && h.reclaimUntil > h.now, true);
  cy.send({ type: "host-reclaim" });
  await sleep(60);
  check("  nobody else", isHost(bea), true);
  host.send({ type: "host-reclaim" });
  await sleep(60);
  check("  and it is theirs again", [isHost(host), isHost(bea)], [true, false]);
  check("  once", host.last("host-request")!.reclaimUntil, null);
  for (const c of [host, bea, cy]) c.close();
  await sleep(60);
}

console.log("\n— a host who goes away mid-countdown, an asker who leaves —");
{
  const [host, bea, cy] = await room("hr-4", ["host", "bea", "cy"]);
  bea.send({ type: "host-request" });
  await sleep(60);
  host.send({ type: "activity-away", away: true });
  await sleep(60);
  const v = cy.last("host-request")!;
  check("the countdown drops to the short wait", v.active.endsAt - v.now <= 200, true);
  bea.close();
  await sleep(100);
  check("who asked left: the request ends", cy.view(), { asker: null, blocked: null });
  await sleep(300);
  check("  and the host keeps the role", isHost(host), true);

  console.log("\n— the host there: accepted —");
  cy.send({ type: "host-request" });
  await sleep(60);
  host.send({ type: "host-request-answer", accept: true });
  await sleep(60);
  check("given: the asker is host", [isHost(cy), isHost(host)], [true, false]);
  check("  and nobody may take it back", host.last("host-request")!.reclaimUntil, null);
  for (const c of [host, cy]) c.close();
  await sleep(60);
}

console.log("\n— HOST_REQUESTS=off —");
{
  process.env.HOST_REQUESTS = "off";
  const [host, bea] = await room("hr-5", ["host", "bea"]);
  bea.send({ type: "host-request" });
  await sleep(60);
  check("no requests", [bea.last("host-request")!.on, bea.view()], [false, { asker: null, blocked: "off" }]);
  check("  the host keeps the role", isHost(host), true);
  delete process.env.HOST_REQUESTS;
  for (const c of [host, bea]) c.close();
  await sleep(60);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
closeWebSocketServer();
server.close();
process.exit(fail === 0 ? 0 : 1);
