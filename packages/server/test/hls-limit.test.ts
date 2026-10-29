/**
 * The HLS budget counts segments, not the parts they are asked for in: run 29
 * (29 October) spent the 3,000 a quarter of an hour in eleven and a half
 * minutes of 16-part segments, and every request after was refused.
 */
import express from "express";
import type { AddressInfo } from "node:net";
import { hlsLimiters, laterPart } from "../src/middleware/hls-limit.js";
import { MAX_SEGMENT_PARTS } from "../src/services/direct-stream.js";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

console.log("— which requests are a segment's later parts —");
check("a whole segment", laterPart({ query: {} }), false);
check("its first part", laterPart({ query: { part: "0", parts: "16" } }), false);
check("its second", laterPart({ query: { part: "1", parts: "16" } }), true);
check("its last", laterPart({ query: { part: "15", parts: "16" } }), true);
check("a part with no split named", laterPart({ query: { part: "3" } }), false);
check("a part that isn't a number", laterPart({ query: { part: "x", parts: "4" } }), false);

const MAX = 5;
const app = express();
const limit = hlsLimiters(MAX);
app.use("/seg", limit);
app.use("/ping", limit);
app.get("/seg", (_req, res) => { res.send("ok"); });
app.get("/ping", (_req, res) => { res.send("ok"); });
const server = app.listen(0);
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const status = async (p: string) => (await fetch(origin + p)).status;

console.log(`\n— ${MAX} segments a quarter, each in ${MAX_SEGMENT_PARTS} parts —`);
const statuses: number[] = [];
for (let seg = 0; seg < MAX - 1; seg++) {
  for (let part = 0; part < MAX_SEGMENT_PARTS; part++) {
    statuses.push(await status(`/seg?n=${seg}&part=${part}&parts=${MAX_SEGMENT_PARTS}`));
  }
}
check(`${MAX - 1} segments in ${MAX_SEGMENT_PARTS} parts each all come`, statuses.every((s) => s === 200), true);
check("the ping counts with the segments", await status("/ping"), 200);
check(`and past ${MAX} a segment's first part is refused`, await status(`/seg?n=9&part=0&parts=${MAX_SEGMENT_PARTS}`), 429);
check("as is a whole one", await status("/seg?n=9"), 429);
check("and the ping", await status("/ping"), 429);

console.log(`\n— later parts have a ceiling of their own, ${MAX_SEGMENT_PARTS} times as high —`);
const later: number[] = [];
for (let i = 0; i < MAX * MAX_SEGMENT_PARTS - (MAX - 1) * (MAX_SEGMENT_PARTS - 1); i++) {
  later.push(await status(`/seg?n=${20 + i}&part=1&parts=2`));
}
check("up to it they come", later.every((s) => s === 200), true);
check("past it they are refused", await status("/seg?n=99&part=1&parts=2"), 429);

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
