#!/usr/bin/env node
/**
 * Phase 0 of the ffmpeg playback engine: what this server's GPU, media mount
 * and Plex can actually do, measured before the engine relies on any of it.
 *
 * Run it inside the container, where the GPU and the media are mapped in:
 *
 *   docker exec -it <container> node scripts/diagnose-ffmpeg.mjs <command> [options]
 *
 *   gpu              ffmpeg's build; /dev/dri and whether the app's process may
 *                    open it; what the GPU decodes and encodes (vainfo); OpenCL;
 *                    test encodes — H.264, HEVC Main10, AV1, HDR labels kept,
 *                    and the three ways of tone mapping.
 *   paths            Whether Plex's files can be read here: a sample from every
 *                    library through MEDIA_PATH_MAP, the map to use when they
 *                    can't, and Plex's stream numbers checked against ffprobe's.
 *   file             One title end to end: what Plex decides for it today, its
 *                    HDR, then real encodes from the file — a copy, HEVC with
 *                    HDR kept, H.264 tone-mapped three ways, several at once —
 *                    with their speed, and samples to look at.
 *   plex-visibility  Whether a stream Plex isn't transcoding shows in Plex's Now
 *                    Playing, and so in Tautulli and Tracearr: timeline reports
 *                    for a test session, phase by phase, while you watch.
 *   all              gpu, then paths.
 *
 * Everything printed is also written to <out>/<time>-<command>.txt and .json
 * (default /data/diagnose, on the data volume). The Plex token is never written.
 * Nothing here changes how the app plays: it runs its own ffmpeg, and its own
 * test session under its own Plex client identifier.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// ─── Arguments ──────────────────────────────────────────────────

const HELP = `
Usage: node scripts/diagnose-ffmpeg.mjs <gpu|paths|file|plex-visibility|all> [options]

  --device <path>        Render node (default FFMPEG_HWACCEL_DEVICE or /dev/dri/renderD128)
  --out <dir>            Where reports and samples go (default /data/diagnose)
  --plex-url <url>       Overrides PLEX_URL.
  --plex-token <token>   Overrides PLEX_TOKEN.

paths
  --count <n>            Titles sampled per library (default 10)
  --probe <n>            Files whose streams are checked against ffprobe (default 20)

file
  --rating-key <id>      The movie or episode (required)
  --media-index <n>      Which of its versions (default: the one the app plays)
  --at <seconds>         Where in it to encode from (default 10 min, or a quarter in)
  --seconds <n>          How much of it each encode takes (default 20)
  --concurrent <n>       Encodes run at once in the last test (default 3)
  --skip-plex            Leave out the Plex decision probes

plex-visibility
  --rating-key <id>      The title the test session reports (required)
  --phase-seconds <n>    Length of the first phase (default 45); the rest are shorter
`;

const argv = process.argv.slice(2);
const COMMAND = argv[0] && !argv[0].startsWith("--") ? argv.shift() : null;
const args = {};
for (let i = 0; i < argv.length; i++) {
  const name = argv[i].replace(/^--/, "");
  if (["help", "skip-plex"].includes(name)) {
    args[name] = true;
    continue;
  }
  const value = argv[++i];
  if (value === undefined || !argv[i - 1].startsWith("--")) {
    console.error(`Unexpected argument: ${argv[i - 1]}`, HELP);
    process.exit(2);
  }
  args[name] = value;
}
if (args.help || !["gpu", "paths", "file", "plex-visibility", "all"].includes(COMMAND ?? "")) {
  console.log(HELP);
  process.exit(args.help ? 0 : 2);
}

const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};
const JF = "/usr/lib/jellyfin-ffmpeg";
const FFMPEG = process.env.FFMPEG_PATH || (exists(`${JF}/ffmpeg`) ? `${JF}/ffmpeg` : "ffmpeg");
const FFPROBE = process.env.FFPROBE_PATH || (exists(`${JF}/ffprobe`) ? `${JF}/ffprobe` : "ffprobe");
const VAINFO = exists(`${JF}/vainfo`) ? `${JF}/vainfo` : "vainfo";
const DEVICE = args.device ?? process.env.FFMPEG_HWACCEL_DEVICE ?? "/dev/dri/renderD128";
const PLEX_URL = (args["plex-url"] ?? process.env.PLEX_URL ?? "").replace(/\/$/, "");
const PLEX_TOKEN = args["plex-token"] ?? process.env.PLEX_TOKEN ?? "";
const OUT_ROOT = path.resolve(args.out ?? (exists("/data") ? "/data/diagnose" : "diagnose-out"));
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
/** This script's own Plex client identifier, never the app's. */
const DIAG_CLIENT = "pdt-diagnose-ffmpeg";

function needPlex() {
  if (!PLEX_URL || !PLEX_TOKEN) {
    console.error("Set PLEX_URL and PLEX_TOKEN (the container has them), or pass --plex-url / --plex-token.");
    process.exit(2);
  }
}

function positive(name, fallback) {
  if (args[name] === undefined) return fallback;
  const n = Number(args[name]);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`--${name} must be a number`);
    process.exit(2);
  }
  return n;
}

// ─── Report ─────────────────────────────────────────────────────

const lines = [];
const report = { command: COMMAND, startedAt: new Date().toISOString(), ffmpeg: FFMPEG, device: DEVICE };
// Only something token-sized: a stand-in like "x" would be masked everywhere.
const redact = (s) => (PLEX_TOKEN.length >= 8 ? String(s).split(PLEX_TOKEN).join("<token>") : String(s));
function out(s = "") {
  const text = redact(s);
  console.log(text);
  lines.push(text);
}
function heading(s) {
  out("");
  out(`── ${s} ${"─".repeat(Math.max(3, 74 - s.length))}`);
}
const tick = (ok) => (ok ? "✓" : "✗");

async function saveReport() {
  await mkdir(OUT_ROOT, { recursive: true });
  const base = path.join(OUT_ROOT, `${STAMP}-${COMMAND}`);
  await writeFile(`${base}.txt`, lines.join("\n") + "\n");
  await writeFile(`${base}.json`, redact(JSON.stringify(report, null, 2)) + "\n");
  console.log(`\nReport: ${base}.txt (and .json)`);
}

// ─── Processes ──────────────────────────────────────────────────

function run(cmd, cmdArgs, { timeoutMs = 180_000, onStdout } = {}) {
  return new Promise((resolve) => {
    const started = performance.now();
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(cmd, cmdArgs, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: -1, stdout, stderr: String(err), ms: 0 });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => {
      const s = d.toString();
      stdout = (stdout + s).slice(-2_000_000);
      onStdout?.(s, performance.now() - started);
    });
    child.stderr.on("data", (d) => {
      stderr = (stderr + d.toString()).slice(-2_000_000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${err}`, ms: performance.now() - started });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, signal, stdout, stderr, ms: performance.now() - started });
    });
  });
}

/** ffmpeg's last progress line: frames, fps and speed against real time. */
function ffStats(stderr) {
  const last = [...stderr.matchAll(/frame=\s*(\d+)\s+fps=\s*([\d.]+).*?speed=\s*([\d.]+)x/g)].at(-1);
  return last ? { frames: Number(last[1]), fps: Number(last[2]), speed: Number(last[3]) } : null;
}

/** The lines of ffmpeg's output that say why something failed. */
function whyFailed(stderr, n = 6) {
  return stderr
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("frame="))
    .filter((l) => /error|fail|invalid|not supported|unsupported|cannot|could not|no such|unable|denied|not found|impossible/i.test(l))
    .slice(-n);
}

/** The rate control the QSV encoder chose, as it says at -v verbose. */
const rateControl = (stderr) => stderr.match(/Using the (.+?) ratecontrol method/i)?.[1] ?? null;

const FF = ["-hide_banner", "-nostdin", "-y"];
/** VAAPI on the render node, Intel's driver, and QSV derived from it — the
 *  way Jellyfin sets up Intel on Linux. */
const hwInit = ({ opencl = false } = {}) => [
  "-init_hw_device", `vaapi=va:${DEVICE},driver=iHD`,
  "-init_hw_device", "qsv=qs@va",
  ...(opencl ? ["-init_hw_device", "opencl=ocl@va"] : []),
  "-filter_hw_device", "qs",
];
const hwDecode = ["-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi", "-hwaccel_device", "va"];
const TAGS_SDR = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"];
const tagsHdr = (trc) => ["-color_primaries", "bt2020", "-color_trc", trc, "-colorspace", "bt2020nc", "-color_range", "tv"];

async function ffprobeJSON(file, extra) {
  const r = await run(FFPROBE, ["-v", "error", "-of", "json", ...extra, file], { timeoutMs: 60_000 });
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

/** A video file's color labels and the HDR metadata on its first frame. */
async function hdrLabels(file, readInterval) {
  const s = await ffprobeJSON(file, ["-select_streams", "v:0", "-show_entries",
    "stream=codec_name,profile,pix_fmt,color_transfer,color_primaries,color_space,width,height,field_order,sample_aspect_ratio,r_frame_rate"]);
  const f = await ffprobeJSON(file, ["-select_streams", "v:0", "-read_intervals", readInterval ?? "%+#1",
    "-show_frames", "-show_entries", "frame=color_transfer,side_data_list"]);
  const stream = s?.streams?.[0] ?? null;
  const frame = f?.frames?.[0] ?? null;
  const side = (frame?.side_data_list ?? []).map((d) => d.side_data_type);
  const mastering = (frame?.side_data_list ?? []).find((d) => /mastering display/i.test(d.side_data_type));
  const light = (frame?.side_data_list ?? []).find((d) => /content light/i.test(d.side_data_type));
  return {
    stream,
    side,
    masteringDisplay: !!mastering,
    contentLight: light ? { maxCLL: light.max_content ?? null, maxFALL: light.max_average ?? null } : null,
    maxLuminance: mastering?.max_luminance ?? null,
    dovi: side.some((t) => /dovi|dolby vision/i.test(t)),
  };
}

// ─── Plex ───────────────────────────────────────────────────────

async function plex(p, { params = {}, headers = {}, method = "GET", timeoutMs = 30_000 } = {}) {
  const url = new URL(`${PLEX_URL}${p}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        "X-Plex-Token": PLEX_TOKEN,
        "X-Plex-Client-Identifier": DIAG_CLIENT,
        "X-Plex-Product": "Plex Discord Theater (diagnose)",
        ...headers,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
async function plexJSON(p, opts) {
  const res = await plex(p, opts);
  if (!res.ok) throw new Error(`${p} → HTTP ${res.status}`);
  return res.json();
}

// The version the app plays: 4K hidden whenever anything else exists, then the
// widest, then the highest bitrate (services/media-versions.ts).
const RESOLUTION_WIDTHS = { "4k": 3840, 2160: 3840, 1080: 1920, 720: 1280, 576: 1024, 480: 854, sd: 720 };
function frameWidth(m) {
  if (m.width > 0) return m.width;
  const known = RESOLUTION_WIDTHS[String(m.videoResolution ?? "").toLowerCase()];
  if (known) return known;
  return m.height > 0 ? Math.round((m.height * 16) / 9) : 0;
}
function defaultMediaIndex(media) {
  const indexed = media.map((m, index) => ({ m, index }));
  const anyUhd = indexed.some(({ m }) => frameWidth(m) >= 3000);
  const anyOther = indexed.some(({ m }) => frameWidth(m) < 3000);
  const playable = anyUhd && anyOther ? indexed.filter(({ m }) => frameWidth(m) < 3000) : indexed;
  playable.sort((a, b) => frameWidth(b.m) - frameWidth(a.m) || (b.m.bitrate ?? 0) - (a.m.bitrate ?? 0) || a.index - b.index);
  return playable[0]?.index ?? 0;
}

/** HDR as Plex describes a video stream. */
function hdrOf(v) {
  if (!v) return "SDR";
  if (v.DOVIPresent || v.DOVIProfile != null) {
    const p = Number(v.DOVIProfile);
    const bl = Number(v.DOVIBLCompatID);
    if (p === 8) return bl === 1 ? "DV P8.1" : bl === 4 ? "DV P8.4" : bl === 2 ? "DV P8.2" : "DV P8";
    return Number.isFinite(p) ? `DV P${p}` : "DV";
  }
  const trc = String(v.colorTrc ?? "").toLowerCase();
  if (trc === "smpte2084") return "HDR10";
  if (trc === "arib-std-b67") return "HLG";
  return "SDR";
}
const isHdr = (cls) => cls !== "SDR" && cls !== "DV P8.2";

// ─── Paths ──────────────────────────────────────────────────────

/** MEDIA_PATH_MAP: "plexPrefix=>localPrefix,…". */
const MAP = (process.env.MEDIA_PATH_MAP ?? "")
  .split(",")
  .map((pair) => pair.split("=>").map((s) => s.trim()))
  .filter((p) => p.length === 2 && p[0]);
function mapPath(p) {
  for (const [from, to] of MAP) {
    if (p === from || p.startsWith(from.endsWith("/") ? from : `${from}/`)) return to + p.slice(from.length);
  }
  return p;
}
function readable(p) {
  try {
    const fd = fs.openSync(p, "r");
    try {
      fs.readSync(fd, Buffer.alloc(4096), 0, 4096, 0);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}
/** This container's mounts, from the kernel — not the system's own. */
function mediaMounts() {
  let text = "";
  try {
    text = fs.readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return [];
  }
  const unescape = (s) => s.replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const f = line.split(" ");
      const dash = f.indexOf("-");
      return { point: unescape(f[4]), ro: f[5].split(",").includes("ro"), fstype: f[dash + 1], source: unescape(f[dash + 2] ?? "") };
    })
    .filter((m) => !["/", "/proc", "/sys", "/dev", "/app"].includes(m.point))
    .filter((m) => !/^\/(proc|sys|dev)\//.test(m.point) && !/^\/etc\/(hosts|hostname|resolv\.conf)$/.test(m.point));
}
/** Where a file Plex names might be in this container, and the map that gets there. */
function discover(plexPath, mounts) {
  const parts = plexPath.split("/").filter(Boolean);
  for (let k = 1; k < parts.length; k++) {
    const suffix = parts.slice(k).join("/");
    for (const m of mounts) {
      const candidate = path.posix.join(m.point, suffix);
      if (exists(candidate)) return { from: `/${parts.slice(0, k).join("/")}`, to: m.point, path: candidate };
    }
  }
  return null;
}

// Plex's codec names → ffmpeg's, for checking stream numbers.
const CODEC = {
  srt: "subrip", pgs: "hdmv_pgs_subtitle", vobsub: "dvd_subtitle", dvd_subtitle: "dvd_subtitle", ssa: "ass",
  dca: "dts", "dca-ma": "dts", mpeg2video: "mpeg2video", msmpeg4v3: "msmpeg4v3",
};
const sameCodec = (plexCodec, ffCodec) => {
  const a = CODEC[String(plexCodec ?? "").toLowerCase()] ?? String(plexCodec ?? "").toLowerCase();
  const b = String(ffCodec ?? "").toLowerCase();
  return a === b || (a.startsWith("pcm") && b.startsWith("pcm")) || (a === "mp3" && b === "mp3float");
};
const STREAM_TYPE = { 1: "video", 2: "audio", 3: "subtitle" };

// ─── gpu ────────────────────────────────────────────────────────

/** The app's own node process: the one that has to open the GPU. */
function appProcess() {
  let pids = [];
  try {
    pids = fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p));
  } catch {
    return null;
  }
  for (const pid of pids) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
      if (!cmd.includes("packages/server/dist/index.js")) continue;
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const uid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1]);
      const gid = Number(status.match(/^Gid:\s+(\d+)/m)?.[1]);
      const groups = (status.match(/^Groups:\s*(.*)$/m)?.[1] ?? "").trim().split(/\s+/).filter(Boolean).map(Number);
      return { pid: Number(pid), uid, groups: [...new Set([gid, ...groups])] };
    } catch {
      // Gone, or not ours to read.
    }
  }
  return null;
}

const SYNTH = ["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=24"];
const HDR_PARAMS = "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv";

async function encodeTest(name, ffArgs, frames) {
  const r = await run(FFMPEG, [...FF, "-v", "verbose", ...ffArgs, "-frames:v", String(frames), "-f", "null", "-"]);
  const stats = ffStats(r.stderr);
  const ok = r.code === 0 && (stats?.frames ?? 0) >= frames * 0.9;
  const rc = rateControl(r.stderr);
  const fps = stats?.fps ? `${String(stats.fps).padStart(5)} fps  ` : "";
  out(`${tick(ok)} ${name.padEnd(46)} ${ok ? `${fps}${String(stats.speed).padStart(5)}× real time${rc ? `  (${rc})` : ""}` : "failed"}`);
  if (!ok) for (const l of whyFailed(r.stderr)) out(`      ${l}`);
  return { name, ok, fps: stats?.fps ?? null, speed: stats?.speed ?? null, rateControl: rc, error: ok ? null : whyFailed(r.stderr) };
}

async function gpu() {
  heading("ffmpeg");
  const ver = await run(FFMPEG, ["-hide_banner", "-version"], { timeoutMs: 15_000 });
  if (ver.code !== 0) {
    out(`No ffmpeg at ${FFMPEG}: ${ver.stderr.trim().split("\n")[0]}`);
    report.gpu = { ffmpeg: null };
    return;
  }
  const config = ver.stdout.match(/configuration: (.*)/)?.[1] ?? "";
  const libs = ["libvpl", "vaapi", "opencl", "vulkan", "libplacebo", "libzimg", "libass", "libx264", "libx265"];
  out(ver.stdout.split("\n")[0]);
  out(`built with: ${libs.map((l) => `${config.includes(`--enable-${l}`) ? "✓" : "·"} ${l}`).join("  ")}`);
  const listed = async (flag) => (await run(FFMPEG, ["-hide_banner", flag])).stdout;
  const [encoders, filters] = [await listed("-encoders"), await listed("-filters")];
  const has = (list, name) => new RegExp(`^\\s*[A-Z.|]+\\s+${name}\\s`, "m").test(list);
  const wantEnc = ["h264_qsv", "hevc_qsv", "av1_qsv", "h264_vaapi", "hevc_vaapi", "av1_vaapi", "libx264", "libx265"];
  const wantFilt = ["scale_qsv", "vpp_qsv", "overlay_qsv", "scale_vaapi", "tonemap_vaapi", "deinterlace_vaapi", "hwmap",
    "tonemap_opencl", "overlay_opencl", "tonemapx", "libplacebo", "zscale", "tonemap", "bwdif", "subtitles"];
  out(`encoders: ${wantEnc.map((e) => `${has(encoders, e) ? "✓" : "·"} ${e}`).join("  ")}`);
  out(`filters:  ${wantFilt.map((f) => `${has(filters, f) ? "✓" : "·"} ${f}`).join("  ")}`);
  report.gpu = {
    version: ver.stdout.split("\n")[0],
    libs: Object.fromEntries(libs.map((l) => [l, config.includes(`--enable-${l}`)])),
    encoders: Object.fromEntries(wantEnc.map((e) => [e, has(encoders, e)])),
    filters: Object.fromEntries(wantFilt.map((f) => [f, has(filters, f)])),
  };

  heading("GPU device");
  let nodes = [];
  try {
    nodes = fs.readdirSync("/dev/dri");
  } catch {
    // None mapped in.
  }
  const app = appProcess();
  if (nodes.length === 0) {
    out("No /dev/dri in this container. Map the GPU in compose:");
    out("  devices:");
    out("    - /dev/dri/renderD128:/dev/dri/renderD128");
  }
  report.gpu.nodes = [];
  for (const n of nodes) {
    const st = fs.statSync(`/dev/dri/${n}`);
    const mode = st.mode & 0o777;
    const canOpen = app
      ? (st.uid === app.uid && mode & 0o600) || (app.groups.includes(st.gid) && mode & 0o060) || mode & 0o006
      : null;
    out(`/dev/dri/${n.padEnd(11)} owner ${st.uid}:${st.gid}  mode ${mode.toString(8)}${app ? `  app can open: ${canOpen ? "yes" : "NO"}` : ""}`);
    report.gpu.nodes.push({ node: n, uid: st.uid, gid: st.gid, mode: mode.toString(8), appCanOpen: canOpen ? true : canOpen === null ? null : false });
  }
  if (app) out(`app process: pid ${app.pid}, uid ${app.uid}, groups ${app.groups.join(",")}`);
  else out("app process: not found (this is only the diagnose script)");
  report.gpu.app = app;

  heading("What the GPU decodes and encodes (vainfo)");
  const va = await run(VAINFO, ["--display", "drm", "--device", DEVICE], { timeoutMs: 20_000 });
  const vaText = `${va.stdout}\n${va.stderr}`;
  const driver = vaText.match(/Driver version:\s*(.*)/)?.[1]?.trim() ?? null;
  const entry = {};
  for (const m of vaText.matchAll(/(VAProfile\w+)\s*:\s*(VAEntrypoint\w+)/g)) (entry[m[1]] ??= new Set()).add(m[2]);
  if (!driver && Object.keys(entry).length === 0) {
    out(`vainfo couldn't open ${DEVICE}:`);
    for (const l of vaText.trim().split("\n").slice(-6)) out(`  ${l.trim()}`);
  } else {
    out(`driver: ${driver ?? "?"}`);
    const rows = [
      ["H.264", "VAProfileH264High"], ["HEVC 8-bit", "VAProfileHEVCMain"], ["HEVC 10-bit", "VAProfileHEVCMain10"],
      ["AV1", "VAProfileAV1Profile0"], ["VP9 10-bit", "VAProfileVP9Profile2"], ["MPEG-2", "VAProfileMPEG2Main"],
      ["VC-1", "VAProfileVC1Advanced"],
    ];
    report.gpu.vaapi = { driver };
    for (const [label, profile] of rows) {
      const e = entry[profile] ?? new Set();
      const decode = e.has("VAEntrypointVLD");
      const encodeLP = e.has("VAEntrypointEncSliceLP");
      const encode = encodeLP || e.has("VAEntrypointEncSlice");
      out(`  ${label.padEnd(12)} decode ${decode ? "✓" : "·"}   encode ${encode ? `✓${encodeLP && !e.has("VAEntrypointEncSlice") ? " (low power only)" : encodeLP ? " (full and low power)" : " (full power)"}` : "·"}`);
      report.gpu.vaapi[label] = { decode, encode, lowPower: encodeLP };
    }
  }

  heading("OpenCL (tone mapping on the GPU)");
  const cl = await run("clinfo", ["-l"], { timeoutMs: 20_000 });
  if (cl.code === 0) for (const l of cl.stdout.trim().split("\n")) out(`  ${l}`);
  else out("  clinfo not available here");
  const derive = await run(FFMPEG, [...FF, "-v", "verbose", "-init_hw_device", `vaapi=va:${DEVICE},driver=iHD`,
    "-init_hw_device", "opencl=ocl@va", "-f", "lavfi", "-i", "nullsrc=s=64x64", "-frames:v", "1", "-f", "null", "-"]);
  out(`${tick(derive.code === 0)} OpenCL derived from the GPU's VAAPI device (what tonemap_opencl needs)`);
  if (derive.code !== 0) for (const l of whyFailed(derive.stderr)) out(`      ${l}`);
  report.gpu.openclFromVaapi = derive.code === 0;

  heading("Test encodes (synthetic 1080p, 10 s each)");
  const N = 240;
  const toQsv = (fmt) => `format=${fmt},hwupload=extra_hw_frames=64,format=qsv`;
  const rate = ["-b:v", "8M", "-maxrate", "8M", "-bufsize", "16M"];
  report.gpu.encodes = [
    await encodeTest("H.264 (h264_qsv, low power)", [...hwInit(), ...SYNTH, "-vf", toQsv("nv12"),
      "-c:v", "h264_qsv", "-low_power", "1", "-profile:v", "high", "-preset", "medium", ...rate], N),
    await encodeTest("HEVC Main10 (hevc_qsv, low power)", [...hwInit(), ...SYNTH, "-vf", toQsv("p010le"),
      "-c:v", "hevc_qsv", "-low_power", "1", "-profile:v", "main10", "-preset", "medium", ...rate], N),
    await encodeTest("HEVC Main10, look-ahead (extbrc)", [...hwInit(), ...SYNTH, "-vf", toQsv("p010le"),
      "-c:v", "hevc_qsv", "-low_power", "1", "-profile:v", "main10", "-preset", "medium", "-extbrc", "1",
      "-look_ahead_depth", "40", ...rate], N),
    await encodeTest("HEVC Main10, quality + cap (QVBR)", [...hwInit(), ...SYNTH, "-vf", toQsv("p010le"),
      "-c:v", "hevc_qsv", "-low_power", "1", "-profile:v", "main10", "-preset", "medium", "-global_quality", "25",
      ...rate], N),
    await encodeTest("AV1 10-bit (av1_qsv)", [...hwInit(), ...SYNTH, "-vf", toQsv("p010le"),
      "-c:v", "av1_qsv", "-preset", "medium", ...rate], N),
    await encodeTest("HEVC Main10 (hevc_vaapi)", ["-init_hw_device", `vaapi=va:${DEVICE},driver=iHD`,
      "-filter_hw_device", "va", ...SYNTH, "-vf", "format=p010le,hwupload", "-c:v", "hevc_vaapi",
      "-profile:v", "main10", ...rate], N),
    await encodeTest("H.264 in software (libx264 faster)", [...SYNTH, "-vf", "format=yuv420p",
      "-c:v", "libx264", "-preset", "faster", "-crf", "20", "-maxrate", "8M", "-bufsize", "16M"], N),
  ];

  heading("HDR labels kept by the HEVC encoder (synthetic)");
  await mkdir(OUT_ROOT, { recursive: true });
  const labelFile = path.join(OUT_ROOT, `${STAMP}-hdr-labels.mp4`);
  const lab = await run(FFMPEG, [...FF, ...hwInit(), ...SYNTH, "-frames:v", "48", "-vf",
    `format=p010le,${HDR_PARAMS},hwupload=extra_hw_frames=64,format=qsv`, "-c:v", "hevc_qsv", "-low_power", "1",
    "-profile:v", "main10", ...rate, ...tagsHdr("smpte2084"), labelFile]);
  if (lab.code !== 0) {
    out("✗ the encode failed");
    for (const l of whyFailed(lab.stderr)) out(`      ${l}`);
    report.gpu.hdrLabels = { ok: false };
  } else {
    const got = await hdrLabels(labelFile);
    const s = got.stream ?? {};
    const ok = s.color_transfer === "smpte2084" && s.color_primaries === "bt2020";
    out(`${tick(ok)} ${s.codec_name ?? "?"} ${s.profile ?? ""} ${s.pix_fmt ?? ""}: transfer ${s.color_transfer ?? "none"}, primaries ${s.color_primaries ?? "none"}, matrix ${s.color_space ?? "none"}`);
    out("  (The brightness metadata needs a real HDR source: the file command checks it.)");
    report.gpu.hdrLabels = { ok, stream: s };
  }
  fs.rmSync(labelFile, { force: true });

  heading("Tone mapping, three ways (synthetic HDR10 → SDR, 2 s each)");
  const hdrSrc = `format=p010le,${HDR_PARAMS}`;
  const tm = "tonemap=mobius:desat=0:peak=100:t=bt709:m=bt709:p=bt709";
  report.gpu.tonemap = [
    await encodeTest("OpenCL on the GPU (tonemap_opencl, mobius)", ["-init_hw_device", `vaapi=va:${DEVICE},driver=iHD`,
      "-init_hw_device", "opencl=ocl@va", "-filter_hw_device", "ocl", ...SYNTH, "-vf",
      `${hdrSrc},hwupload,tonemap_opencl=${tm}:format=nv12,hwdownload,format=nv12`, "-c:v", "libx264", "-preset", "ultrafast"], 48),
    await encodeTest("QSV video engine (vpp_qsv tonemap)", [...hwInit(), ...SYNTH, "-vf",
      `${hdrSrc},hwupload=extra_hw_frames=64,format=qsv,vpp_qsv=tonemap=1:format=nv12`, "-c:v", "h264_qsv", "-low_power", "1"], 48),
    await encodeTest("Software (tonemapx, mobius)", [...SYNTH, "-vf", `${hdrSrc},tonemapx=${tm}:format=yuv420p`,
      "-c:v", "libx264", "-preset", "ultrafast"], 48),
  ];
}

// ─── paths ──────────────────────────────────────────────────────

async function paths() {
  needPlex();
  heading("Library mount");
  out(`MEDIA_PATH_MAP: ${MAP.length ? MAP.map(([a, b]) => `${a} => ${b}`).join(", ") : "(empty: Plex's paths are used as they are)"}`);
  const mounts = mediaMounts();
  out(`mounts: ${mounts.map((m) => `${m.point}${m.ro ? " (read-only)" : ""}`).join(", ") || "(couldn't read them)"}`);
  const sections = ((await plexJSON("/library/sections")).MediaContainer?.Directory ?? [])
    .filter((s) => s.type === "movie" || s.type === "show");
  const count = positive("count", 10);
  const suggestions = new Map();
  const found = [];
  report.paths = { map: MAP, mounts, sections: [] };
  for (const s of sections) {
    const type = s.type === "show" ? 4 : 1;
    const head = await plexJSON(`/library/sections/${s.key}/all`, {
      params: { type, "X-Plex-Container-Start": 0, "X-Plex-Container-Size": 0 },
    });
    const total = head.MediaContainer?.totalSize ?? 0;
    const offsets = [...new Set(Array.from({ length: Math.min(count, total) }, (_, i) => Math.floor(((i + 0.5) * total) / Math.min(count, total))))];
    let ok = 0;
    const failed = [];
    for (const offset of offsets) {
      const page = await plexJSON(`/library/sections/${s.key}/all`, {
        params: { type, "X-Plex-Container-Start": offset, "X-Plex-Container-Size": 1 },
      });
      const item = page.MediaContainer?.Metadata?.[0];
      const media = item?.Media ?? [];
      const part = media[defaultMediaIndex(media)]?.Part?.[0];
      if (!part?.file) continue;
      const local = mapPath(part.file);
      if (readable(local)) {
        ok++;
        found.push({ ratingKey: item.ratingKey, plexPath: part.file, local });
        continue;
      }
      const hit = discover(part.file, mounts);
      if (hit) {
        const key = `${hit.from}=>${hit.to}`;
        suggestions.set(key, (suggestions.get(key) ?? 0) + 1);
        if (readable(hit.path)) found.push({ ratingKey: item.ratingKey, plexPath: part.file, local: hit.path });
      }
      failed.push({ plexPath: part.file, tried: local });
    }
    out(`${tick(ok === offsets.length)} ${s.title}: ${ok}/${offsets.length} readable${failed[0] ? `   e.g. Plex has ${failed[0].plexPath}, not found at ${failed[0].tried}` : ""}`);
    report.paths.sections.push({ title: s.title, total, sampled: offsets.length, readable: ok, failed: failed.slice(0, 3) });
  }
  if (suggestions.size) {
    const best = [...suggestions.entries()].sort((a, b) => b[1] - a[1]);
    out("");
    out(`Files found under another path. Set MEDIA_PATH_MAP=${best.map(([k]) => k).join(",")}`);
    report.paths.suggestedMap = best.map(([k]) => k).join(",");
  }

  heading("Plex's stream numbers vs ffprobe's");
  const probeN = positive("probe", 20);
  let checked = 0;
  let mismatched = 0;
  const examples = [];
  for (const f of found.slice(0, probeN)) {
    const meta = (await plexJSON(`/library/metadata/${f.ratingKey}`)).MediaContainer?.Metadata?.[0];
    const part = (meta?.Media ?? []).flatMap((m) => m.Part ?? []).find((p) => p.file === f.plexPath);
    const probe = await ffprobeJSON(f.local, ["-show_entries", "stream=index,codec_type,codec_name"]);
    if (!part || !probe) continue;
    checked++;
    const bad = (part.Stream ?? [])
      .filter((st) => !st.key && st.index != null && STREAM_TYPE[st.streamType])
      .filter((st) => {
        const ff = probe.streams?.find((x) => x.index === st.index);
        return !ff || ff.codec_type !== STREAM_TYPE[st.streamType] || !sameCodec(st.codec, ff.codec_name);
      });
    if (bad.length) {
      mismatched++;
      const st = bad[0];
      const ff = probe.streams?.find((x) => x.index === st.index);
      examples.push(`${f.plexPath}: Plex #${st.index} ${STREAM_TYPE[st.streamType]} ${st.codec}, ffprobe #${st.index} ${ff ? `${ff.codec_type} ${ff.codec_name}` : "missing"}`);
    }
  }
  out(`${tick(mismatched === 0 && checked > 0)} ${checked} files checked, ${mismatched} where Plex's stream numbers don't match ffprobe's`);
  for (const e of examples.slice(0, 5)) out(`  ${e}`);
  report.paths.streamIndex = { checked, mismatched, examples };
}

// ─── file ───────────────────────────────────────────────────────

/**
 * The app's profile for Plex (routes/plex.ts profileExtra), and Plex's decision
 * under it: "copy" as the app asks for a player that decodes HEVC; "h264" as
 * its final ask for one that doesn't — copying still allowed, at the
 * re-encode's bitrate.
 */
function profileExtra(offer) {
  return [
    "add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts" +
      `&videoCodec=${offer === "copy" ? "h264,hevc" : "h264"}&audioCodec=aac&replace=true)`,
    ...(offer === "copy"
      ? ["add-limitation(scope=videoCodec&scopeName=hevc&type=upperBound&name=video.bitDepth&value=10&replace=true)"]
      : []),
  ].join("+");
}
async function plexDecision(ratingKey, mediaIndex, offer) {
  const session = randomUUID();
  const copy = offer === "copy";
  const res = await plex("/video/:/transcode/universal/decision", {
    params: {
      hasMDE: 1, path: `/library/metadata/${ratingKey}`, mediaIndex, partIndex: 0, protocol: "hls", fastSeek: 1,
      directPlay: 0, directStream: 1, directStreamAudio: 1, videoResolution: "1920x1080",
      videoBitrate: copy ? 200000 : 12000, peakBitrate: copy ? 200000 : 20000, videoQuality: 99, autoAdjustQuality: 0,
      location: "lan", mediaBufferSize: 102400, secondsPerSegment: 3, subtitles: "none", transcodeSessionId: session,
    },
    headers: {
      "X-Plex-Session-Identifier": session, "X-Plex-Client-Profile-Extra": profileExtra(offer),
      "X-Plex-Platform": "Chrome", "X-Plex-Device": "Browser",
    },
  });
  const body = await res.json().catch(() => null);
  const mc = body?.MediaContainer;
  const streams = mc?.Metadata?.[0]?.Media?.[0]?.Part?.[0]?.Stream ?? [];
  const v = streams.find((s) => s.streamType === 1);
  const a = streams.find((s) => s.streamType === 2);
  return {
    status: res.status, code: mc?.generalDecisionCode ?? null, text: mc?.generalDecisionText ?? null,
    video: v ? { decision: v.decision ?? null, codec: v.codec ?? null } : null,
    audio: a ? { decision: a.decision ?? null, codec: a.codec ?? null, channels: a.channels ?? null } : null,
  };
}

/** Even-sized frame no bigger than 1920x1080, unless the file is only just over (transcodeFrame). */
function targetFrame(w, h) {
  if (w <= 2048 && h <= 1200) return [w - (w % 2), h - (h % 2)];
  const scale = Math.min(1920 / w, 1080 / h);
  const even = (n) => Math.max(2, Math.round((n * scale) / 2) * 2);
  return [even(w), even(h)];
}

async function file() {
  needPlex();
  const ratingKey = String(args["rating-key"] ?? "");
  if (!/^\d+$/.test(ratingKey)) {
    console.error("--rating-key <id> is required");
    process.exit(2);
  }
  const item = (await plexJSON(`/library/metadata/${ratingKey}`)).MediaContainer?.Metadata?.[0];
  if (!item) throw new Error(`No item ${ratingKey}`);
  const media = item.Media ?? [];
  const mediaIndex = args["media-index"] !== undefined ? positive("media-index", 0) : defaultMediaIndex(media);
  const version = media[mediaIndex];
  const part = version?.Part?.[0];
  if (!part) throw new Error(`Item ${ratingKey} has no version ${mediaIndex}`);
  const video = (part.Stream ?? []).find((s) => s.streamType === 1);
  const cls = hdrOf(video);
  const durationS = (item.duration ?? version.duration ?? 0) / 1000;
  const at = positive("at", Math.round(Math.min(600, durationS * 0.25)));
  const seconds = positive("seconds", 20);
  const title = item.type === "episode"
    ? `${item.grandparentTitle} S${item.parentIndex}E${item.index} "${item.title}"`
    : `${item.title}${item.year ? ` (${item.year})` : ""}`;

  heading(`${title} (ratingKey ${ratingKey}, version ${mediaIndex})`);
  out(`${version.container} · ${version.videoCodec} ${video?.bitDepth ?? "?"}-bit · ${version.width}x${version.height} · ${version.bitrate} kbps · ${version.audioCodec} ${version.audioChannels}ch`);
  out(`HDR: ${cls}${video?.colorTrc ? `  (transfer ${video.colorTrc}, primaries ${video.colorPrimaries ?? "?"})` : ""}`);
  let local = mapPath(part.file ?? "");
  let input;
  if (part.file && readable(local)) {
    out(`file: ${local} ${local !== part.file ? `(Plex: ${part.file})` : ""}`);
    input = ["-i", local];
  } else {
    const hit = part.file ? discover(part.file, mediaMounts()) : null;
    if (hit && readable(hit.path)) {
      local = hit.path;
      out(`file: ${local}  (found with MEDIA_PATH_MAP=${hit.from}=>${hit.to}, which isn't set)`);
      input = ["-i", local];
    } else {
      out(`file: not readable here (Plex: ${part.file}). Reading it through Plex instead, which is slower.`);
      local = null;
      input = ["-headers", `X-Plex-Token: ${PLEX_TOKEN}\r\n`, "-i", `${PLEX_URL}${part.key}`];
    }
  }
  report.file = { ratingKey, title, mediaIndex, hdr: cls, plexPath: part.file, local, at, seconds, encodes: [] };

  if (!args["skip-plex"]) {
    heading("What the Plex engine does with it today");
    for (const [offer, label] of [["copy", "player that decodes HEVC"], ["h264", "player that can't (Firefox)"]]) {
      try {
        const d = await plexDecision(ratingKey, mediaIndex, offer);
        out(`${label.padEnd(30)} video ${d.video?.decision ?? "?"} → ${d.video?.codec ?? "?"}, audio ${d.audio?.decision ?? "?"} → ${d.audio?.codec ?? "?"} ${d.audio?.channels ?? ""}ch   (${d.code} ${d.text ?? ""})`);
        report.file[`plex_${offer}`] = d;
      } catch (err) {
        out(`${label}: decision failed (${err.message})`);
      }
    }
    try {
      const prefs = ((await plexJSON("/:/prefs")).MediaContainer?.Setting ?? []).filter((s) => /tonemap|hdr/i.test(s.id));
      for (const s of prefs) out(`Plex setting ${s.id} = ${JSON.stringify(s.value)}`);
      report.file.plexPrefs = Object.fromEntries(prefs.map((s) => [s.id, s.value]));
    } catch (err) {
      out(`Plex settings unreadable (${err.message})`);
    }
  }

  heading("The file, as ffprobe reads it");
  const src = local ? await hdrLabels(local, `${at}%+#1`) : null;
  const s = src?.stream;
  if (s) {
    out(`${s.codec_name} ${s.profile ?? ""} ${s.pix_fmt} ${s.width}x${s.height} ${s.r_frame_rate}  transfer ${s.color_transfer ?? "?"}  field order ${s.field_order ?? "?"}  SAR ${s.sample_aspect_ratio ?? "?"}`);
    out(`HDR metadata at ${at}s: mastering display ${src.masteringDisplay ? "yes" : "no"}${src.contentLight ? `, MaxCLL ${src.contentLight.maxCLL}, MaxFALL ${src.contentLight.maxFALL}` : ", no content light level"}${src.dovi ? ", Dolby Vision RPU" : ""}`);
  } else {
    out("(read through Plex: no local file to probe)");
  }
  report.file.source = src;

  const w = s?.width ?? version.width;
  const h = s?.height ?? version.height;
  const [W, H] = targetFrame(w, h);
  const dir = path.join(OUT_ROOT, `${STAMP}-${ratingKey}`);
  await mkdir(dir, { recursive: true });
  const trc = String(video?.colorTrc ?? s?.color_transfer ?? "").toLowerCase() === "arib-std-b67" ? "arib-std-b67" : "smpte2084";
  const hdr = isHdr(cls);
  const dv5 = cls === "DV P5";
  const window = ["-ss", String(at), "-t", String(seconds)];
  const rate = ["-b:v", "8M", "-maxrate", "8M", "-bufsize", "16M"];
  const h264 = ["-c:v", "h264_qsv", "-low_power", "1", "-profile:v", "high", "-preset", "medium", ...rate, ...TAGS_SDR];
  const hevc = ["-c:v", "hevc_qsv", "-low_power", "1", "-profile:v", "main10", "-preset", "medium", ...rate];
  const toQsv = (fmt) => `scale_vaapi=w=${W}:h=${H}:format=${fmt},hwmap=derive_device=qsv,format=qsv`;
  const tmOpencl = (algo) =>
    `scale_vaapi=w=${W}:h=${H}:format=p010,hwmap=derive_device=opencl:mode=read,` +
    `tonemap_opencl=tonemap=${algo}:desat=0:peak=100:t=bt709:m=bt709:p=bt709:format=nv12${dv5 ? ":apply_dovi=1" : ""}`;

  async function encode(name, ffArgs, outFile, { check } = {}) {
    const target = path.join(dir, outFile);
    const r = await run(FFMPEG, [...FF, "-v", "verbose", ...ffArgs, target], { timeoutMs: Math.max(120_000, seconds * 20_000) });
    const stats = ffStats(r.stderr);
    const ok = r.code === 0 && exists(target);
    const rc = rateControl(r.stderr);
    out(`${tick(ok)} ${name.padEnd(44)} ${ok ? `${String(stats?.speed ?? "?").padStart(5)}× real time  ${outFile}${rc ? `  (${rc})` : ""}` : "failed"}`);
    if (!ok) for (const l of whyFailed(r.stderr)) out(`      ${l}`);
    const result = { name, ok, speed: stats?.speed ?? null, rateControl: rc, file: ok ? target : null, error: ok ? null : whyFailed(r.stderr) };
    if (ok && check) Object.assign(result, await check(target));
    report.file.encodes.push(result);
    return result;
  }

  heading(`Encodes: ${seconds} s from ${at} s, output ${W}x${H}`);
  // The copy: how soon its first 3 s segment is ready, and how fast it runs.
  const copyDir = path.join(dir, "copy");
  await mkdir(copyDir, { recursive: true });
  let firstSegMs = null;
  const copy = await run(FFMPEG, [...FF, ...window, ...input, "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy",
    "-c:a", "aac", "-ac", "2", "-b:a", "256k", "-f", "segment", "-segment_format", "mpegts", "-segment_time", "3",
    "-segment_list", "pipe:1", "-segment_list_type", "csv", "-reset_timestamps", "0", path.join(copyDir, "%05d.ts")],
    { onStdout: (_s, ms) => { firstSegMs ??= Math.round(ms); } });
  const copyStats = ffStats(copy.stderr);
  out(`${tick(copy.code === 0)} ${"Copy (video as it is, audio to AAC)".padEnd(44)} ${copy.code === 0 ? `${String(copyStats?.speed ?? "?").padStart(5)}× real time  first segment after ${firstSegMs ?? "?"} ms` : "failed"}`);
  if (copy.code !== 0) for (const l of whyFailed(copy.stderr)) out(`      ${l}`);
  report.file.copy = { ok: copy.code === 0, speed: copyStats?.speed ?? null, firstSegmentMs: firstSegMs };

  const checkHdr = async (target) => {
    const got = await hdrLabels(target);
    const st = got.stream ?? {};
    const labels = st.color_transfer === trc && st.color_primaries === "bt2020";
    const meta = !src?.masteringDisplay || got.masteringDisplay;
    const light = !src?.contentLight || !!got.contentLight;
    out(`      ${tick(labels)} labels: transfer ${st.color_transfer ?? "none"}, primaries ${st.color_primaries ?? "none"}   ` +
      `${tick(meta)} mastering display ${got.masteringDisplay ? "kept" : src?.masteringDisplay ? "LOST" : "(source has none)"}   ` +
      `${tick(light)} MaxCLL ${got.contentLight ? `kept (${got.contentLight.maxCLL})` : src?.contentLight ? "LOST" : "(source has none)"}`);
    return { hdrLabels: labels, masteringDisplay: got.masteringDisplay, contentLight: got.contentLight };
  };

  if (hdr) {
    const keep = await encode("HEVC Main10, HDR kept (GPU decode)", [...hwInit(), ...hwDecode, ...window, ...input,
      "-map", "0:v:0", "-vf", toQsv("p010"), ...hevc, ...tagsHdr(trc), "-an"], "hevc-keep-hdr.mp4", { check: checkHdr });
    if (!keep.ok) {
      await encode("HEVC Main10, HDR kept (CPU decode)", [...hwInit(), ...window, ...input, "-map", "0:v:0", "-vf",
        `scale=${W}:${H},format=p010le,hwupload=extra_hw_frames=64,format=qsv`, ...hevc, ...tagsHdr(trc), "-an"],
        "hevc-keep-hdr-cpu.mp4", { check: checkHdr });
    }
    const viaOpencl = await encode("H.264 tone-mapped: OpenCL mobius", [...hwInit({ opencl: true }), ...hwDecode, ...window,
      ...input, "-map", "0:v:0", "-vf", `${tmOpencl("mobius")},hwmap=derive_device=vaapi:mode=write:reverse=1,format=vaapi,hwmap=derive_device=qsv,format=qsv`,
      ...h264, "-an"], "h264-tonemap-opencl-mobius.mp4");
    if (!viaOpencl.ok) {
      await encode("H.264 tone-mapped: OpenCL mobius → VAAPI", [...hwInit({ opencl: true }), ...hwDecode, ...window,
        ...input, "-map", "0:v:0", "-vf", `${tmOpencl("mobius")},hwmap=derive_device=vaapi:mode=write:reverse=1,format=vaapi`,
        "-c:v", "h264_vaapi", "-profile:v", "high", ...rate, ...TAGS_SDR, "-an"], "h264-tonemap-opencl-mobius-vaapi.mp4");
    }
    await encode("H.264 tone-mapped: QSV video engine", [...hwInit(), ...hwDecode, ...window, ...input, "-map", "0:v:0",
      "-vf", `${toQsv("p010")},vpp_qsv=tonemap=1:format=nv12`, ...h264, "-an"], "h264-tonemap-vpp.mp4");
    await encode("H.264 tone-mapped: software tonemapx", [...hwInit(), ...window, ...input, "-map", "0:v:0", "-vf",
      `scale=${W}:${H},tonemapx=tonemap=mobius:desat=0:peak=100:t=bt709:m=bt709:p=bt709:format=nv12,hwupload=extra_hw_frames=64,format=qsv`,
      ...h264, "-an"], "h264-tonemap-tonemapx.mp4");

    heading(`Tone-mapping samples: one frame at ${at} s, for comparing by eye`);
    for (const algo of ["mobius", "bt2390", "hable", "reinhard"]) {
      const r = await run(FFMPEG, [...FF, ...hwInit({ opencl: true }), ...hwDecode, "-ss", String(at), ...input,
        "-map", "0:v:0", "-vf", `${tmOpencl(algo)},hwdownload,format=nv12`, "-frames:v", "1", "-update", "1",
        path.join(dir, `frame-${algo}.png`)]);
      out(`${tick(r.code === 0)} frame-${algo}.png${r.code === 0 ? "" : `  ${whyFailed(r.stderr, 2).join(" / ")}`}`);
    }
    const vppFrame = await run(FFMPEG, [...FF, ...hwInit(), ...hwDecode, "-ss", String(at), ...input, "-map", "0:v:0",
      "-vf", `${toQsv("p010")},vpp_qsv=tonemap=1:format=nv12,hwdownload,format=nv12`, "-frames:v", "1", "-update", "1",
      path.join(dir, "frame-intel-vpp.png")]);
    out(`${tick(vppFrame.code === 0)} frame-intel-vpp.png${vppFrame.code === 0 ? "" : `  ${whyFailed(vppFrame.stderr, 2).join(" / ")}`}`);
    out("Compare them with the same moment paused in Discord on a Plex-mode H.264 stream (Firefox), which Plex tone-maps.");
  } else {
    await encode("HEVC Main10 re-encode (GPU)", [...hwInit(), ...hwDecode, ...window, ...input, "-map", "0:v:0",
      "-vf", toQsv("p010"), ...hevc, ...TAGS_SDR, "-an"], "hevc-main10.mp4");
    await encode("H.264 re-encode (GPU)", [...hwInit(), ...hwDecode, ...window, ...input, "-map", "0:v:0",
      "-vf", toQsv("nv12"), ...h264, "-an"], "h264.mp4");
  }

  const n = positive("concurrent", 3);
  if (n > 1) {
    heading(`${n} HEVC Main10 re-encodes at once`);
    const runs = await Promise.all(Array.from({ length: n }, () => run(FFMPEG, [...FF, ...hwInit(), ...hwDecode, ...window,
      ...input, "-map", "0:v:0", "-vf", toQsv("p010"), ...hevc, "-an", "-f", "null", "-"], { timeoutMs: Math.max(180_000, seconds * 30_000) })));
    const speeds = runs.map((r) => (r.code === 0 ? ffStats(r.stderr)?.speed ?? null : null));
    out(`${tick(speeds.every((x) => x !== null))} speed of each, against real time: ${speeds.map((x) => (x === null ? "failed" : `${x}×`)).join(", ")}`);
    for (const r of runs.filter((r) => r.code !== 0).slice(0, 1)) for (const l of whyFailed(r.stderr)) out(`      ${l}`);
    report.file.concurrent = { n, speeds };
  }
  out("");
  out(`Samples are in ${dir}`);
}

// ─── plex-visibility ────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function plexVisibility() {
  needPlex();
  const ratingKey = String(args["rating-key"] ?? "");
  if (!/^\d+$/.test(ratingKey)) {
    console.error("--rating-key <id> is required");
    process.exit(2);
  }
  const item = (await plexJSON(`/library/metadata/${ratingKey}`)).MediaContainer?.Metadata?.[0];
  if (!item) throw new Error(`No item ${ratingKey}`);
  const duration = item.duration ?? 0;
  const before = { viewOffset: item.viewOffset ?? null, viewCount: item.viewCount ?? 0 };
  const phaseS = positive("phase-seconds", 45);
  const short = randomUUID().slice(0, 6);
  const A = { name: "A", session: randomUUID(), client: `pdt-diag-${short}`, at: 10_000, state: "playing", seenAt: null };
  const B = { name: "B", session: randomUUID(), client: A.client, at: 10_000, state: "playing", seenAt: null };
  const C = { name: "C", session: randomUUID(), client: `pdt-diag-${short}-c`, at: 10_000, state: "playing", seenAt: null };
  const all = [A, B, C];
  let active = [];
  const started = Date.now();
  const t = () => `+${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s`;
  report.visibility = { ratingKey, before, phases: [], terminated: null };

  heading("Plex visibility test");
  out(`Reports "${item.title}" as playing on the server owner's account, as the Plex engine does today.`);
  out("Tautulli will record it as a play. When the test ends the title's resume point is put back.");

  async function timeline(s, state) {
    const res = await plex("/:/timeline", {
      method: "POST",
      params: {
        ratingKey, key: `/library/metadata/${ratingKey}`, state, time: Math.round(s.at), duration,
        identifier: "com.plexapp.plugins.library",
      },
      headers: {
        "X-Plex-Session-Identifier": s.session, "X-Plex-Client-Identifier": s.client,
        "X-Plex-Product": "Plex Discord Theater", "X-Plex-Device-Name": `Discord Theater (test ${s.name})`,
        "X-Plex-Platform": "Chrome", "X-Plex-Device": "Browser", "X-Plex-Version": "1.0.0",
      },
    });
    const body = await res.text().catch(() => "");
    const terminated = /terminationCode|terminationText/.test(body);
    if (terminated) {
      out(`${t()} ${s.name}: Plex says this stream was terminated: ${body.slice(0, 300)}`);
      report.visibility.terminated ??= { session: s.name, body: body.slice(0, 500), at: Date.now() - started };
      s.state = "stopped";
    } else if (!res.ok) {
      out(`${t()} ${s.name}: timeline answered ${res.status} ${body.slice(0, 120)}`);
    }
    return { status: res.status, terminated };
  }

  async function rows() {
    const data = await plexJSON("/status/sessions");
    return (data.MediaContainer?.Metadata ?? [])
      .filter((m) => String(m.Player?.machineIdentifier ?? "").startsWith(`pdt-diag-${short}`))
      .map((m) => ({
        sessionKey: m.sessionKey, sessionId: m.Session?.id ?? null, bandwidth: m.Session?.bandwidth ?? null,
        location: m.Session?.location ?? null, state: m.Player?.state ?? null, client: m.Player?.machineIdentifier,
        player: m.Player?.title ?? null, product: m.Player?.product ?? null, user: m.User?.title ?? null,
        transcode: !!m.TranscodeSession, decision: m.Media?.[0]?.Part?.[0]?.decision ?? null,
      }));
  }

  const describe = (r) => {
    const s = all.find((x) => x.session === r.sessionId);
    return `${s ? s.name : "?"}: ${r.state}, Session id ${s ? "= ours" : r.sessionId}, bandwidth ${r.bandwidth ?? "none"}, ${r.location ?? "?"}, user ${r.user ?? "?"}, ${r.transcode ? "transcode" : r.decision ?? "direct"}`;
  };

  let shadowOn = false;
  async function shadowRead(s) {
    const part = item.Media?.[defaultMediaIndex(item.Media ?? [])]?.Part?.[0];
    if (!part?.key) return;
    const res = await plex(part.key, {
      headers: {
        Range: "bytes=0-1048575", "X-Plex-Session-Identifier": s.session, "X-Plex-Client-Identifier": s.client,
        "X-Plex-Product": "Plex Discord Theater", "X-Plex-Device-Name": `Discord Theater (test ${s.name})`,
      },
    });
    await res.arrayBuffer().catch(() => null);
  }

  async function phase(name, seconds, note) {
    heading(name);
    if (note) out(note);
    const seen = new Map();
    const endAt = Date.now() + seconds * 1000;
    while (Date.now() < endAt) {
      for (const s of active) {
        if (s.state === "stopped") continue;
        if (s.state === "playing") s.at = Math.min(duration || Infinity, s.at + 5000);
        await timeline(s, s.state);
        if (shadowOn) await shadowRead(s);
      }
      await sleep(1500);
      let now = [];
      try {
        now = await rows();
      } catch (err) {
        out(`${t()} couldn't read /status/sessions (${err.message})`);
      }
      for (const r of now) {
        const s = all.find((x) => x.session === r.sessionId || (x.client === r.client && !x.seenAt && x.state !== "stopped"));
        if (s && !s.seenAt) {
          s.seenAt = Date.now();
          out(`${t()} ${s.name} appeared in Now Playing`);
        }
      }
      out(`${t()} ${now.length} row(s)${now.length ? `   ${now.map(describe).join("  |  ")}` : ""}`);
      for (const r of now) seen.set(r.sessionKey, r);
      await sleep(3500);
    }
    report.visibility.phases.push({ name, rows: [...seen.values()] });
    return [...seen.values()];
  }

  let stopping = false;
  async function finish() {
    if (stopping) return;
    stopping = true;
    for (const s of all) {
      if (s.state !== "stopped") {
        s.state = "stopped";
        await timeline(s, "stopped").catch(() => {});
      }
    }
    try {
      await plex("/:/progress", {
        params: { key: ratingKey, identifier: "com.plexapp.plugins.library", time: before.viewOffset ?? 0, state: "stopped" },
      });
      const after = (await plexJSON(`/library/metadata/${ratingKey}`)).MediaContainer?.Metadata?.[0];
      out(`resume point: was ${before.viewOffset ?? "none"}, now ${after?.viewOffset ?? "none"}`);
      report.visibility.after = { viewOffset: after?.viewOffset ?? null, viewCount: after?.viewCount ?? 0 };
    } catch (err) {
      out(`couldn't put the resume point back (${err.message}); it was ${before.viewOffset ?? "none"}`);
    }
  }
  process.on("SIGINT", () => {
    out("\nInterrupted: stopping the test sessions…");
    finish().then(saveReport).finally(() => process.exit(130));
  });

  active = [A];
  const first = await phase("1. One test stream (A) playing", phaseS,
    "Look now at Plex's dashboard (Now Playing), Tautulli's Activity and Tracearr.\n" +
    "To test Terminate, stop this stream from Tautulli or Plex during this phase.");
  if (first.length === 0 && A.state !== "stopped") {
    shadowOn = true;
    await phase("1b. A playing, and reading the file through Plex", Math.max(20, phaseS / 2),
      "Nothing showed from the timeline alone, so the test now also reads the file through Plex, the way a player playing it directly would.");
  }
  if (A.state === "stopped") A.state = "playing";
  active = [A, B];
  await phase("2. A and B playing, same client identifier", Math.max(20, phaseS / 2),
    "Does Plex show two rows, or one? (One means each stream needs its own client identifier.)");
  active = [A, B, C];
  await phase("3. A, B and C (its own client identifier) playing", Math.max(20, phaseS / 2));
  for (const s of active) if (s.state !== "stopped") s.state = "paused";
  await phase("4. All paused", 20, "Plex and Tautulli should show them paused.");
  for (const s of active) {
    s.state = "stopped";
    await timeline(s, "stopped");
  }
  active = [];
  await phase("5. Stopped", 15, "The rows should go away, and Tautulli should write a history entry.");
  await finish();

  heading("Summary");
  const r1 = report.visibility.phases[0]?.rows ?? [];
  const p2 = report.visibility.phases.find((p) => p.name.startsWith("2."))?.rows ?? [];
  out(`${tick(!!A.seenAt)} a timeline-only stream ${A.seenAt ? `appears in Now Playing (after ${Math.round((A.seenAt - started) / 1000)} s)` : "did NOT appear in Now Playing"}${shadowOn ? " — only once the file was read through Plex" : ""}`);
  out(`${tick(r1.some((r) => r.sessionId === A.session))} Plex's Session id is ours (what the qBT manager matches on)`);
  out(`  bandwidth Plex shows: ${r1.map((r) => r.bandwidth ?? "none").join(", ") || "—"}`);
  out(`  same client id, two streams: ${new Set(p2.map((r) => r.sessionKey)).size} row(s)`);
  out(`  terminate: ${report.visibility.terminated ? `seen in the timeline response (${report.visibility.terminated.session})` : "not tried, or not seen in the timeline response"}`);
  out("Also note what Tautulli and Tracearr showed (player, user, Direct Play/Stream), and send that along with this report.");
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  out(`diagnose-ffmpeg ${COMMAND} · ${new Date().toISOString()} · ffmpeg ${FFMPEG}`);
  if (COMMAND === "gpu" || COMMAND === "all") await gpu();
  if (COMMAND === "paths" || COMMAND === "all") await paths();
  if (COMMAND === "file") await file();
  if (COMMAND === "plex-visibility") await plexVisibility();
  await saveReport();
}

main().catch(async (err) => {
  out(`\nFailed: ${err.stack ?? err.message}`);
  await saveReport().catch(() => {});
  process.exit(1);
});
