/**
 * Seerr sessions that stop being valid.
 *
 * The server logs into Seerr once and reuses the session cookie. When Seerr
 * drops that session, it answers 403 — not 401 — and the server used to retry
 * only on 401, so every lookup failed until the cookie's six-hour TTL ran out:
 * show pages said "Could not load missing seasons" for hours. The fake Seerr
 * here keeps real sessions and follows Seerr's own rule for requests without
 * one.
 */
import type { AddressInfo } from "node:net";
import express from "express";

process.env.PLEX_TOKEN = "test-token";
process.env.SEERR_URL = "http://seerr.test";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const sessions = new Set<string>();
let logins = 0;
const asked: string[] = [];

globalThis.fetch = (async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "127.0.0.1") return realFetch(input, init);
  if (url.hostname !== "seerr.test") throw new Error(`Unexpected upstream: ${url.hostname}`);
  if (url.pathname === "/api/v1/auth/plex") {
    const sid = `s${++logins}`;
    sessions.add(sid);
    return json({}, 200, { "set-cookie": `connect.sid=${sid}; Path=/; HttpOnly` });
  }
  asked.push(url.pathname);
  const sid = new Headers(init?.headers).get("cookie")?.match(/connect\.sid=([^;]+)/)?.[1] ?? "";
  const refused = { status: 403, error: "You do not have permission to access this endpoint" };
  // Seerr's rule: no valid session is a 403.
  if (!sessions.has(sid)) return json(refused, 403);
  // And a title this account may not see, whatever its session.
  if (url.pathname === "/api/v1/tv/666") return json(refused, 403);
  return json({ seasons: [{ seasonNumber: 1, episodeCount: 7, airDate: "2020-10-23" }] });
}) as typeof fetch;

const { default: seerr } = await import("../src/routes/seerr.js");
const app = express();
app.use("/api/seerr", seerr);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/seerr`;
const lookup = async (tmdbId: number) => (await fetch(`${base}/tv/${tmdbId}`)).status;

try {
  check("a first lookup logs in and succeeds", await lookup(87739), 200);
  check("…with one login", logins, 1);
  check("the session is reused", [await lookup(87739), logins], [200, 1]);

  // Seerr restarts, or its session store expires the cookie.
  sessions.clear();
  check("a dropped session is noticed and the lookup still succeeds", await lookup(87739), 200);
  check("…by logging in again once", logins, 2);
  check("the new session is reused", [await lookup(87739), logins], [200, 2]);

  asked.length = 0;
  check("a real refusal still fails", await lookup(666), 502);
  check("…after a single fresh login, not a loop", [logins, asked.length], [3, 2]);
  check("and lookups afterwards are unaffected", [await lookup(87739), logins], [200, 3]);
} finally {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
