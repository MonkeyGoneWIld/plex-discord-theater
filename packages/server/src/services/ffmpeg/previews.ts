/**
 * Seek-bar previews made by ffmpeg for a file Plex has none for
 * (PLAYBACK_ENGINE=ffmpeg, FFMPEG_PREVIEWS, the file on the mount): a BIF like
 * Plex's — a 320-wide JPEG every PREVIEW_INTERVAL_S — which the preview route
 * serves as it does Plex's. Kept in the app's data folder, so each file is made
 * once; past FFMPEG_PREVIEWS_MAX_GB the least recently used go.
 *
 * Each frame is the keyframe at or before its time, one ffmpeg seek apiece: a
 * few megabytes read per frame, not the whole film read through. One file at a
 * time, SEEKS_AT_ONCE seeks at once, at the lowest CPU priority. An HDR film's
 * frames are tone-mapped: Jellyfin's tonemapx, else zscale's, else as they are.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { logEvent } from "../logger.js";
import { LruMap } from "../lru.js";
import { ffmpegPath, previewsMaxBytes } from "./config.js";

export const PREVIEW_INTERVAL_S = 10;
const WIDTH = 320;
const SEEKS_AT_ONCE = 2;
const FRAME_TIMEOUT_MS = 30_000;
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

function fileFor(partId: number, fileSize: number | null): string {
  return path.join(previewDir(), `${partId}-${fileSize ?? "x"}.bif`);
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
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(ffmpegPath(), args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    try {
      if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW);
    } catch {
      // As it is.
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
  const count = Math.max(1, Math.floor(o.durationS / PREVIEW_INTERVAL_S));
  const frames: Array<Buffer | null> = new Array(count).fill(null);
  let vf = SDR;
  for (const tried of o.hdr ? HDR : []) {
    frames[0] = await grab(o.film, 0, tried);
    if (frames[0]) {
      vf = tried;
      break;
    }
  }
  let next = frames[0] ? 1 : 0;
  await Promise.all(Array.from({ length: SEEKS_AT_ONCE }, async () => {
    while (next < count) {
      const i = next++;
      frames[i] = await grab(o.film, i * PREVIEW_INTERVAL_S, vf);
    }
  }));
  const missed = frames.filter((f) => !f).length;
  // A frame that couldn't be had is the one before it, or the first that could.
  const first = frames.find((f): f is Buffer => !!f);
  if (!first) {
    logEvent("Preview", "ffmpeg couldn't make previews", { partId: o.partId, frames: count });
    return null;
  }
  let last = first;
  const filled = frames.map((f) => (last = f ?? last));
  const file = fileFor(o.partId, o.fileSize);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, bif(filled, PREVIEW_INTERVAL_S * 1000));
  fs.renameSync(tmp, file);
  logEvent("Preview", "previews made by ffmpeg", {
    partId: o.partId, frames: count, missed, hdr: o.hdr ? vf === SDR ? "as it is" : vf.includes("tonemapx") ? "tonemapx" : "zscale" : "no",
    bytes: fs.statSync(file).size, ms: Date.now() - startedAt,
  });
  trim();
  return file;
}

/** The least recently used let go, down to FFMPEG_PREVIEWS_MAX_GB. */
function trim(): void {
  try {
    const dir = previewDir();
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
