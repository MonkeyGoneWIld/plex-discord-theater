#!/usr/bin/env node
/**
 * Why does Direct Stream stall, and what will Plex agree to send this app?
 *
 *   node scripts/diagnose-direct-stream.mjs --rating-key 30310 --at 564
 *
 * Four things, in order:
 *
 *  1. The item: every version Plex has for it, with codec, profile, bit depth,
 *     size and bitrate, so the rest of the report can be read against the source.
 *  2. Plex's transcoder settings that bear on this (hardware, HEVC, tone mapping).
 *  3. Decision probes: the same /decision call the app makes, once per client
 *     profile, printing what Plex would do with each — copy or transcode, and to
 *     which codec. Nothing is started by these. This is where "HEVC is on in
 *     Plex but every transcode is still H.264" gets its answer.
 *  4. A real session with video copy (directStream=1), started exactly the way
 *     the app starts one, then walked segment by segment from --from to --to.
 *     Every segment is downloaded and run through ffprobe, and what is actually
 *     inside it is checked against what the playlist claims: where it starts,
 *     whether it opens on a keyframe, gaps and overlaps with its neighbour,
 *     timestamp jumps, and format changes. The session is stopped at the end,
 *     and on Ctrl+C.
 *
 * Plus a look at the source file itself around --at: where its keyframes fall
 * and whether its own timestamps jump.
 *
 * Needs Node 18 or newer, PLEX_URL and PLEX_TOKEN (environment, or --plex-url /
 * --plex-token) and ffprobe on PATH (or FFPROBE=/path/to/ffprobe). Without a
 * new enough Node or ffprobe on the host, run it in a throwaway container:
 *
 *   docker run --rm -it --network host -v "$PWD":/work -w /work node:22-alpine \
 *     sh -c "apk add --no-cache ffmpeg >/dev/null && node diagnose-direct-stream.mjs …" Run it from a machine on the
 * same network as Plex — remote fetches are throttled to real time. It uses its
 * own client identifier, so it cannot disturb a room that is playing.
 *
 * Writes report.txt and report.json, plus the playlists and the segments around
 * --at, to diagnose-out/<ratingKey>-<time>/. The Plex token is never written.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// ─── Arguments ──────────────────────────────────────────────────

const HELP = `
Usage: node scripts/diagnose-direct-stream.mjs --rating-key <id> [options]

  --rating-key <id>     Plex ratingKey of the movie or episode (required)
  --at <seconds>        Where playback stalled. Segments around it are kept,
                        and the source file is probed around it.
  --from <seconds>      Where the session starts (default 0). Starting at 0
                        reproduces "played from the beginning".
  --to <seconds>|end    Where to stop walking segments (default --at + 30,
                        or --from + 120 without --at). "end" walks the
                        whole file.
  --mode copy|transcode Video copy (default) or the app's current re-encode,
                        as a control.
  --media-index <n>     Which version to play (default: the one the app picks).
  --decisions-only      Only steps 1-3: no session, no segments.
  --skip-decisions      Skip step 3.
  --profile-extra <s>   One more decision probe with this exact
                        X-Plex-Client-Profile-Extra value.
  --keep <n>            Segments to keep either side of --at (default 4).
  --out <dir>           Output directory (default diagnose-out/<id>-<time>).
  --plex-url <url>      Overrides PLEX_URL.
  --plex-token <token>  Overrides PLEX_TOKEN.
`;

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (["decisions-only", "skip-decisions", "help"].includes(name)) {
      opts[name] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${arg} needs a value`);
    opts[name] = value;
  }
  return opts;
}

function num(value, name) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a number of seconds`);
  return n;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(err.message, HELP);
  process.exit(2);
}
if (args.help || !args["rating-key"]) {
  console.log(HELP);
  process.exit(args.help ? 0 : 2);
}

const RATING_KEY = String(args["rating-key"]);
if (!/^\d+$/.test(RATING_KEY)) {
  console.error("--rating-key must be numeric");
  process.exit(2);
}
const PLEX_URL = (args["plex-url"] ?? process.env.PLEX_URL ?? "").replace(/\/$/, "");
const PLEX_TOKEN = args["plex-token"] ?? process.env.PLEX_TOKEN ?? "";
if (!PLEX_URL || !PLEX_TOKEN) {
  console.error("Set PLEX_URL and PLEX_TOKEN (or pass --plex-url / --plex-token).");
  process.exit(2);
}
const FFPROBE = process.env.FFPROBE || "ffprobe";
const AT = num(args.at, "at");
const FROM = num(args.from, "from") ?? 0;
const TO = args.to === "end" ? Infinity : num(args.to, "to") ?? (AT !== undefined ? AT + 30 : FROM + 120);
const MODE = args.mode ?? "copy";
if (MODE !== "copy" && MODE !== "transcode") {
  console.error("--mode must be copy or transcode");
  process.exit(2);
}
const KEEP = num(args.keep, "keep") ?? 4;
const OUT_DIR = path.resolve(
  args.out ?? path.join("diagnose-out", `${RATING_KEY}-${new Date().toISOString().replace(/[:.]/g, "-")}`),
);

// The app's own values, from routes/plex.ts. Copied rather than imported so the
// script runs without building the server; if those change, change these.
const SECONDS_PER_SEGMENT = 3;
const VIDEO_BITRATE_KBPS = process.env.VIDEO_BITRATE_KBPS || "12000";
const VIDEO_PEAK_BITRATE_KBPS = process.env.VIDEO_PEAK_BITRATE_KBPS || "20000";
/** The client profile the app sends, with the video codecs it offers. */
const appProfile = (videoCodec = "h264") =>
  "add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts" +
  `&videoCodec=${videoCodec}&audioCodec=aac&replace=true)`;
/** media-versions.ts transcodeFrame: the file's own size when only just over 1080p. */
function transcodeFrame(m) {
  const w = m?.width ?? 0;
  const h = m?.height ?? 0;
  return w > 0 && h > 0 && w <= 2048 && h <= 1200 ? `${Math.max(1920, w)}x${Math.max(1080, h)}` : "1920x1080";
}

// A client identifier of its own, so Plex keeps this run's per-client state
// apart from the app's ("plex-discord-theater").
const CLIENT_ID = `pdt-diagnose-${randomUUID().slice(0, 8)}`;

// ─── Output ─────────────────────────────────────────────────────

const reportLines = [];
const reportJson = { ratingKey: RATING_KEY, mode: MODE, from: FROM, to: TO, at: AT ?? null };

function redact(text) {
  return String(text).split(PLEX_TOKEN).join("<token>");
}

function out(line = "") {
  const safe = redact(line);
  console.log(safe);
  reportLines.push(safe);
}

function heading(title) {
  out();
  out(`── ${title} ${"─".repeat(Math.max(0, 70 - title.length))}`);
}

function fmtTime(s) {
  if (s === undefined || s === null || !Number.isFinite(s)) return "—";
  const sign = s < 0 ? "-" : "";
  const abs = Math.abs(s);
  const m = Math.floor(abs / 60);
  return `${sign}${m}:${(abs - m * 60).toFixed(2).padStart(5, "0")}`;
}

function fmtNum(n, digits = 2) {
  return n === undefined || n === null || !Number.isFinite(n) ? "—" : n.toFixed(digits);
}

// ─── Plex HTTP ──────────────────────────────────────────────────

function plexUrl(p, params = {}) {
  // String concatenation, like services/plex.ts: Plex paths contain ":/".
  const url = new URL(`${PLEX_URL}${p.startsWith("/") ? "" : "/"}${p}`);
  url.searchParams.set("X-Plex-Token", PLEX_TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

function plexHeaders(sessionId, extra = {}) {
  return {
    Accept: "application/json",
    "X-Plex-Client-Identifier": CLIENT_ID,
    "X-Plex-Product": "Plex Discord Theater",
    "X-Plex-Version": "1.0.0",
    "X-Plex-Platform": "Chrome",
    "X-Plex-Device": "Browser",
    ...(sessionId ? { "X-Plex-Session-Identifier": sessionId } : {}),
    ...extra,
  };
}

async function plexFetch(p, { params, headers, method = "GET", timeoutMs = 20_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(plexUrl(p, params), {
      method,
      headers: headers ?? plexHeaders(),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function plexJSON(p, params) {
  const res = await plexFetch(p, { params });
  if (!res.ok) throw new Error(`${p} → HTTP ${res.status}`);
  return res.json();
}

// ─── ffprobe ────────────────────────────────────────────────────

function run(cmd, cmdArgs, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function checkFfprobe() {
  const { code, stdout } = await run(FFPROBE, ["-version"], { timeoutMs: 10_000 });
  if (code !== 0) {
    console.error(`ffprobe not found (tried "${FFPROBE}"). Install ffmpeg or set FFPROBE.`);
    process.exit(2);
  }
  return stdout.split("\n")[0].trim();
}

/** Packets and streams of one file or URL, with whatever ffprobe complained about. */
async function probePackets(input, extraArgs = []) {
  const { code, stdout, stderr } = await run(FFPROBE, [
    "-v", "warning",
    ...extraArgs,
    "-show_entries",
    "packet=stream_index,codec_type,pts_time,dts_time,duration_time,flags:" +
      "stream=index,codec_type,codec_name,profile,width,height,pix_fmt,level,r_frame_rate",
    "-of", "json",
    input,
  ]);
  let parsed = {};
  try {
    parsed = JSON.parse(stdout || "{}");
  } catch {
    // Reported below as a probe failure.
  }
  const warnings = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return { ok: code === 0, packets: parsed.packets ?? [], streams: parsed.streams ?? [], warnings };
}

// ─── 1. The item ────────────────────────────────────────────────

const UHD_MIN_WIDTH = 3000;
const RESOLUTION_WIDTHS = { "4k": 3840, "2160": 3840, "1080": 1920, "720": 1280, "576": 1024, "480": 854, sd: 720 };

function frameWidth(m) {
  if (m.width > 0) return m.width;
  const known = RESOLUTION_WIDTHS[String(m.videoResolution ?? "").toLowerCase()];
  if (known) return known;
  return m.height > 0 ? Math.round((m.height * 16) / 9) : 0;
}

/** The app's playableVersionOrder: hide 4K when anything else exists, widest first. */
function defaultMediaIndex(media) {
  const indexed = media.map((m, index) => ({ m, index }));
  const anyUhd = indexed.some(({ m }) => frameWidth(m) >= UHD_MIN_WIDTH);
  const anyOther = indexed.some(({ m }) => frameWidth(m) < UHD_MIN_WIDTH);
  const playable = anyUhd && anyOther ? indexed.filter(({ m }) => frameWidth(m) < UHD_MIN_WIDTH) : indexed;
  playable.sort((a, b) => frameWidth(b.m) - frameWidth(a.m) || (b.m.bitrate ?? 0) - (a.m.bitrate ?? 0) || a.index - b.index);
  return playable[0]?.index ?? 0;
}

async function describeItem() {
  heading("1. Item");
  const data = await plexJSON(`/library/metadata/${RATING_KEY}`);
  const meta = data.MediaContainer?.Metadata?.[0];
  if (!meta) throw new Error(`No metadata for ratingKey ${RATING_KEY}`);
  const title = meta.type === "episode"
    ? `${meta.grandparentTitle} S${meta.parentIndex}E${meta.index} "${meta.title}"`
    : `${meta.title}${meta.year ? ` (${meta.year})` : ""}`;
  out(`${title} — ${fmtTime((meta.duration ?? 0) / 1000)}`);

  const media = meta.Media ?? [];
  const mediaIndex = args["media-index"] !== undefined ? Number(args["media-index"]) : defaultMediaIndex(media);
  const versions = media.map((m, index) => {
    const part = m.Part?.[0] ?? {};
    const streams = part.Stream ?? [];
    const video = streams.find((s) => s.streamType === 1) ?? {};
    const audio = streams.find((s) => s.streamType === 2 && s.selected) ?? streams.find((s) => s.streamType === 2) ?? {};
    return {
      index,
      container: m.container,
      videoCodec: m.videoCodec,
      videoProfile: video.profile ?? m.videoProfile,
      bitDepth: video.bitDepth,
      width: m.width,
      height: m.height,
      codedWidth: video.codedWidth,
      codedHeight: video.codedHeight,
      frameRate: video.frameRate ?? m.videoFrameRate,
      hdr: video.colorTrc ?? null,
      dovi: video.DOVIPresent ? `DV profile ${video.DOVIProfile}` : null,
      bitrateKbps: m.bitrate,
      videoBitrateKbps: video.bitrate,
      audio: [audio.codec, audio.channels ? `${audio.channels}ch` : null, audio.language].filter(Boolean).join(" "),
      partId: part.id,
      partKey: part.key,
      file: part.file,
      sizeMB: part.size ? Math.round(part.size / 1e6) : undefined,
    };
  });
  for (const v of versions) {
    const mark = v.index === mediaIndex ? "▶" : " ";
    out(`${mark} [${v.index}] ${v.container} · ${v.videoCodec} ${v.videoProfile ?? ""}${v.bitDepth ? ` ${v.bitDepth}-bit` : ""}` +
      ` · ${v.width}×${v.height}${v.codedHeight && v.codedHeight !== v.height ? ` (coded ${v.codedWidth}×${v.codedHeight})` : ""}` +
      ` · ${v.frameRate ?? "?"} fps · ${v.bitrateKbps ?? "?"} kbps` +
      `${v.hdr ? ` · ${v.hdr}` : ""}${v.dovi ? ` · ${v.dovi}` : ""} · audio ${v.audio || "?"} · ${v.sizeMB ?? "?"} MB`);
    out(`      ${v.file ?? ""}`);
  }
  out(`Using version [${mediaIndex}] — the one the app would pick unless --media-index says otherwise.`);
  reportJson.item = { title, durationMs: meta.duration, mediaIndex, versions };
  return { meta, versions, mediaIndex, durationS: (meta.duration ?? 0) / 1000 };
}

// ─── 2. Server settings ─────────────────────────────────────────

async function describePrefs() {
  heading("2. Plex transcoder settings");
  try {
    const data = await plexJSON("/:/prefs");
    const settings = (data.MediaContainer?.Setting ?? []).filter((s) =>
      /hevc|hardware|hwdevice|transcod|tonemap|hdr|throttle|segment|vaapi|qsv|nvenc|codec/i.test(s.id),
    );
    if (settings.length === 0) out("(none of the expected settings were returned)");
    for (const s of settings) {
      out(`${s.id} = ${JSON.stringify(s.value)}${s.label ? `   (${s.label})` : ""}`);
    }
    reportJson.prefs = Object.fromEntries(settings.map((s) => [s.id, s.value]));
  } catch (err) {
    out(`Couldn't read /:/prefs (${err.message}) — the token may not be the server owner's.`);
  }
}

// ─── 3. Decision probes ─────────────────────────────────────────

function sessionParams(mediaIndex, {
  directStream, offset, protocol = "hls", videoResolution = "1920x1080",
  videoBitrate = VIDEO_BITRATE_KBPS, peakBitrate = VIDEO_PEAK_BITRATE_KBPS,
}) {
  const params = {
    hasMDE: "1",
    path: `/library/metadata/${RATING_KEY}`,
    mediaIndex: String(mediaIndex),
    partIndex: "0",
    protocol,
    fastSeek: "1",
    directPlay: "0",
    directStream: directStream ? "1" : "0",
    directStreamAudio: "1",
    videoResolution,
    videoBitrate: String(videoBitrate),
    peakBitrate: String(peakBitrate),
    videoQuality: "99",
    autoAdjustQuality: "0",
    location: "lan",
    mediaBufferSize: "102400",
    secondsPerSegment: String(SECONDS_PER_SEGMENT),
    subtitles: "none",
  };
  if (offset) params.offset = String(Math.round(offset));
  return params;
}

function summariseDecision(body) {
  const mc = body?.MediaContainer ?? {};
  const media = mc.Metadata?.[0]?.Media?.find((m) => m.selected) ?? mc.Metadata?.[0]?.Media?.[0] ?? {};
  const part = media.Part?.[0] ?? {};
  const streams = part.Stream ?? [];
  const video = streams.find((s) => s.streamType === 1) ?? {};
  const audio = streams.find((s) => s.streamType === 2) ?? {};
  return {
    general: `${mc.generalDecisionCode ?? "?"} ${mc.generalDecisionText ?? ""}`.trim(),
    directPlay: `${mc.directPlayDecisionCode ?? "?"} ${mc.directPlayDecisionText ?? ""}`.trim(),
    transcode: `${mc.transcodeDecisionCode ?? "?"} ${mc.transcodeDecisionText ?? ""}`.trim(),
    protocol: media.protocol,
    container: media.container,
    video: `${video.decision ?? "?"} → ${video.codec ?? media.videoCodec ?? "?"}` +
      `${video.width ? ` ${video.width}×${video.height}` : ""}${video.bitrate ? ` ${video.bitrate} kbps` : ""}`,
    audio: `${audio.decision ?? "?"} → ${audio.codec ?? media.audioCodec ?? "?"}${audio.channels ? ` ${audio.channels}ch` : ""}`,
  };
}

async function decisionProbes(item) {
  heading("3. Decision probes (nothing is started)");
  out("What Plex says it would do for each client profile. 'copy' is Direct Stream.");
  const version = item.versions.find((v) => v.index === item.mediaIndex);
  const frame = transcodeFrame(version);
  // What the app sends now, then what Direct Stream would need. Earlier rounds
  // (the wordings Plex ignored) are in this file's history.
  const probes = [
    { name: "app today", directStream: false, extra: appProfile(), videoResolution: frame },
    { name: "app with HEVC_TRANSCODE=1", directStream: false, extra: appProfile("hevc,h264"), videoResolution: frame },
    { name: "copy allowed, H.264 or HEVC, old 1920x1080 box", directStream: true, extra: appProfile("h264,hevc") },
    { name: "copy allowed, H.264 or HEVC, sized to the file", directStream: true, extra: appProfile("h264,hevc"), videoResolution: frame },
    { name: "copy allowed, sized to the file, 60 Mbps cap", directStream: true, extra: appProfile("h264,hevc"), videoResolution: frame,
      videoBitrate: 60000, peakBitrate: 80000 },
  ];
  if (args["profile-extra"]) {
    probes.push({ name: "--profile-extra", directStream: MODE === "copy", extra: args["profile-extra"] });
  }
  reportJson.decisions = [];
  for (const probe of probes) {
    const sessionId = randomUUID();
    const params = { ...sessionParams(item.mediaIndex, probe), transcodeSessionId: sessionId };
    try {
      const res = await plexFetch("/video/:/transcode/universal/decision", {
        params,
        headers: plexHeaders(sessionId, { "X-Plex-Client-Profile-Extra": probe.extra }),
      });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      const s = body ? summariseDecision(body) : null;
      out();
      out(`${probe.name}   [HTTP ${res.status}]`);
      if (s) {
        out(`   video ${s.video}   audio ${s.audio}   via ${s.protocol ?? "?"}/${s.container ?? "?"}`);
        out(`   decision ${s.general} | direct play: ${s.directPlay} | transcode: ${s.transcode}`);
      } else {
        out(`   ${text.replace(/\s+/g, " ").slice(0, 300)}`);
      }
      reportJson.decisions.push({ ...probe, status: res.status, summary: s });
    } catch (err) {
      out();
      out(`${probe.name}: request failed — ${err.message}`);
    }
  }
}

// ─── 4. A real session, segment by segment ──────────────────────

const TRANSCODE_PREFIX = "/video/:/transcode/universal/";
const PLEX_SESSION_KEY_RE = /session\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i;

/** A playlist line → a path on Plex (with its query string), relative to baseDir. */
function resolvePlexPath(uri, baseDir) {
  if (/^https?:\/\//i.test(uri)) {
    const u = new URL(uri);
    u.searchParams.delete("X-Plex-Token");
    return u.pathname + (u.search || "");
  }
  return baseDir + uri;
}

function parseMediaPlaylist(text) {
  const entries = [];
  let pendingDuration = null;
  let pendingDiscontinuity = false;
  const tags = { endList: false, playlistType: null, mediaSequence: 0, targetDuration: null };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) pendingDuration = parseFloat(line.slice(8));
    else if (line === "#EXT-X-DISCONTINUITY") pendingDiscontinuity = true;
    else if (line === "#EXT-X-ENDLIST") tags.endList = true;
    else if (line.startsWith("#EXT-X-PLAYLIST-TYPE:")) tags.playlistType = line.split(":")[1];
    else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) tags.mediaSequence = parseInt(line.split(":")[1], 10);
    else if (line.startsWith("#EXT-X-TARGETDURATION:")) tags.targetDuration = parseFloat(line.split(":")[1]);
    else if (!line.startsWith("#")) {
      entries.push({ uri: line, duration: pendingDuration ?? 0, discontinuity: pendingDiscontinuity });
      pendingDuration = null;
      pendingDiscontinuity = false;
    }
  }
  return { entries, tags };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const live = { sessionId: null, plexKey: null, stopped: false };

async function stopSession(ratingKey) {
  if (!live.sessionId || live.stopped) return;
  live.stopped = true;
  // Our session id first, then Plex's own key: the app has seen Plex answer
  // either one with a 404 (see transcodeControl in routes/plex.ts).
  for (const id of [live.sessionId, live.plexKey].filter(Boolean)) {
    try {
      const res = await plexFetch(`${TRANSCODE_PREFIX}stop`, {
        params: { session: id },
        headers: plexHeaders(live.sessionId),
        timeoutMs: 8_000,
      });
      out(`Stopped transcode (session=${id === live.sessionId ? "ours" : "plex key"}) → HTTP ${res.status}`);
      if (res.ok) break;
    } catch (err) {
      out(`Stop failed: ${err.message}`);
    }
  }
  try {
    await plexFetch("/:/timeline", {
      method: "POST",
      params: { ratingKey, key: `/library/metadata/${ratingKey}`, state: "stopped", time: "0", duration: "0", identifier: "com.plexapp.plugins.library" },
      headers: plexHeaders(live.sessionId),
      timeoutMs: 8_000,
    });
  } catch {
    // Best effort.
  }
}

process.on("SIGINT", async () => {
  console.log("\nInterrupted — stopping the transcode…");
  await stopSession(RATING_KEY);
  process.exit(130);
});

async function plexTranscodeView(plexKey) {
  try {
    const data = await plexJSON("/transcode/sessions");
    const t = (data.MediaContainer?.TranscodeSession ?? []).find((s) => s.key?.split("/").pop() === plexKey);
    if (!t) return null;
    const pick = [
      "videoDecision", "audioDecision", "protocol", "container", "sourceVideoCodec", "videoCodec",
      "sourceAudioCodec", "audioCodec", "width", "height", "speed", "throttled",
      "transcodeHwRequested", "transcodeHwDecoding", "transcodeHwEncoding", "transcodeHwFullPipeline",
      "maxOffsetAvailable", "minOffsetAvailable",
    ];
    return Object.fromEntries(pick.filter((k) => t[k] !== undefined).map((k) => [k, t[k]]));
  } catch {
    return null;
  }
}

/** Fetch one segment, waiting for the transcoder to reach it. */
async function fetchSegment(plexPath, waitS = 90) {
  const deadline = Date.now() + waitS * 1000;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const res = await plexFetch(plexPath, { headers: plexHeaders(live.sessionId), timeoutMs: 60_000 }).catch(() => null);
    if (res?.ok) return Buffer.from(await res.arrayBuffer());
    lastStatus = res?.status ?? 0;
    // 404 is "not produced yet"; anything else is worth a slower retry too.
    await sleep(1000);
  }
  throw new Error(`segment never arrived (last HTTP ${lastStatus})`);
}

function analyseSegment(probe) {
  const vStream = probe.streams.find((s) => s.codec_type === "video");
  const video = probe.packets.filter((p) => p.codec_type === "video");
  const audio = probe.packets.filter((p) => p.codec_type === "audio");
  const vPts = video.map((p) => parseFloat(p.pts_time)).filter(Number.isFinite).sort((a, b) => a - b);
  const aPts = audio.map((p) => parseFloat(p.pts_time)).filter(Number.isFinite).sort((a, b) => a - b);
  const diffs = vPts.slice(1).map((t, i) => t - vPts[i]);
  const sortedDiffs = [...diffs].sort((a, b) => a - b);
  const frameDur = sortedDiffs.length ? sortedDiffs[Math.floor(sortedDiffs.length / 2)] : 0;
  const keyTimes = video.filter((p) => String(p.flags ?? "").includes("K")).map((p) => parseFloat(p.pts_time));
  return {
    videoPackets: video.length,
    audioPackets: audio.length,
    // Decode order is what a decoder sees first — if that isn't a keyframe,
    // everything up to the first one is undecodable.
    firstIsKey: video.length > 0 && String(video[0].flags ?? "").includes("K"),
    keyframes: keyTimes.length,
    keyTimes,
    vFirst: vPts[0],
    vLast: vPts[vPts.length - 1],
    aFirst: aPts[0],
    aLast: aPts[aPts.length - 1],
    frameDur,
    maxInternalGap: diffs.length ? Math.max(...diffs) : 0,
    // Unknown when the segment carries no parameter sets (no keyframe), which
    // is its own flag — not a format change.
    format: vStream?.width > 0
      ? `${vStream.codec_name} ${vStream.profile ?? ""} ${vStream.width}×${vStream.height} ${vStream.pix_fmt ?? ""}`.replace(/\s+/g, " ").trim()
      : null,
    warnings: probe.warnings,
  };
}

async function walkSegments(item) {
  heading(`4. Session with video ${MODE === "copy" ? "copied (Direct Stream)" : "re-encoded (as the app does today)"}`);
  const to = Math.min(TO, item.durationS);
  out(`Walking ${fmtTime(FROM)} → ${fmtTime(to)}${AT !== undefined ? `, stall reported at ${fmtTime(AT)}` : ""}.`);

  const sessionId = randomUUID();
  live.sessionId = sessionId;
  const version = item.versions.find((v) => v.index === item.mediaIndex);
  const params = {
    ...sessionParams(item.mediaIndex, { directStream: MODE === "copy", offset: FROM, videoResolution: transcodeFrame(version) }),
    transcodeSessionId: sessionId,
  };
  // Copy mode accepts HEVC too, or an HEVC source would be re-encoded and there
  // would be nothing copied to look at. Whether the room can decode it is a
  // separate question; this is about what Plex's segments look like.
  const profileExtra = appProfile(MODE === "copy" ? "h264,hevc" : "h264");
  const headers = plexHeaders(sessionId, { "X-Plex-Client-Profile-Extra": profileExtra });
  out(`Client profile: ${profileExtra}`);

  const decisionRes = await plexFetch(`${TRANSCODE_PREFIX}decision`, { params, headers });
  const decisionBody = await decisionRes.json().catch(() => null);
  const d = decisionBody ? summariseDecision(decisionBody) : null;
  out(`Decision HTTP ${decisionRes.status}: ${d ? `video ${d.video}, audio ${d.audio}` : "(no body)"}`);

  const startRes = await plexFetch(`${TRANSCODE_PREFIX}start.m3u8`, { params, headers });
  const master = await startRes.text();
  if (!startRes.ok) throw new Error(`start.m3u8 → HTTP ${startRes.status}: ${master.slice(0, 200)}`);
  await writeFile(path.join(OUT_DIR, "master.m3u8"), redact(master));
  const keyMatch = master.match(PLEX_SESSION_KEY_RE);
  live.plexKey = keyMatch?.[1] ?? null;
  const variant = master.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  if (!variant) throw new Error("master playlist has no variant");
  const subPath = resolvePlexPath(variant, TRANSCODE_PREFIX);
  const baseDir = subPath.split("?")[0].replace(/[^/]*$/, "");
  out(`Plex transcode key ${live.plexKey ?? "?"} · media playlist ${subPath.split("?")[0]}`);

  // The app tells Plex it is playing straight away — without it, delivery is throttled.
  const timeline = (timeS, state = "playing") =>
    plexFetch("/:/timeline", {
      method: "POST",
      params: {
        ratingKey: RATING_KEY, key: `/library/metadata/${RATING_KEY}`, state,
        time: String(Math.round(timeS * 1000)), duration: String(Math.round(item.durationS * 1000)),
        identifier: "com.plexapp.plugins.library",
      },
      headers: plexHeaders(sessionId),
      timeoutMs: 8_000,
    }).catch(() => {});
  await timeline(FROM);

  const loadPlaylist = async () => {
    const res = await plexFetch(subPath, { headers: plexHeaders(sessionId) });
    const text = await res.text();
    if (!res.ok) throw new Error(`media playlist → HTTP ${res.status}`);
    return { text, ...parseMediaPlaylist(text) };
  };
  let playlist = await loadPlaylist();
  for (let i = 0; i < 20 && playlist.entries.length === 0; i++) {
    await sleep(1000);
    playlist = await loadPlaylist();
  }
  await writeFile(path.join(OUT_DIR, "index.m3u8"), redact(playlist.text));

  // Does the playlist describe the whole title from 0:00, or only from the
  // offset on? Whichever its total is closer to.
  const declaredTotal = playlist.entries.reduce((s, e) => s + e.duration, 0);
  const fromZero = playlist.tags.endList && FROM > 0 &&
    Math.abs(declaredTotal - item.durationS) < Math.abs(declaredTotal - (item.durationS - FROM));
  const base = fromZero ? 0 : FROM;
  const durations = playlist.entries.map((e) => e.duration);
  const uniform = durations.length > 1 && durations.slice(0, -1).every((x) => Math.abs(x - durations[0]) < 0.01);
  out(`Media playlist: ${playlist.entries.length} entries${playlist.tags.endList ? " (complete, ENDLIST)" : " (growing)"}, ` +
    `type ${playlist.tags.playlistType ?? "none"}, ${uniform ? `every entry ${durations[0]}s` : "entry durations vary"}, ` +
    `${playlist.entries.filter((e) => e.discontinuity).length} DISCONTINUITY tags, first entry "${playlist.entries[0]?.uri ?? "?"}"`);
  out("First lines of the media playlist:");
  for (const l of playlist.text.split(/\r?\n/).slice(0, 12)) out(`   ${l}`);

  const view = await plexTranscodeView(live.plexKey);
  if (view) out(`Plex's view of this transcode: ${JSON.stringify(view)}`);
  reportJson.session = { decision: d, playlistTags: playlist.tags, declaredTotal, uniform, playlistFromZero: fromZero, plexView: view };

  const segDir = path.join(OUT_DIR, "segments");
  await mkdir(segDir, { recursive: true });
  const results = [];
  let lastKeepAlive = Date.now();
  let declaredStart = base;
  let index = 0;
  let lastGrowth = Date.now();
  let keptSuspicious = 0;
  // Skip entries that end before --from (only when the playlist starts at 0:00).
  while (index < playlist.entries.length && declaredStart + playlist.entries[index].duration <= FROM) {
    declaredStart += playlist.entries[index].duration;
    index++;
  }

  while (declaredStart < to) {
    if (index >= playlist.entries.length) {
      if (playlist.tags.endList) break;
      if (Date.now() - lastGrowth > 90_000) {
        out(`\nThe media playlist stopped growing at ${playlist.entries.length} entries — Plex's transcoder stalled or died here.`);
        break;
      }
      await sleep(1000);
      const before = playlist.entries.length;
      playlist = await loadPlaylist();
      if (playlist.entries.length > before) lastGrowth = Date.now();
      continue;
    }
    const entry = playlist.entries[index];
    const segPath = resolvePlexPath(entry.uri, baseDir);
    const name = entry.uri.split("?")[0].split("/").pop();

    if (Date.now() - lastKeepAlive > 10_000) {
      lastKeepAlive = Date.now();
      plexFetch(`${TRANSCODE_PREFIX}ping`, { params: { session: sessionId }, headers: plexHeaders(sessionId), timeoutMs: 8_000 }).catch(() => {});
      timeline(declaredStart);
    }

    const result = { index, name, declaredStart, declaredDuration: entry.duration, discontinuityTag: entry.discontinuity };
    try {
      const bytes = await fetchSegment(segPath);
      const file = path.join(segDir, name);
      await writeFile(file, bytes);
      result.bytes = bytes.length;
      result.file = file;
      Object.assign(result, analyseSegment(await probePackets(file)));
      // Kept: the segments around --at, and the first few that look wrong on
      // their own. Everything else goes straight away, so walking a whole
      // remux doesn't leave the whole remux on disk.
      const nearAt = AT !== undefined && Math.abs(declaredStart - AT) <= KEEP * SECONDS_PER_SEGMENT + 0.01;
      const suspicious = !result.firstIsKey || result.keyframes === 0 || result.maxInternalGap > 1 || result.warnings.length > 0;
      if (nearAt || (suspicious && keptSuspicious++ < 10)) result.kept = path.relative(OUT_DIR, file);
      else await rm(file, { force: true });
    } catch (err) {
      result.error = err.message;
    }
    results.push(result);
    process.stdout.write(`\r  ${name}  ${fmtTime(declaredStart)}  ${results.length} segments checked   `);
    declaredStart += entry.duration;
    index++;
  }
  process.stdout.write("\n");

  const flagged = annotate(results);
  reportSegments(results, flagged);
  reportJson.segments = results.map(({ keyTimes, file, ...rest }) => rest);
  return results;
}

/** Cross-segment checks: where each one really starts, and against its neighbours. */
function annotate(results) {
  const first = results.find((r) => Number.isFinite(r.vFirst));
  // MPEG-TS timestamps carry an arbitrary offset; line them up on the first segment.
  const origin = first ? first.vFirst - first.declaredStart : 0;
  let prev = null;
  let lastFormat = null;
  for (const r of results) {
    const flags = [];
    if (r.error) flags.push(`ERROR(${r.error})`);
    else if (!r.videoPackets) flags.push("NO_VIDEO");
    else {
      r.actualStart = r.vFirst - origin;
      r.drift = r.actualStart - r.declaredStart;
      if (!r.firstIsKey) flags.push("NOT_ON_KEYFRAME");
      if (r.keyframes === 0) flags.push("NO_KEYFRAME");
      if (Math.abs(r.drift) > 1) flags.push(`DRIFT(${r.drift > 0 ? "+" : ""}${r.drift.toFixed(2)}s)`);
      if (r.maxInternalGap > 1) flags.push(`TIMESTAMP_JUMP(${r.maxInternalGap.toFixed(2)}s)`);
      if (Number.isFinite(r.aFirst) && Math.abs(r.aFirst - r.vFirst) > 1) flags.push(`AV_OFFSET(${(r.aFirst - r.vFirst).toFixed(2)}s)`);
      if (prev && Number.isFinite(prev.vLast)) {
        r.gapFromPrev = r.vFirst - (prev.vLast + (prev.frameDur || 0));
        if (r.gapFromPrev > 0.25) flags.push(`GAP(${r.gapFromPrev.toFixed(2)}s)`);
        if (r.gapFromPrev < -0.25) flags.push(`OVERLAP(${(-r.gapFromPrev).toFixed(2)}s)`);
      }
      if (r.format && lastFormat && r.format !== lastFormat) flags.push(`FORMAT_CHANGE(${lastFormat} → ${r.format})`);
      if (r.format) lastFormat = r.format;
      const span = r.vLast + (r.frameDur || 0) - r.vFirst;
      r.actualDuration = span;
      // A second either way is normal when cuts follow keyframes; DRIFT is what
      // says whether it adds up to something a player would trip on.
      if (Math.abs(span - r.declaredDuration) > 2) flags.push(`LENGTH(${span.toFixed(2)}s vs ${r.declaredDuration}s)`);
      if (r.warnings?.length) flags.push(`FFPROBE_WARNINGS(${r.warnings.length})`);
    }
    if (r.discontinuityTag) flags.push("DISCONTINUITY_TAG");
    r.flags = flags;
    if (!r.error) prev = r;
  }
  return results.filter((r) => r.flags.length > 0);
}

function segmentRow(r) {
  return [
    r.name.padEnd(10),
    fmtTime(r.declaredStart).padStart(9),
    fmtTime(r.actualStart).padStart(9),
    fmtNum(r.drift).padStart(7),
    fmtNum(r.actualDuration).padStart(6),
    String(r.keyframes ?? "—").padStart(3),
    (r.firstIsKey ? "yes" : "NO").padStart(4),
    fmtNum(r.gapFromPrev).padStart(6),
    ((r.bytes ?? 0) / 1e6).toFixed(1).padStart(6),
    r.flags.join(" "),
  ].join("  ");
}

function reportSegments(results, flagged) {
  heading("Segments");
  const header = ["segment".padEnd(10), "playlist".padStart(9), "actual".padStart(9), "drift".padStart(7),
    "length".padStart(6), "kf".padStart(3), "kf@0".padStart(4), "gap".padStart(6), "MB".padStart(6), "flags"].join("  ");
  out("'playlist' is where the playlist says a segment starts; 'actual' is where its first frame really is.");
  out(header);
  const near = AT !== undefined
    ? results.filter((r) => Math.abs(r.declaredStart - AT) <= 8 * SECONDS_PER_SEGMENT)
    : [];
  const shown = new Set([...flagged, ...near, ...results.slice(0, 3)]);
  let last = -1;
  for (const r of results) {
    if (!shown.has(r)) continue;
    if (last >= 0 && r.index !== last + 1) out("   …");
    out(segmentRow(r));
    last = r.index;
  }
  // The whole table goes to the report file regardless.
  reportLines.push("", "All segments:", header, ...results.map((r) => redact(segmentRow(r))));

  const formats = [...new Set(results.map((r) => r.format).filter(Boolean))];
  const drifts = results.map((r) => r.drift).filter(Number.isFinite);
  heading("Summary");
  out(`${results.length} segments checked, ${flagged.length} flagged.`);
  out(`Video format(s) seen: ${formats.join(" | ") || "none"}`);
  if (drifts.length) {
    out(`Drift (actual − playlist start): min ${fmtNum(Math.min(...drifts))}s, max ${fmtNum(Math.max(...drifts))}s, last ${fmtNum(drifts[drifts.length - 1])}s`);
  }
  const counts = {};
  for (const r of flagged) for (const f of r.flags) {
    const k = f.replace(/\(.*$/, "");
    counts[k] = (counts[k] ?? 0) + 1;
  }
  for (const [k, n] of Object.entries(counts)) out(`  ${k}: ${n} segment(s)`);
  const firstBad = flagged.find((r) => r.flags.some((f) => !f.startsWith("FFPROBE_WARNINGS")));
  if (firstBad) out(`First problem at ${fmtTime(firstBad.declaredStart)} (${firstBad.name}): ${firstBad.flags.join(" ")}`);
  for (const r of flagged.filter((x) => x.warnings?.length).slice(0, 3)) {
    out(`  ffprobe on ${r.name}: ${r.warnings.slice(0, 3).join(" | ")}`);
  }
  reportJson.summary = { checked: results.length, flagged: flagged.length, counts, formats };
}

// ─── 5. The source file around --at ─────────────────────────────

async function probeSource(item) {
  if (AT === undefined) return;
  const version = item.versions.find((v) => v.index === item.mediaIndex);
  if (!version?.partKey) return;
  const start = Math.max(0, AT - 60);
  const end = AT + 30;
  heading(`5. Source file around ${fmtTime(AT)} (${fmtTime(start)} → ${fmtTime(end)})`);
  const probe = await probePackets(plexUrl(version.partKey), ["-select_streams", "v:0", "-read_intervals", `${start}%${end}`]);
  if (!probe.ok && probe.packets.length === 0) {
    out(`ffprobe couldn't read the source: ${probe.warnings.slice(0, 3).join(" | ")}`);
    return;
  }
  const video = probe.packets.filter((p) => p.codec_type === "video");
  const pts = video.map((p) => parseFloat(p.pts_time)).filter(Number.isFinite).sort((a, b) => a - b);
  const keys = video.filter((p) => String(p.flags ?? "").includes("K")).map((p) => parseFloat(p.pts_time)).sort((a, b) => a - b);
  const gops = keys.slice(1).map((t, i) => t - keys[i]);
  const jumps = pts.slice(1).map((t, i) => ({ at: pts[i], gap: t - pts[i] })).filter((j) => j.gap > 1);
  const stream = probe.streams[0];
  if (stream) out(`Video: ${stream.codec_name} ${stream.profile ?? ""} ${stream.width}×${stream.height} ${stream.pix_fmt ?? ""} level ${stream.level ?? "?"}`);
  out(`${video.length} video packets, ${keys.length} keyframes, keyframe spacing ` +
    `${gops.length ? `${fmtNum(Math.min(...gops))}–${fmtNum(Math.max(...gops))}s (longest gap between keyframes)` : "n/a"}`);
  out(`Keyframes: ${keys.map((k) => fmtTime(k)).join(" ")}`);
  if (jumps.length) for (const j of jumps) out(`TIMESTAMP_JUMP in the source after ${fmtTime(j.at)}: ${fmtNum(j.gap)}s with no frames`);
  else out("No timestamp jumps in the source in this window.");
  if (probe.warnings.length) out(`ffprobe warnings: ${probe.warnings.slice(0, 5).join(" | ")}`);
  reportJson.source = { keyframes: keys, longestGop: gops.length ? Math.max(...gops) : null, jumps, warnings: probe.warnings.slice(0, 20) };
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const ffprobeVersion = await checkFfprobe();
  out(`Plex Discord Theater — Direct Stream diagnosis · ${new Date().toISOString()}`);
  out(`Plex ${PLEX_URL} · client id ${CLIENT_ID} · ${ffprobeVersion}`);
  out(`Bitrate settings used for the probes: ${VIDEO_BITRATE_KBPS}/${VIDEO_PEAK_BITRATE_KBPS} kbps`);

  const item = await describeItem();
  await describePrefs();
  if (!args["skip-decisions"]) await decisionProbes(item);
  if (!args["decisions-only"]) {
    try {
      await walkSegments(item);
    } finally {
      await stopSession(RATING_KEY);
    }
    await probeSource(item);
  }

  await writeFile(path.join(OUT_DIR, "report.txt"), reportLines.join("\n") + "\n");
  await writeFile(path.join(OUT_DIR, "report.json"), redact(JSON.stringify(reportJson, null, 2)));
  console.log(`\nReport written to ${OUT_DIR}`);
}

main().catch(async (err) => {
  console.error(redact(`\nFailed: ${err.stack ?? err.message}`));
  await stopSession(RATING_KEY);
  try {
    await writeFile(path.join(OUT_DIR, "report.txt"), reportLines.join("\n") + `\nFailed: ${redact(err.message)}\n`);
  } catch {
    // Nothing more to do.
  }
  process.exit(1);
});
