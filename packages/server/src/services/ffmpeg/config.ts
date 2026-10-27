/**
 * The ffmpeg playback engine's settings. Read on every call, so a test can turn
 * the engine on and off; ffmpeg itself is looked for once, at startup.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PRESETS, cudaInit, qsvInit, vaapiInit, type Hardware, type Tonemapper } from "./plan.js";

/** Jellyfin's build, which the image ships. */
const JELLYFIN_FFMPEG = "/usr/lib/jellyfin-ffmpeg/ffmpeg";

/** Null until checkFfmpeg has run: then whether ffmpeg answered. */
let found: boolean | null = null;

export function ffmpegPath(): string {
  return process.env.FFMPEG_PATH?.trim() || (fs.existsSync(JELLYFIN_FFMPEG) ? JELLYFIN_FFMPEG : "ffmpeg");
}

/** FFPROBE_PATH, else the ffprobe beside ffmpeg (Jellyfin's ships one), else the PATH's. */
export function ffprobePath(): string {
  const set = process.env.FFPROBE_PATH?.trim();
  if (set) return set;
  const ffmpeg = ffmpegPath();
  if (!/[\\/]/.test(ffmpeg)) return "ffprobe";
  const beside = path.join(path.dirname(ffmpeg), path.basename(ffmpeg).replace(/ffmpeg/i, "ffprobe"));
  return fs.existsSync(beside) ? beside : "ffprobe";
}

/** A setting turned off: 0, off, false or no. */
function off(value: string | undefined): boolean {
  return ["0", "off", "false", "no"].includes((value ?? "").trim().toLowerCase());
}

/** FFMPEG_FALLBACK_TO_PLEX=off: a stream ffmpeg can't make fails to start
 *  rather than going to Plex — for finding out what those are. */
export function fallbackToPlex(): boolean {
  return !off(process.env.FFMPEG_FALLBACK_TO_PLEX);
}

/** FFMPEG_SUBTITLES=off: text subtitles inside a film are read by Plex, as
 *  without the engine, not out of the mounted file. */
export function ffmpegSubtitlesOn(): boolean {
  return ffmpegEngineOn() && !off(process.env.FFMPEG_SUBTITLES);
}

/** STYLED_SUBTITLES=off: an ASS subtitle is drawn as plain lines in the
 *  viewer's own look, as before 24 October, not as its script has it
 *  (styled-subtitles.ts). */
export function styledSubtitlesOn(): boolean {
  return !off(process.env.STYLED_SUBTITLES);
}

/** FFMPEG_PGS=off: PGS subtitles are burned in, as before 24 October, rather
 *  than cut out of the film for the player to draw (picture-subtitles.ts). */
export function ffmpegPgsOn(): boolean {
  return ffmpegEngineOn() && !off(process.env.FFMPEG_PGS);
}

/** A surround track that isn't AAC becomes 5.1 AAC, or stereo with
 *  FFMPEG_AUDIO_CHANNELS=2 (plan.ts convertedAudio). Stereo was the default
 *  until 1917 in 5.1 sounded "a lot better" on 21 October. */
export function audioChannels(): 2 | 6 {
  return process.env.FFMPEG_AUDIO_CHANNELS?.trim() === "2" ? 2 : 6;
}

/** FFMPEG_PRESET: one of plan.ts PRESETS, or null for each encoder's own. */
export function encodePreset(): string | null {
  const want = process.env.FFMPEG_PRESET?.trim().toLowerCase();
  return want && PRESETS.includes(want) ? want : null;
}

/** FFMPEG_HW_DECODE=off: the GPU encodes, the CPU decodes everything. */
export function gpuDecodeOn(): boolean {
  return !off(process.env.FFMPEG_HW_DECODE);
}

/** FFMPEG_SEGMENT_MEMORY_MB: memory for the segments rooms are fetching now
 *  (hot-segments.ts), 512 MB unless set; 0 reads every one from disk. */
export function segmentMemoryBytes(): number {
  const v = process.env.FFMPEG_SEGMENT_MEMORY_MB?.trim();
  const mb = v ? Number(v) : 512;
  return (Number.isFinite(mb) && mb >= 0 ? mb : 512) * 1024 * 1024;
}

/** FFMPEG_PREVIEWS=off: no seek-bar previews made here for a file Plex has
 *  none for (previews.ts). */
export function ffmpegPreviewsOn(): boolean {
  return ffmpegEngineOn() && !off(process.env.FFMPEG_PREVIEWS);
}

/** FFMPEG_PREVIEWS_MAX_GB: room on disk for the previews made here, 20 GB
 *  unless set; the least recently used go past it. */
export function previewsMaxBytes(): number {
  const gb = Number(process.env.FFMPEG_PREVIEWS_MAX_GB?.trim() || 20);
  return (Number.isFinite(gb) && gb > 0 ? gb : 20) * 1024 ** 3;
}

/** PLAYBACK_ENGINE=ffmpeg, and ffmpeg not found missing at startup. */
export function ffmpegEngineOn(): boolean {
  return process.env.PLAYBACK_ENGINE?.trim().toLowerCase() === "ffmpeg" && found !== false;
}

/** Whether ffmpeg runs, and its version line — for the [Config] line at startup. */
export function checkFfmpeg(): Promise<{ ok: boolean; version: string | null; error: string | null }> {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(ffmpegPath(), ["-hide_banner", "-version"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      found = false;
      resolve({ ok: false, version: null, error: String(err) });
      return;
    }
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("error", (err) => {
      found = false;
      resolve({ ok: false, version: null, error: err.message });
    });
    child.on("close", (code) => {
      found = code === 0;
      resolve({ ok: found, version: out.split("\n")[0]?.trim() || null, error: found ? null : `exit ${code}` });
    });
  });
}

/**
 * MEDIA_PATH_MAP: "plexPrefix=>localPrefix,…", for a library mounted here at
 * other paths than Plex's. Empty when it is mounted where Plex has it.
 */
export function mediaPathMap(): Array<[string, string]> {
  return (process.env.MEDIA_PATH_MAP ?? "")
    .split(",")
    .map((pair) => pair.split("=>").map((s) => s.trim()))
    .filter((p): p is [string, string] => p.length === 2 && p[0] !== "");
}

/** Where a file Plex names is in this container. */
export function localPath(plexPath: string): string {
  for (const [from, to] of mediaPathMap()) {
    const prefix = from.endsWith("/") ? from : `${from}/`;
    if (plexPath === from || plexPath.startsWith(prefix)) return to + plexPath.slice(from.length);
  }
  return plexPath;
}

/** Whether this process can read a file. */
export function readable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** A file's size in bytes, null when it can't be read. */
export function sizeOnDisk(file: string): number | null {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

// ─── Re-encodes ─────────────────────────────────────────────────

/** Null until detectHardware has run. */
let hardware: Hardware | null = null;
let mapper: Tonemapper | null = null;
/** The GPU encodes HEVC Main10 too, not only H.264. */
let hevcEncodes = false;
/** The GPU encodes AV1 too: Intel Arc and Core Ultra, NVIDIA's RTX 40, AMD's RX 7000. */
let av1Encodes = false;
/** And at 10 bits, for an HDR picture kept (plan.ts av1HdrOk). */
let av1Encodes10 = false;
/** VAAPI's AV1 encoder only has its low-power form (Intel's), whatever H.264's has. */
let av1LowPower = false;
/** VAAPI's encoder only has its low-power form: newer Intel GPUs. */
let vaapiLowPower = false;
/** The render node wasn't there when detectHardware last ran — see recheckHardware. */
let deviceMissing = false;
let rechecking: Promise<void> | null = null;

/** The render node QSV and VAAPI run on; NVENC's GPU number, where a number
 *  is given (cudaInit takes anything else as 0). */
export function hwDevice(): string {
  return process.env.FFMPEG_HWACCEL_DEVICE?.trim() || "/dev/dri/renderD128";
}

/** Whether re-encodes can be HEVC: a GPU that encodes HEVC Main10. */
export function gpuEncodesHevc(): boolean {
  return ffmpegHardware() !== "software" && hevcEncodes;
}

/** Whether re-encodes can be AV1: a GPU that encodes it at 8 bits. */
export function gpuEncodesAv1(): boolean {
  return ffmpegHardware() !== "software" && av1Encodes;
}

/** And at 10 bits, so HDR kept can be AV1 rather than HEVC Main10. */
export function gpuEncodesAv1Hdr(): boolean {
  return gpuEncodesAv1() && av1Encodes10;
}

/** VAAPI's AV1 encoder in its low-power form (lowPower in plan.ts). */
export function lowPowerVaapiAv1(): boolean {
  return av1LowPower;
}

/** VAAPI with its low-power encoder (lowPower in plan.ts). */
export function lowPowerVaapi(): boolean {
  return vaapiLowPower;
}

/** What re-encodes run on, as detectHardware found: the CPU until it has run. */
export function ffmpegHardware(): Hardware {
  return hardware ?? "software";
}

/**
 * FFMPEG_MAX_ENCODES: re-encodes at once (copies don't count); past it, Plex
 * makes the stream. Six on a GPU: Phase 0 had three 4K HDR → 1080p re-encodes
 * at once on the 265K at about 4× each, so six still run about twice as fast
 * as the film plays; and Plex, which takes the seventh, shares that GPU.
 * Consumer NVIDIA cards allow eight NVENC sessions at once, Plex's included.
 */
export function maxEncodes(): number {
  const n = Number(process.env.FFMPEG_MAX_ENCODES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : ffmpegHardware() === "software" ? 2 : 6;
}

/**
 * FFMPEG_LOOKAHEAD: how far past its watcher a run gets before it is paused,
 * seconds. Unset, 0 or "all": no pause — the whole film is made, flat out.
 */
export function lookaheadS(): number | null {
  const v = (process.env.FFMPEG_LOOKAHEAD ?? "").trim().toLowerCase();
  const n = Number(v);
  return v && v !== "all" && Number.isFinite(n) && n > 0 ? n : null;
}

/** What the GPU tone-maps with, as detectHardware found: OpenCL when it
 *  works there, else QSV's video engine; the CPU without QSV. */
export function tonemapper(): Tonemapper {
  return mapper ?? "software";
}

const CURVES = ["reinhard", "mobius", "hable", "bt2390", "linear", "gamma", "clip"];

/** FFMPEG_TONEMAP: the curve HDR is mapped to SDR by — reinhard, the closest
 *  to Plex's, unless set. */
export function tonemapAlgo(): string {
  const want = process.env.FFMPEG_TONEMAP?.trim().toLowerCase();
  return want && CURVES.includes(want) ? want : "reinhard";
}

/** FFMPEG_HDR_REENCODE: keep (default), or tonemap as Plex does. */
export function keepHdrOnReencode(): boolean {
  return process.env.FFMPEG_HDR_REENCODE?.trim().toLowerCase() !== "tonemap";
}

/** Whether ffmpeg runs these arguments to the end, and the last thing it said. */
function trial(args: string[]): Promise<{ ok: boolean; said: string }> {
  return new Promise((resolve) => {
    let err = "";
    let child;
    try {
      child = spawn(ffmpegPath(), args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      resolve({ ok: false, said: String(e) });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-2_000); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, said: e.message }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, said: err.trim().split("\n").pop()?.trim() ?? "" });
    });
  });
}

/**
 * FFMPEG_HWACCEL (auto | qsv | vaapi | nvenc | none). auto and qsv try a short
 * HEVC Main10 and H.264 encode on Intel's GPU, with Phase 0's setup, and use
 * it if both work — and an AV1 one, for players that decode AV1 on their GPU; auto then tries VAAPI on the same render node (an AMD GPU,
 * or Intel without QSV's runtime). vaapi tries VAAPI alone: H.264, and HEVC
 * Main10 if it has it, in its full or low-power form. nvenc tries NVIDIA's
 * NVENC with CUDA's scaler. Otherwise re-encodes are H.264 on the CPU. With
 * QSV or VAAPI, a short tonemap_opencl says whether OpenCL tone-maps there:
 * else QSV's video engine does (VAAPI's and NVENC's frames are brought down
 * and tone-mapped on the CPU), and Dolby Vision 5 is left to Plex.
 */
export async function detectHardware(): Promise<{ hardware: Hardware; note: string }> {
  // Empty is auto: the compose files leave every setting there, most empty.
  const want = (process.env.FFMPEG_HWACCEL?.trim() || "auto").toLowerCase();
  const done = (
    h: Hardware, note: string, m: Tonemapper = "software", hevc = h !== "software", lowPower = false,
    av1: boolean | "low-power" = false, av1Ten = false,
  ) => {
    hardware = h;
    mapper = m;
    hevcEncodes = hevc;
    av1Encodes = !!av1;
    av1Encodes10 = !!av1 && av1Ten;
    av1LowPower = av1 === "low-power";
    vaapiLowPower = lowPower;
    return { hardware: h, note: `${note}${av1 ? `; AV1 ${av1Ten ? "in 8 and 10 bits (HDR kept is AV1)" : "in 8 bits only (HDR kept is HEVC)"}` : ""}` };
  };
  if (["none", "software", "off", "cpu"].includes(want)) return done("software", "CPU (FFMPEG_HWACCEL=none)");
  if (!["auto", "qsv", "vaapi", "nvenc"].includes(want)) {
    return done("software", `CPU (FFMPEG_HWACCEL=${want} isn't one of auto, qsv, vaapi, nvenc or none)`);
  }
  const testCard = ["-f", "lavfi", "-i", "testsrc2=s=320x240:r=24:d=1"];
  if (want === "nvenc") {
    // AV1 has no profile to name: Main, which 8 and 10 bits both are.
    const nvenc = (codec: string, fmt: string, profile: string | null) => trial([
      "-hide_banner", "-nostdin", "-loglevel", "error", ...cudaInit(hwDevice()), ...testCard,
      "-vf", `format=${fmt === "p010" ? "p010le" : fmt},hwupload,scale_cuda=w=160:h=120:format=${fmt}`,
      "-c:v", codec, ...(profile ? ["-profile:v", profile] : []), "-f", "null", "-",
    ]);
    const [h264, hevc, av1, av1Ten] = await Promise.all([
      nvenc("h264_nvenc", "nv12", "high"), nvenc("hevc_nvenc", "p010", "main10"), nvenc("av1_nvenc", "nv12", null),
      nvenc("av1_nvenc", "p010", null),
    ]);
    if (!h264.ok) return done("software", `CPU (NVENC didn't encode: ${h264.said || "no answer"})`);
    return done("nvenc", `NVIDIA NVENC (H.264${hevc.ok ? " and HEVC Main10" : `; not HEVC: ${hevc.said || "no answer"}`}), ` +
      `tone mapping ${tonemapAlgo()} on the CPU (Dolby Vision 5 goes to Plex)`, "software", hevc.ok, false, av1.ok, av1Ten.ok);
  }
  deviceMissing = !fs.existsSync(hwDevice());
  if (deviceMissing) {
    let has: string;
    try {
      has = fs.readdirSync("/dev/dri").join(", ") || "nothing";
    } catch {
      has = "no /dev/dri at all";
    }
    return done("software", `CPU (no ${hwDevice()}; /dev/dri has: ${has} — map /dev/dri for Intel's GPU; looked for again before each re-encode)`);
  }
  const encode = (codec: string, fmt: string, profile: string | null) => trial([
    "-hide_banner", "-nostdin", "-loglevel", "error", ...qsvInit(hwDevice()),
    "-f", "lavfi", "-i", "testsrc2=s=320x240:r=24:d=1",
    "-vf", `format=${fmt},hwupload=extra_hw_frames=16,format=qsv`,
    "-c:v", codec, "-low_power", "1", ...(profile ? ["-profile:v", profile] : []), "-f", "null", "-",
  ]);
  const opencl = (intel = true) => trial([
    "-hide_banner", "-nostdin", "-loglevel", "error",
    "-init_hw_device", `vaapi=va:${hwDevice()}${intel ? ",driver=iHD" : ""}`, "-init_hw_device", "opencl=ocl@va", "-filter_hw_device", "ocl",
    "-f", "lavfi", "-i", "testsrc2=s=320x240:r=24:d=1",
    "-vf", "format=p010le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv,hwupload," +
      `tonemap_opencl=tonemap=${tonemapAlgo()}:desat=0:peak=100:t=bt709:m=bt709:p=bt709:format=nv12,hwdownload,format=nv12`,
    "-f", "null", "-",
  ]);
  // VAAPI: its full encoder, else its low-power one; OpenCL from it without
  // naming Intel's driver, so an AMD GPU is asked too.
  const vaapi = async () => {
    const encodeVa = (codec: string, fmt: string, profile: string | null, lowPower: boolean) => trial([
      "-hide_banner", "-nostdin", "-loglevel", "error", ...vaapiInit(hwDevice()), ...testCard,
      "-vf", `format=${fmt},hwupload,format=vaapi`,
      "-c:v", codec, ...(lowPower ? ["-low_power", "1"] : []), ...(profile ? ["-profile:v", profile] : []),
      "-f", "null", "-",
    ]);
    let lowPower = false;
    let h264 = await encodeVa("h264_vaapi", "nv12", "high", false);
    if (!h264.ok) {
      const lp = await encodeVa("h264_vaapi", "nv12", "high", true);
      if (lp.ok) [h264, lowPower] = [lp, true];
    }
    if (!h264.ok) return { ok: false as const, said: h264.said };
    // Intel's AV1 encoder is only low-power; AMD's only the full one.
    const [hevc, cl, av1Full, av1Low, av1Full10, av1Low10] = await Promise.all([
      encodeVa("hevc_vaapi", "p010le", "main10", lowPower), opencl(false),
      encodeVa("av1_vaapi", "nv12", null, false), encodeVa("av1_vaapi", "nv12", null, true),
      encodeVa("av1_vaapi", "p010le", null, false), encodeVa("av1_vaapi", "p010le", null, true),
    ]);
    const av1 = av1Full.ok || (av1Low.ok && "low-power");
    const av1Ten = av1Full.ok ? av1Full10.ok : av1Low10.ok;
    // AV1 named too: the line said "H.264 and HEVC Main10" while AV1 was in use.
    const what = `VAAPI${lowPower ? ", low-power" : ""} (H.264${hevc.ok ? ", HEVC Main10" : ", not HEVC"}${av1 ? ", AV1" : ", not AV1"})`;
    return {
      ok: true as const,
      result: cl.ok
        ? done("vaapi", `${what}, tone mapping ${tonemapAlgo()} on OpenCL`, "opencl", hevc.ok, lowPower, av1, av1Ten)
        : done("vaapi", `${what}, tone mapping ${tonemapAlgo()} on the CPU (Dolby Vision 5 goes to Plex)`,
            "software", hevc.ok, lowPower, av1, av1Ten),
    };
  };
  if (want === "vaapi") {
    const va = await vaapi();
    return va.ok ? va.result : done("software", `CPU (VAAPI didn't encode: ${va.said || "no answer"})`);
  }
  const [hevc, h264, cl, av1, av1Ten] = await Promise.all([
    encode("hevc_qsv", "p010le", "main10"), encode("h264_qsv", "nv12", "high"), opencl(), encode("av1_qsv", "nv12", null),
    encode("av1_qsv", "p010le", null),
  ]);
  if (hevc.ok && h264.ok) {
    const what = `Intel QSV (H.264, HEVC Main10${av1.ok ? ", AV1" : ", not AV1"})`;
    return cl.ok
      ? done("qsv", `${what}, tone mapping ${tonemapAlgo()} on OpenCL`, "opencl", true, false, av1.ok, av1Ten.ok)
      : done("qsv", `${what}, tone mapping ${tonemapAlgo()} on QSV's video engine ` +
          `(OpenCL didn't: ${cl.said || "no answer"}; Dolby Vision 5 goes to Plex)`, "vpp", true, false, av1.ok, av1Ten.ok);
  }
  const why = (!hevc.ok ? hevc.said : h264.said) || "no answer";
  if (want === "auto") {
    const va = await vaapi();
    if (va.ok) return va.result;
  }
  return done("software", `CPU (Intel QSV didn't encode: ${why})`);
}

/**
 * Before a re-encode: if the render node wasn't there when the hardware was
 * looked at, look again, and use the GPU once it is. On 18 October the
 * container started twice without /dev/dri/renderD128, which the host had all
 * along, and every re-encode until the next restart ran on the CPU.
 */
export function recheckHardware(): Promise<void> {
  if (!deviceMissing || !fs.existsSync(hwDevice())) return Promise.resolve();
  rechecking ??= detectHardware()
    .then((hw) => console.log(`[Config] ${hwDevice()} is here now; re-encodes on ${hw.note}`))
    .finally(() => { rechecking = null; });
  return rechecking;
}
