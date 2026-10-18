/**
 * The ffmpeg engine's copies (PLAYBACK_ENGINE=ffmpeg), through the routes as a
 * player sees them: real ffmpeg, films made for the test, and a fake Plex that
 * records everything it is asked — so a copy can be shown never to ask Plex to
 * transcode anything, and what ffmpeg can't copy yet to go to Plex as before.
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
process.env.PDT_FFMPEG_LEAD_S = "36";

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

/** 60 s at 640×360, a keyframe every 2 s, with the audio given. */
function film(name: string, audio: string[]): string {
  const file = path.join(tmp, name);
  const r = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "60", "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-g", "48",
    "-pix_fmt", "yuv420p", ...audio, file]);
  if (r.status !== 0) throw new Error(`couldn't make ${name}: ${r.stderr}`);
  return file;
}
const AAC_FILM = film("aac.mkv", ["-c:a", "aac", "-ac", "2"]);
const AC3_FILM = film("ac3.mkv", ["-c:a", "ac3", "-ac", "6"]);
const BROKEN_FILM = path.join(tmp, "broken.mkv");
fs.writeFileSync(BROKEN_FILM, Buffer.alloc(200_000, 7));

// ── Plex ─────────────────────────────────────────────────────────

/** ratingKey → the file, and how Plex describes it. */
const titles: Record<string, { file: string; plexPath: string; codec: string; width: number; height: number;
  audio: string; channels: number; hdr?: Record<string, unknown>; slow?: boolean }> = {
  1: { file: AAC_FILM, plexPath: AAC_FILM, codec: "h264", width: 640, height: 360, audio: "aac", channels: 2 },
  2: { file: AC3_FILM, plexPath: AC3_FILM, codec: "h264", width: 640, height: 360, audio: "ac3", channels: 6 },
  // HEVC, for a player nobody has said decodes it.
  3: { file: AAC_FILM, plexPath: AAC_FILM, codec: "hevc", width: 640, height: 360, audio: "aac", channels: 2 },
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
};

const asked: string[] = [];
const plex = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://plex");
  asked.push(url.pathname);
  const send = (body: unknown) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ MediaContainer: body }));
  };
  const meta = url.pathname.match(/^\/library\/metadata\/(\d+)$/);
  if (meta && titles[meta[1]]) {
    const t = titles[meta[1]];
    return send({ Metadata: [{
      ratingKey: meta[1], title: `Film ${meta[1]}`, type: "movie", duration: 60_000,
      Media: [{ id: 1, container: "mkv", width: t.width, height: t.height, videoCodec: t.codec, bitrate: 2000,
        Part: [{ id: Number(meta[1]), key: `/library/parts/${meta[1]}/1/file.mkv`, file: t.plexPath,
          size: fs.statSync(t.file).size, Stream: [
            { id: 11, streamType: 1, index: 0, codec: t.codec, bitDepth: 8, ...t.hdr },
            { id: 12, streamType: 2, index: 1, codec: t.audio, channels: t.channels, selected: true },
            // Listed only: a picture subtitle, which can only be burned in.
            { id: 21, streamType: 3, index: 2, codec: "pgs", language: "English", languageCode: "eng" },
          ] }] }],
    }] });
  }
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
  // Plex's transcoder isn't really here: a start that reaches it fails.
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

console.log("\n— a seek past what is there —");
{
  const m = await master("1", sid, "?offset=31");
  const variant = variantOf(m.text);
  const key = keyOf(variant);
  check("an offset starts a run of its own", !!key && key !== firstKey, true);
  const playlist = await (await fetch(origin + variant)).text();
  check("the playlist begins where the player asked", playlist.includes("#EXT-X-START:TIME-OFFSET=31.000,PRECISE=YES"), true);
  check("with gaps up to the keyframe before it", /#EXT-X-GAP/.test(playlist), true);
  const first = entries(playlist)[0];
  const bytes = Buffer.from(await (await fetch(origin + first.uri)).arrayBuffer());
  const span = videoSpan(bytes)!;
  check("whose picture opens on the keyframe at 30 s (40 on the copy's clock)", Math.abs(span.start - 40) < 0.1, true);
  // Jellyfin's ffmpeg counted the start twice with -segment_time: 30 s to 64 s here.
  check("and is a segment long, not the stretch since the start", span.end - span.start <= 6, true);
  const old = await fetch(`${origin}/api/plex/hls/seg?p=${encodeURIComponent(`/video/:/transcode/universal/session/${firstKey}/base/index.m3u8`)}`);
  check("the run it replaced is gone (410), not asked of Plex", [old.status, transcodeAsked()], [410, []]);
}

console.log("\n— audio that isn't AAC —");
{
  const m = await master("2", crypto.randomUUID());
  const notes = notesOf(m.text);
  check("is converted, and the player told so", [notes.engine, notes.audio, notes.audioFrom, notes.audioTo],
    ["ffmpeg", "transcode", "AC3 5.1", "AAC Stereo"]);
  const variant = variantOf(m.text);
  const first = entries(await (await fetch(origin + variant)).text())[0];
  const span = videoSpan(Buffer.from(await (await fetch(origin + first.uri)).arrayBuffer()))!;
  check("and is in the segments", span.audioStart !== null, true);
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
  const { planEncode, encodeArgs } = await import("../src/services/ffmpeg/plan.js");
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
}

/** A playlist's entries once it lists `n`: an encode lists them as it goes. */
async function listed(variant: string, n: number) {
  for (let i = 0; ; i++) {
    const list = entries(await (await fetch(origin + variant)).text());
    if (list.length >= n || i >= 40) return list;
    await sleep(250);
  }
}

console.log("\n— a re-encode —");
{
  asked.length = 0;
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  const m = await master("3", ids[0]);
  const notes = notesOf(m.text);
  check("HEVC for a player nobody said decodes it is re-encoded by ffmpeg, saying why",
    [notes.engine, notes.video, notes.reason], ["ffmpeg", "transcode", "HEVC, and this player can't decode it"]);
  check("  and Plex was never asked to transcode", transcodeAsked(), []);
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
  const second = await master("4", crypto.randomUUID());
  check("with FFMPEG_MAX_ENCODES taken, the next re-encode goes to Plex",
    [notesOf(first.text).engine, transcodeAsked().includes("/video/:/transcode/universal/decision")], ["ffmpeg", true]);
  check("  and nothing of the engine's is handed out for it", second.text.includes("com.pdt.engine"), false);
  delete process.env.FFMPEG_MAX_ENCODES;
  await fetch(`${origin}/api/plex/hls/session/${keep}?reason=test`, { method: "DELETE" });
}

console.log("\n— what is still Plex's —");
for (const [rk, why] of [["7", "Dolby Vision profile 5 without OpenCL"], ["6", "a file ffmpeg can't read"]]) {
  asked.length = 0;
  const m = await master(rk, crypto.randomUUID());
  check(`${why} goes to Plex`, transcodeAsked().includes("/video/:/transcode/universal/decision"), true);
  check(`  and nothing of the engine's is handed out for it`, m.text.includes("com.pdt.engine"), false);
}
{
  asked.length = 0;
  await master("1", crypto.randomUUID(), "?subtitles=burn&subtitleStreamID=21");
  check("a stream with a subtitle burned in goes to Plex", transcodeAsked().includes("/video/:/transcode/universal/decision"), true);
  asked.length = 0;
  process.env.PLAYBACK_ENGINE = "plex";
  await master("1", crypto.randomUUID());
  check("and with PLAYBACK_ENGINE=plex, everything does", transcodeAsked().includes("/video/:/transcode/universal/decision"), true);
  process.env.PLAYBACK_ENGINE = "ffmpeg";
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
  await sleep(200);
  const left = fs.existsSync(path.join(tmp, "stream-cache", "ffmpeg", sid))
    ? fs.readdirSync(path.join(tmp, "stream-cache", "ffmpeg", sid)) : [];
  check("and so are its files", left, []);
}

api.close();
plex.close();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* still open on Windows */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
