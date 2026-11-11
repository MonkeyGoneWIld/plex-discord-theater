/**
 * A player's log batch (POST /api/logs/client) is written one line per entry
 * (routes/logs.ts): nothing a browser sends — its id, the entry's tag, message,
 * or the names and values in its data — can start a line of its own in the
 * file, where it would pass for one of the server's.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "client-logs-"));
process.env.THUMB_CACHE_DIR = dir;
process.env.LOG_DIR = path.join(dir, "logs");
delete process.env.LOG_TO_FILE;

const { default: express } = await import("express");
const { default: logsRouter } = await import("../src/routes/logs.js");
const { closeLogger } = await import("../src/services/logger.js");
// The route finds whose lines they are from the session (for the admin
// page's history), so it opens the session database: closed before the
// folder goes, which Windows won't delete with it open.
const { closeSessionDb } = await import("../src/middleware/auth.js");

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

const app = express();
app.use(express.json());
app.use("/api/logs", logsRouter);
const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;

const FORGED = "2026-01-01T00:00:00.000Z [Server] forged";
const entries = [
  { t: Date.now(), tag: "Player", msg: "plain" },
  { t: Date.now(), tag: "Player", msg: "data value", data: { note: `x\n${FORGED} by value` } },
  { t: Date.now(), tag: "Player", msg: "data key", data: { [`k\r\n${FORGED} by key`]: 1 } },
  { t: Date.now(), tag: "Player", msg: "nested", data: { obj: { a: `y\n${FORGED} nested` } } },
];
const res = await fetch(`http://127.0.0.1:${port}/api/logs/client`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ clientId: `\n${FORGED} by id`, sentAt: Date.now(), entries }),
});
check("the batch is taken", res.status, 200);
closeLogger();
await new Promise<void>((resolve) => server.close(() => resolve()));

const files = fs.readdirSync(process.env.LOG_DIR).filter((n) => n.startsWith("theater-"));
const lines = files.flatMap((n) => fs.readFileSync(path.join(process.env.LOG_DIR!, n), "utf8").split("\n")).filter(Boolean);
const clientLines = lines.filter((l) => l.includes("[client:"));
check("one line per entry", clientLines.length, entries.length);
check("no line was started by the browser", lines.filter((l) => l.startsWith(FORGED)).length, 0);
check("every line starts with a whole timestamp (the browser's id can't start one)",
  lines.filter((l) => !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /.test(l)).map((l) => l.slice(0, 80)), []);
check("what was sent is still there, on its own line", clientLines.some((l) => l.includes("by value")), true);

closeSessionDb();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
