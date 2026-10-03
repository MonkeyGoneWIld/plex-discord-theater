/**
 * The duration on Plex timeline updates.
 *
 * Every timeline we send carries the title's duration, which used to be known
 * only for titles whose metadata had been built from Plex since the server
 * started. Metadata answered from a cache — the persisted one answers for
 * nearly everything after a restart — never recorded it, and neither did a
 * session started without anyone reading /meta, so Plex logged
 * "progress of 3437358/0ms" for most of what was played. Pinned down here
 * against a Plex that records every timeline it is sent.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

process.env.THUMB_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "timeline-duration-"));
process.env.PLEX_TOKEN = "test-token";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

// ── a Plex with two films, which keeps what it is told ───────────
const CACHED = "100"; // metadata already in the persisted cache, as after a restart
const UNSEEN = "200"; // metadata nobody has asked for yet
const film = (ratingKey: string, title: string, duration: number) => ({
  ratingKey, title, type: "movie", duration,
  Media: [{ id: Number(ratingKey), Part: [{ id: Number(ratingKey), file: `/movies/${title}.mkv` }] }],
});
const films = [film(CACHED, "Cached", 7_200_000), film(UNSEEN, "Unseen", 5_400_000)];

const timelines: Array<{ ratingKey: string | null; state: string | null; duration: string | null }> = [];
const metadataRequests: string[] = [];

const plex = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://plex");
  const send = (body: unknown) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ MediaContainer: body }));
  };
  const one = films.find((f) => url.pathname === `/library/metadata/${f.ratingKey}`);
  if (one) {
    metadataRequests.push(one.ratingKey);
    return send({ Metadata: [one] });
  }
  if (url.pathname === "/:/timeline") {
    const q = url.searchParams;
    timelines.push({ ratingKey: q.get("ratingKey"), state: q.get("state"), duration: q.get("duration") });
    return send({});
  }
  if (url.pathname === "/video/:/transcode/universal/decision") {
    return send({ generalDecisionCode: 1000, generalDecisionText: "Direct play OK." });
  }
  if (url.pathname === "/video/:/transcode/universal/start.m3u8") {
    res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
    res.end(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000\nsession/${crypto.randomUUID()}/base/index.m3u8\n`);
    return;
  }
  if (url.pathname === "/video/:/transcode/universal/ping" || url.pathname === "/video/:/transcode/universal/stop") {
    return send({});
  }
  // Everything else — the prefetcher's segments included — is absent.
  res.writeHead(404);
  res.end();
});
await new Promise<void>((r) => plex.listen(0, "127.0.0.1", r));
process.env.PLEX_URL = `http://127.0.0.1:${(plex.address() as AddressInfo).port}`;

// Imported only now: the router reads PLEX_URL at module load.
const express = (await import("express")).default;
const plexRoutes = (await import("../src/routes/plex.js"));
const { writeDetailCache } = await import("../src/services/detail-cache.js");

const app = express();
app.use("/api/plex", plexRoutes.default);
const api = http.createServer(app);
await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}/api/plex`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The duration on the first timeline Plex is sent for this title and state,
 *  counting from the `from`th timeline it was sent. */
async function timelineDuration(ratingKey: string, state: string, from = 0): Promise<string | null> {
  for (let i = 0; i < 50; i++) {
    const t = timelines.slice(from).find((x) => x.ratingKey === ratingKey && x.state === state);
    if (t) return t.duration;
    await sleep(20);
  }
  return null;
}
/** Start a session that names its version, so nothing on the way reads /meta. */
async function play(ratingKey: string): Promise<string> {
  const sessionId = crypto.randomUUID();
  const res = await fetch(`${base}/hls/${ratingKey}/${sessionId}/master.m3u8?mediaIndex=0`);
  await res.text();
  if (!res.ok) throw new Error(`master.m3u8 for ${ratingKey} → ${res.status}`);
  return sessionId;
}

console.log("— a title answered from the persisted cache —");
writeDetailCache("meta", CACHED, {
  ratingKey: CACHED, title: "Cached", type: "movie", duration: 7_200_000,
  versions: [{ mediaIndex: 0, partId: Number(CACHED) }],
});
check("/meta answers from the cache", (await (await fetch(`${base}/meta/${CACHED}`)).json()).duration, 7_200_000);
const cachedSession = await play(CACHED);
check("the first timeline carries its duration", await timelineDuration(CACHED, "playing"), "7200000");
const beforePing = timelines.length;
await (await fetch(`${base}/hls/ping/${cachedSession}?time=60000&playing=1`)).text();
check("so does a ping's timeline", await timelineDuration(CACHED, "playing", beforePing), "7200000");
await plexRoutes.notifyPlexStopped(CACHED, cachedSession);
check("so does the stopped timeline", await timelineDuration(CACHED, "stopped"), "7200000");
check("…all without asking Plex for the metadata", metadataRequests.includes(CACHED), false);

console.log("— a title nobody has looked up —");
const unseenSession = await play(UNSEEN);
check("the first timeline carries its duration", await timelineDuration(UNSEEN, "playing"), "5400000");
await plexRoutes.notifyPlexStopped(UNSEEN, unseenSession);
check("so does the stopped timeline", await timelineDuration(UNSEEN, "stopped"), "5400000");
check("Plex was asked for it once", metadataRequests.filter((rk) => rk === UNSEEN).length, 1);

console.log("— nothing sent without one —");
check("no timeline said duration=0", timelines.filter((t) => t.duration === "0"), []);

api.close();
plex.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
