/**
 * The ffmpeg playback engine's settings. Read on every call, so a test can turn
 * the engine on and off; ffmpeg itself is looked for once, at startup.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

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
