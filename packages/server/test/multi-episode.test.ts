/**
 * Multi-episode files.
 *
 * Plex files "S02E18-E19" as two episode entries pointing at one file, and its
 * own players treat the file as the unit: either entry plays both episodes,
 * marks both played, and is followed by E20. Treating the entries as ordinary
 * neighbours played the file twice in a row. Pinned down here against a Plex
 * whose season 2 has exactly that file between two ordinary episodes.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

process.env.THUMB_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "multi-episode-"));
process.env.PLEX_TOKEN = "test-token";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

// ── a Plex with one multi-episode file in season 2 ───────────────
const SHOW = "900";
const SEASON = "901";
function episode(ratingKey: string, index: number, title: string, partId: number, file: string) {
  return {
    ratingKey, index, title, type: "episode", duration: 2_640_000,
    parentIndex: 2, parentRatingKey: SEASON, grandparentRatingKey: SHOW,
    grandparentTitle: "The Show", parentTitle: "Season 2",
    Media: [{ id: partId, Part: [{ id: partId, file }] }],
  };
}
const episodes = [
  episode("917", 17, "Before", 5017, "/tv/The Show/S02E17.mkv"),
  episode("918", 18, "First Half", 5018, "/tv/The Show/S02E18-E19.mkv"),
  episode("919", 19, "Second Half", 5018, "/tv/The Show/S02E18-E19.mkv"),
  episode("920", 20, "After", 5020, "/tv/The Show/S02E20.mkv"),
];

const plex = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://plex");
  const send = (body: unknown) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ MediaContainer: body }));
  };
  if (url.pathname === `/library/metadata/${SHOW}/allLeaves` || url.pathname === `/library/metadata/${SEASON}/children`) {
    return send({ Metadata: episodes });
  }
  if (url.pathname === "/:/prefs") {
    return send({ Setting: [{ id: "LibraryVideoPlayedThreshold", value: 90 }] });
  }
  if (url.pathname === `/library/metadata/${SHOW}`) {
    return send({ Metadata: [{ ratingKey: SHOW, title: "The Show", type: "show" }] });
  }
  const one = episodes.find((e) => url.pathname === `/library/metadata/${e.ratingKey}`);
  if (one) return send({ Metadata: [one] });
  res.writeHead(404);
  res.end();
});
await new Promise<void>((r) => plex.listen(0, "127.0.0.1", r));
process.env.PLEX_URL = `http://127.0.0.1:${(plex.address() as AddressInfo).port}`;

// Imported only now: the router reads PLEX_URL at module load.
const express = (await import("express")).default;
const plexRoutes = (await import("../src/routes/plex.js")).default;
const { sameFileRun, sharesFile, episodesInSameFile } = await import("../src/services/episode-files.js");
const history = await import("../src/services/watch-history.js");

const app = express();
app.use("/api/plex", plexRoutes);
const api = http.createServer(app);
await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}/api/plex`;
const get = async (p: string) => (await fetch(`${base}${p}`)).json() as Promise<Record<string, any>>;

console.log("— telling files apart —");
const part = (id?: number, file?: string) => ({ Media: [{ Part: [{ ...(id != null && { id }), ...(file && { file }) }] }] });
check("same part id", sharesFile(part(1), part(1)), true);
check("same path, different part ids", sharesFile(part(1, "/a.mkv"), part(2, "/a.mkv")), true);
check("different files", sharesFile(part(1, "/a.mkv"), part(2, "/b.mkv")), false);
check("nothing known about the files", sharesFile({}, {}), false);
const three = [part(1, "/e1.mkv"), part(2, "/e2-e4.mkv"), part(2, "/e2-e4.mkv"), part(2, "/e2-e4.mkv"), part(5, "/e5.mkv")];
check("an ordinary episode is a run of one", sameFileRun(three, 0), { start: 0, end: 0 });
check("a three-episode file from its middle", sameFileRun(three, 2), { start: 1, end: 3 });
check("…and from its last episode", sameFileRun(three, 3), { start: 1, end: 3 });

console.log("— next and previous episode —");
const siblings = async (rk: string) => {
  const r = await get(`/siblings/${rk}`);
  return { prev: r.prev?.ratingKey ?? null, next: r.next?.ratingKey ?? null };
};
check("E17 is followed by the file, at its first episode", await siblings("917"), { prev: null, next: "918" });
check("E18 is followed by E20, not E19", await siblings("918"), { prev: "917", next: "920" });
check("E19 is followed by E20 and preceded by E17", await siblings("919"), { prev: "917", next: "920" });
check("E20 goes back to the start of the file", await siblings("920"), { prev: "918", next: null });

console.log("— naming the episodes —");
const both = [
  { ratingKey: "918", index: 18, title: "First Half" },
  { ratingKey: "919", index: 19, title: "Second Half" },
];
check("E18's metadata names both episodes", (await get("/meta/918")).fileEpisodes, both);
check("so does E19's", (await get("/meta/919")).fileEpisodes, both);
check("an ordinary episode names none", (await get("/meta/917")).fileEpisodes, undefined);
check("the lookup the progress writer uses agrees", await episodesInSameFile("919"), both);
check("…and says nothing for an ordinary episode", await episodesInSameFile("920"), []);
check("the file path never reaches a client", JSON.stringify(await get("/meta/918")).includes("/tv/"), false);

console.log("— what to watch next —");
await history.recordProgress("u1", "918", 2_600, { force: true });
check("finishing E18 offers E20, even with no row for E19", (await history.getShowNextUp("u1", SHOW))?.ratingKey, "920");
await history.recordProgress("u2", "919", 2_600, { force: true });
check("finishing E19 offers E20", (await history.getShowNextUp("u2", SHOW))?.ratingKey, "920");
await history.recordProgress("u3", "917", 2_600, { force: true });
check("finishing E17 still offers the file", (await history.getShowNextUp("u3", SHOW))?.ratingKey, "918");

console.log("— watching the file in a room —");
const { WebSocket } = await import("ws");
const { attachWebSocketServer, closeWebSocketServer } = await import("../src/services/sync.js");
const { createSession } = await import("../src/middleware/auth.js");
const { instanceHosts } = await import("../src/routes/discord.js");
const syncServer = http.createServer();
attachWebSocketServer(syncServer);
await new Promise<void>((r) => syncServer.listen(0, "127.0.0.1", r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
instanceHosts.set("inst-multi", { hostUserId: "u-host", guildId: null, channelId: null, createdAt: Date.now() });
const token = createSession("u-host", null);
const ws = new WebSocket(`ws://127.0.0.1:${(syncServer.address() as AddressInfo).port}/ws?token=${token}`);
await new Promise<void>((r, j) => { ws.once("open", () => r()); ws.once("error", j); });
const send = (m: Record<string, unknown>) => ws.send(JSON.stringify(m));
send({ type: "join", sessionToken: token, instanceId: "inst-multi", userId: "u-host", username: "host" });
await sleep(60);
send({ type: "watching", value: true });
send({
  type: "play", ratingKey: "918", title: "The Show", subtitles: false,
  hlsSessionId: crypto.randomUUID(), position: 2_600, sessionOffset: 0,
  audioStreamId: 1, subtitleStreamId: 0,
});
await sleep(60);
send({ type: "pause", position: 2_600 });
await sleep(500);
const watched = (rk: string) => history.getProgress("u-host", rk)?.watched ?? null;
check("playing E18 records E18 as watched", watched("918"), true);
check("…and E19, the other half of the file", watched("919"), true);
check("…and nothing else", [watched("917"), watched("920")], [null, null]);
ws.close();
closeWebSocketServer();
syncServer.close();

history.closeHistoryDb();
api.close();
plex.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
