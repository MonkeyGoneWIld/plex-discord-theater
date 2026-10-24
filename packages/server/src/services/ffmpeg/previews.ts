/**
 * Seek-bar previews made by ffmpeg for a file Plex has none for
 * (PLAYBACK_ENGINE=ffmpeg, FFMPEG_PREVIEWS, the file on the mount): a BIF like
 * Plex's — a 320-wide JPEG every PREVIEW_INTERVAL_S — which the preview route
 * serves as it does Plex's. Kept in the app's data folder, so each file is made
 * once; past FFMPEG_PREVIEWS_MAX_GB the least recently used go.
 *
 * Made as Plex makes its own: one ffmpeg reading the film through, decoding
 * only its keyframes, each frame the last keyframe at or before its time. One
 * seek per frame, as these were made until 24 October, was a spawn and a few
 * megabytes read apiece: fine at one every ten seconds (143 to 259 frames a
 * film), five times that at Plex's two. One file at a time, at the lowest CPU
 * priority. An HDR film's frames are tone-mapped: Jellyfin's tonemapx, else
 * zscale's, else as they are.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { logEvent } from "../logger.js";
import { LruMap } from "../lru.js";
import { ffmpegPath, previewsMaxBytes } from "./config.js";

export const PREVIEW_INTERVAL_S = 2;
const WIDTH = 320;
const FRAME_TIMEOUT_MS = 30_000;
/** The pass through the film is stopped when no frame has come for this long. */
const STALL_MS = 120_000;
/** Files waiting to be made, past which another isn't taken on: asked again later. */
const MAX_WAITING = 20;
/** A file that couldn't be made isn't tried again for this long. */
const RETRY_AFTER_MS = 60 * 60_000;

const MAGIC = Buffer.from([0x89, 0x42, 0x49, 0x46, 13, 10, 26, 10]);

const SDR = `scale=${WIDTH}:-2:out_range=pc,format=yuvj420p`;
/** Tried in turn on an HDR film's first frame; the first that draws one is used. */
const HDR = [
  `scale=${WIDTH}:-2,format=yuv420p10le,` +
    "tonemapx=tonemap=hable:desat=0:peak=100:t=bt709:m=bt709:p=bt709:format=yuv420p,scale=out_range=pc,format=yuvj420p",
  `scale=${WIDTH}:-2,zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,` +
    "zscale=t=bt709:m=bt709:r=full,format=yuvj420p",
  SDR,
];

/** Where they are kept: beside the app's other data. */
function previewDir(): string {
  const data = process.env.THUMB_CACHE_DIR
    ? path.resolve(process.env.THUMB_CACHE_DIR)
    : path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "../../../data");
  return path.join(data, "previews");
}

/** Made at PREVIEW_INTERVAL_S: one of the ten-second ones made before is made again. */
const MADE_AS = `-i${PREVIEW_INTERVAL_S}`;

function fileFor(partId: number, fileSize: number | null): string {
  return path.join(previewDir(), `${partId}-${fileSize ?? "x"}${MADE_AS}.bif`);
}

/** Which title and version a part is, from the titles' pages: the preview route has only the part. */
const parts = new LruMap<number, { ratingKey: string; mediaIndex: number }>(5000);

export function rememberPreviewPart(partId: number, ratingKey: string, mediaIndex: number): void {
  parts.set(partId, { ratingKey, mediaIndex });
}

export function previewPartOf(partId: number): { ratingKey: string; mediaIndex: number } | null {
  return parts.get(partId) ?? null;
}

/** The previews made for a part, when they are: now the most recently used. */
export function madePreview(partId: number, fileSize: number | null): { file: string; bytes: number } | null {
  const file = fileFor(partId, fileSize);
  try {
    const { size } = fs.statSync(file);
    const now = new Date();
    fs.utimesSync(file, now, now);
    return { file, bytes: size };
  } catch {
    return null;
  }
}

/** A made file's bytes, as the preview route sends Plex's. */
export function previewBody(file: string): ReadableStream<Uint8Array> {
  return Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream<Uint8Array>;
}

/** A BIF of these JPEGs, `intervalMs` apart. */
export function bif(frames: Buffer[], intervalMs: number): Buffer {
  const head = Buffer.alloc(64);
  MAGIC.copy(head, 0);
  head.writeUInt32LE(0, 8);
  head.writeUInt32LE(frames.length, 12);
  head.writeUInt32LE(intervalMs, 16);
  const index = Buffer.alloc((frames.length + 1) * 8);
  let at = head.length + index.length;
  frames.forEach((frame, i) => {
    index.writeUInt32LE(i, i * 8);
    index.writeUInt32LE(at, i * 8 + 4);
    at += frame.length;
  });
  index.writeUInt32LE(0xffffffff, frames.length * 8);
  index.writeUInt32LE(at, frames.length * 8 + 4);
  return Buffer.concat([head, index, ...frames]);
}

/** One frame: the keyframe at or before `atS`, as a JPEG; null when there is none. */
function grab(film: string, atS: number, vf: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const args = ["-hide_banner", "-nostdin", "-v", "error", "-noaccurate_seek", "-skip_frame", "nokey",
      "-ss", atS.toFixed(3), "-i", film, "-map", "0:V:0", "-frames:v", "1", "-vf", vf, "-q:v", "5",
      "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"];
    const child = lowly(args);
    if (!child) {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => chunks.push(c));
    const timer = setTimeout(() => child.kill("SIGKILL"), FRAME_TIMEOUT_MS);
    child.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks);
      resolve(code === 0 && out.length > 2 && out[0] === 0xff && out[1] === 0xd8 ? out : null);
    });
  });
}

/** ffmpeg at the lowest CPU priority; null when it can't be started. */
function lowly(args: string[]): ReturnType<typeof spawn> | null {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(ffmpegPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return null;
  }
  try {
    if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW);
  } catch {
    // As it is.
  }
  return child;
}

/**
 * The JPEGs in what ffmpeg has written so far, and what is left of the next
 * one. Each ends at its EOI marker (FF D9), which nothing inside one can be:
 * an FF in its picture data is followed by 00 or a restart marker.
 */
export function splitJpegs(buf: Buffer): { frames: Buffer[]; rest: Buffer } {
  const frames: Buffer[] = [];
  let from = 0;
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd9) {
      frames.push(buf.subarray(from, i + 2));
      from = i + 2;
      i++;
    }
  }
  return { frames, rest: buf.subarray(from) };
}

/**
 * A frame every PREVIEW_INTERVAL_S from the keyframes: each slot the last one
 * at or before it (rounding up), from 0 s whenever the picture starts — an
 * Opus film's opens 7 ms in, and its first frame went in the second slot,
 * every frame after it a slot late — and the last keyframe held to the end.
 */
const SLOTS = `tpad=stop_mode=clone:stop_duration=${2 * PREVIEW_INTERVAL_S},` +
  `fps=fps=1/${PREVIEW_INTERVAL_S}:round=up:start_time=0`;

/**
 * Every frame from one pass through the film, its keyframes only (-skip_frame
 * nokey), up to where the file ends, whatever Plex says its length is (a
 * Grimm episode at 97 hours).
 */
function pass(film: string, vf: string): Promise<{ frames: Buffer[] } | { failed: string }> {
  return new Promise((resolve) => {
    const args = ["-hide_banner", "-nostdin", "-v", "error", "-skip_frame", "nokey", "-i", film,
      "-map", "0:V:0", "-an", "-sn", "-dn", "-vf", `${SLOTS},${vf}`, "-q:v", "5",
      "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"];
    const child = lowly(args);
    if (!child) {
      resolve({ failed: "couldn't start ffmpeg" });
      return;
    }
    const frames: Buffer[] = [];
    let rest: Buffer = Buffer.alloc(0);
    let stderr = "";
    let stalled: ReturnType<typeof setTimeout> | undefined;
    const watch = () => {
      clearTimeout(stalled);
      stalled = setTimeout(() => child.kill("SIGKILL"), STALL_MS);
    };
    watch();
    child.stdout?.on("data", (c: Buffer) => {
      const split = splitJpegs(rest.length ? Buffer.concat([rest, c]) : c);
      // Copied out of the chunk they came in, which is then let go.
      for (const f of split.frames) frames.push(Buffer.from(f));
      rest = Buffer.from(split.rest);
      if (split.frames.length) watch();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-600);
    });
    child.on("error", () => {});
    child.on("close", (code, signal) => {
      clearTimeout(stalled);
      if (code === 0 && frames.length) resolve({ frames });
      else resolve({ failed: `ffmpeg exited ${code ?? signal}${stderr.trim() ? `: ${stderr.trim().split("\n").pop()}` : ""}` });
    });
  });
}

export interface PreviewSource {
  partId: number;
  fileSize: number | null;
  /** The film on the mount. */
  film: string;
  durationS: number;
  hdr: boolean;
}

async function make(o: PreviewSource): Promise<string | null> {
  const startedAt = Date.now();
  // An HDR film's is the first chain that draws its first keyframe.
  let vf = SDR;
  for (const tried of o.hdr ? HDR : []) {
    if (await grab(o.film, 0, tried)) {
      vf = tried;
      break;
    }
  }
  const made = await pass(o.film, vf);
  if ("failed" in made) {
    logEvent("Preview", "ffmpeg couldn't make previews", { partId: o.partId, why: made.failed, ms: Date.now() - startedAt });
    return null;
  }
  const file = fileFor(o.partId, o.fileSize);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, bif(made.frames, PREVIEW_INTERVAL_S * 1000));
  fs.renameSync(tmp, file);
  const plexFrames = Math.floor(o.durationS / PREVIEW_INTERVAL_S);
  logEvent("Preview", "previews made by ffmpeg", {
    partId: o.partId, frames: made.frames.length, everyS: PREVIEW_INTERVAL_S,
    ...(Math.abs(made.frames.length - plexFrames) > 30 ? { plexFrames } : {}),
    hdr: o.hdr ? vf === SDR ? "as it is" : vf.includes("tonemapx") ? "tonemapx" : "zscale" : "no",
    bytes: fs.statSync(file).size, ms: Date.now() - startedAt,
  });
  trim();
  return file;
}

/** The least recently used let go, down to FFMPEG_PREVIEWS_MAX_GB. */
function trim(): void {
  try {
    const dir = previewDir();
    // The ten-second ones made before go first, whatever room is left.
    for (const n of fs.readdirSync(dir)) {
      if (n.endsWith(".bif") && !n.endsWith(`${MADE_AS}.bif`)) fs.rmSync(path.join(dir, n), { force: true });
    }
    const kept = fs.readdirSync(dir)
      .filter((n) => n.endsWith(".bif"))
      .map((n) => {
        const st = fs.statSync(path.join(dir, n));
        return { file: path.join(dir, n), bytes: st.size, at: st.mtimeMs };
      })
      .sort((a, b) => a.at - b.at);
    let total = kept.reduce((sum, k) => sum + k.bytes, 0);
    for (const k of kept) {
      if (total <= previewsMaxBytes()) break;
      fs.rmSync(k.file, { force: true });
      total -= k.bytes;
    }
  } catch {
    // Nothing kept yet.
  }
}

const making = new Map<number, Promise<string | null>>();
const failed = new Map<number, number>();
let line: Promise<unknown> = Promise.resolve();

/**
 * The part's previews: made already, or made now — after whatever is ahead of
 * it — or null when they can't be (tried lately and failed, or too many
 * waiting).
 */
export function makePreview(o: PreviewSource): Promise<string | null> {
  const made = madePreview(o.partId, o.fileSize);
  if (made) return Promise.resolve(made.file);
  const already = making.get(o.partId);
  if (already) return already;
  const failedAt = failed.get(o.partId);
  if (failedAt !== undefined && Date.now() - failedAt < RETRY_AFTER_MS) return Promise.resolve(null);
  if (making.size >= MAX_WAITING) return Promise.resolve(null);
  const job = line.then(() => make(o)).catch(() => null).then((file) => {
    making.delete(o.partId);
    if (!file) failed.set(o.partId, Date.now());
    return file;
  });
  line = job;
  making.set(o.partId, job);
  return job;
}

/** For tests: forget what failed. */
export function forgetPreviewFailures(): void {
  failed.clear();
}
