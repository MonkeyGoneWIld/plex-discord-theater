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
 * starting the stream over — the one thing that must never happen. And, as
 * Deadpool started at 3:39 showed, a session begun mid-film can open with
 * audio from well before its first keyframe.
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
// Reading a title's other subtitles ahead is checked on its own, at the end:
// everywhere else it would race the counts.
process.env.SUBTITLE_PREFETCH = "0";
// Remuxes above this are re-encoded rather than copied. Title 950 is one.
process.env.DIRECT_STREAM_MAX_KBPS = "20000";

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
 *  with its audio starting `audioLead` seconds before the picture (null: none). */
function segment(start: number, frames: number, audioLead: number | null = 0): Buffer {
  const order: number[] = [];
  for (let i = 0; i < frames; i += 3) {
    order.push(i);
    if (i + 2 < frames) order.push(i + 2);
    if (i + 1 < frames) order.push(i + 1);
  }
  const packets = audioLead === null ? [] : [pesPacket(0xc0, start - audioLead)];
  order.forEach((f, n) => packets.push(pesPacket(0xe0, start + f * FRAME, n % 4 === 0), continuation()));
  if (audioLead !== null) packets.push(pesPacket(0xc0, start - audioLead + frames * FRAME / 2));
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
  check("and says where the audio starts", videoSpan(segment(1808.551, 50, 9.72))!.audioStart!.toFixed(3), "1798.831");
  check("or that there is none", videoSpan(segment(20, 12, null))!.audioStart, null);
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
  /** How far the first segment's audio starts before its keyframe. */
  firstAudioLead: number;
  /** When its playlist was first asked for — copying starts then, not before. */
  startedAt: number | null;
}
const plexSessions = new Map<string, PlexSession>();
/** Paths answered with something unreadable instead of a segment. */
const unreadable = new Set<string>();
/** Paths answered 200 with JSON, as a misbehaving server might. */
const notSegments = new Set<string>();

function plexSession(key: string, offset: number, firstAudioLead = 0): PlexSession {
  const firstGop = keyframes.filter((k) => k * FRAME <= offset).length - 1;
  const firstIndex = Math.floor(offset / 3);
  const s: PlexSession = { firstIndex, firstGop, produced: firstIndex - 1, startedAt: null, outOfOrder: [], firstAudioLead };
  plexSessions.set(key, s);
  return s;
}

/** What Plex holds as segment `index` of a session, copying or not. */
function copiedSegment(s: PlexSession, index: number): Buffer {
  const gop = s.firstGop + (index - s.firstIndex);
  if (gop >= keyframes.length) return STUB;
  const endFrame = gop + 1 < keyframes.length ? keyframes[gop + 1] : Math.round(FILM_END / FRAME);
  return segment(keyframes[gop] * FRAME + CLOCK, endFrame - keyframes[gop], index === s.firstIndex ? s.firstAudioLead : 0);
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

const decisions: Array<{
  ratingKey: string; directStream: string | null; profile: string; subtitles: string | null; videoBitrate: string | null;
}> = [];
/** Each title's bitrate, kbps: 950 is over DIRECT_STREAM_MAX_KBPS, 960 and 970
 *  over VIDEO_BITRATE_KBPS's default of 12000 but under the cap. */
const fileKbps = (ratingKey: string) =>
  ratingKey === "950" ? 31000 : ratingKey === "960" || ratingKey === "970" ? 15000 : 8000;
/** The subtitle the item has selected, as Plex keeps it — per item, not per request. */
let selectedSubtitle: string | null = null;
let subtitleReads = 0;
/** Reads of 910's subtitles going at once, and the most there ever were. */
let readsInFlight = 0;
let mostReadsInFlight = 0;
let sidecarFetches = 0;
/** Titles 930-933, for the order reads ahead are done in: their subtitles. */
const aheadTitles: Record<string, number[]> = { "930": [51, 52], "931": [61], "932": [71], "933": [81], "934": [91, 92, 93, 94] };
const aheadIds = new Set(Object.values(aheadTitles).flat().map(String));
/** The subtitles Plex was asked to read, in order. */
const readOrder: string[] = [];
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
  if (meta && aheadTitles[meta[1]]) {
    return send({ Metadata: [{
      ratingKey: meta[1], title: "Episode", type: "episode", duration: FILM_END * 1000,
      Media: [{ id: 1, width: 1920, height: 1080, videoCodec: "h264", bitrate: 8000, Part: [{ id: 1, size: 2000, file: "/tv/Ep.mkv", Stream: [
        { id: 11, streamType: 1, codec: "h264" },
        { id: 12, streamType: 2, codec: "aac", selected: true },
        ...aheadTitles[meta[1]].map((id) => ({ id, streamType: 3, codec: "ass", language: "English" })),
      ] }] }],
    }] });
  }
  if (meta && meta[1] === "910") {
    // A title for reading subtitles ahead: three inside the file and one
    // beside it. Its selection is the item's, as Plex reports it.
    const sub = (id: number, language: string, extra: Record<string, unknown> = {}) =>
      ({ id, streamType: 3, codec: "srt", language, selected: selectedSubtitle === String(id), ...extra });
    return send({ Metadata: [{
      ratingKey: "910", title: "Series", type: "movie", duration: FILM_END * 1000,
      Media: [{ id: 1, width: 1920, height: 1080, videoCodec: "h264", bitrate: 8000, Part: [{ id: 1, size: 1000, file: "/tv/Series.mkv", Stream: [
        { id: 11, streamType: 1, codec: "h264" },
        { id: 12, streamType: 2, codec: "aac", selected: true, language: "Japanese", languageCode: "jpn" },
        sub(31, "English"), sub(32, "Spanish"), sub(33, "English", { title: "Signs" }),
        sub(34, "German", { key: "/library/streams/34", format: "srt" }),
      ] }] }],
    }] });
  }
  if (meta) {
    return send({ Metadata: [{
      ratingKey: meta[1], title: "Film", type: "movie", duration: FILM_END * 1000,
      Media: [{ id: 1, width: 1920, height: 1080, videoCodec: "h264", bitrate: fileKbps(meta[1]), Part: [{ id: 1, file: "/movies/Film.mkv", Stream: [
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
    if (selected && aheadIds.has(selected)) {
      readOrder.push(selected);
      res.writeHead(200, { "Content-Type": "text/srt" });
      res.write(SRT_FIRST);
      setTimeout(() => res.end(SRT.slice(SRT_FIRST.length)), 600);
      return;
    }
    if (selected === "31" || selected === "32" || selected === "33") {
      readsInFlight++;
      mostReadsInFlight = Math.max(mostReadsInFlight, readsInFlight);
      res.writeHead(200, { "Content-Type": "text/srt" });
      res.write(SRT_FIRST);
      setTimeout(() => { readsInFlight--; res.end(SRT.slice(SRT_FIRST.length)); }, 300);
      return;
    }
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
    // 26: one that breaks off partway, after the player's first ask is answered.
    res.write(SRT_FIRST);
    setTimeout(() => {
      if (selected === "25") res.end(SRT.slice(SRT_FIRST.length));
      else res.destroy();
    }, selected === "25" ? 6_000 : 5_000);
    return;
  }
  if (url.pathname === "/library/streams/34") {
    sidecarFetches++;
    res.writeHead(200, { "Content-Type": "text/srt" });
    return res.end(SRT);
  }
  if (url.pathname === "/library/streams/24") {
    res.writeHead(200, { "Content-Type": "text/srt" });
    return res.end(SRT);
  }
  if (url.pathname === "/video/:/transcode/universal/decision") {
    // A subtitle read's own decision isn't one of the stream's.
    if (url.searchParams.get("protocol") === "http") return send({});
    const ratingKey = (url.searchParams.get("path") ?? "").split("/").pop()!;
    // As the real one does: a copy only of a file whose *peaks* are within the
    // bitrate asked for — taken here as three times its average, which is
    // what a Blu-ray's can be. 970 stands for one it won't copy at any bitrate
    // (a codec the room can't play, say).
    const copy = url.searchParams.get("directStream") === "1" &&
      Number(url.searchParams.get("videoBitrate")) >= fileKbps(ratingKey) * 3 && ratingKey !== "970";
    decisions.push({
      ratingKey,
      directStream: url.searchParams.get("directStream"),
      profile: String(req.headers["x-plex-client-profile-extra"] ?? ""),
      subtitles: url.searchParams.get("subtitles"),
      videoBitrate: url.searchParams.get("videoBitrate"),
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
/** A copied segment's bytes as hex, wherever the server keeps it; or what it said instead. */
async function hexOf(seg: ReturnType<typeof ds.directStreamSegment>) {
  return seg && seg !== "gone" ? (await seg.read(0, seg.bytes)).toString("hex") : seg;
}

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
  check("and served from here", await hexOf(ds.directStreamSegment(key, pathOf(key, 0))), copiedSegment(plexSide, 0).toString("hex"));
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
  check("with the playhead at the end and memory to spare, the start is still here to go back to",
    await hexOf(ds.directStreamSegment(key, pathOf(key, 0))), copiedSegment(plexSide, 0).toString("hex"));
  check("Plex was never asked for anything out of order", plexSide.outOfOrder, []);
  ds.stopDirectStream("s-from-start");
  check("stopped, it is forgotten", ds.isDirectStreamKey(key), false);
}

console.log("\n— past its memory, a copy is kept on disk —");
{
  // Memory for a few segments only: what is watched goes to disk, and is
  // served from there, until the stream ends.
  ds.setDirectStreamMemoryBytes(3 * copiedSegment(plexSession(crypto.randomUUID(), 0), 0).length);
  const key = crypto.randomUUID();
  const plexSide = plexSession(key, 0);
  ds.startDirectStream("s-disk", key, "500", 0);
  await ds.directStreamPlaylist(key, (p) => p);
  ds.updateDirectStreamPosition("s-disk", FILM_END);
  await until(() => plexSide.produced - plexSide.firstIndex >= keyframes.length);
  await sleep(300);
  const dir = path.join(ds.directStreamCacheDir(), "s-disk");
  const onDisk = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  check("the segments memory can't hold are written to disk", onDisk >= keyframes.length - 3, true);
  check("and served from there, the same bytes", await hexOf(ds.directStreamSegment(key, pathOf(key, 0))), copiedSegment(plexSide, 0).toString("hex"));
  const seg = ds.directStreamSegment(key, pathOf(key, 1));
  const tail = seg && seg !== "gone" ? (await seg.read(seg.bytes - 100, seg.bytes)).toString("hex") : seg;
  check("a part of one, too", tail, copiedSegment(plexSide, 1).subarray(-100).toString("hex"));
  ds.stopDirectStream("s-disk");
  await sleep(200);
  check("and taken off the disk when the stream ends", fs.existsSync(dir), false);
  ds.setDirectStreamMemoryBytes(6144 * 1024 * 1024);
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
  check("in a few long pieces", [gaps.length, gaps.every((e) => e.d <= 60)], [Math.ceil((keyframes[plexSide.firstGop] * FRAME) / 60), true]);
  // hls.js waits a whole target duration before its first reload of a playlist
  // like this one; at the gap entries' sixty seconds, the half minute listed
  // ran out first.
  check("which don't count toward the target duration, so the player reloads in seconds",
    [target, target < sum(list.filter((e) => !e.gap).map((e) => e.d))], [12, true]);
  check("playback starts where the seek asked", playlist.includes("#EXT-X-START:TIME-OFFSET=100.000"), true);
  check("Plex was never asked for anything out of order", plexSide.outOfOrder, []);
  ds.stopDirectStream("s-mid");
}

console.log("\n— a copy started mid-film whose audio begins before its picture —");
{
  // Deadpool from 3:39: audio from almost ten seconds before the first keyframe.
  const LEAD = 9.72;
  const key = crypto.randomUUID();
  const plexSide = plexSession(key, 100, LEAD);
  ds.startDirectStream("s-lead", key, "500", 100);
  const playlist = (await ds.directStreamPlaylist(key, (p) => p))!;
  const list = entries(playlist);
  const firstAt = sum(list.filter((e) => e.gap).map((e) => e.d));
  const picture = keyframes[plexSide.firstGop] * FRAME;
  check("the first segment starts where its sound does", firstAt.toFixed(3), (picture - LEAD).toFixed(3));
  // What hls.js does with it: pins the earlier of the first segment's audio and
  // video timestamps to where the playlist says the segment starts, and places
  // everything else by timestamp from there.
  const pinned = Math.min(picture + CLOCK, picture + CLOCK - LEAD) - firstAt;
  check("so the player puts its picture where it is in the film, not ten seconds late",
    (picture + CLOCK - pinned).toFixed(3), picture.toFixed(3));
  const firstReal = list.find((e) => !e.gap)!;
  check("and lists it as long as it really is, sound and all",
    Math.abs(firstReal.d - (gopLength(plexSide.firstGop) + LEAD)) < 0.0015, true);
  check("playback still starts where the seek asked, after picture and sound have begun",
    playlist.includes("#EXT-X-START:TIME-OFFSET=100.000"), true);
  ds.stopDirectStream("s-lead");

  // The other way round: sound that starts three seconds after the picture.
  // Started at the picture, the player would wait there on silence that has
  // nothing buffered under it; it starts where the sound does instead.
  const late = crypto.randomUUID();
  plexSession(late, picture, -3);
  ds.startDirectStream("s-lead-late", late, "500", picture);
  const lateList = (await ds.directStreamPlaylist(late, (p) => p))!;
  check("sound that starts after the picture: laid out from the picture, started on the sound",
    [sum(entries(lateList).filter((e) => e.gap).map((e) => e.d)).toFixed(3),
      lateList.includes(`#EXT-X-START:TIME-OFFSET=${(picture + 3).toFixed(3)}`)],
    [picture.toFixed(3), true]);
  ds.stopDirectStream("s-lead-late");
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
  app.use(express.json());
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

  console.log("\n— a segment in parts, for a player fetching it several ways at once —");
  check("the playlist gives each segment's size", first.uri.endsWith(`&n=${bytes.length}`), true);
  const parts = await Promise.all([0, 1, 2].map(async (i) => {
    const r = await fetch(`${origin}${first.uri}&part=${i}&parts=3`);
    return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
  }));
  check("each part is its share", parts.map((p) => [p.status, p.body.length]),
    [0, 1, 2].map((i) => [200, Math.floor((bytes.length * (i + 1)) / 3) - Math.floor((bytes.length * i) / 3)]));
  check("and together they are the segment", Buffer.concat(parts.map((p) => p.body)).equals(bytes), true);
  check("a part that doesn't exist is refused", (await fetch(`${origin}${first.uri}&part=3&parts=3`)).status, 400);
  check("as is a split past the most there is", (await fetch(`${origin}${first.uri}&part=0&parts=99`)).status, 400);
  const resumed = await fetch(origin + first.uri, { headers: { Range: "bytes=1000-" } });
  check("the rest of one from where another download stopped",
    [resumed.status, resumed.headers.get("content-range"), Buffer.from(await resumed.arrayBuffer()).equals(bytes.subarray(1000))],
    [206, `bytes 1000-${bytes.length - 1}/${bytes.length}`, true]);
  check("past its end, nothing", (await fetch(origin + first.uri, { headers: { Range: `bytes=${bytes.length}-` } })).status, 416);
  check("Plex was never asked for anything out of order", plexSessions.get(key)!.outOfOrder, []);

  plexRoutes.markTranscodeStopped(sid);
  check("stopping the session stops the copy", ds.isDirectStreamKey(key), false);

  await (await fetch(`${origin}/api/plex/hls/600/${crypto.randomUUID()}/master.m3u8`)).text();
  check("a title whose copy failed is asked for as a re-encode", [decisions.at(-1)?.ratingKey, decisions.at(-1)?.directStream], ["600", "0"]);

  const big = crypto.randomUUID();
  await (await fetch(`${origin}/api/plex/hls/950/${big}/master.m3u8`)).text();
  plexRoutes.markTranscodeStopped(big);
  check("a file averaging above DIRECT_STREAM_MAX_KBPS is re-encoded instead of copied",
    [decisions.at(-1)?.ratingKey, decisions.at(-1)?.directStream], ["950", "0"]);

  // Averaging over VIDEO_BITRATE_KBPS but under the limit, with peaks well
  // over the limit: judged on its average, so copied — and Plex, which judges
  // on peaks, has to be asked at a bitrate they don't reach, or it re-encodes.
  const mid = crypto.randomUUID();
  await (await fetch(`${origin}/api/plex/hls/960/${mid}/master.m3u8`)).text();
  check("a file averaging under DIRECT_STREAM_MAX_KBPS is copied, whatever its peaks",
    [decisions.at(-1)?.ratingKey, decisions.at(-1)?.videoBitrate, ds.isDirectStreamKey(plexRoutes.getPlexTranscodeKey(mid) ?? "")],
    ["960", "200000", true]);
  plexRoutes.markTranscodeStopped(mid);

  const before = decisions.length;
  const wont = crypto.randomUUID();
  await (await fetch(`${origin}/api/plex/hls/970/${wont}/master.m3u8`)).text();
  check("one Plex won't copy anyway is asked again at the transcode bitrate",
    decisions.slice(before).map((d) => [d.ratingKey, d.videoBitrate]), [["970", "200000"], ["970", "12000"]]);
  check("and played as the re-encode it is", ds.isDirectStreamKey(plexRoutes.getPlexTranscodeKey(wont) ?? ""), false);
  plexRoutes.markTranscodeStopped(wont);

  console.log("\n— what the player is told about the stream, for Stats for nerds —");
  /** The notes a master playlist carries, as hls.js would read them. */
  const notesOf = (m3u8: string) => Object.fromEntries(
    [...m3u8.matchAll(/#EXT-X-SESSION-DATA:DATA-ID="com\.pdt\.([a-z]+)",VALUE="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const startNotes = async (ratingKey: string, query = "") => {
    const sid = crypto.randomUUID();
    const text = await (await fetch(`${origin}/api/plex/hls/${ratingKey}/${sid}/master.m3u8${query}`)).text();
    plexRoutes.markTranscodeStopped(sid);
    return { notes: notesOf(text), asked: decisions.at(-1)! };
  };
  check("a copy says so, and how heavy it is", (await startNotes("100")).notes, { video: "copy", kbps: "8000" });
  check("a file over the copy limit says that is why, and what it is re-encoded at",
    (await startNotes("950")).notes,
    { video: "transcode", reason: "the file averages 31 Mbps, over this server's 20 Mbps copy limit", kbps: "12000" });
  check("one Plex declined to copy says so, without blaming a bitrate it was asked well over",
    (await startNotes("970")).notes.reason,
    "Plex declined to copy it");

  console.log("\n— a viewer's own quality setting —");
  const capped = await startNotes("960", "?quality=8000");
  check("a file averaging over it is re-encoded at it, without asking for a copy first, and the player told why",
    [capped.asked.directStream, capped.asked.videoBitrate, capped.notes],
    ["0", "8000", { video: "transcode", reason: "the file averages 15 Mbps, over your 8 Mbps quality setting", kbps: "8000", quality: "8000" }]);
  const fits = await startNotes("100", "?quality=12000");
  check("a file averaging under it is still copied, its peaks left to the buffer",
    [fits.asked.directStream, fits.asked.videoBitrate, fits.notes.video], ["1", "200000", "copy"]);
  check("a setting that isn't one of the levels is no setting",
    [(await startNotes("100", "?quality=123")).notes.quality], [undefined]);
  const ten = await startNotes("960", "?quality=10000");
  check("10 Mbps, the level Plex itself offers between 8 and 12, is one",
    [ten.asked.directStream, ten.asked.videoBitrate, ten.notes.quality], ["0", "10000", "10000"]);

  console.log("\n— subtitles, which used to force a re-encode —");
  /** A stream start, burning in `burn` (the player asks for that only when it
   *  can't draw a subtitle itself), or with a clean picture. */
  const start = async (burn: number) => {
    const sid = crypto.randomUUID();
    const q = burn ? `subtitles=burn&subtitleStreamID=${burn}` : "subtitleStreamID=0";
    await (await fetch(`${origin}/api/plex/hls/900/${sid}/master.m3u8?${q}&audioStreamID=12`)).text();
    plexRoutes.markTranscodeStopped(sid);
    return decisions.at(-1)!;
  };
  const answer = async (id: number) => {
    const r = await fetch(`${origin}/api/plex/subtitles/${id}?ratingKey=900`);
    const body = r.ok ? ((await r.json()) as { cues: unknown[]; complete?: boolean }) : null;
    return { status: r.status, cues: body?.cues.length ?? 0, complete: body?.complete };
  };

  const drawn = await start(0);
  check("a stream for people drawing their own subtitles is copied, with no subtitle in it",
    [drawn.subtitles, drawn.directStream], ["none", "1"]);
  check("nothing is read out of the file for it", subtitleReads, 0);

  check("the player gets a text subtitle inside the file as text to draw",
    await answer(21), { status: 200, cues: 2, complete: true });
  check("read out of the file once", [subtitleReads, (await answer(21)).cues, subtitleReads], [1, 2, 1]);
  check("through Plex's subtitle-only transcode, never the one that sends the film", wrongEndpointReads, 0);
  const kept = new Database(path.join(process.env.THUMB_CACHE_DIR!, "subtitles.sqlite"), { readonly: true });
  check("and kept on disk, so a restart doesn't read the file again",
    kept.prepare("SELECT COUNT(*) AS n FROM embedded_subtitles WHERE stream_id = '21'").get(), { n: 1 });
  kept.close();
  check("a separate subtitle file is drawn as before", await answer(24), { status: 200, cues: 2, complete: true });

  check("one Plex can't read out is refused, so the player asks for it burned in",
    (await answer(23)).status, 404);
  check("one Plex answers with video is refused too", (await answer(27)).status, 404);
  const beforeBurn = decisions.length;
  const burnt = await start(22);
  check("a picture subtitle (PGS) is burned in when asked, as the re-encode that needs — not asked for as a copy first",
    [burnt.subtitles, burnt.directStream, burnt.videoBitrate, decisions.length - beforeBurn], ["burn", "0", "12000", 1]);
  check("and so is text that couldn't be drawn", (await start(23)).subtitles, "burn");

  let began = Date.now();
  check("a big file's first ask answers within seconds, with the lines read so far and word there's more",
    [await answer(25), Date.now() - began < 5000], [{ status: 200, cues: 1, complete: false }, true]);
  await until(() => embeddedSubs.embeddedSubtitleState("25")?.state === "ready", 10_000);
  check("and all of them once Plex is done", await answer(25), { status: 200, cues: 2, complete: true });

  check("one that breaks off partway starts out readable", (await answer(26)).status, 200);
  await until(() => embeddedSubs.embeddedSubtitleState("26")?.state === "unreadable", 8_000);
  check("and is refused once it has failed, so the player asks for it burned in",
    (await answer(26)).status, 404);

  console.log("\n— a title's other subtitles, read ahead for switching to —");
  process.env.SUBTITLE_PREFETCH = "1";
  process.env.SUBTITLE_PREFETCH_DELAY_MS = "0";
  const readsBefore = subtitleReads;
  const firstAsk = await fetch(`${origin}/api/plex/subtitles/31?ratingKey=910`);
  check("the one asked for is answered as before", firstAsk.status, 200);
  await until(() => embeddedSubs.embeddedSubtitleState("31")?.state === "ready", 10_000);
  await new Promise((r) => setTimeout(r, 200));
  check("asking for one reads that one and nothing else: the rest wait for the player",
    [subtitleReads - readsBefore, embeddedSubs.embeddedSubtitleState("33")], [1, null]);
  // The player, its buffer in good shape: the others in the language it draws.
  const rest = await fetch(`${origin}/api/plex/subtitles/prefetch`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ratingKey: "910", first: 31, scope: "all", watching: true }),
  });
  check("the player asking for the rest is answered at once", rest.status, 200);
  await until(() => embeddedSubs.embeddedSubtitleState("33")?.state === "ready", 10_000);
  await new Promise((r) => setTimeout(r, 200));
  check("then only the other English one is read: not the Spanish, not the German file beside it",
    [subtitleReads - readsBefore, embeddedSubs.embeddedSubtitleState("32"), sidecarFetches], [2, null, 0]);
  check("one at a time: each is Plex going through the whole film", mostReadsInFlight, 1);
  check("the item is left on the subtitle that was asked for, not the last one read ahead", selectedSubtitle, "31");
  began = Date.now();
  const switched = await fetch(`${origin}/api/plex/subtitles/33?ratingKey=910`);
  const switchedBody = (await switched.json()) as { cues: unknown[]; complete?: boolean };
  check("so switching to it is answered at once, complete",
    [switchedBody.cues.length, switchedBody.complete, Date.now() - began < 1000], [2, true, true]);
  check("and reads nothing more", subtitleReads - readsBefore, 2);
  const keptRaw = new Database(path.join(process.env.THUMB_CACHE_DIR!, "subtitles.sqlite"), { readonly: true });
  check("what Plex sent is kept with the cues, for a better parser to read again",
    keptRaw.prepare("SELECT raw IS NOT NULL AS raw, fingerprint, parser_version AS v FROM embedded_subtitles WHERE stream_id = '33'").get(),
    { raw: 1, fingerprint: "1:1000", v: 2 });
  keptRaw.close();

  console.log("\n— what is read ahead first —");
  const ahead = (body: Record<string, unknown>) => fetch(`${origin}/api/plex/subtitles/prefetch`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // An episode about to be reached: everything, soon.
  check("asking answers at once", (await ahead({ ratingKey: "930", first: 52, scope: "all" })).status, 200);
  await pause(60);
  // Someone browsing, past one title and on to the next.
  await ahead({ ratingKey: "931", first: 61, scope: "first" });
  await pause(60);
  await ahead({ ratingKey: "932", first: 71, scope: "first" });
  await pause(60);
  // Another episode coming up, after the browsing.
  await ahead({ ratingKey: "933", scope: "all" });
  await until(() => ["51", "52", "71", "81"].every((id) => embeddedSubs.embeddedSubtitleState(id)?.state === "ready"), 15_000);
  check("the one the viewer would start on first, everything wanted soon before a guess, only the latest guess — and nothing for an episode no subtitle was picked for",
    readOrder, ["52", "51", "71"]);
  check("four English ones: three are read, the one watched first", await (async () => {
    readOrder.length = 0;
    await ahead({ ratingKey: "934", first: 93, scope: "all" });
    await until(() => ["91", "92", "93"].every((id) => embeddedSubs.embeddedSubtitleState(id)?.state === "ready"), 15_000);
    await pause(200);
    return [readOrder, embeddedSubs.embeddedSubtitleState("94")];
  })(), [["93", "91", "92"], null]);
  check("the title browsed past isn't read at all", embeddedSubs.embeddedSubtitleState("61"), null);
  check("a title someone is looking at without a subtitle chosen reads nothing",
    await (await ahead({ ratingKey: "931", scope: "first" })).json(), { ok: true, queued: false });
  check("a key that isn't one is refused", (await ahead({ ratingKey: "../x" })).status, 400);
  // A title's other subtitles, queued while it played and reached after it stopped.
  const startedWith = selectedSubtitle;
  check("a read nobody wants any more by its turn is dropped unread",
    embeddedSubs.prefetchEmbeddedSubtitles([{
      streamId: "61", ratingKey: "931", mediaIndex: 0,
      withTrackSelected: (start) => start(),
    }], { stillWanted: () => false }), 1);
  await pause(300);
  check("and Plex isn't asked to go through the film for it",
    [embeddedSubs.embeddedSubtitleState("61"), selectedSubtitle], [null, startedWith]);
  process.env.SUBTITLE_PREFETCH = "0";

  await plexRoutes.stopAllActiveSessions();
  api.close();
}

plex.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
