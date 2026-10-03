// Stream server for the media-errors fixture: node packages/client/test/media-errors-server.mjs
//
// Serves a two-minute HLS stream shaped like a Plex transcode (H.264 + MP3 in
// MPEG-TS, 3s segments) on http://localhost:3999/<scenario>/, with some segments
// replaced by random bytes that hls.js cannot parse:
//   tail   — segments 37-39 (111s to the end): a stream that breaks near the end,
//            the way The Queen's Gambit's last minute did
//   middle — segments 20-22 (60-69s): a bad patch mid-film
//   clean  — nothing broken
// Needs ffmpeg on the PATH the first time, to generate the stream.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const PORT = 3999;
const dir = path.join(os.tmpdir(), "plex-theater-media-errors");
const broken = { tail: [37, 38, 39], middle: [20, 21, 22], clean: [] };

if (!fs.existsSync(path.join(dir, "index.m3u8"))) {
  fs.mkdirSync(dir, { recursive: true });
  console.log("generating the test stream in", dir);
  const made = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "120", "-c:v", "libx264", "-preset", "veryfast", "-g", "72", "-keyint_min", "72",
    "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-c:a", "libmp3lame", "-b:a", "96k",
    "-f", "hls", "-hls_time", "3", "-hls_list_size", "0", "-hls_playlist_type", "vod",
    "-hls_segment_filename", path.join(dir, "seg%03d.ts"), path.join(dir, "index.m3u8"),
  ], { stdio: "inherit" });
  if (made.status !== 0) {
    console.error("ffmpeg failed — is it installed and on the PATH?");
    process.exit(1);
  }
}

http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const m = new URL(req.url, "http://x").pathname.match(/^\/(\w+)\/(.+)$/);
  const scenario = m?.[1];
  const file = m?.[2];
  if (!scenario || !(scenario in broken) || !file) { res.writeHead(404); res.end(); return; }
  if (file === "master.m3u8") {
    res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
    res.end("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360\nindex.m3u8\n");
    return;
  }
  if (file === "index.m3u8") {
    res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
    res.end(fs.readFileSync(path.join(dir, "index.m3u8")));
    return;
  }
  const seg = file.match(/^seg(\d+)\.ts$/);
  if (!seg || !fs.existsSync(path.join(dir, file))) { res.writeHead(404); res.end(); return; }
  const data = fs.readFileSync(path.join(dir, file));
  res.writeHead(200, { "Content-Type": "video/mp2t" });
  res.end(broken[scenario].includes(Number(seg[1])) ? crypto.randomBytes(data.length) : data);
}).listen(PORT, "127.0.0.1", () => console.log(`media-errors stream server on http://localhost:${PORT}`));
