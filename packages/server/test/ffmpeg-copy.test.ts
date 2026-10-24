/**
 * The ffmpeg engine's copies (PLAYBACK_ENGINE=ffmpeg), through the routes as a
 * player sees them: real ffmpeg, films made for the test, and a fake Plex that
 * records everything it is asked — so a copy can be shown never to ask Plex to
 * transcode anything, and what ffmpeg can't copy yet to go to Plex as before.
 * Its re-encodes too, a PGS subtitle burned in among them: one written here,
 * a white box, looked for in the picture where it should and shouldn't be.
 * And text subtitles read out of the file by ffmpeg rather than by Plex, what
 * Plex is told plays (ffmpeg/plex-report.ts), and what the upload budget is
 * told of each stream (routes/qbt-manager.ts).
 *
 * Skipped where there is no ffmpeg.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

if (spawnSync("ffmpeg", ["-hide_banner", "-version"]).status !== 0) {
  console.log("ffmpeg-copy: skipped, no ffmpeg on PATH");
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ffmpeg-copy-"));
process.env.THUMB_CACHE_DIR = tmp;
process.env.PLEX_TOKEN = "test-token";
process.env.LOG_TO_FILE = "0";
process.env.DIRECT_STREAM = "1";
process.env.SUBTITLE_PREFETCH = "0";
process.env.PLAYBACK_ENGINE = "ffmpeg";
// Small, so the pause ahead of the watcher shows inside a 60 s film: it
// stops past 36 s and carries on once the watcher is within 18 s of that.
// Unset, runs go on to the end of the film: checked on its own below.
process.env.FFMPEG_LOOKAHEAD = "36";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Films ────────────────────────────────────────────────────────

/** 60 s at 640×360, a keyframe every 2 s, with the audio given, in H.264 or HEVC. */
function film(name: string, audio: string[], video = "libx264"): string {
  const file = path.join(tmp, name);
  const r = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "60", "-map", "0:v", "-map", "1:a", "-c:v", video, "-preset", "ultrafast", "-g", "48",
    ...(video === "libx265" ? ["-x265-params", "log-level=none"] : []),
    "-pix_fmt", "yuv420p", ...audio, file]);
  if (r.status !== 0) throw new Error(`couldn't make ${name}: ${r.stderr}`);
  return file;
}
const AAC_FILM = film("aac.mkv", ["-c:a", "aac", "-ac", "2"]);
const AC3_FILM = film("ac3.mkv", ["-c:a", "ac3", "-ac", "6"]);
const HEVC_FILM = film("hevc.mkv", ["-c:a", "aac", "-ac", "2"], "libx265");
/** AC3, a keyframe every 4 s, and B-frames: ffmpeg's seek to 32 s lands on the one at 28. */
const LATE_SOUND_FILM = film("late-sound.mkv", ["-bf", "2", "-g", "96", "-keyint_min", "96", "-sc_threshold", "0",
  "-c:a", "ac3", "-ac", "6"]);

/**
 * A PGS subtitle (.sup) of white boxes: each shown from `from` to `to`
 * seconds at [x, y, w, h] on a W×H canvas — an epoch-start display set, and
 * an empty one to clear it, as a Blu-ray's are.
 */
function pgs(W: number, H: number, shown: Array<{ from: number; to: number; box: [number, number, number, number] }>): Buffer {
  const out: Buffer[] = [];
  const seg = (pts: number, type: number, body: number[]) => {
    const head = Buffer.alloc(13);
    head.write("PG", 0, "latin1");
    head.writeUInt32BE(Math.round(pts * 90_000), 2);
    head.writeUInt32BE(0, 6);
    head.writeUInt8(type, 10);
    head.writeUInt16BE(body.length, 11);
    out.push(head, Buffer.from(body));
  };
  const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
  shown.forEach(({ from, to, box: [x, y, w, h] }, n) => {
    const window = [1, 0, ...u16(x), ...u16(y), ...u16(w), ...u16(h)];
    seg(from, 0x16, [...u16(W), ...u16(H), 0x10, ...u16(n * 2), 0x80, 0, 0, 1, ...u16(0), 0, 0, ...u16(x), ...u16(y)]);
    seg(from, 0x17, window);
    seg(from, 0x14, [0, 0, 1, 235, 128, 128, 255]);
    // Each line: w pixels of colour 1, then the end of the line.
    const rle: number[] = [];
    for (let i = 0; i < h; i++) rle.push(0, 0xc0 | ((w >> 8) & 0x3f), w & 0xff, 1, 0, 0);
    const len = rle.length + 4;
    seg(from, 0x15, [...u16(0), 0, 0xc0, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff, ...u16(w), ...u16(h), ...rle]);
    seg(from, 0x80, []);
    seg(to, 0x16, [...u16(W), ...u16(H), 0x10, ...u16(n * 2 + 1), 0, 0, 0, 0]);
    seg(to, 0x17, window);
    seg(to, 0x80, []);
  });
  return Buffer.concat(out);
}
const BOX: [number, number, number, number] = [220, 280, 200, 40];
const SUP = path.join(tmp, "boxes.sup");
fs.writeFileSync(SUP, pgs(640, 360, [{ from: 0.5, to: 5, box: BOX }, { from: 32, to: 40, box: BOX }]));
const SRT = "1\n00:00:02,000 --> 00:00:04,500\nHello there\n\n2\n00:00:40,000 --> 00:00:42,000\nHalfway\n";
const ASS = [
  "[Script Info]", "ScriptType: v4.00+", "PlayResX: 640", "PlayResY: 360", "",
  "[V4+ Styles]",
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
  "Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1", "",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  "Dialogue: 0,0:00:03.00,0:00:05.00,Default,,0,0,0,,Konnichiwa",
  "Dialogue: 0,0:00:41.00,0:00:43.00,Default,,0,0,0,,Mata ne", "",
].join("\n");
fs.writeFileSync(path.join(tmp, "lines.srt"), SRT);
fs.writeFileSync(path.join(tmp, "lines.ass"), ASS);
const TEXT_FILM = path.join(tmp, "text.mkv");
{
  const r = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", AAC_FILM,
    "-i", path.join(tmp, "lines.srt"), "-i", path.join(tmp, "lines.ass"),
    "-map", "0", "-map", "1", "-map", "2", "-c", "copy", TEXT_FILM]);
  if (r.status !== 0) throw new Error(`couldn't make text.mkv: ${r.stderr}`);
}
const PGS_FILM = path.join(tmp, "pgs.mkv");
{
  // -copyts: ffmpeg would otherwise start the subtitle's clock at its first picture.
  const r = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-copyts", "-i", AAC_FILM, "-i", SUP,
    "-map", "0", "-map", "1", "-c", "copy", PGS_FILM]);
  if (r.status !== 0) throw new Error(`couldn't make pgs.mkv: ${r.stderr}`);
}
/** Black, with the SRT and the ASS in it: what is burned in shows. */
const BLACK_FILM = path.join(tmp, "black.mkv");
{
  const r = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y",
    "-f", "lavfi", "-i", "color=c=black:s=640x360:r=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-i", path.join(tmp, "lines.srt"), "-i", path.join(tmp, "lines.ass"),
    "-t", "60", "-map", "0:v", "-map", "1:a", "-map", "2", "-map", "3", "-c:v", "libx264", "-preset", "ultrafast", "-g", "48",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-c:s", "copy", BLACK_FILM]);
  if (r.status !== 0) throw new Error(`couldn't make black.mkv: ${r.stderr}`);
}
/** A film in a folder of its own, with an English PGS and an English SRT
 *  beside it, and a French SRT that isn't the one asked for. */
const SIDECAR_DIR = path.join(tmp, "Sidecar Film (2001)");
fs.mkdirSync(SIDECAR_DIR);
const SIDECAR_FILM = path.join(SIDECAR_DIR, "Sidecar Film (2001).mkv");
fs.copyFileSync(path.join(tmp, "black.mkv"), SIDECAR_FILM);
fs.copyFileSync(SUP, path.join(SIDECAR_DIR, "Sidecar Film (2001).en.sup"));
fs.writeFileSync(path.join(SIDECAR_DIR, "Sidecar Film (2001).en.srt"), SRT);
fs.writeFileSync(path.join(SIDECAR_DIR, "Sidecar Film (2001).fr.srt"), "1\n00:00:01,000 --> 00:00:02,000\nBonjour\n");
const BROKEN_FILM = path.join(tmp, "broken.mkv");
fs.writeFileSync(BROKEN_FILM, Buffer.alloc(200_000, 7));
/** AV1 with Opus, a keyframe every 2 s: copied only in fragmented MP4. By
 *  the engine's ffmpeg, which has an AV1 encoder where the one on PATH may not. */
const AV1_FILM = path.join(tmp, "av1.mkv");
{
  const r = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "60", "-map", "0:v", "-map", "1:a", "-c:v", "libsvtav1", "-preset", "12", "-g", "48", "-pix_fmt", "yuv420p",
    "-c:a", "libopus", "-b:a", "96k", AV1_FILM]);
  if (r.status !== 0) throw new Error(`couldn't make av1.mkv: ${r.stderr}`);
}
const FLAC_FILM = film("flac.mkv", ["-c:a", "flac", "-ac", "2"]);
const EAC3_FILM = film("eac3.mkv", ["-c:a", "eac3", "-ac", "6", "-b:a", "384k"]);
/** PCM 7.1, standing in for TrueHD and DTS-HD MA 7.1, which no browser plays either. */
const PCM71_FILM = film("pcm71.mkv", ["-c:a", "pcm_s16le", "-ac", "8"]);
const PCM_FILM = film("pcm.mkv", ["-c:a", "pcm_s16le", "-ac", "2"]);

// ── Plex ─────────────────────────────────────────────────────────

/** ratingKey → the file, and how Plex describes it. */
const titles: Record<string, { file: string; plexPath: string; codec: string; width: number; height: number;
  audio: string; channels: number; audioKbps?: number; hdr?: Record<string, unknown>; slow?: boolean; size?: number;
  subs?: Array<Record<string, unknown>> }> = {
  1: { file: AAC_FILM, plexPath: AAC_FILM, codec: "h264", width: 640, height: 360, audio: "aac", channels: 2 },
  2: { file: AC3_FILM, plexPath: AC3_FILM, codec: "h264", width: 640, height: 360, audio: "ac3", channels: 6 },
  // HEVC, for a player nobody has said decodes it.
  3: { file: HEVC_FILM, plexPath: HEVC_FILM, codec: "hevc", width: 640, height: 360, audio: "aac", channels: 2 },
  // 4K: shown at 1080p, which is a re-encode.
  4: { file: AAC_FILM, plexPath: AAC_FILM, codec: "h264", width: 3840, height: 2160, audio: "aac", channels: 2 },
  // Not mounted here: read through Plex's file endpoint.
  5: { file: AAC_FILM, plexPath: "/nowhere/film.mkv", codec: "h264", width: 640, height: 360, audio: "aac", channels: 2 },
  // Not a film at all: ffmpeg fails.
  6: { file: BROKEN_FILM, plexPath: BROKEN_FILM, codec: "h264", width: 640, height: 360, audio: "aac", channels: 2 },
  // Dolby Vision profile 5: tone-mapped on OpenCL only, which isn't here.
  7: { file: AAC_FILM, plexPath: AAC_FILM, codec: "hevc", width: 640, height: 360, audio: "aac", channels: 2,
    hdr: { DOVIPresent: true, DOVIProfile: 5, colorTrc: "smpte2084" } },
  // Read through Plex at ten times the speed it plays, as a disk far slower
  // than a real one: so a run's pause can be seen before it reaches the end.
  8: { file: AAC_FILM, plexPath: "/nowhere/slow.mkv", codec: "h264", width: 640, height: 360, audio: "aac", channels: 2,
    slow: true },
  // With the PGS subtitle (stream 21, the file's third) in it.
  9: { file: PGS_FILM, plexPath: PGS_FILM, codec: "h264", width: 640, height: 360, audio: "aac", channels: 2 },
  // With an SRT and an ASS subtitle in it.
  10: { file: TEXT_FILM, plexPath: TEXT_FILM, codec: "h264", width: 640, height: 360, audio: "aac", channels: 2, subs: [
    { id: 31, streamType: 3, index: 2, codec: "srt", language: "English", languageCode: "eng" },
    { id: 32, streamType: 3, index: 3, codec: "ass", language: "Japanese", languageCode: "jpn" },
  ] },
  // Plex has it as AC3 where the file has AAC: replaced since Plex read it,
  // at the same size.
  11: { file: AAC_FILM, plexPath: AAC_FILM, codec: "h264", width: 640, height: 360, audio: "ac3", channels: 6 },
  // And a file whose size isn't what Plex last read.
  12: { file: AAC_FILM, plexPath: AAC_FILM, codec: "h264", width: 640, height: 360, audio: "aac", channels: 2,
    size: fs.statSync(AAC_FILM).size + 1 },
  // Black, with its SRT (41) and ASS (42) to burn in.
  13: { file: BLACK_FILM, plexPath: BLACK_FILM, codec: "h264", width: 640, height: 360, audio: "aac", channels: 2, subs: [
    { id: 41, streamType: 3, index: 2, codec: "srt", language: "English", languageCode: "eng" },
    { id: 42, streamType: 3, index: 3, codec: "ass", language: "Japanese", languageCode: "jpn" },
  ] },
  // Black, with sidecars: a PGS (51) and an SRT (52), which Plex can't send.
  14: { file: SIDECAR_FILM, plexPath: SIDECAR_FILM, codec: "h264", width: 640, height: 360, audio: "aac", channels: 2, subs: [
    { id: 51, streamType: 3, codec: "pgs", key: "/library/streams/51", language: "English", languageCode: "eng", languageTag: "en" },
    { id: 52, streamType: 3, codec: "srt", key: "/library/streams/52", language: "English", languageCode: "eng", languageTag: "en" },
  ] },
  // The text film again, under other stream ids: read ahead, both in one pass.
  15: { file: TEXT_FILM, plexPath: TEXT_FILM, codec: "h264", width: 640, height: 360, audio: "aac", channels: 2, subs: [
    { id: 61, streamType: 3, index: 2, codec: "srt", language: "English", languageCode: "eng" },
    { id: 62, streamType: 3, index: 3, codec: "ass", language: "Japanese", languageCode: "jpn" },
  ] },
  16: { file: LATE_SOUND_FILM, plexPath: LATE_SOUND_FILM, codec: "h264", width: 640, height: 360, audio: "ac3", channels: 6 },
  17: { file: AV1_FILM, plexPath: AV1_FILM, codec: "av1", width: 640, height: 360, audio: "opus", channels: 2 },
  18: { file: FLAC_FILM, plexPath: FLAC_FILM, codec: "h264", width: 640, height: 360, audio: "flac", channels: 2 },
  19: { file: EAC3_FILM, plexPath: EAC3_FILM, codec: "h264", width: 640, height: 360, audio: "eac3", channels: 6 },
  // PCM at what Plex says of it: 48 kHz, 16 bits, a channel each.
  20: { file: PCM71_FILM, plexPath: PCM71_FILM, codec: "h264", width: 640, height: 360, audio: "pcm", channels: 8, audioKbps: 6144 },
  21: { file: PCM_FILM, plexPath: PCM_FILM, codec: "h264", width: 640, height: 360, audio: "pcm", channels: 2, audioKbps: 1536 },
};

const asked: string[] = [];
/** Whether Plex's transcoder answers a start, for the checks on what is
 *  said of a stream ffmpeg left to it: otherwise a start fails. */
let plexStarts = false;
/** Timeline reports, as Plex had them. */
const timelines: Array<{ q: Record<string, string>; h: Record<string, string> }> = [];
const plex = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://plex");
  asked.push(url.pathname);
  if (url.pathname === "/:/timeline" && req.method === "POST") {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (k.startsWith("x-plex-") && k !== "x-plex-token") h[k] = String(v);
    const { "X-Plex-Token": _token, ...q } = Object.fromEntries(url.searchParams);
    timelines.push({ q, h });
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end("{}");
  }
  const send = (body: unknown) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ MediaContainer: body }));
  };
  // Who it is, for the upload budget's snapshot (routes/qbt-manager.ts).
  if (url.pathname === "/") return send({ machineIdentifier: "test-plex" });
  const meta = url.pathname.match(/^\/library\/metadata\/(\d+)$/);
  if (meta && titles[meta[1]]) {
    const t = titles[meta[1]];
    return send({ Metadata: [{
      ratingKey: meta[1], title: `Film ${meta[1]}`, type: "movie", duration: 60_000,
      Media: [{ id: 1, container: "mkv", width: t.width, height: t.height, videoCodec: t.codec, bitrate: 2000,
        Part: [{ id: Number(meta[1]), key: `/library/parts/${meta[1]}/1/file.mkv`, file: t.plexPath,
          size: t.size ?? fs.statSync(t.file).size, Stream: [
            { id: 11, streamType: 1, index: 0, codec: t.codec, bitDepth: 8, ...t.hdr },
            { id: 12, streamType: 2, index: 1, codec: t.audio, channels: t.channels, bitrate: t.audioKbps ?? 160, selected: true },
            // A picture subtitle, which can only be burned in: in film 9, listed
            // only in the rest. And a text one, listed only.
            ...(t.subs ?? [
              { id: 21, streamType: 3, index: 2, codec: "pgs", language: "English", languageCode: "eng" },
              { id: 22, streamType: 3, index: 3, codec: "srt", language: "French", languageCode: "fra" },
            ]),
          ] }] }],
    }] });
  }
  // No previews: none of these films has had Plex's made.
  if (/^\/library\/parts\/\d+\/indexes\/sd$/.test(url.pathname)) return res.writeHead(404).end();
  // The file itself, with byte ranges, as Plex serves it.
  const part = url.pathname.match(/^\/library\/parts\/(\d+)\/1\/file\.mkv$/);
  if (part && titles[part[1]]) {
    const data = fs.readFileSync(titles[part[1]].file);
    const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ""));
    const from = range ? Number(range[1]) : 0;
    const to = range && range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
    res.writeHead(range ? 206 : 200, {
      "Content-Type": "video/x-matroska", "Accept-Ranges": "bytes", "Content-Length": String(to - from + 1),
      ...(range ? { "Content-Range": `bytes ${from}-${to}/${data.length}` } : {}),
    });
    const body = data.subarray(from, to + 1);
    if (!titles[part[1]].slow) return res.end(body);
    const chunk = Math.ceil(data.length / 60 * 10 / 20); // 10× the film's pace, 20 writes a second
    let sent = 0;
    const timer = setInterval(() => {
      res.write(body.subarray(sent, sent += chunk));
      if (sent >= body.length) { clearInterval(timer); res.end(); }
    }, 50);
    res.on("close", () => clearInterval(timer));
    return;
  }
  // Plex's transcoder isn't really here: a start that reaches it fails, or
  // is answered with a playlist of nothing, re-encoded.
  if (plexStarts && url.pathname === "/video/:/transcode/universal/decision") {
    return send({ Metadata: [{ Media: [{ Part: [{ Stream: [{ streamType: 1, codec: "h264", decision: "transcode" }] }] }] }] });
  }
  if (plexStarts && url.pathname === "/video/:/transcode/universal/start.m3u8") {
    res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
    return res.end(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=640x360
session/${crypto.randomUUID()}/base/index.m3u8
`);
  }
  res.writeHead(500).end();
});
await new Promise<void>((r) => plex.listen(0, "127.0.0.1", r));
process.env.PLEX_URL = `http://127.0.0.1:${(plex.address() as AddressInfo).port}`;

// ── The routes ───────────────────────────────────────────────────

const plexRoutes = await import("../src/routes/plex.js");
const { videoSpan } = await import("../src/services/ts-timestamps.js");
plexRoutes.allowStartsWithoutRoom();
const express = (await import("express")).default;
const app = express();
app.use(express.json());
app.use("/api/plex", plexRoutes.default);
const api = http.createServer(app);
await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

const transcodeAsked = () => asked.filter((p) => p.startsWith("/video/:/transcode"));
const variantOf = (master: string) => master.split("\n").find((l) => l && !l.startsWith("#"))!;
const keyOf = (uri: string) => decodeURIComponent(uri).match(/session\/([0-9a-f-]{36})\//)?.[1] ?? null;
const notesOf = (master: string) => Object.fromEntries([...master.matchAll(/DATA-ID="com\.pdt\.(\w+)",VALUE="([^"]*)"/g)]
  .map((m) => [m[1], m[2]]));
function entries(playlist: string): Array<{ duration: number; uri: string }> {
  const out: Array<{ duration: number; uri: string }> = [];
  const lines = playlist.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#EXTINF:([\d.]+),/);
    if (!m) continue;
    let j = i + 1;
    if (lines[j] === "#EXT-X-GAP") continue;
    out.push({ duration: Number(m[1]), uri: lines[j] });
    j++;
  }
  return out;
}
async function master(ratingKey: string, sid: string, query = "") {
  const r = await fetch(`${origin}/api/plex/hls/${ratingKey}/${sid}/master.m3u8${query}`);
  return { status: r.status, text: await r.text() };
}

console.log("\n— what a copy is judged on —");
{
  const { planCopy } = await import("../src/services/ffmpeg/plan.js");
  const version = (video: Record<string, unknown>, more: Record<string, unknown> = {}) => ({
    container: "mkv", width: 1920, height: 1080, partKey: "/library/parts/1/1/file.mkv", file: "/data/media/f.mkv",
    streams: [{ id: 11, streamType: 1, index: 0, codec: "hevc", bitDepth: 10, ...video },
      { id: 12, streamType: 2, index: 1, codec: "eac3", channels: 6, default: true },
      { id: 13, streamType: 2, index: 2, codec: "aac", channels: 2 }],
    ...more,
  });
  const why = (v: ReturnType<typeof version>, hevcOk = true, audioStreamId: number | null = null) => {
    const p = planCopy(v, { audioStreamId, hevcOk });
    return p.ok ? "copy" : p.why;
  };
  check("HDR10 HEVC, for a player that decodes it, is copied as it is", why(version({ colorTrc: "smpte2084" })), "copy");
  check("so is Dolby Vision 8.1, whose HDR10 picture is underneath",
    why(version({ DOVIPresent: true, DOVIProfile: 8, DOVIBLCompatID: 1 })), "copy");
  check("but not profile 5, which has none",
    why(version({ DOVIPresent: true, DOVIProfile: 5 })), "Dolby Vision P5 needs tone mapping");
  check("nor HEVC for a player that can't decode it", why(version({}), false), "HEVC, and this player can't decode it");
  check("nor 10-bit H.264", why(version({ codec: "h264" })), "10-bit H.264");
  check("nor what MPEG-TS can't carry from an AVI", why(version({}, { container: "avi" })), "avi container");
  const chosen = planCopy(version({}), { audioStreamId: 13, hevcOk: true });
  check("the track asked for is the one taken, and AAC is copied",
    chosen.ok && [chosen.audio?.id, chosen.audioCopy], [13, true]);
  const dflt = planCopy(version({}), { audioStreamId: null, hevcOk: true });
  check("with none asked for, the file's default, converted", dflt.ok && [dflt.audio?.id, dflt.audioCopy], [12, false]);
  check("a track the file hasn't is no copy", why(version({}), true, 99), "no audio track 99");
  check("nor 1080i H.264, which Chrome can't decode (Cunk on Shakespeare)",
    why(version({ codec: "h264", bitDepth: 8, scanType: "interlaced" })), "interlaced H.264");
  check("but HEVC marked interlaced is (His Dark Materials)", why(version({ scanType: "interlaced" })), "copy");
  const stereo = planCopy(version({}, { streams: [{ id: 11, streamType: 1, index: 0, codec: "hevc", bitDepth: 10 },
    { id: 12, streamType: 2, index: 1, codec: "ac3", channels: 2, default: true }] }), { audioStreamId: null, hevcOk: true, audioChannels: 6 });
  check("stereo stays stereo when surround becomes 5.1", stereo.ok && stereo.audioOut, { codec: "aac", channels: 2, kbps: 256 });
}

console.log("\n— a copy from the start —");
const sid = crypto.randomUUID();
let firstKey: string | null = null;
{
  asked.length = 0;
  const m = await master("1", sid);
  check("the master playlist comes back", m.status, 200);
  const notes = notesOf(m.text);
  check("made by ffmpeg, the video copied, the AAC copied",
    [notes.engine, notes.video, notes.audio], ["ffmpeg", "copy", "copy"]);
  check("and Plex was never asked to transcode", transcodeAsked(), []);
  const variant = variantOf(m.text);
  firstKey = keyOf(variant);
  check("the player is pointed back here, at a key of the engine's", [variant.startsWith("/api/plex/hls/seg?p="), !!firstKey], [true, true]);

  const playlist = await (await fetch(origin + variant)).text();
  check("the playlist is the measured kind", playlist.includes("#EXT-X-PLAYLIST-TYPE:EVENT"), true);
  check("it starts at the start", /#EXT-X-START:TIME-OFFSET=0\.0\d\d,PRECISE=YES/.test(playlist), true);
  const list = entries(playlist);
  check("with segments listed, their sizes in their URLs", list.length > 0 && list.every((e) => /&n=\d+$/.test(e.uri)), true);
  const first = list[0];
  const res = await fetch(origin + first.uri);
  const bytes = Buffer.from(await res.arrayBuffer());
  check("a segment is served as MPEG-TS", [res.status, res.headers.get("content-type")], [200, "video/MP2T"]);
  check("all of it", bytes.length, Number(first.uri.match(/&n=(\d+)$/)![1]));
  const span = videoSpan(bytes)!;
  check("its timestamps are the film's own plus Plex's 10 s: it opens at 10", Math.abs(span.start - 10) < 0.1, true);
  check("with sound in it", span.audioStart !== null, true);
  const ranged = await fetch(origin + first.uri, { headers: { Range: "bytes=100-199" } });
  check("a byte range of one is served too", [ranged.status, (await ranged.arrayBuffer()).byteLength], [206, 100]);
  const part = await fetch(`${origin}${first.uri}&part=1&parts=2`);
  check("and one of its parts", Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(Math.floor(bytes.length / 2))), true);
  check("still nothing asked of Plex's transcoder", transcodeAsked(), []);
}

{
  const variant = variantOf((await master("1", sid)).text);
  check("asked again without an offset, the running stream is the answer", keyOf(variant), firstKey);
}

console.log("\n— a seek past what is there —");
{
  // Here, before FFMPEG_LOOKAHEAD is unset below and the run from the start goes on to the end:
  // one that has reached it serves the seek from what it made.
  const m = await master("1", sid, "?offset=31");
  const variant = variantOf(m.text);
  const key = keyOf(variant);
  check("an offset starts a run of its own", !!key && key !== firstKey, true);
  const playlist = await (await fetch(origin + variant)).text();
  check("the playlist begins where the player asked", playlist.includes("#EXT-X-START:TIME-OFFSET=31.000,PRECISE=YES"), true);
  if (process.platform === "win32") {
    // Where the run from the start went on to the end: the seek is served from it (see below).
    console.log("  (no SIGSTOP on Windows: the run from the start has reached the end, so it isn't a new run here)");
  } else {
    check("with gaps up to the keyframe before it", /#EXT-X-GAP/.test(playlist), true);
    const first = entries(playlist)[0];
    const bytes = Buffer.from(await (await fetch(origin + first.uri)).arrayBuffer());
    const span = videoSpan(bytes)!;
    check("whose picture opens on the keyframe at 30 s (40 on the copy's clock)", Math.abs(span.start - 40) < 0.1, true);
    // Jellyfin's ffmpeg counted the start twice with -segment_time: 30 s to 64 s here.
    check("and is a segment long, not the stretch since the start", span.end - span.start <= 6, true);
  }
  const old = await fetch(`${origin}/api/plex/hls/seg?p=${encodeURIComponent(`/video/:/transcode/universal/session/${firstKey}/base/index.m3u8`)}`);
  check("the run it replaced is gone (410), not asked of Plex", [old.status, transcodeAsked()], [410, []]);
}

console.log("\n— ahead of the watcher, and no further —");
{
  const slow = crypto.randomUUID();
  const variant = variantOf((await master("8", slow)).text);
  const edge = (text: string) => entries(text).reduce((s, e) => s + e.duration, 0);
  const playlist = async () => (await fetch(origin + variant)).text();
  let now = await playlist();
  for (let i = 0; i < 40 && edge(now) < 32 && !now.includes("#EXT-X-ENDLIST"); i++) {
    await sleep(250);
    now = await playlist();
  }
  if (process.platform === "win32") {
    console.log("  (no SIGSTOP on Windows: the pause isn't checked here)");
  } else {
    await sleep(1500);
    const a = await playlist();
    await sleep(1000);
    const b = await playlist();
    // Stopped once a segment ends past 36 s; the playlist lists up to the one before.
    check("with the watcher at 0 it stops about 36 s in, short of the end",
      [edge(a) >= 32 && edge(a) < 48, edge(b) === edge(a), b.includes("#EXT-X-ENDLIST")], [true, true, false]);
  }
  const ping = await fetch(`${origin}/api/plex/hls/ping/${slow}?time=50000&playing=1`);
  check("a ping is answered without asking Plex", [ping.status, transcodeAsked()], [200, []]);
  let ended = "";
  for (let i = 0; i < 60 && !ended.includes("#EXT-X-ENDLIST"); i++) {
    await sleep(250);
    ended = await playlist();
  }
  check("once the watcher is at 50 s it carries on to the end of the film", ended.includes("#EXT-X-ENDLIST"), true);
  check("which the playlist reaches, at its true length", Math.abs(edge(ended) - 60) < 0.2, true);
  await fetch(`${origin}/api/plex/hls/session/${slow}?reason=test`, { method: "DELETE" });
}

console.log("\n— the whole film, with FFMPEG_LOOKAHEAD unset —");
{
  delete process.env.FFMPEG_LOOKAHEAD;
  const whole = crypto.randomUUID();
  const variant = variantOf((await master("8", whole)).text);
  const edge = (text: string) => entries(text).reduce((s, e) => s + e.duration, 0);
  let now = "";
  for (let i = 0; i < 60 && !now.includes("#EXT-X-ENDLIST"); i++) {
    await sleep(250);
    now = await (await fetch(origin + variant)).text();
  }
  check("with the watcher at 0 it goes on to the end of the film all the same",
    [now.includes("#EXT-X-ENDLIST"), Math.abs(edge(now) - 60) < 0.2], [true, true]);
  await fetch(`${origin}/api/plex/hls/session/${whole}?reason=test`, { method: "DELETE" });
  process.env.FFMPEG_LOOKAHEAD = "36";
}

console.log("\n— audio that isn't AAC —");
{
  const m = await master("2", crypto.randomUUID());
  const notes = notesOf(m.text);
  check("is converted, and the player told so", [notes.engine, notes.audio, notes.audioFrom, notes.audioTo],
    ["ffmpeg", "transcode", "AC3 5.1", "AAC 5.1"]);
  const variant = variantOf(m.text);
  const first = entries(await (await fetch(origin + variant)).text())[0];
  const span = videoSpan(Buffer.from(await (await fetch(origin + first.uri)).arrayBuffer()))!;
  check("and is in the segments", span.audioStart !== null, true);
  const seg = path.join(tmp, "surround.ts");
  const list = entries(await (await fetch(origin + variant)).text());
  fs.writeFileSync(seg, Buffer.from(await (await fetch(origin + list[0].uri)).arrayBuffer()));
  const channels = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels",
    "-of", "csv=p=0", seg], { encoding: "utf8" }).stdout.trim().split(/\s+/)[0];
  check("as AAC 5.1 at 448 kbps", [notes.audioKbps, channels], ["448", "6"]);
  process.env.FFMPEG_AUDIO_CHANNELS = "2";
  const stereo = notesOf((await master("2", crypto.randomUUID())).text);
  check("and with FFMPEG_AUDIO_CHANNELS=2, as AAC stereo, as Plex makes it", [stereo.audioTo, stereo.audioKbps], ["AAC Stereo", "256"]);
  delete process.env.FFMPEG_AUDIO_CHANNELS;
  // 1917 on 22 October: its first segment had no sound, and the friend's player failed on the next.
  const late = variantOf((await master("16", crypto.randomUUID(), "?offset=32")).text);
  const opening = entries(await (await fetch(origin + late)).text())[0];
  const at = videoSpan(Buffer.from(await (await fetch(origin + opening.uri)).arrayBuffer()))!;
  check("from a seek that lands a keyframe early, the first segment has sound from its picture on",
    [Math.round((at.start - 10) * 10) / 10, at.audioStart !== null && Math.abs(at.audioStart - at.start) < 0.5], [28, true]);
}

console.log("\n— AV1 and Opus, and FLAC, copied in fragmented MP4 for a player that decodes them —");
{
  const { initTracks, mp4Span } = await import("../src/services/mp4-timestamps.js");
  const none = { hevc: false, av1: false, opus: false, flac: false, ac3: false, eac3: false, av1Encode: false };
  plexRoutes.capsForTests({ ...none, av1: true, opus: true, flac: true });
  const mapOf = (playlist: string) => playlist.match(/^#EXT-X-MAP:URI="([^"]+)"/m)?.[1] ?? null;
  const copied = async (ratingKey: string) => {
    const sid = crypto.randomUUID();
    asked.length = 0;
    const m = await master(ratingKey, sid);
    const variant = variantOf(m.text);
    let playlist = "";
    for (let i = 0; i < 40 && entries(playlist).length === 0; i++) {
      playlist = await (await fetch(origin + variant)).text();
      if (entries(playlist).length === 0) await sleep(250);
    }
    return { sid, notes: notesOf(m.text), playlist };
  };

  const av1 = await copied("17");
  check("AV1 with Opus is copied by ffmpeg, both as they are", [av1.notes.engine, av1.notes.video, av1.notes.audio],
    ["ffmpeg", "copy", "copy"]);
  check("and Plex was never asked to transcode", transcodeAsked(), []);
  check("the stream says it needs AV1 and Opus", plexRoutes.sessionNeeds(av1.sid), ["av1", "opus"]);
  check("its playlist is version 7, with an init segment",
    [av1.playlist.includes("#EXT-X-VERSION:7"), !!mapOf(av1.playlist)], [true, true]);
  const list = entries(av1.playlist);
  check("and fMP4 segments, their sizes in their URLs", list.length > 0 && list.every((e) => /\.m4s/.test(decodeURIComponent(e.uri)) && /&n=\d+$/.test(e.uri)), true);
  const initRes = await fetch(origin + mapOf(av1.playlist)!);
  const init = Buffer.from(await initRes.arrayBuffer());
  check("the init is served as MP4, all of it",
    [initRes.status, initRes.headers.get("content-type"), init.subarray(4, 8).toString("latin1"), init.length],
    [200, "video/mp4", "ftyp", Number(mapOf(av1.playlist)!.match(/&n=(\d+)$/)![1])]);
  const segRes = await fetch(origin + list[0].uri);
  const seg = Buffer.from(await segRes.arrayBuffer());
  check("a segment as MP4, kept by caches like a .ts", [segRes.headers.get("content-type"), segRes.headers.get("cache-control")],
    ["video/mp4", "public, max-age=300, immutable"]);
  const span = mp4Span(initTracks(init), seg);
  check("its timestamps the film's own plus Plex's 10 s: it opens at 10, with sound",
    [!!span && Math.abs(span.start - 10) < 0.1, span?.audioStart !== null && span?.audioStart !== undefined], [true, true]);
  const whole = path.join(tmp, "av1-first.mp4");
  fs.writeFileSync(whole, Buffer.concat([init, seg]));
  const codecs = spawnSync(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", whole],
    { encoding: "utf8" }).stdout.trim().split(/\s+/);
  check("AV1 and Opus in it, as a browser's MSE takes them", codecs, ["av1", "opus"]);
  await fetch(`${origin}/api/plex/hls/session/${av1.sid}?reason=test`, { method: "DELETE" });

  const flac = await copied("18");
  check("H.264 with FLAC: both copied, FLAC needed", [flac.notes.video, flac.notes.audio, plexRoutes.sessionNeeds(flac.sid)],
    ["copy", "copy", ["flac"]]);
  check("in fMP4 too", [!!mapOf(flac.playlist), entries(flac.playlist).every((e) => /\.m4s/.test(decodeURIComponent(e.uri)))],
    [true, true]);
  await fetch(`${origin}/api/plex/hls/session/${flac.sid}?reason=test`, { method: "DELETE" });

  plexRoutes.capsForTests({ ...none, eac3: true });
  const eac3 = await copied("19");
  check("H.264 with EAC3 5.1, for a player that decodes EAC3: both copied, EAC3 needed, in fMP4",
    [eac3.notes.video, eac3.notes.audio, eac3.notes.audioFrom, plexRoutes.sessionNeeds(eac3.sid), !!mapOf(eac3.playlist)],
    ["copy", "copy", "EAC3 5.1", ["eac3"], true]);
  {
    const list = entries(eac3.playlist);
    const init = Buffer.from(await (await fetch(origin + mapOf(eac3.playlist)!)).arrayBuffer());
    const seg = Buffer.from(await (await fetch(origin + list[0].uri)).arrayBuffer());
    const whole = path.join(tmp, "eac3-first.mp4");
    fs.writeFileSync(whole, Buffer.concat([init, seg]));
    const probe = spawnSync(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-select_streams", "a",
      "-show_entries", "stream=codec_name,codec_tag_string,channels", "-of", "csv=p=0", whole], { encoding: "utf8" }).stdout.trim()
      .replace(/,+$/, "");
    check("its sound EAC3 5.1, tagged ec-3 as MSE takes it", probe, "eac3,ec-3,6");
  }
  await fetch(`${origin}/api/plex/hls/session/${eac3.sid}?reason=test`, { method: "DELETE" });
  plexRoutes.capsForTests(none);
  const noEac3 = await copied("19");
  check("for a player that can't, made AAC 5.1, and saying that is why rather than \"Unsupported codec\"",
    [noEac3.notes.video, noEac3.notes.audio, noEac3.notes.audioTo, noEac3.notes.audioReason],
    ["copy", "transcode", "AAC 5.1", "EAC3, and this player can't play it"]);
  await fetch(`${origin}/api/plex/hls/session/${noEac3.sid}?reason=test`, { method: "DELETE" });

  /** The sound of a stream's first segment: codec, MP4 tag, channels. */
  const soundOf = async (c: { playlist: string }, name: string) => {
    const init = Buffer.from(await (await fetch(origin + mapOf(c.playlist)!)).arrayBuffer());
    const seg = Buffer.from(await (await fetch(origin + entries(c.playlist)[0].uri)).arrayBuffer());
    const whole = path.join(tmp, name);
    fs.writeFileSync(whole, Buffer.concat([init, seg]));
    return spawnSync(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-select_streams", "a",
      "-show_entries", "stream=codec_name,codec_tag_string,channels", "-of", "csv=p=0", whole], { encoding: "utf8" }).stdout.trim()
      .replace(/,+$/, "");
  };
  plexRoutes.capsForTests({ ...none, opus: true });
  const opus71 = await copied("20");
  check("7.1 no browser plays, for a player that decodes Opus: the picture copied, the sound Opus 7.1 rather than AAC 5.1, Opus needed, in fMP4",
    [opus71.notes.video, opus71.notes.audio, opus71.notes.audioTo, plexRoutes.sessionNeeds(opus71.sid), !!mapOf(opus71.playlist)],
    ["copy", "transcode", "Opus 7.1", ["opus"], true]);
  check("its sound Opus, all eight channels, as MSE takes it", await soundOf(opus71, "opus71-first.mp4"), "opus,Opus,8");
  await fetch(`${origin}/api/plex/hls/session/${opus71.sid}?reason=test`, { method: "DELETE" });
  plexRoutes.capsForTests(none);
  const aac51 = await copied("20");
  check("for a player that doesn't, AAC 5.1 in MPEG-TS, and whoever decodes Opus given a copy with it",
    [aac51.notes.audioTo, !!mapOf(aac51.playlist), plexRoutes.sessionWithheld(aac51.sid)], ["AAC 5.1", false, ["opus"]]);
  await fetch(`${origin}/api/plex/hls/session/${aac51.sid}?reason=test`, { method: "DELETE" });
  plexRoutes.capsForTests({ ...none, flac: true });
  const pcm = await copied("21");
  check("PCM stereo, for a player that decodes FLAC: made FLAC, the same sound, FLAC needed, in fMP4",
    [pcm.notes.video, pcm.notes.audio, pcm.notes.audioTo, plexRoutes.sessionNeeds(pcm.sid), !!mapOf(pcm.playlist)],
    ["copy", "transcode", "FLAC Stereo", ["flac"], true]);
  check("its sound FLAC, stereo, as MSE takes it", await soundOf(pcm, "pcm-first.mp4"), "flac,fLaC,2");
  await fetch(`${origin}/api/plex/hls/session/${pcm.sid}?reason=test`, { method: "DELETE" });

  const held = await copied("17");
  check("for a player that decodes neither, AV1 is re-encoded and Opus made AAC, in MPEG-TS",
    [held.notes.video, held.notes.audio, !!mapOf(held.playlist)], ["transcode", "transcode", false]);
  check("what it couldn't have said, so whoever can is given the copy",
    [plexRoutes.sessionWithheld(held.sid), plexRoutes.sessionNeeds(held.sid)], [["av1", "opus"], []]);
  await fetch(`${origin}/api/plex/hls/session/${held.sid}?reason=test`, { method: "DELETE" });
  plexRoutes.capsForTests(none);
}

console.log("\n— a file that isn't mounted here —");
{
  asked.length = 0;
  const m = await master("5", crypto.randomUUID());
  check("is still copied by ffmpeg", notesOf(m.text).engine, "ffmpeg");
  check("reading the file through Plex's file endpoint, not its transcoder",
    [asked.includes("/library/parts/5/1/file.mkv"), transcodeAsked()], [true, []]);
}

console.log("\n— what a re-encode is made of —");
{
  const { planEncode, encodeArgs, encodeTargetKbps } = await import("../src/services/ffmpeg/plan.js");
  const version = (video: Record<string, unknown>, more: Record<string, unknown> = {}) => ({
    container: "mkv", width: 1920, height: 1080, partKey: "/library/parts/1/1/file.mkv", file: "/data/media/f.mkv",
    streams: [{ id: 11, streamType: 1, index: 0, codec: "hevc", bitDepth: 10, colorPrimaries: "bt709", colorTrc: "bt709",
      colorSpace: "bt709", colorRange: "tv", ...video },
      { id: 12, streamType: 2, index: 1, codec: "eac3", channels: 6, default: true }],
    ...more,
  });
  const ask = { audioStreamId: null, hevcOk: true, hardware: "qsv" as "qsv" | "software", kbps: 8000, peakKbps: 8000,
    maxWidth: 1920, maxHeight: 1080, keepHdr: true };
  const plan = (v: ReturnType<typeof version>, more: Partial<Parameters<typeof planEncode>[1]> = {}) =>
    planEncode(v, { ...ask, ...more });
  const hdr10 = plan(version({ colorPrimaries: "bt2020", colorTrc: "smpte2084", colorSpace: "bt2020nc" }));
  check("HDR10 for an HEVC player stays HDR, in HEVC Main10",
    hdr10.ok && [hdr10.codec, hdr10.hdrTrc], ["hevc", "smpte2084"]);
  const hdrArgs = hdr10.ok ? encodeArgs(hdr10, ["-i", "f.mkv"], 0, 60, "/dev/dri/renderD128").join(" ") : "";
  check("  labelled HDR10 on the output, decoded and scaled on the GPU in 10 bits",
    [hdrArgs.includes("-color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc"),
      hdrArgs.includes("-hwaccel vaapi"), hdrArgs.includes("scale_vaapi=w=1920:h=1080:format=p010"),
      hdrArgs.includes("-c:v hevc_qsv -low_power 1 -profile:v main10")], [true, true, true, true]);
  check("  VBR, never CBR: the peak a little over a target equal to it",
    hdrArgs.includes("-b:v 8000k -maxrate 8001k -bufsize 16002k"), true);
  check("  its target for the upload budget, the video's and the EAC3's as AAC at 256 kbps",
    hdr10.ok && encodeTargetKbps(hdr10), 8256);
  const hlg = plan(version({ DOVIPresent: true, DOVIProfile: 8, DOVIBLCompatID: 4, colorTrc: "arib-std-b67" }));
  check("Dolby Vision 8.4 is kept as the HLG underneath", hlg.ok && hlg.hdrTrc, "arib-std-b67");
  const why = (p: ReturnType<typeof plan>) => (p.ok ? "encode" : p.why);
  const tonemapped = (p: ReturnType<typeof plan>) => p.ok && [p.codec, p.hdrTrc, p.tonemap?.via, p.tonemap?.dovi];
  check("HDR10 for an H.264 player is tone-mapped to H.264, on QSV's video engine without OpenCL",
    tonemapped(plan(version({ colorTrc: "smpte2084" }), { hevcOk: false })), ["h264", null, "vpp", false]);
  check("  and on OpenCL where it works",
    tonemapped(plan(version({ colorTrc: "smpte2084" }), { hevcOk: false, tonemapper: "opencl" })), ["h264", null, "opencl", false]);
  check("so is HDR with FFMPEG_HDR_REENCODE=tonemap, for an HEVC player too",
    tonemapped(plan(version({ colorTrc: "smpte2084" }), { keepHdr: false })), ["h264", null, "vpp", false]);
  check("and on the CPU when the GPU doesn't decode it",
    tonemapped(plan(version({ colorTrc: "smpte2084" }), { hevcOk: false, gpuDecode: false })), ["h264", null, "software", false]);
  check("Dolby Vision 5 is tone-mapped with its own metadata, on OpenCL",
    tonemapped(plan(version({ DOVIPresent: true, DOVIProfile: 5 }), { tonemapper: "opencl" })), ["h264", null, "opencl", true]);
  check("  and left to Plex without it",
    why(plan(version({ DOVIPresent: true, DOVIProfile: 5 }))), "Dolby Vision P5 needs OpenCL tone mapping");
  check("  or decoded on the CPU",
    why(plan(version({ DOVIPresent: true, DOVIProfile: 5 }), { tonemapper: "opencl", gpuDecode: false })),
    "Dolby Vision P5 needs OpenCL tone mapping");
  const p5 = plan(version({ DOVIPresent: true, DOVIProfile: 5, colorPrimaries: "bt2020", colorTrc: "smpte2084", colorSpace: "bt2020nc" }),
    { tonemapper: "opencl" });
  const p5Args = p5.ok ? encodeArgs(p5, ["-i", "f.mkv"], 0, 60, "/dev/dri/renderD128").join(" ") : "";
  check("  by Phase 0's chain: OpenCL from VAAPI, its Dolby Vision applied, back to QSV, labelled BT.709", [
    p5Args.includes("-init_hw_device qsv=qs@va -init_hw_device opencl=ocl@va -filter_hw_device qs"),
    p5Args.includes("-vf scale_vaapi=w=1920:h=1080:format=p010,hwmap=derive_device=opencl:mode=read," +
      "tonemap_opencl=tonemap=reinhard:desat=0:peak=100:t=bt709:m=bt709:p=bt709:format=nv12:apply_dovi=1," +
      "hwmap=derive_device=vaapi:mode=write:reverse=1,format=vaapi,hwmap=derive_device=qsv,format=qsv"),
    p5Args.includes("-c:v h264_qsv"),
    p5Args.includes("-color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv"),
  ], [true, true, true, true]);
  const vpp = plan(version({ colorTrc: "smpte2084" }), { hevcOk: false });
  check("  QSV's video engine after the GPU's scale",
    vpp.ok && encodeArgs(vpp, ["-i", "f.mkv"], 0, 60, "/dev/dri/renderD128").join(" ").includes(
      "scale_vaapi=w=1920:h=1080:format=p010,hwmap=derive_device=qsv,format=qsv,vpp_qsv=tonemap=1:format=nv12"), true);
  const soft = plan(version({ colorTrc: "smpte2084" }), { hardware: "software", tonemapAlgo: "mobius" });
  check("  and tonemapx on the CPU, by FFMPEG_TONEMAP's curve",
    soft.ok && encodeArgs(soft, ["-i", "f.mkv"], 0, 60, "").join(" ").includes(
      "scale=1920:1080,format=yuv420p10le,tonemapx=tonemap=mobius:desat=0:peak=100:t=bt709:m=bt709:p=bt709:format=nv12,format=yuv420p"),
    true);
  const cpu = plan(version({ codec: "h264", bitDepth: 8 }), { hardware: "software" });
  check("on the CPU it is H.264", cpu.ok && cpu.codec, "h264");
  const anamorphic = plan(version({ codec: "mpeg2video", bitDepth: 8, anamorphic: true, pixelAspectRatio: "4:3" },
    { width: 1440, height: 1080 }));
  check("1440×1080 at 4:3 pixels becomes square 1920×1080, decoded on the GPU",
    anamorphic.ok && [anamorphic.width, anamorphic.height, anamorphic.gpuDecode], [1920, 1080, true]);
  check("4K fits 1080p, and the 4 Mbps level 720p",
    [plan(version({}, { width: 3840, height: 2160 })), plan(version({}), { maxWidth: 1280, maxHeight: 720 })]
      .map((p) => p.ok && `${p.width}x${p.height}`), ["1920x1080", "1280x720"]);
  const vc1 = plan(version({ codec: "vc1", bitDepth: 8, scanType: "interlaced", colorPrimaries: undefined,
    colorTrc: undefined, colorSpace: undefined, colorRange: undefined }, { width: 720, height: 480 }));
  check("VC-1 is decoded on the CPU, deinterlaced, its missing labels filled as NTSC's",
    vc1.ok && [vc1.gpuDecode, vc1.interlaced, vc1.color.fill],
    [false, true, "setparams=color_primaries=smpte170m:color_trc=smpte170m:colorspace=smpte170m:range=tv"]);
  const pal = plan(version({ codec: "mpeg2video", bitDepth: 8, frameRate: 25, colorPrimaries: undefined,
    colorTrc: undefined, colorSpace: undefined, colorRange: undefined }, { width: 720, height: 576 }));
  check("a PAL DVD's labels filled by names Jellyfin's ffmpeg 8 knows (no gamma28)", pal.ok && pal.color.fill,
    "setparams=color_primaries=bt470bg:color_trc=bt470bg:colorspace=bt470bg:range=tv");
  check("  and labelled on the output by the encoder's name for it",
    pal.ok && encodeArgs(pal, ["-i", "f.mkv"], 0, 60, "").join(" ").includes("-color_trc gamma28"), true);
  const vc1Args = vc1.ok ? encodeArgs(vc1, ["-i", "f.mkv"], 0, 60, "/dev/dri/renderD128").join(" ") : "";
  check("  and handed to the GPU after the CPU's filters", vc1Args.includes(
    "-vf setparams=color_primaries=smpte170m:color_trc=smpte170m:colorspace=smpte170m:range=tv," +
    "bwdif=mode=send_frame,scale=720:480,format=p010le,hwupload=extra_hw_frames=64,format=qsv"), true);

  const subs = (more: Record<string, unknown> = {}) => ({ ...version({ colorTrc: "smpte2084", colorPrimaries: "bt2020", colorSpace: "bt2020nc" }),
    ...more });
  const withSubs = (v: ReturnType<typeof version>) => ({ ...v, streams: [...v.streams,
    { id: 21, streamType: 3, index: 2, codec: "pgs", language: "English" },
    { id: 22, streamType: 3, index: 3, codec: "srt" },
    { id: 23, streamType: 3, codec: "pgs", key: "/library/streams/23" }] });
  const burned = plan(withSubs(subs()), { burn: 21, tonemapper: "opencl" });
  check("a PGS subtitle on HDR10, for an HEVC player, is burned into tone-mapped H.264",
    burned.ok && [burned.codec, burned.hdrTrc, burned.tonemap?.via, burned.burn?.sub.index], ["h264", null, "opencl", 2]);
  const burnArgs = burned.ok ? encodeArgs(burned, ["-i", "f.mkv"], 0, 60, "/dev/dri/renderD128") : [];
  const graph = burnArgs[burnArgs.indexOf("-filter_complex") + 1] ?? "";
  check("  the picture brought down from OpenCL, the subtitle fitted to the frame, overlaid, and back up to QSV", graph,
    "[0:0]scale_vaapi=w=1920:h=1080:format=p010,hwmap=derive_device=opencl:mode=read," +
    "tonemap_opencl=tonemap=reinhard:desat=0:peak=100:t=bt709:m=bt709:p=bt709:format=nv12,hwdownload,format=nv12[pic];" +
    "[0:2]scale=1920:1080:force_original_aspect_ratio=decrease[sub];" +
    "[pic][sub]overlay=x=(main_w-overlay_w)/2:y=(main_h-overlay_h)/2:eof_action=pass,hwupload=extra_hw_frames=64,format=qsv[v]");
  check("  mapped from the graph, with no -vf", [burnArgs.join(" ").includes("-map [v] -map 0:1"), burnArgs.includes("-vf")], [true, false]);
  check("  on a Blu-ray's canvas, given up front", burnArgs.join(" ").includes("-canvas_size 1920x1080 -i f.mkv"), true);
  const sdr = plan(withSubs(version({})), { burn: 21 });
  check("on SDR HEVC, for an HEVC player, H.264 too, from the GPU's scale",
    sdr.ok && [sdr.codec, sdr.tonemap, encodeArgs(sdr, ["-i", "f.mkv"], 0, 60, "/dev/dri/renderD128").join(" ")
      .includes("[0:0]scale_vaapi=w=1920:h=1080:format=nv12,hwdownload,format=nv12[pic]")], ["h264", null, true]);
  const dvd = plan(withSubs(version({ codec: "mpeg2video", bitDepth: 8, anamorphic: true, pixelAspectRatio: "32:27" },
    { width: 720, height: 480 })), { burn: 21, hardware: "software" });
  const dvdGraph = dvd.ok ? encodeArgs(dvd, ["-i", "f.mkv"], 0, 60, "").join(" ") : "";
  check("an anamorphic DVD's subtitle is stretched with its picture, on the CPU, on the canvas it comes with",
    [dvd.ok && dvd.burn?.stretch, dvdGraph.includes("[0:2]scale=854:480[sub]"), dvdGraph.includes(",format=yuv420p[v]"),
      dvdGraph.includes("-canvas_size")], [true, true, true, false]);
  check("a text subtitle burned in, with no text of it to draw from, is Plex's",
    why(plan(withSubs(version({})), { burn: 22 })), "a srt subtitle burned in, with no text of it to draw from");
  check("so is a picture subtitle in a file of its own, not found on the mount",
    why(plan(withSubs(version({})), { burn: 23 })), "a picture subtitle beside the film, not found on the mount");

  // NVIDIA's and VAAPI's chains (FFMPEG_HWACCEL=nvenc, vaapi): checked on a
  // real NVENC on 20 October, and VAAPI's are QSV's without the QSV.
  const nv = plan(version({}), { hardware: "nvenc", hevcOk: true });
  const nvArgs = nv.ok ? encodeArgs(nv, ["-i", "f.mkv"], 0, 60, "0").join(" ") : "";
  check("NVENC: decoded and scaled by CUDA, HEVC by its encoder at its middle preset", [
    nvArgs.includes("-init_hw_device cuda=cu:0 -filter_hw_device cu -hwaccel cuda -hwaccel_output_format cuda"),
    nvArgs.includes("-vf scale_cuda=w=1920:h=1080:format=p010"),
    nvArgs.includes("-c:v hevc_nvenc -preset p4 -tune hq -profile:v main10 -rc vbr"),
    nvArgs.includes("-forced-idr 1"),
  ], [true, true, true, true]);
  const nvHdr = plan(version({ colorTrc: "smpte2084" }), { hardware: "nvenc", hevcOk: false, preset: "fast" });
  check("  HDR for an H.264 player brought down and tone-mapped on the CPU, FFMPEG_PRESET=fast as p3",
    nvHdr.ok && [nvHdr.tonemap?.via, encodeArgs(nvHdr, ["-i", "f.mkv"], 0, 60, "0").join(" ").includes(
      "scale_cuda=w=1920:h=1080:format=p010,hwdownload,format=p010le,tonemapx=tonemap=reinhard"), nvHdr.preset],
    ["software", true, "p3"]);
  const va = plan(version({ codec: "vc1", bitDepth: 8, colorPrimaries: undefined, colorTrc: undefined, colorSpace: undefined,
    colorRange: undefined }, { width: 1920, height: 1080 }), { hardware: "vaapi", hevcOk: false, lowPower: true });
  const vaArgs = va.ok ? encodeArgs(va, ["-i", "f.mkv"], 0, 60, "/dev/dri/renderD128").join(" ") : "";
  check("VAAPI: what the GPU can't decode uploaded from the CPU, its low-power H.264 encoder, VBR", [
    vaArgs.includes("-init_hw_device vaapi=va:/dev/dri/renderD128 -filter_hw_device va"),
    vaArgs.includes(",format=nv12,hwupload,format=vaapi"),
    vaArgs.includes("-c:v h264_vaapi -low_power 1 -profile:v high -rc_mode VBR"),
    vaArgs.includes("-hwaccel "),
  ], [true, true, true, false]);

  // What a re-encode is made at (sourceMatchedKbps): on 18 October all of it
  // was 12 Mbps.
  const matched = (codec: string, kbps: number, width: number, height: number, more: Record<string, unknown> = {}) => {
    const p = plan(version({ codec, bitDepth: 8, bitrate: kbps }, { width, height }), { kbps: 12000, peakKbps: 20000, hevcOk: false, ...more });
    return p.ok ? [p.kbps, p.peakKbps] : p.why;
  };
  check("Steins;Gate's 3 Mbps HEVC at 1080p is H.264 at 4.8 Mbps, its peak as far above", matched("hevc", 3000, 1920, 1080), [4800, 8000]);
  check("Airplane II's 6.8 Mbps HEVC is H.264 at 10.9 Mbps, under the level's 12", matched("hevc", 6818, 1920, 1080), [10909, 18182]);
  check("  and HEVC at the 1080p floor for an HEVC player", matched("hevc", 3000, 1920, 1080, { hevcOk: true }), [4000, 6667]);
  check("Hell's Kitchen's 673 kbps 320×240 MPEG-4 at the floor for its size", matched("msmpeg4v3", 673, 320, 240), [1500, 2500]);
  check("a 4K 60 Mbps HEVC at 1080p at the level's 12 Mbps", matched("hevc", 60000, 3840, 2160), [12000, 20000]);
  check("and an MPEG-2 DVD at what an H.264 needs of its 6 Mbps", matched("mpeg2video", 6000, 720, 480), [3000, 5000]);
  const surround = plan(version({}), { audioChannels: 6 });
  check("EAC3 5.1 becomes AAC 5.1 at 448 kbps", surround.ok && [surround.audioOut, encodeArgs(surround,
    ["-i", "f.mkv"], 0, 60, "/dev/dri/renderD128").join(" ").includes("-c:a aac -ac 6 -b:a 448k")],
    [{ codec: "aac", channels: 6, kbps: 448 }, true]);
}

/** A playlist's entries once it lists `n`: an encode lists them as it goes. */
async function listed(variant: string, n: number) {
  for (let i = 0; ; i++) {
    const list = entries(await (await fetch(origin + variant)).text());
    if (list.length >= n || i >= 40) return list;
    await sleep(250);
  }
}

/**
 * The first of a run's segments that opens at or after `s` seconds into it.
 * An upstream ffmpeg counts the listed cuts from zero, not from the first
 * packet as Jellyfin's does, so it also cuts at x264's scene-change keyframes:
 * where a burned-in line appears, say. The run's segments are more, not fewer.
 */
function opening(list: Array<{ duration: number; uri: string }>, s: number) {
  let at = 0;
  for (const e of list) {
    if (at > s - 0.1) return e;
    at += e.duration;
  }
  return list[list.length - 1];
}

console.log("\n— a re-encode —");
{
  asked.length = 0;
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  const m = await master("3", ids[0]);
  const notes = notesOf(m.text);
  check("HEVC for a player nobody said decodes it is re-encoded by ffmpeg, saying why, and on what",
    [notes.engine, notes.video, notes.reason, notes.encoder],
    ["ffmpeg", "transcode", "HEVC, and this player can't decode it", "CPU (x264), CPU decode"]);
  check("  at what H.264 needs for its 2 Mbps HEVC", notes.kbps, "3200");
  check("  and Plex was never asked to transcode", transcodeAsked(), []);
  // Four segments of 2.97 to 3.01 s: just under 12 by their durations.
  const firstList = entries(await (await fetch(origin + variantOf(m.text))).text());
  check("  its first playlist lists 12 s, not the next segment or two",
    firstList.reduce((s, e) => s + e.duration, 0) >= 11.5, true);
  const list = await listed(variantOf(m.text), 3);
  check("  in 3 s segments", list.slice(0, 3).map((e) => Math.round(e.duration * 10) / 10), [3, 3, 3]);
  const m4 = await master("4", ids[1]);
  check("a 4K file is re-encoded at 1080p", [notesOf(m4.text).engine, /RESOLUTION=1920x1080/.test(m4.text)], ["ffmpeg", true]);
  // Both of the CPU's encode slots, which the seek below needs one of.
  for (const id of ids) await fetch(`${origin}/api/plex/hls/session/${id}?reason=test`, { method: "DELETE" });
}
{
  const m = await master("3", crypto.randomUUID(), "?offset=31");
  const list = await listed(variantOf(m.text), 2);
  const starts: number[] = [];
  for (const e of list.slice(0, 2)) {
    starts.push(Math.round(videoSpan(Buffer.from(await (await fetch(origin + e.uri)).arrayBuffer()))!.start * 10) / 10);
  }
  check("a seek's re-encode opens where it was asked (41 on the clock), its keyframes 3 s on", starts, [41, 44]);
}
{
  process.env.FFMPEG_MAX_ENCODES = "1";
  // The runs above reach the film's end first: an ended run holds no slot.
  await sleep(4000);
  const keep = crypto.randomUUID();
  const first = await master("3", keep);
  asked.length = 0;
  plexStarts = true;
  const onPlex = crypto.randomUUID();
  const second = await master("4", onPlex);
  plexStarts = false;
  await fetch(`${origin}/api/plex/hls/session/${onPlex}?reason=test`, { method: "DELETE" });
  check("with FFMPEG_MAX_ENCODES taken, the next re-encode goes to Plex",
    [notesOf(first.text).engine, transcodeAsked().includes("/video/:/transcode/universal/decision")], ["ffmpeg", true]);
  check("  and nothing of the engine's is handed out for it", second.text.includes("com.pdt.engine"), false);
  check("  Stats for nerds is told why", notesOf(second.text).fallback, "encode slots full (1/1)");
  delete process.env.FFMPEG_MAX_ENCODES;
  await fetch(`${origin}/api/plex/hls/session/${keep}?reason=test`, { method: "DELETE" });
}

console.log("\n— what a run started mid-film skipped, made once it reaches the end —");
{
  // Hot Fuzz on 21 October: resumed 30 minutes in, a seek back started ffmpeg again.
  const engine: { ffmpegBeforeState?: (id: string) => string } = await import("../src/services/ffmpeg/engine.js");
  delete process.env.FFMPEG_LOOKAHEAD;
  for (const [rk, what] of [["1", "a copy"], ["3", "a re-encode"]] as const) {
    const id = crypto.randomUUID();
    const started = variantOf((await master(rk, id, "?offset=31")).text);
    let now = "";
    for (let i = 0; i < 120 && !now.includes("#EXT-X-ENDLIST"); i++) {
      await sleep(250);
      now = await (await fetch(origin + started)).text();
    }
    // A re-encode's waits for an encode slot, looked for every 15 s.
    let state = engine.ffmpegBeforeState?.(id) ?? "none";
    for (let i = 0; i < 160 && (state === "none" || state === "making"); i++) {
      await sleep(250);
      state = engine.ffmpegBeforeState?.(id) ?? "none";
    }
    check(`${what} from 31 s, once at the end of the film, makes the film before it`, state, "made");
    const m = await master(rk, id, "?offset=5");
    const variant = variantOf(m.text);
    const playlist = await (await fetch(origin + variant)).text();
    check("  a seek back to 5 s is served from that: a key of its own, listed whole and ended, no gap",
      [!!keyOf(variant) && keyOf(variant) !== keyOf(started), playlist.includes("#EXT-X-GAP"), playlist.includes("#EXT-X-ENDLIST"),
        playlist.includes("#EXT-X-START:TIME-OFFSET=5.000,PRECISE=YES")], [true, false, true, true]);
    check("  every segment a length above zero", playlist.includes("#EXTINF:-") || playlist.includes("#EXTINF:0.000,"), false);
    const list = entries(playlist);
    const made = list.filter((e) => /\/base\/b\d+\.ts/.test(decodeURIComponent(e.uri))).length;
    check("  what was made before, then the run's own",
      made > 0 && made < list.length && list.every((e, i) => /\/base\/b\d+\.ts/.test(decodeURIComponent(e.uri)) === i < made), true);
    if (made > 0 && made < list.length) {
      const span = async (uri: string) => videoSpan(Buffer.from(await (await fetch(origin + uri)).arrayBuffer()))!;
      const [first, seamA, seamB] = [await span(list[0].uri), await span(list[made - 1].uri), await span(list[made].uri)];
      check("  from the start of the film (10 on the clock) to its end",
        [Math.abs(first.start - 10) < 0.1, Math.abs(list.reduce((s, e) => s + e.duration, 0) - 60) < 0.2], [true, true]);
      // A copy cut by its decode order may hold a frame or two of the run's first.
      const over = Math.round((seamA.end - seamB.start) * 1000) / 1000;
      check("  meeting where the run started: no hole, nothing twice but a frame or two",
        [Math.round(seamB.start * 10) / 10, over >= -0.01 && over <= 0.15 ? "meets" : over], [rk === "1" ? 40 : 41, "meets"]);
    }
    const old = await fetch(`${origin}/api/plex/hls/seg?p=${encodeURIComponent(`/video/:/transcode/universal/session/${keyOf(started)}/base/index.m3u8`)}`);
    check("  the key it was under is gone (410)", old.status, 410);
    await fetch(`${origin}/api/plex/hls/session/${id}?reason=test`, { method: "DELETE" });
  }

  // 1917 and Hot Fuzz on 22 October: a seek to before where the stream began
  // asks for a new session (Player.tsx), and the one made whole went unused.
  // The player stops its old session first when nobody else is on it.
  for (const [rk, what, stopFirst] of [["1", "a copy", false], ["3", "a re-encode", false], ["1", "a copy", true]] as const) {
    const was = crypto.randomUUID();
    const started = variantOf((await master(rk, was, "?offset=31")).text);
    let state = engine.ffmpegBeforeState?.(was) ?? "none";
    for (let i = 0; i < 240 && state !== "made" && !state.startsWith("failed"); i++) {
      await sleep(250);
      state = engine.ffmpegBeforeState?.(was) ?? "none";
    }
    if (stopFirst) await fetch(`${origin}/api/plex/hls/session/${was}?reason=test`, { method: "DELETE" });
    plexRoutes.replaceStreamsForTests?.(() => [was]);
    const id = crypto.randomUUID();
    const variant = variantOf((await master(rk, id, "?offset=5")).text);
    plexRoutes.replaceStreamsForTests?.(() => []);
    const playlist = await (await fetch(origin + variant)).text();
    const made = entries(playlist).filter((e) => /\/base\/b\d+\.ts/.test(decodeURIComponent(e.uri))).length;
    check(`${what}${stopFirst ? ", its old session stopped first," : ""} sought back to 5 s under a new session: served from what the old one made`,
      [!!keyOf(variant) && keyOf(variant) !== keyOf(started), playlist.includes("#EXT-X-GAP"), playlist.includes("#EXT-X-ENDLIST"),
        playlist.includes("#EXT-X-START:TIME-OFFSET=5.000,PRECISE=YES"), made > 0, engine.ffmpegBeforeState?.(id)],
      [true, false, true, true, true, "made"]);
    if (!stopFirst) {
      await fetch(`${origin}/api/plex/hls/session/${was}?reason=test`, { method: "DELETE" });
      check("  the old session's stop, after, leaves it be", (await fetch(origin + variant)).status, 200);
    }
    const old = await fetch(`${origin}/api/plex/hls/seg?p=${encodeURIComponent(`/video/:/transcode/universal/session/${keyOf(started)}/base/index.m3u8`)}`);
    check("  the old key is gone (410)", old.status, 410);
    await fetch(`${origin}/api/plex/hls/session/${id}?reason=test`, { method: "DELETE" });
  }
  process.env.FFMPEG_LOOKAHEAD = "36";
}

console.log("\n— what is still Plex's —");
for (const [rk, why, said] of [
  ["7", "Dolby Vision profile 5 without OpenCL", "Dolby Vision P5 needs OpenCL tone mapping"],
  ["6", "a file ffmpeg can't read", null],
  ["11", "a file whose tracks aren't what Plex has", "tracks differ from Plex's: stream #1 is aac in the file, ac3 to Plex"],
  ["12", "a file whose size isn't what Plex last read", "the file on disk isn't the one Plex last read"],
] as const) {
  asked.length = 0;
  plexStarts = true;
  const id = crypto.randomUUID();
  const m = await master(rk, id);
  plexStarts = false;
  check(`${why} goes to Plex`, transcodeAsked().includes("/video/:/transcode/universal/decision"), true);
  check(`  and nothing of the engine's is handed out for it`, m.text.includes("com.pdt.engine"), false);
  if (said) check("  Stats for nerds is told why", notesOf(m.text).fallback, said);
  await fetch(`${origin}/api/plex/hls/session/${id}?reason=test`, { method: "DELETE" });
}
{
  process.env.FFMPEG_FALLBACK_TO_PLEX = "off";
  asked.length = 0;
  const m = await master("12", crypto.randomUUID());
  check("with FFMPEG_FALLBACK_TO_PLEX=off it fails to start instead, Plex never asked",
    [m.status, transcodeAsked().includes("/video/:/transcode/universal/decision")], [502, false]);
  delete process.env.FFMPEG_FALLBACK_TO_PLEX;
}
{
  asked.length = 0;
  plexStarts = true;
  const id = crypto.randomUUID();
  const m = await master("1", id, "?subtitles=burn&subtitleStreamID=22");
  plexStarts = false;
  check("a text subtitle burned in whose text can't be had goes to Plex, saying so",
    [transcodeAsked().includes("/video/:/transcode/universal/decision"), notesOf(m.text).fallback],
    [true, "the subtitle's text isn't read out yet"]);
  await fetch(`${origin}/api/plex/hls/session/${id}?reason=test`, { method: "DELETE" });
  // Its text is read out meanwhile, for the next start: through Plex here,
  // which the fake refuses. Done before what follows counts Plex's requests.
  const { embeddedSubtitleState } = await import("../src/services/embedded-subtitles.js");
  for (let i = 0; i < 40 && embeddedSubtitleState("22")?.state !== "unreadable"; i++) await sleep(250);
  check("  and its text is read out meanwhile, for the next start", embeddedSubtitleState("22")?.state, "unreadable");
  asked.length = 0;
  process.env.PLAYBACK_ENGINE = "plex";
  await master("1", crypto.randomUUID());
  check("and with PLAYBACK_ENGINE=plex, everything does", transcodeAsked().includes("/video/:/transcode/universal/decision"), true);
  process.env.PLAYBACK_ENGINE = "ffmpeg";
}

console.log("\n— a PGS subtitle burned in —");
/** How bright the picture is where the box goes, 0–255, at the first frame of a segment. */
async function brightness(uri: string) {
  const file = path.join(tmp, `seg-${crypto.randomUUID()}.ts`);
  fs.writeFileSync(file, Buffer.from(await (await fetch(origin + uri)).arrayBuffer()));
  const [x, y, w, h] = BOX;
  const r = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-i", file, "-frames:v", "1",
    "-vf", `crop=${w - 40}:${h - 16}:${x + 20}:${y + 8},format=gray`, "-f", "rawvideo", "pipe:1"]);
  const px = r.stdout as Buffer;
  return px.length ? Math.round(px.reduce((a, b) => a + b, 0) / px.length) : -1;
}
{
  asked.length = 0;
  const id = crypto.randomUUID();
  const m = await master("9", id, "?subtitles=burn&subtitleStreamID=21");
  const notes = notesOf(m.text);
  check("is re-encoded by ffmpeg, saying why", [notes.engine, notes.video, notes.reason],
    // Asked for only when the player couldn't draw it.
    ["ffmpeg", "transcode", "Subtitle burn-in (PGS couldn't be drawn)"]);
  check("  and Plex was never asked to transcode", transcodeAsked(), []);
  const list = await listed(variantOf(m.text), 5);
  const shown = await brightness(opening(list, 3).uri);
  const gone = await brightness(opening(list, 6).uri);
  check(`  the box is in the picture while it is shown (3 s: ${shown}), and gone once it isn't (6 s: ${gone})`,
    [shown > 200, gone >= 0 && gone < 200], [true, true]);
  await fetch(`${origin}/api/plex/hls/session/${id}?reason=test`, { method: "DELETE" });
}
{
  const id = crypto.randomUUID();
  const m = await master("9", id, "?subtitles=burn&subtitleStreamID=21&offset=31");
  const list = await listed(variantOf(m.text), 2);
  const before = await brightness(list[0].uri);
  const after = await brightness(list[1].uri);
  check(`  after a seek to 31 s, on time: not yet at 31 s (${before}), there at 34 s (${after})`,
    [before >= 0 && before < 200, after > 200], [true, true]);
  await fetch(`${origin}/api/plex/hls/session/${id}?reason=test`, { method: "DELETE" });
}

console.log("\n— a PGS subtitle the player draws —");
/** When each display set in a .sup starts, in seconds. */
function supTimes(buf: Buffer): number[] {
  const out: number[] = [];
  for (let at = 0; at + 13 <= buf.length; at += 13 + buf.readUInt16BE(at + 11)) {
    if (buf.toString("latin1", at, at + 2) !== "PG") return [-1];
    if (buf[at + 10] === 0x16) out.push(Math.round(buf.readUInt32BE(at + 2) / 90) / 1000);
  }
  return out;
}
{
  const meta = await (await fetch(`${origin}/api/plex/meta/9`)).json() as
    { versions?: Array<{ subtitleTracks: Array<{ id: number; external?: boolean; picture?: boolean }> }> };
  const t = meta.versions?.[0].subtitleTracks.find((s) => s.id === 21);
  check("a PGS track is one the player draws, as pictures", [t?.external, t?.picture], [true, true]);
  check("  and isn't read as text", (await fetch(`${origin}/api/plex/subtitles/21?ratingKey=9&mediaIndex=0`)).status, 404);
  type Status = { pieces: Array<{ id: number; fromS: number; bytes: number; done: boolean }>; done: boolean; failed: string | null };
  let status: Status | null = null;
  for (let i = 0; i < 80 && !status?.done && !status?.failed; i++) {
    status = await (await fetch(`${origin}/api/plex/pgs/21?ratingKey=9&mediaIndex=0&at=3`)).json() as Status;
    if (!status.done) await sleep(250);
  }
  check("  cut out of the film whole, from the start for a player near it, then handed out as made",
    [status?.done, status?.failed, status?.pieces.map((p) => [p.id, p.fromS]), typeof status?.v], [true, null, [[1000, 0]], "string"]);
  const whole = Buffer.from(await (await fetch(`${origin}/api/plex/pgs/21/1000?ratingKey=9&mediaIndex=0&from=0`)).arrayBuffer());
  check("  every line on the film's clock", supTimes(whole), [0.5, 5, 32, 40]);
  const cutPiece = Buffer.from(await (await fetch(`${origin}/api/plex/pgs/21/0?ratingKey=9&mediaIndex=0&from=0`)).arrayBuffer());
  check("  the cut's own piece still there for a player part way through it", cutPiece.equals(whole), true);
  const rest = Buffer.from(await (await fetch(`${origin}/api/plex/pgs/21/0?ratingKey=9&mediaIndex=0&from=100`)).arrayBuffer());
  check("  and read on from where a player left off", [rest.length, rest.equals(whole.subarray(100))], [whole.length - 100, true]);
  check("  kept, for the next to ask", fs.readdirSync(path.join(tmp, "subtitles-pgs")).filter((n) => n.endsWith(".sup")).length, 1);
  const { forgetPgs, pgsArgs, pgsPieceBytesForTests, joinPgsPiecesForTests } = await import("../src/services/ffmpeg/picture-subtitles.js");
  forgetPgs();
  const again = await (await fetch(`${origin}/api/plex/pgs/21?ratingKey=9&mediaIndex=0&at=40`)).json() as Status;
  check("  which is the kept one, at once", [again.done, again.pieces.map((p) => p.bytes)], [true, [whole.length]]);
  const kept = await fetch(`${origin}/api/plex/pgs/21/1000?ratingKey=9&mediaIndex=0&from=0&v=${encodeURIComponent(again.v!)}`,
    { headers: { "accept-encoding": "gzip" } });
  const keptBytes = Buffer.from(await kept.arrayBuffer());
  check("  asked for by its v, kept by the browser, and gzipped",
    [kept.headers.get("cache-control"), whole.length <= 1024 || kept.headers.get("content-encoding") === "gzip", keptBytes.equals(whole)],
    ["private, max-age=2592000, immutable", true, true]);
  check("  not without it", (await fetch(`${origin}/api/plex/pgs/21/1000?ratingKey=9&mediaIndex=0&from=0`)).headers.get("cache-control"),
    "no-store");
  // In pieces small enough that each line starts one.
  pgsPieceBytesForTests(1);
  forgetPgs();
  const parts = await (await fetch(`${origin}/api/plex/pgs/21?ratingKey=9&mediaIndex=0&at=33`)).json() as
    Status & { pieces: Array<{ toS: number | null }> };
  // Its lines go up at 0.5 and 32 s, each cleared after (5, 40 s): a piece each, with its clear.
  check("  a made one in pieces, each from a line drawn afresh to the next",
    parts.pieces.map((p) => [p.id, p.fromS, p.toS]), [[1000, 0, 32], [1001, 32, null]]);
  const each = await Promise.all(parts.pieces.map(async (p) =>
    Buffer.from(await (await fetch(`${origin}/api/plex/pgs/21/${p.id}?ratingKey=9&mediaIndex=0&from=0`)).arrayBuffer())));
  check("  the pieces are the file, a line each", [Buffer.concat(each).equals(whole), each.map(supTimes)],
    [true, [[0.5, 5], [32, 40]]]);
  pgsPieceBytesForTests(1024 * 1024);
  forgetPgs();
  // Pieces from a place: the rest of the film from it, and the start up to past it.
  const cut = (fromS: number, toS: number | null) => {
    const out = path.join(tmp, `piece-${fromS}-${toS}.sup`);
    const r = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", pgsArgs(["-i", PGS_FILM], 2, fromS, toS, out));
    return r.status === 0 ? supTimes(fs.readFileSync(out)) : [String(r.stderr).trim()];
  };
  check("  a piece from 30 s has what is after it, on the film's clock", cut(30, null), [32, 40]);
  check("  one from the start to 35 s, what is before", cut(0, 35), [0.5, 5, 32]);
  check("  the two made one, each line once, in order",
    supTimes(joinPgsPiecesForTests(fs.readFileSync(path.join(tmp, "piece-30-null.sup")), fs.readFileSync(path.join(tmp, "piece-0-35.sup")))),
    [0.5, 5, 32, 40]);
  {
    // A page looked at has its picture subtitle cut ahead, nobody playing it.
    for (const n of fs.readdirSync(path.join(tmp, "subtitles-pgs"))) fs.rmSync(path.join(tmp, "subtitles-pgs", n), { recursive: true, force: true });
    forgetPgs();
    process.env.SUBTITLE_PREFETCH = "1";
    await fetch(`${origin}/api/plex/subtitles/prefetch`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ratingKey: "9", mediaIndex: 0, first: 21, scope: "first" }),
    });
    process.env.SUBTITLE_PREFETCH = "0";
    let made = 0;
    for (let i = 0; i < 80 && made === 0; i++) {
      made = fs.readdirSync(path.join(tmp, "subtitles-pgs")).filter((n) => n.endsWith(".sup")).length;
      if (made === 0) await sleep(250);
    }
    check("a picture subtitle a page would start with is cut ahead, kept for when it plays", made, 1);
  }
  check("a PGS file beside the film is the file it is", await (async () => {
    asked.length = 0;
    let s: Status | null = null;
    for (let i = 0; i < 40 && !s?.done && !s?.failed; i++) {
      s = await (await fetch(`${origin}/api/plex/pgs/51?ratingKey=14&mediaIndex=0&at=0`)).json() as Status;
      if (!s.done) await sleep(100);
    }
    const bytes = Buffer.from(await (await fetch(`${origin}/api/plex/pgs/51/1000?ratingKey=14&mediaIndex=0&from=0`)).arrayBuffer());
    return [s?.done, bytes.equals(fs.readFileSync(SUP)), asked.includes("/library/streams/51")];
  })(), [true, true, false]);
  check("a text subtitle has no pictures to cut", (await fetch(`${origin}/api/plex/pgs/22?ratingKey=1&mediaIndex=0`)).status, 404);
}

console.log("\n— a text subtitle burned in, and one beside the film —");
/** The brightest pixel where a subtitle is drawn, 0–255, at a segment's first frame. */
async function brightest(uri: string, crop = "400:90:120:260") {
  const file = path.join(tmp, `seg-${crypto.randomUUID()}.ts`);
  fs.writeFileSync(file, Buffer.from(await (await fetch(origin + uri)).arrayBuffer()));
  const r = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-i", file, "-frames:v", "1",
    "-vf", `crop=${crop},format=gray`, "-f", "rawvideo", "pipe:1"]);
  const px = r.stdout as Buffer;
  return px.length ? px.reduce((a, b) => Math.max(a, b), 0) : -1;
}
{
  // Read out by ffmpeg first, as the player would have.
  for (let i = 0; i < 40; i++) {
    const a = await (await fetch(`${origin}/api/plex/subtitles/41?ratingKey=13&mediaIndex=0`)).json() as { complete?: boolean };
    if (a.complete) break;
    await sleep(250);
  }
  asked.length = 0;
  const id = crypto.randomUUID();
  const m = await master("13", id, "?subtitles=burn&subtitleStreamID=41");
  check("an SRT whose text was read is burned in by ffmpeg, not Plex",
    [notesOf(m.text).engine, notesOf(m.text).video, transcodeAsked()], ["ffmpeg", "transcode", []]);
  const list = await listed(variantOf(m.text), 5);
  // "Hello there" is up from 2 to 4.5 s: on at 3, off at 6.
  const on = await brightest(opening(list, 3).uri);
  const off = await brightest(opening(list, 6).uri);
  check(`  its line is in the picture while it is up (3 s: ${on}), and gone after (6 s: ${off})`, [on > 180, off >= 0 && off < 60], [true, true]);
  await fetch(`${origin}/api/plex/hls/session/${id}?reason=test`, { method: "DELETE" });
  const seek = crypto.randomUUID();
  const later = await master("13", seek, "?subtitles=burn&subtitleStreamID=41&offset=38");
  const after = await listed(variantOf(later.text), 2);
  // "Halfway", 40 to 42 s.
  const before = await brightest(after[0].uri);
  const there = await brightest(after[1].uri);
  check(`  after a seek to 38 s, on time: not at 38 s (${before}), there at 41 s (${there})`, [before >= 0 && before < 60, there > 180], [true, true]);
  await fetch(`${origin}/api/plex/hls/session/${seek}?reason=test`, { method: "DELETE" });
}
{
  // The ASS, never read: its text comes out of the mkv's index, the first time.
  asked.length = 0;
  const second = crypto.randomUUID();
  const again = await master("13", second, "?subtitles=burn&subtitleStreamID=42");
  check("an ASS never read is burned in by ffmpeg from the mkv's index, Plex never asked",
    [notesOf(again.text).engine, transcodeAsked()], ["ffmpeg", []]);
  const list = await listed(variantOf(again.text), 2);
  // "Konnichiwa", 3 to 5 s.
  const on = await brightest(list[1].uri);
  check(`  drawn by libass (3 s: ${on})`, on > 180, true);
  await fetch(`${origin}/api/plex/hls/session/${second}?reason=test`, { method: "DELETE" });
}
{
  asked.length = 0;
  const id = crypto.randomUUID();
  const m = await master("14", id, "?subtitles=burn&subtitleStreamID=51");
  check("a PGS beside the film is found on the mount and burned in by ffmpeg",
    [notesOf(m.text).engine, transcodeAsked()], ["ffmpeg", []]);
  const list = await listed(variantOf(m.text), 5);
  const shown = await brightness(opening(list, 3).uri);
  const gone = await brightness(opening(list, 6).uri);
  check(`  the box shown at 3 s (${shown}), gone at 6 s (${gone})`, [shown > 200, gone >= 0 && gone < 200], [true, true]);
  await fetch(`${origin}/api/plex/hls/session/${id}?reason=test`, { method: "DELETE" });
  const seek = crypto.randomUUID();
  const later = await master("14", seek, "?subtitles=burn&subtitleStreamID=51&offset=31");
  const after = await listed(variantOf(later.text), 2);
  const before = await brightness(after[0].uri);
  const there = await brightness(after[1].uri);
  check(`  on the film's clock after a seek: not at 31 s (${before}), there at 34 s (${there})`,
    [before >= 0 && before < 200, there > 200], [true, true]);
  await fetch(`${origin}/api/plex/hls/session/${seek}?reason=test`, { method: "DELETE" });
}
{
  asked.length = 0;
  const a = await (await fetch(`${origin}/api/plex/subtitles/52?ratingKey=14&mediaIndex=0`)).json() as
    { cues?: Array<{ start: number; text: string }> };
  check("an SRT beside the film is read off the mount, its French neighbour not taken for it",
    [a.cues?.map((c) => [c.start, c.text]), asked.includes("/library/streams/52")], [[[2, "Hello there"], [40, "Halfway"]], false]);
}
{
  // An ASS track's fonts come out of the film under names of their own.
  const { prepareBurn } = await import("../src/services/ffmpeg/burn-files.js");
  const { probe } = await import("../src/services/ffmpeg/probe.js");
  const font = path.join(tmp, "Fake Sans.ttf");
  fs.writeFileSync(font, Buffer.from("not really a font"));
  const withFont = path.join(tmp, "with-font.mkv");
  spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", TEXT_FILM, "-map", "0", "-c", "copy",
    "-attach", font, "-metadata:s:t", "mimetype=font/ttf", "-metadata:s:t", "filename=../../escaped.ttf", withFont]);
  const input = ["-protocol_whitelist", "file", "-i", withFont];
  const made = await prepareBurn("fonts-test", {
    sub: { id: 32, streamType: 3, index: 3, codec: "ass" }, kind: "text", film: withFont, input, probed: await probe(input),
    storedText: () => ASS, indexText: async () => null, sidecarBytes: async () => null, startOf: async () => null,
  });
  check("an ASS track's font comes out of the film beside its text, not where its name points",
    made.ok && [path.basename(made.file), made.fonts && fs.readdirSync(made.fonts), made.fonts &&
      fs.readFileSync(path.join(made.fonts, "0.ttf"), "utf8"), fs.existsSync(path.join(tmp, "..", "escaped.ttf"))],
    ["subtitle.ass", ["0.ttf"], "not really a font", false]);
}

console.log("\n— text subtitles read by ffmpeg, out of the file —");
{
  asked.length = 0;
  type Answer = { cues?: Array<{ start: number; end: number; text: string }>; complete?: boolean };
  const read = async (id: number) => {
    let a: Answer = {};
    for (let i = 0; i < 40 && !a.complete; i++) {
      if (i) await sleep(250);
      a = await (await fetch(`${origin}/api/plex/subtitles/${id}?ratingKey=10&mediaIndex=0`)).json() as Answer;
    }
    return a;
  };
  const srt = await read(31);
  check("an SRT track is read whole", [srt.complete, srt.cues?.map((c) => [c.start, c.end, c.text])],
    [true, [[2, 4.5, "Hello there"], [40, 42, "Halfway"]]]);
  const ass = await read(32);
  check("so is an ASS one", [ass.complete, ass.cues?.map((c) => [c.start, c.end, c.text])],
    [true, [[3, 5, "Konnichiwa"], [41, 43, "Mata ne"]]]);
  check("with nothing asked of Plex's subtitle reader, nor a track selected on the item",
    asked.filter((p) => p.startsWith("/subtitles") || /^\/library\/parts\/\d+$/.test(p)), []);
}
{
  const { prefetchEmbeddedSubtitles, embeddedSubtitleState } = await import("../src/services/embedded-subtitles.js");
  const said: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { said.push(a.join(" ")); log(...a); };
  const read = (id: number, index: number, codec: string) => ({
    streamId: String(id), ratingKey: "15", mediaIndex: 0, withTrackSelected: <T>(start: () => Promise<T>) => start(),
    fromFile: { file: TEXT_FILM, index, codec },
  });
  prefetchEmbeddedSubtitles([read(61, 2, "srt"), read(62, 3, "ass")]);
  for (let i = 0; i < 40 && !["61", "62"].every((id) => embeddedSubtitleState(id)?.state === "ready"); i++) await sleep(250);
  console.log = log;
  const cues = (id: string) => {
    const st = embeddedSubtitleState(id);
    return st?.state === "ready" ? st.cues.map((c) => c.text) : st?.state ?? null;
  };
  check("two of a film's subtitles read ahead are both read", [cues("61"), cues("62")],
    [["Hello there", "Halfway"], ["Konnichiwa", "Mata ne"]]);
  check("  in one pass of ffmpeg through the film",
    said.filter((l) => l.includes("ffmpeg is reading an embedded subtitle out of the file")).length, 1);
}

console.log("\n— stopping —");
{
  const variant = variantOf((await master("1", sid)).text);
  const first = entries(await (await fetch(origin + variant)).text())[0];
  asked.length = 0;
  const del = await fetch(`${origin}/api/plex/hls/session/${sid}?reason=test`, { method: "DELETE" });
  check("the stream stops without a word to Plex", [del.status, asked], [200, []]);
  check("its playlist is gone", (await fetch(origin + variant)).status, 410);
  check("and its segments", (await fetch(origin + first.uri)).status, 410);
  // Made whole, Before and all, it is kept 15 s for a new session of its driver's (takeOver).
  const filesLeft = () => fs.existsSync(path.join(tmp, "stream-cache", "ffmpeg", sid))
    ? fs.readdirSync(path.join(tmp, "stream-cache", "ffmpeg", sid)) : [];
  let left = filesLeft();
  for (let i = 0; i < 100 && left.length > 0; i++) {
    await sleep(250);
    left = filesLeft();
  }
  check("and so are its files, within 15 s", left, []);
  asked.length = 0;
  await fetch(`${origin}/api/plex/hls/session/${sid}?reason=again`, { method: "DELETE" });
  await fetch(`${origin}/api/plex/hls/ping/${sid}?time=5000`).catch(() => null);
  check("stopped again, or pinged, it is still nothing to tell Plex", asked, []);
}

console.log("\n— Plex's Now Playing —");
{
  const report = await import("../src/services/ffmpeg/plex-report.js");
  const A = crypto.randomUUID();
  const B = crypto.randomUUID();
  let now: Array<{ key: string; sessionId: string; ratingKey: string; positionS: number; state: "playing" | "paused" | "buffering" }> = [];
  report.reportFrom(() => now, plexRoutes.durationFor);
  const at = (ms: number, streams: typeof now) => { now = streams; return report.plexReportTick(1_000_000 + ms); };
  const stream = (sessionId: string, positionS: number, state: "playing" | "paused" | "buffering" = "playing") =>
    [{ key: "room:0:0:1", sessionId, ratingKey: "1", positionS, state }];
  timelines.length = 0;

  await at(0, stream(A, 12.5));
  check("a stream is reported at once", timelines.map((t) => t.q), [{
    ratingKey: "1", key: "/library/metadata/1", state: "playing", time: "12500", duration: "60000",
    identifier: "com.plexapp.plugins.library",
  }]);
  const h = timelines[0]?.h ?? {};
  check("on a player of its own, named for Plex",
    [h["x-plex-client-identifier"], h["x-plex-session-identifier"], h["x-plex-product"], h["x-plex-device-name"]],
    [`plex-discord-theater-${A}`, A, "Plex Discord Theater", "Discord Theater"]);
  await at(1_000, stream(A, 13.5));
  await at(9_000, stream(A, 21.5));
  check("then not again while it plays on as the clock says", timelines.length, 1);
  await at(10_000, stream(A, 22.5));
  check("until ten seconds have gone", timelines.map((t) => [t.q.state, t.q.time]).slice(1), [["playing", "22500"]]);
  await at(11_000, stream(B, 40));
  check("a seek, on its new session, at once and on the same player",
    timelines.slice(2).map((t) => [t.q.state, t.q.time, t.h["x-plex-client-identifier"]]),
    [["playing", "40000", `plex-discord-theater-${A}`]]);
  await at(12_000, stream(B, 41, "paused"));
  await at(13_000, stream(B, 41, "buffering"));
  check("a pause and a wait for somebody's picture, at once",
    timelines.slice(3).map((t) => [t.q.state, t.q.time]), [["paused", "41000"], ["buffering", "41000"]]);
  await at(14_000, []);
  await at(25_000, []);
  check("gone, not stopped yet: a seek's restart is back sooner", timelines.length, 5);
  await at(29_000, []);
  check("gone fifteen seconds, stopped where it was",
    timelines.slice(5).map((t) => [t.q.state, t.q.time, t.h["x-plex-client-identifier"]]),
    [["stopped", "41000", `plex-discord-theater-${A}`]]);

  timelines.length = 0;
  process.env.FFMPEG_REPORT_TO_PLEX = "0";
  await at(40_000, stream(crypto.randomUUID(), 5));
  await at(60_000, []);
  check("FFMPEG_REPORT_TO_PLEX=0 tells Plex nothing", timelines.length, 0);
  delete process.env.FFMPEG_REPORT_TO_PLEX;
}

console.log("\n— a render node that wasn't there at startup —");
{
  const { detectHardware, recheckHardware } = await import("../src/services/ffmpeg/config.js");
  // A stand-in for /dev/dri/renderD128: QSV won't encode on it, but that it
  // was looked for again is what this is about.
  const node = path.join(tmp, "renderD128");
  process.env.FFMPEG_HWACCEL_DEVICE = node;
  // Empty, as the compose files leave it: auto, which looks for the GPU.
  process.env.FFMPEG_HWACCEL = "";
  const first = await detectHardware();
  delete process.env.FFMPEG_HWACCEL;
  check("missing, the CPU, saying what /dev/dri has and that it looks again",
    [first.hardware, first.note.startsWith(`CPU (no ${node}; /dev/dri has: `), first.note.includes("looked for again")], ["software", true, true]);
  const said: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { said.push(a.join(" ")); };
  try {
    await recheckHardware();
    const stillMissing = said.length;
    fs.writeFileSync(node, "");
    await Promise.all([recheckHardware(), recheckHardware()]);
    const once = said.length;
    await recheckHardware();
    console.log = log;
    check("not looked at again while it's still missing", stillMissing, 0);
    check("once it's there, looked at again, once, however many re-encodes ask",
      [once, said[0]?.startsWith(`[Config] ${node} is here now; re-encodes on `)], [1, true]);
    check("  and not again after", said.length, 1);
  } finally {
    console.log = log;
    delete process.env.FFMPEG_HWACCEL_DEVICE;
  }
}

console.log("\n— what of the GPU a re-encode used, by the kernel's count —");
{
  const { parseFdinfo, gpuUse } = await import("../src/services/ffmpeg/gpu-use.js");
  const i915 = (videoNs: number, renderNs: number) => [
    "pos:\t0", "flags:\t02100002", "drm-driver:\ti915", "drm-client-id:\t18", "drm-pdev:\t0000:00:02.0",
    `drm-engine-render:\t${renderNs} ns`, "drm-engine-copy:\t0 ns", `drm-engine-video:\t${videoNs} ns`,
    "drm-engine-capacity-video:\t2", "drm-engine-video-enhance:\t0 ns",
  ].join("\n");
  const xe = (vcs: number, total: number) => [
    "drm-driver:\txe", "drm-client-id:\t42", "drm-cycles-rcs:\t0", `drm-total-cycles-rcs:\t${total}`,
    `drm-cycles-vcs:\t${vcs}`, `drm-total-cycles-vcs:\t${total}`, "drm-engine-capacity-vcs:\t2",
  ].join("\n");
  const sample = (at: number, text: string) => {
    const f = parseFdinfo(text)!;
    return { at, cpuS: null, readBytes: null, devices: ["/dev/dri/renderD128"], driver: f.driver, engines: f.engines };
  };
  check("i915: busy ns over the time between, by the engines there are of it",
    gpuUse(sample(0, i915(0, 0)), sample(10_000, i915(9e9, 1e9))),
    "video 45%, render 10%, copy 0%, video-enhance 0% over 10 s (i915, /dev/dri/renderD128)");
  check("xe: busy cycles over the GPU's cycles meanwhile, by its class names as i915's",
    gpuUse(sample(0, xe(0, 1000)), sample(5_000, xe(1600, 2000))), "video 80%, render 0% over 5 s (xe, /dev/dri/renderD128)");
  check("a file that isn't a DRM client is no count", parseFdinfo("pos:\t0\nflags:\t02\n"), null);
  check("nothing of the GPU open: the CPU did it",
    gpuUse(null, { at: 1, cpuS: null, readBytes: null, devices: [], driver: null, engines: {} }), "none: ffmpeg had no GPU open, so the CPU did the work");
}

// Last, since rooms start the reporter's own timer, every second on the real
// clock: the Now Playing checks above keep a clock of their own, and the
// render node's count what is logged.
console.log("\n— what the upload budget is told of each stream (qbt-manager snapshot) —");
{
  const { attachWebSocketServer, closeWebSocketServer, getQbtManagerStreams } = await import("../src/services/sync.js");
  const { createSession } = await import("../src/middleware/auth.js");
  const { instanceHosts } = await import("../src/routes/discord.js");
  const { default: qbtRoutes } = await import("../src/routes/qbt-manager.js");
  const { WebSocket } = await import("ws");
  type Stream = Record<string, unknown>;
  process.env.QBT_MANAGER_API_KEY = "qbt-test-key";
  // Nothing reported until a check below says so.
  process.env.FFMPEG_REPORT_TO_PLEX = "0";
  app.use("/api/integrations/qbt-manager", qbtRoutes);
  attachWebSocketServer(api);
  const sockets: InstanceType<typeof WebSocket>[] = [];

  /** A room with its host in it, who plays what it is told to. */
  async function room() {
    const id = `qbt-${crypto.randomUUID()}`;
    const userId = `${id}-host`;
    instanceHosts.set(id, { hostUserId: userId, guildId: null, channelId: null, createdAt: Date.now() });
    const token = createSession(userId, null);
    const ws = new WebSocket(`${origin.replace(/^http/, "ws")}/ws?token=${token}`);
    sockets.push(ws);
    const seen: Stream[] = [];
    ws.on("message", (d) => seen.push(JSON.parse(String(d))));
    await new Promise<void>((r, j) => { ws.once("open", () => r()); ws.once("error", j); });
    ws.send(JSON.stringify({ type: "join", sessionToken: token, instanceId: id, userId, username: "host" }));
    for (let i = 0; i < 80 && !seen.some((m) => m.type === "state"); i++) await sleep(25);
    return {
      play: (ratingKey: string, hlsSessionId: string, positionS: number, offsetS = positionS) => ws.send(JSON.stringify({
        type: "play", ratingKey, title: `Film ${ratingKey}`, subtitles: false, hlsSessionId,
        position: positionS, sessionOffset: offsetS, audioStreamId: 0, subtitleStreamId: 0,
      })),
      /** Its player's stop of a session, as the host's: nobody else's is heeded while the host watches it. */
      stop: (hlsSessionId: string) => fetch(`${origin}/api/plex/hls/session/${hlsSessionId}?reason=test`, {
        method: "DELETE", headers: { Authorization: `Bearer ${token}` },
      }),
    };
  }
  /** The room's stream on `sid` once `ready` says so, as the manager is sent it. */
  async function streamOn(sid: string, ready: (s: Stream) => boolean = () => true): Promise<Stream | undefined> {
    for (let i = 0; i < 80; i++) {
      const s = getQbtManagerStreams().find((x) => x.hls_session_id === sid) as Stream | undefined;
      if (s && ready(s)) break;
      await sleep(50);
    }
    const res = await fetch(`${origin}/api/integrations/qbt-manager/state`, { headers: { Authorization: "Bearer qbt-test-key" } });
    return ((await res.json()) as { streams: Stream[] }).streams.find((x) => x.hls_session_id === sid);
  }
  /** A run's playlist once it has `edgeS` listed, or has ended. */
  async function madeTo(variant: string, edgeS: number) {
    let text = "";
    for (let i = 0; i < 80; i++) {
      text = await (await fetch(origin + variant)).text();
      if (text.includes("#EXT-X-ENDLIST") || entries(text).reduce((s, e) => s + e.duration, 0) >= edgeS) break;
      await sleep(100);
    }
    return text;
  }

  // A copy from the start, made to 32 s or more ahead of a room at 0 s.
  const a = await room();
  const A = crypto.randomUUID();
  const copy = await master("1", A);
  await madeTo(variantOf(copy.text), 32);
  a.play("1", A, 0);
  const measured = await streamOn(A);
  check("a copy, however much of it is made, is given one figure: the file's average, and said to be ffmpeg's",
    [measured?.engine, measured?.bandwidth_source, measured?.bandwidth_kbps], ["ffmpeg", "target", Number(notesOf(copy.text).kbps)]);
  check("  with FFMPEG_REPORT_TO_PLEX=0, no player in Plex for it", measured?.plex_client_id, null);

  timelines.length = 0;
  delete process.env.FFMPEG_REPORT_TO_PLEX;
  const reportedAs = () => timelines.find((t) => t.q.ratingKey === "1")?.h["x-plex-client-identifier"];
  for (let i = 0; i < 60 && !reportedAs(); i++) await sleep(50);
  const reported = await streamOn(A, (s) => s.plex_client_id !== null);
  check("reported to Plex, the player it is reported as: Plex's row of it",
    [reported?.plex_client_id, reportedAs()], [`plex-discord-theater-${A}`, `plex-discord-theater-${A}`]);

  // A seek by a host alone on its variant: its player stops the session before
  // it asks for the next, and the room is on the stopped one until it hears of
  // that, while Plex still lists the reporter's row.
  await a.stop(A);
  const between = await streamOn(A);
  check("  between a seek's stop and its new session: still ffmpeg's, on that player, with no bandwidth to give",
    [between?.engine, between?.plex_client_id, !!between && "bandwidth_kbps" in between, !!between && "bandwidth_source" in between],
    ["ffmpeg", `plex-discord-theater-${A}`, false, false]);

  // The new session on the same variant, which Plex goes on knowing by the first.
  const B = crypto.randomUUID();
  await master("1", B, "?offset=20");
  a.play("1", B, 20);
  const sought = await streamOn(B);
  check("  and after a seek, on its new session, still the first session's",
    [sought?.engine, sought?.plex_client_id], ["ffmpeg", `plex-discord-theater-${A}`]);

  // Reported already, and then not: the reporter still holds the stream, but tells Plex nothing.
  process.env.FFMPEG_REPORT_TO_PLEX = "0";
  const unreported = await streamOn(B);
  check("  FFMPEG_REPORT_TO_PLEX=0 set after it was reported: no player in Plex for it any more",
    [unreported?.engine, unreported?.plex_client_id], ["ffmpeg", null]);
  // Stopped, with no player in Plex for it — reporting off, as once the
  // reporter has let it go — it is nothing of ffmpeg's to the manager.
  await a.stop(B);
  const gone = await streamOn(B);
  check("  stopped, with no player in Plex for it: none of it, as a stream of Plex's",
    [!!gone, ["engine", "plex_client_id", "bandwidth_kbps", "bandwidth_source"].filter((k) => !!gone && k in gone)], [true, []]);
  delete process.env.FFMPEG_REPORT_TO_PLEX;

  // Near the end of the film, on a run made from its start: 60 s made, 20 s
  // of it past the room, which is all that counts.
  const nearEnd = await room();
  const C = crypto.randomUUID();
  const late = await master("1", C);
  // Its driver's ping, from 40 s: so it carries on past LEAD_S to the end.
  await fetch(`${origin}/api/plex/hls/ping/${C}?time=40000&playing=1`);
  await madeTo(variantOf(late.text), 60);
  nearEnd.play("1", C, 40, 0);
  const lateCopy = await streamOn(C);
  check("  near the end of the film, the same: the file's average",
    [lateCopy?.bandwidth_source, lateCopy?.bandwidth_kbps], ["target", Number(notesOf(late.text).kbps)]);

  const encoding = await room();
  const D = crypto.randomUUID();
  const encode = await master("3", D, "?offset=40");
  encoding.play("3", D, 40);
  const lateEncode = await streamOn(D);
  check("a re-encode's target is its video's and its sound's: the AAC copied, at Plex's 160 kbps",
    [notesOf(encode.text).video, lateEncode?.bandwidth_source, lateEncode?.bandwidth_kbps],
    ["transcode", "target", Number(notesOf(encode.text).kbps) + 160]);

  // One of Plex's: a session no run of the engine's makes.
  const plexRoom = await room();
  const E = crypto.randomUUID();
  plexRoom.play("1", E, 0);
  const plexStream = await streamOn(E);
  check("a stream of Plex's carries none of it: schema 1 as it always was", Object.keys(plexStream ?? {}).sort(), [
    "hls_session_id", "host_heartbeat_age_seconds", "plex_transcode_key", "rating_key", "room_id", "state",
    "state_age_seconds", "state_revision", "variant_id", "viewer_count",
  ]);

  for (const ws of sockets) ws.terminate();
  closeWebSocketServer();
  for (const id of [A, B, C, D]) await fetch(`${origin}/api/plex/hls/session/${id}?reason=test`, { method: "DELETE" });
}

console.log("\n— previews made by ffmpeg, keyframes off the mount, segments kept in memory —");
{
  const { fileKeyframes } = await import("../src/services/keyframes.js");
  asked.length = 0;
  check("the keyframe check reads a film on the mount, not through Plex",
    [await fileKeyframes("/library/parts/77/1/file.mkv", 77, titles["1"].file), asked.includes("/library/parts/77/1/file.mkv")],
    ["idr", false]);
}
{
  const { hotSegmentStats } = await import("../src/services/ffmpeg/hot-segments.js");
  const { directStreamCacheDir } = await import("../src/services/direct-stream.js");
  const before = hotSegmentStats().segments;
  const id = crypto.randomUUID();
  const m = await master("1", id);
  const list = await listed(variantOf(m.text), 3);
  const kept = hotSegmentStats().segments;
  check("a run's segments are kept in memory as they are made", kept - before >= 3, true);
  const first = Buffer.from(await (await fetch(origin + list[0].uri)).arrayBuffer());
  // Its files gone from disk, what is in memory is still sent.
  const dir = path.join(directStreamCacheDir(), "ffmpeg", id, keyOf(list[0].uri)!);
  for (const name of fs.readdirSync(dir)) {
    try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* being written */ }
  }
  const again = await fetch(origin + list[0].uri);
  const second = Buffer.from(await again.arrayBuffer());
  check("  and sent from there", [again.status, second.equals(first), first.length > 0], [200, true, true]);
  await fetch(`${origin}/api/plex/hls/session/${id}?reason=test`, { method: "DELETE" });
  check("  and let go when the run ends", hotSegmentStats().segments < kept, true);
}
{
  const meta = await (await fetch(`${origin}/api/plex/meta/1`)).json() as { previewThumbs?: boolean; versions?: Array<{ previewThumbs: boolean }> };
  check("previews are offered for a film Plex has none for", [meta.previewThumbs, meta.versions?.[0]?.previewThumbs], [true, true]);
  const pass0 = await fetch(`${origin}/api/plex/preview/1/index?progressive=2&pass=0`);
  const head = Buffer.from(await pass0.arrayBuffer());
  check("  the first pass comes once ffmpeg has made them",
    [pass0.status, pass0.headers.get("content-type")], [200, "application/x-plex-preview-v2"]);
  // A keyframe every 2 s from 0 to 58, the last held to the end: 0 to 60.
  check("  31 frames, two seconds apart", [head.readUInt32LE(4 + 12), head.readUInt32LE(4 + 16)], [31, 2_000]);
  const whole = Buffer.from(await (await fetch(`${origin}/api/plex/preview/1/index`)).arrayBuffer());
  const count = whole.readUInt32LE(12);
  const frames = Array.from({ length: count }, (_, i) =>
    whole.subarray(whole.readUInt32LE(64 + i * 8 + 4), whole.readUInt32LE(64 + (i + 1) * 8 + 4)));
  check("  every frame a JPEG, each keyframe's its own picture",
    [frames.every((f) => f[0] === 0xff && f[1] === 0xd8 && f[f.length - 2] === 0xff && f[f.length - 1] === 0xd9),
      new Set(frames.map((f) => f.toString("base64"))).size], [true, 30]);
  check("  kept for next time", fs.existsSync(path.join(tmp, "previews", `1-${fs.statSync(titles["1"].file).size}-i2.bif`)), true);
  // Plex's length far past the file's: stopped where the film ends.
  const { makePreview } = await import("../src/services/ffmpeg/previews.js");
  const long = await makePreview({ partId: 9001, fileSize: 1, film: titles["2"].file, durationS: 3600, hdr: false });
  check("  a film Plex thinks an hour long gets its own minute's frames",
    long ? fs.readFileSync(long).readUInt32LE(12) : null, 31);
  process.env.FFMPEG_PREVIEWS = "off";
  const off = await fetch(`${origin}/api/plex/preview/2/index`);
  await off.arrayBuffer();
  const offMeta = await (await fetch(`${origin}/api/plex/meta/2`)).json() as { previewThumbs?: boolean };
  check("with FFMPEG_PREVIEWS=off, none are made or offered", [off.status, offMeta.previewThumbs], [404, false]);
  delete process.env.FFMPEG_PREVIEWS;
}

api.close();
plex.close();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* still open on Windows */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
