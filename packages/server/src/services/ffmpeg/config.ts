/**
 * The ffmpeg playback engine's settings. Read on every call, so a test can turn
 * the engine on and off; ffmpeg itself is looked for once, at startup.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { qsvInit, type Hardware } from "./plan.js";

/** Jellyfin's build, which the image ships. */
const JELLYFIN_FFMPEG = "/usr/lib/jellyfin-ffmpeg/ffmpeg";

/** Null until checkFfmpeg has run: then whether ffmpeg answered. */
let found: boolean | null = null;

export function ffmpegPath(): string {
  return process.env.FFMPEG_PATH?.trim() || (fs.existsSync(JELLYFIN_FFMPEG) ? JELLYFIN_FFMPEG : "ffmpeg");
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

// ─── Re-encodes ─────────────────────────────────────────────────

/** Null until detectHardware has run. */
let hardware: Hardware | null = null;

/** The render node QSV runs on. */
export function hwDevice(): string {
  return process.env.FFMPEG_HWACCEL_DEVICE?.trim() || "/dev/dri/renderD128";
}

/** What re-encodes run on, as detectHardware found: the CPU until it has run. */
export function ffmpegHardware(): Hardware {
  return hardware ?? "software";
}

/** FFMPEG_MAX_ENCODES: re-encodes at once (copies don't count); past it, Plex makes the stream. */
export function maxEncodes(): number {
  const n = Number(process.env.FFMPEG_MAX_ENCODES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : ffmpegHardware() === "qsv" ? 4 : 2;
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
 * FFMPEG_HWACCEL (auto | qsv | none): auto and qsv try a short HEVC Main10 and
 * H.264 encode on Intel's GPU, with Phase 0's setup, and use it if both work;
 * otherwise re-encodes are H.264 on the CPU. VAAPI and NVENC aren't built yet.
 */
export async function detectHardware(): Promise<{ hardware: Hardware; note: string }> {
  const want = (process.env.FFMPEG_HWACCEL ?? "auto").trim().toLowerCase();
  const done = (h: Hardware, note: string) => {
    hardware = h;
    return { hardware: h, note };
  };
  if (["none", "software", "off", "cpu"].includes(want)) return done("software", "CPU (FFMPEG_HWACCEL=none)");
  if (want !== "auto" && want !== "qsv") return done("software", `CPU (FFMPEG_HWACCEL=${want} isn't supported yet: auto, qsv or none)`);
  if (!fs.existsSync(hwDevice())) return done("software", `CPU (no ${hwDevice()} — map /dev/dri for Intel's GPU)`);
  const encode = (codec: string, fmt: string, profile: string) => trial([
    "-hide_banner", "-nostdin", "-loglevel", "error", ...qsvInit(hwDevice()),
    "-f", "lavfi", "-i", "testsrc2=s=320x240:r=24:d=1",
    "-vf", `format=${fmt},hwupload=extra_hw_frames=16,format=qsv`,
    "-c:v", codec, "-low_power", "1", "-profile:v", profile, "-f", "null", "-",
  ]);
  const [hevc, h264] = await Promise.all([encode("hevc_qsv", "p010le", "main10"), encode("h264_qsv", "nv12", "high")]);
  if (hevc.ok && h264.ok) return done("qsv", "Intel QSV (HEVC Main10 and H.264)");
  const why = (!hevc.ok ? hevc.said : h264.said) || "no answer";
  return done("software", `CPU (Intel QSV didn't encode: ${why})`);
}
