/**
 * What the server relays from Plex to a player (a re-encoded segment, a
 * preview file) goes at the player's pace (routes/plex.ts pipeBody): a player
 * reading slowly isn't sent more than it takes, the rest held in the server's
 * memory, and a player gone stops the read from Plex.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

process.env.THUMB_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pipe-body-"));
process.env.PLEX_URL = "http://127.0.0.1:9";
process.env.PLEX_TOKEN = "test-token";
process.env.LOG_TO_FILE = "0";

const { pipeBody } = await import("../src/routes/plex.js");

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CHUNK = 64 * 1024;
const CHUNKS = 1024; // 64 MB, as from Plex: handed over as fast as it is asked for
let pulled = 0;
let cancelled = false;
function plexBody(): ReadableStream<Uint8Array> {
  pulled = 0;
  cancelled = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= CHUNKS) return controller.close();
      pulled++;
      controller.enqueue(new Uint8Array(CHUNK));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
}

let piped: Promise<void> | null = null;
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "video/MP2T" });
  piped = pipeBody(plexBody(), res);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;

console.log("— a player that isn't reading —");
{
  // Connected, and reading nothing: what the server takes from Plex is what
  // the connection holds, not the whole body.
  const req = http.get(`http://127.0.0.1:${port}/`);
  const res = await new Promise<http.IncomingMessage>((r) => req.on("response", r));
  res.pause();
  await sleep(800);
  const mb = (pulled * CHUNK) / 1024 / 1024;
  check("isn't sent more than the connection holds (under 16 of 64 MB)", mb < 16 ? "yes" : `${mb} MB`, "yes");
  req.destroy();
  await sleep(300);
  check("and gone, the read from Plex is stopped", cancelled, true);
  check("before the rest of it", pulled < CHUNKS, true);
  await piped;
}

console.log("— a player that reads it all —");
{
  const res = await fetch(`http://127.0.0.1:${port}/`);
  const body = Buffer.from(await res.arrayBuffer());
  await piped;
  check("gets every byte", body.length, CHUNK * CHUNKS);
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
