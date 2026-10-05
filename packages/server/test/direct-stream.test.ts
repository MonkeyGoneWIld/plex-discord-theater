/**
 * Direct Stream: reading copied segments, and the playlist built from them.
 *
 * Against a fake Plex that copies the way the real one was measured to
 * (scripts/diagnose-direct-stream.mjs): one segment per keyframe interval, of
 * whatever length that is; its clock 10s ahead of the film; a session started
 * mid-film numbered from offset ÷ 3; single-packet segments past the end; and
 * nothing at all until its own playlist for the session has been asked for,
 * which is what a real deployment showed (the first version of the tracker
 * never asked, and got 404 for as long as anyone waited). It also keeps count
 * of every request that arrives out of order, which the real one answers by
 * starting the stream over — the one thing that must never happen.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";

process.env.THUMB_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "direct-stream-"));
process.env.PLEX_TOKEN = "test-token";
process.env.DIRECT_STREAM = "1";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(10);
  return cond();
}

// ── MPEG-TS, just enough of it ───────────────────────────────────

function writePts(b: Buffer, at: number, pts: number) {
  const hi = Math.floor(pts / 2 ** 30) % 8;
  const mid = Math.floor(pts / 2 ** 15) % 2 ** 15;
  const lo = pts % 2 ** 15;
  b[at] = 0x21 | (hi << 1);
  b[at + 1] = mid >> 7;
  b[at + 2] = ((mid & 0x7f) << 1) | 1;
  b[at + 3] = lo >> 7;
  b[at + 4] = ((lo & 0x7f) << 1) | 1;
}

/** One packet opening a PES with a PTS, optionally behind an adaptation field. */
function pesPacket(streamId: number, seconds: number, adaptation = false): Buffer {
  const p = Buffer.alloc(188, 0xff);
  p[0] = 0x47;
  p[1] = 0x40 | 0x01; // payload unit start, PID 0x100
  p[2] = 0x00;
  let o = 4;
  if (adaptation) {
    p[3] = 0x30;
    p[4] = 7;
    p[5] = 0x10;
    o = 12;
  } else {
    p[3] = 0x10;
  }
  p.set([0, 0, 1, streamId, 0, 0, 0x80, 0x80, 5], o);
  writePts(p, o + 9, Math.round(seconds * 90_000));
  return p;
}

/** A packet continuing a PES — no header in it, so nothing to read. */
function continuation(): Buffer {
  const p = Buffer.alloc(188, 0xab);
  p[0] = 0x47; p[1] = 0x01; p[2] = 0x00; p[3] = 0x10;
  return p;
}

const FRAME = 1001 / 24000;

/** A segment of video frames from `start` for `frames`, in B-frame decode order,
 *  with an audio PES in front that has to be ignored. */
function segment(start: number, frames: number): Buffer {
  const order: number[] = [];
  for (let i = 0; i < frames; i += 3) {
    order.push(i);
    if (i + 2 < frames) order.push(i + 2);
    if (i + 1 < frames) order.push(i + 1);
  }
  const packets = [pesPacket(0xc0, start - 0.5)];
  order.forEach((f, n) => packets.push(pesPacket(0xe0, start + f * FRAME, n % 4 === 0), continuation()));
  return Buffer.concat(packets);
}

const STUB = (() => { const p = Buffer.alloc(188, 0xff); p[0] = 0x47; p[1] = 0x1f; p[2] = 0xff; p[3] = 0x10; return p; })();

console.log("— reading a segment's timestamps —");
{
  const { videoSpan } = await import("../src/services/ts-timestamps.js");
  const span = videoSpan(segment(1808.551, 50))!;
  check("starts at its earliest frame, out-of-order frames and all", span.start.toFixed(3), "1808.551");
  check("ends one frame after its latest", span.end.toFixed(3), (1808.551 + 50 * FRAME).toFixed(3));
  check("counts only the video", span.frames, 50);
  check("Plex's single-packet end-of-stream segment holds no video", videoSpan(STUB), null);
  check("nor does anything that isn't MPEG-TS", videoSpan(Buffer.from("not a transport stream")), null);
  const shifted = Buffer.concat([Buffer.from([1, 2, 3]), segment(20, 12)]);
  check("a stray byte before the first packet is skipped", videoSpan(shifted)?.frames, 12);
}

// ── a Plex that copies ───────────────────────────────────────────

/** Keyframes of a 400s film, in frames: irregular, as a real encode's are. */
const GOP_FRAMES = [48, 108, 26, 249, 72, 149];
const FILM_END = 400;
const keyframes: number[] = [];
for (let f = 0, i = 0; f * FRAME < FILM_END; f += GOP_FRAMES[i++ % GOP_FRAMES.length]) keyframes.push(f);
const CLOCK = 10;
const gopLength = (i: number) => ((keyframes[i + 1] ?? Math.round(FILM_END / FRAME)) - keyframes[i]) * FRAME;

interface PlexSession {
  firstIndex: number; firstGop: number; produced: number; outOfOrder: number[];
  /** When its playlist was first asked for — copying starts then, not before. */
  startedAt: number | null;
}
const plexSessions = new Map<string, PlexSession>();
/** Paths answered with something unreadable instead of a segment. */
const unreadable = new Set<string>();
/** Paths answered 200 with JSON, as a misbehaving server might. */
const notSegments = new Set<string>();

function plexSession(key: string, offset: number): PlexSession {
  const firstGop = keyframes.filter((k) => k * FRAME <= offset).length - 1;
  const firstIndex = Math.floor(offset / 3);
  const s: PlexSession = { firstIndex, firstGop, produced: firstIndex - 1, startedAt: null, outOfOrder: [] };
  plexSessions.set(key, s);
  return s;
}

/** What Plex holds as segment `index` of a session, copying or not. */
function copiedSegment(s: PlexSession, index: number): Buffer {
  const gop = s.firstGop + (index - s.firstIndex);
  if (gop >= keyframes.length) return STUB;
  const endFrame = gop + 1 < keyframes.length ? keyframes[gop + 1] : Math.round(FILM_END / FRAME);
  return segment(keyframes[gop] * FRAME + CLOCK, endFrame - keyframes[gop]);
}

/** Segment `index` as a request for it would get it: 404 until copied. */
function plexSegment(s: PlexSession, index: number): Buffer | null {
  // Real Plex starts over on a request this far off; here it is only counted.
  if (index < s.firstIndex || index > s.produced + 2) s.outOfOrder.push(index);
  // Copying starts when the playlist is asked for, and then runs far faster
  // than real time, but not instantly.
  if (s.startedAt === null) return null;
  if (index > s.firstIndex + Math.floor((Date.now() - s.startedAt) / 5)) return null;
  s.produced = Math.max(s.produced, index);
  return copiedSegment(s, index);
}

const decisions: Array<{ ratingKey: string; directStream: string | null; profile: string; subtitles: string | null }> = [];
/** The subtitle the item has selected, as Plex keeps it — per item, not per request. */
let selectedSubtitle: string | null = null;
let subtitleReads = 0;
/** Asks of the endpoint the first version used, which Plex answers with the film. */
let wrongEndpointReads = 0;
const SRT_FIRST = "1\n00:00:01,000 --> 00:00:02,500\nHello\n\n";
const SRT = SRT_FIRST + "2\n00:00:03,000 --> 00:00:04,000\nAgain\n";
/** The first bytes of a Matroska file. */
const MKV = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x23, 0x42, 0x86]);
const plex = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://plex");
  const send = (body: unknown) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ MediaContainer: body }));
  };
  const meta = url.pathname.match(/^\/library\/metadata\/(\d+)$/);
  if (meta) {
    return send({ Metadata: [{
      ratingKey: meta[1], title: "Film", type: "movie", duration: FILM_END * 1000,
      Media: [{ id: 1, width: 1920, height: 1080, videoCodec: "h264", Part: [{ id: 1, file: "/movies/Film.mkv", Stream: [
        { id: 11, streamType: 1, codec: "h264" },
        { id: 12, streamType: 2, codec: "aac", selected: true },
        { id: 21, streamType: 3, codec: "srt", language: "English" },
        { id: 22, streamType: 3, codec: "pgs", language: "English" },
        { id: 23, streamType: 3, codec: "srt", language: "French" },
        { id: 24, streamType: 3, codec: "srt", key: "/library/streams/24", format: "srt", language: "German" },
        { id: 25, streamType: 3, codec: "srt", language: "Spanish" },
        { id: 26, streamType: 3, codec: "srt", language: "Italian" },
        { id: 27, streamType: 3, codec: "srt", language: "Dutch" },
      ] }] }],
    }] });
  }
  if (url.pathname === "/library/parts/1" && req.method === "PUT") {
    selectedSubtitle = url.searchParams.get("subtitleStreamID") ?? selectedSubtitle;
    return send({});
  }
  if (url.pathname === "/video/:/transcode/universal/subtitles") {
    // What the real one did with this: started a second transcode of the whole
    // film and sent that.
    wrongEndpointReads++;
    res.writeHead(200, { "Content-Type": "video/x-matroska" });
    return res.end(MKV);
  }
  if (url.pathname === "/subtitles/:/transcode/universal/start") {
    subtitleReads++;
    // Reads whatever the item has selected, at the moment it is asked.
    const selected = selectedSubtitle;
    // 23: one Plex can't read out.
    if (selected === "23") { res.writeHead(500); return res.end(); }
    // 27: one it answers with video anyway.
    if (selected === "27") {
      res.writeHead(200, { "Content-Type": "video/x-matroska" });
      return res.end(MKV);
    }
    if (selected !== "21" && selected !== "25" && selected !== "26") { res.writeHead(400); return res.end(); }
    res.writeHead(200, { "Content-Type": "text/srt" });
    if (selected === "21") return res.end(SRT);
    // 25: a big file — the first line straight away, the rest a while later.
    // 26: one that breaks off partway.
    res.write(SRT_FIRST);
    setTimeout(() => {
      if (selected === "25") res.end(SRT.slice(SRT_FIRST.length));
      else res.destroy();
    }, selected === "25" ? 6_000 : 300);
    return;
  }
  if (url.pathname === "/library/streams/24") {
    res.writeHead(200, { "Content-Type": "text/srt" });
    return res.end(SRT);
  }
  if (url.pathname === "/video/:/transcode/universal/decision") {
    const copy = url.searchParams.get("directStream") === "1";
    // A subtitle read's own decision isn't one of the stream's.
    if (url.searchParams.get("protocol") === "http") return send({});
    decisions.push({
      ratingKey: (url.searchParams.get("path") ?? "").split("/").pop()!,
      directStream: url.searchParams.get("directStream"),
      profile: String(req.headers["x-plex-client-profile-extra"] ?? ""),
      subtitles: url.searchParams.get("subtitles"),
    });
    return send({ generalDecisionCode: 1001, Metadata: [{ Media: [{ selected: true, protocol: "hls", videoCodec: "h264", audioCodec: "aac",
      Part: [{ Stream: [{ streamType: 1, codec: "h264", decision: copy ? "copy" : "transcode" }, { streamType: 2, codec: "aac", decision: "copy" }] }] }] }] });
  }
  if (url.pathname === "/video/:/transcode/universal/start.m3u8") {
    const key = crypto.randomUUID();
    plexSession(key, Number(url.searchParams.get("offset") ?? 0));
    res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
    return res.end(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080\nsession/${key}/base/index.m3u8\n`);
  }
  const own = url.pathname.match(/^\/video\/:\/transcode\/universal\/session\/([0-9a-f-]{36})\/base\/index\.m3u8$/);
  if (own && plexSessions.has(own[1])) {
    const s = plexSessions.get(own[1])!;
    s.startedAt ??= Date.now();
    // Plex's own playlist: three seconds a segment, whatever they really are.
    res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
    return res.end("#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\n00000.ts\n#EXT-X-ENDLIST\n");
  }
  const seg = url.pathname.match(/^\/video\/:\/transcode\/universal\/session\/([0-9a-f-]{36})\/base\/(\d{5,})\.ts$/);
  if (seg && plexSessions.has(seg[1])) {
    if (notSegments.has(url.pathname)) return send({});
    if (unreadable.has(url.pathname)) {
      res.writeHead(200);
      return res.end(Buffer.concat(Array.from({ length: 12 }, continuation)));
    }
    const body = plexSegment(plexSessions.get(seg[1])!, Number(seg[2]));
    if (!body) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": "video/MP2T" });
    return res.end(body);
  }
  // A segment of a session it doesn't know, the way Plex answers one.
  if (/\/session\/[0-9a-f-]{36}\/base\//.test(url.pathname)) { res.writeHead(404); return res.end(); }
  if (url.pathname === "/:/timeline" || url.pathname.startsWith("/video/:/transcode/universal/")) return send({});
  res.writeHead(404);
  res.end();
});
await new Promise<void>((r) => plex.listen(0, "127.0.0.1", r));
process.env.PLEX_URL = `http://127.0.0.1:${(plex.address() as AddressInfo).port}`;

const ds = await import("../src/services/direct-stream.js");
const embeddedSubs = await import("../src/services/embedded-subtitles.js");
const pathOf = (key: string, index: number) =>
  `/video/:/transcode/universal/session/${key}/base/${String(index).padStart(5, "0")}.ts`;

/** The playlist's entries. */
function entries(m3u8: string) {
  const out: Array<{ d: number; uri: string; gap: boolean }> = [];
  let d = 0;
  let gap = false;
  for (const line of m3u8.split("\n")) {
    if (line.startsWith("#EXTINF:")) d = parseFloat(line.slice(8));
    else if (line === "#EXT-X-GAP") gap = true;
    else if (line && !line.startsWith("#")) { out.push({ d, uri: line, gap }); gap = false; }
  }
  return out;
}
const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 1000) / 1000;

console.log("\n— a copy from the start —");
{
  const key = crypto.randomUUID();
  const plexSide = plexSession(key, 0);
  ds.startDirectStream("s-from-start", key, "500", 0);
  const playlist = (await ds.directStreamPlaylist(key, (p) => `/seg?p=${p}`))!;
  const list = entries(playlist);
  check("it is an EVENT playlist, still growing", [playlist.includes("#EXT-X-PLAYLIST-TYPE:EVENT"), playlist.includes("#EXT-X-ENDLIST")], [true, false]);
  check("it says where to start, so hls.js doesn't start at its far end", playlist.includes("#EXT-X-START:TIME-OFFSET=0.000"), true);
  check("nothing before the first segment", list.filter((e) => e.gap).length, 0);
  check("the first playlist waits for half a minute of film, so the player can't outrun it",
    sum(list.map((e) => e.d)) >= 30, true);
  // Each runs to where the next starts, rounded to the millisecond so the
  // running total stays exact — so a length can be a millisecond off its own.
  await sleep(100);
  const later = entries((await ds.directStreamPlaylist(key, (p) => `/seg?p=${p}`))!);
  check("each segment is as long as its keyframe interval",
    later.slice(0, 6).every((e, i) => Math.abs(e.d - gopLength(i)) < 0.0015), true);
  check("named as Plex names them", list[0].uri, `/seg?p=${pathOf(key, 0)}`);
  check("and served from here", ds.directStreamSegment(key, pathOf(key, 0))?.toString("hex"), copiedSegment(plexSide, 0).toString("hex"));
  check("a segment it hasn't measured is nobody's business", ds.directStreamSegment(key, pathOf(key, 999)), null);

  // Nobody has moved, so it measures LEAD_S ahead and then waits.
  await sleep(400);
  const measuredTo = sum(entries((await ds.directStreamPlaylist(key, (p) => p))!).map((e) => e.d));
  check("it stops about 150s ahead of the watcher", measuredTo >= 140 && measuredTo < 175 ? "yes" : measuredTo, "yes");

  ds.updateDirectStreamPosition("s-from-start", FILM_END);
  await until(() => plexSide.produced - plexSide.firstIndex >= keyframes.length);
  await sleep(50);
  const done = (await ds.directStreamPlaylist(key, (p) => p))!;
  const all = entries(done);
  check("once the watcher gets there it runs to the end of the film", [all.length, done.includes("#EXT-X-ENDLIST")], [keyframes.length, true]);
  check("and the lengths add up to the film", sum(all.map((e) => e.d)).toFixed(1), FILM_END.toFixed(1));
  check("with the playhead at the end, the start has been let go", ds.directStreamSegment(key, pathOf(key, 0)), "gone");
  check("Plex was never asked for anything out of order", plexSide.outOfOrder, []);
  ds.stopDirectStream("s-from-start");
  check("stopped, it is forgotten", ds.isDirectStreamKey(key), false);
}

console.log("\n— a copy started mid-film, as a seek starts one —");
{
  const key = crypto.randomUUID();
  const plexSide = plexSession(key, 100);
  ds.startDirectStream("s-mid", key, "500", 100);
  const playlist = (await ds.directStreamPlaylist(key, (p) => p))!;
  const list = entries(playlist);
  const gaps = list.filter((e) => e.gap);
  check("Plex's first segment is number offset ÷ 3", list.find((e) => !e.gap)?.uri, pathOf(key, 33));
  check("everything before it is a gap the player never loads", gaps.every((e) => e.uri === "gap.ts"), true);
  check("the first playlist reaches half a minute past the start",
    sum(list.map((e) => e.d)) - 100 >= 30, true);
  check("and the gap reaches exactly to the keyframe it starts on",
    sum(gaps.map((e) => e.d)).toFixed(3), (keyframes[plexSide.firstGop] * FRAME).toFixed(3));
  const target = Number(playlist.match(/#EXT-X-TARGETDURATION:(\d+)/)![1]);
  check("in a few long pieces, each within the target duration",
    [gaps.length, gaps.every((e) => e.d <= 60 && e.d <= target)], [Math.ceil((keyframes[plexSide.firstGop] * FRAME) / 60), true]);
  check("playback starts where the seek asked", playlist.includes("#EXT-X-START:TIME-OFFSET=100.000"), true);
  check("Plex was never asked for anything out of order", plexSide.outOfOrder, []);
  ds.stopDirectStream("s-mid");
}

console.log("\n— a copy Plex never starts —");
{
  // A session Plex knows nothing about: every segment 404s, forever.
  const key = crypto.randomUUID();
  ds.startDirectStream("s-never", key, "700", 0);
  const started = Date.now();
  const playlist = await ds.directStreamPlaylist(key, (p) => p);
  check("the player is told to try again rather than left waiting past its own timeout",
    [playlist, Date.now() - started < 9000], ["retry", true]);
  ds.stopDirectStream("s-never");
}

console.log("\n— Plex answering with something that isn't a segment —");
{
  // A 200 with JSON in it, where a segment should be: not the end of the film.
  const key = crypto.randomUUID();
  plexSession(key, 0);
  notSegments.add(pathOf(key, 3));
  ds.startDirectStream("s-json", key, "800", 0);
  await sleep(1500);
  notSegments.delete(pathOf(key, 3));
  const playlist = (await ds.directStreamPlaylist(key, (p) => p))!;
  check("is waited out rather than taken for the end of the film",
    [playlist.includes("#EXT-X-ENDLIST"), entries(playlist).length > 3], [false, true]);
  ds.stopDirectStream("s-json");
}

console.log("\n— a copy that can't be read —");
{
  const key = crypto.randomUUID();
  plexSession(key, 0);
  unreadable.add(pathOf(key, 1));
  check("a title is copied until something goes wrong with it", ds.directStreamRefused("600"), false);
  ds.startDirectStream("s-broken", key, "600", 0);
  const playlist = await ds.directStreamPlaylist(key, (p) => p);
  check("the first playlist still arrives rather than hanging", typeof playlist, "string");
  check("and the title is re-encoded from its next start", ds.directStreamRefused("600"), true);
  ds.stopDirectStream("s-broken");
}

// ── through the routes, as a player sees it ──────────────────────

console.log("\n— through the routes —");
{
  const plexRoutes = await import("../src/routes/plex.js");
  const express = (await import("express")).default;
  const app = express();
  app.use("/api/plex", plexRoutes.default);
  const api = http.createServer(app);
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  const sid = crypto.randomUUID();
  const master = await (await fetch(`${origin}/api/plex/hls/100/${sid}/master.m3u8`)).text();
  const asked = decisions.at(-1)!;
  check("Plex is asked to copy", asked.directStream, "1");
  check("in place of its own HLS target", asked.profile.includes("replace=true"), true);
  check("as H.264 only, for a room nobody has said can decode HEVC",
    asked.profile.includes("videoCodec=h264&") && !asked.profile.includes("hevc"), true);
  const variant = master.split("\n").find((l) => l && !l.startsWith("#"))!;
  check("the player is pointed back here for the playlist", variant.startsWith("/api/plex/hls/seg?p="), true);
  const key = decodeURIComponent(variant).match(/session\/([0-9a-f-]{36})\//)![1];

  const playlist = await (await fetch(origin + variant)).text();
  check("and gets the measured one", playlist.includes("#EXT-X-PLAYLIST-TYPE:EVENT"), true);
  const first = entries(playlist)[0];
  const res = await fetch(origin + first.uri);
  const bytes = Buffer.from(await res.arrayBuffer());
  check("its segments are served", [res.status, res.headers.get("content-type")], [200, "video/MP2T"]);
  check("exactly as Plex copied them", bytes.equals(copiedSegment(plexSessions.get(key)!, 0)), true);
  check("one it hasn't measured isn't fetched from Plex for anyone",
    (await fetch(origin + first.uri.replace("00000.ts", "00500.ts"))).status, 404);
  check("Plex was never asked for anything out of order", plexSessions.get(key)!.outOfOrder, []);

  plexRoutes.markTranscodeStopped(sid);
  check("stopping the session stops the copy", ds.isDirectStreamKey(key), false);

  await (await fetch(`${origin}/api/plex/hls/600/${crypto.randomUUID()}/master.m3u8`)).text();
  check("a title whose copy failed is asked for as a re-encode", [decisions.at(-1)?.ratingKey, decisions.at(-1)?.directStream], ["600", "0"]);

  console.log("\n— subtitles, which used to force a re-encode —");
  const start = async (subtitleStreamID: number) => {
    const sid = crypto.randomUUID();
    await (await fetch(`${origin}/api/plex/hls/900/${sid}/master.m3u8?subtitles=burn&audioStreamID=12&subtitleStreamID=${subtitleStreamID}`)).text();
    plexRoutes.markTranscodeStopped(sid);
    return decisions.at(-1)!;
  };
  const answer = async (id: number) => {
    const r = await fetch(`${origin}/api/plex/subtitles/${id}?ratingKey=900`);
    const body = r.ok ? ((await r.json()) as { cues: unknown[]; complete?: boolean }) : null;
    return { status: r.status, cues: body?.cues.length ?? 0, complete: body?.complete };
  };
  const cues = async (id: number) => {
    const a = await answer(id);
    return [a.status, a.cues];
  };
  const lost: string[] = [];
  embeddedSubs.onEmbeddedSubtitleLost((id) => lost.push(id));

  const embedded = await start(21);
  check("a text subtitle inside the file isn't burned, so the video can still be copied",
    [embedded.subtitles, embedded.directStream], ["none", "1"]);
  check("the player gets it as text to draw", await answer(21), { status: 200, cues: 2, complete: true });
  check("read out of the file once, for the start and the player both", subtitleReads, 1);
  check("through Plex's subtitle-only transcode, never the one that sends the film", wrongEndpointReads, 0);
  const kept = new Database(path.join(process.env.THUMB_CACHE_DIR!, "subtitles.sqlite"), { readonly: true });
  check("and kept on disk, so a restart doesn't read the file again",
    kept.prepare("SELECT COUNT(*) AS n FROM embedded_subtitles WHERE stream_id = '21'").get(), { n: 1 });
  kept.close();
  check("a picture subtitle (PGS) is burned in as before", (await start(22)).subtitles, "burn");
  check("a text one Plex can't read out is burned in instead", (await start(23)).subtitles, "burn");
  check("and the player is told it's not there, so it isn't shown twice", (await cues(23))[0], 404);
  check("a separate subtitle file is drawn as before", [(await start(24)).subtitles, await cues(24)], ["none", [200, 2]]);

  let began = Date.now();
  const video = await start(27);
  check("one Plex answers with video is burned in, and found out at once",
    [video.subtitles, Date.now() - began < 2000], ["burn", true]);

  began = Date.now();
  const slow = await start(25);
  check("a big file's start doesn't wait for the whole read",
    [slow.subtitles, slow.directStream, Date.now() - began < 2000], ["none", "1", true]);
  check("the player gets the lines read so far, and is told there's more",
    await answer(25), { status: 200, cues: 1, complete: false });
  await until(() => embeddedSubs.embeddedSubtitleState("25")?.state === "ready", 10_000);
  check("and all of them once Plex is done", await answer(25), { status: 200, cues: 2, complete: true });

  const broken = await start(26);
  check("one that breaks off partway starts drawn by the player", broken.subtitles, "none");
  await until(() => lost.includes("26"));
  check("its failure is reported, so the streams drawing it restart with it burned in", lost, ["26"]);
  check("which the restart does", (await start(26)).subtitles, "burn");

  await plexRoutes.stopAllActiveSessions();
  api.close();
}

plex.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
