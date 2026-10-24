/**
 * PGS subtitles cut out of the film for the player to draw over the picture
 * (PictureSubtitleLayer), rather than burned into a re-encode of it. Burning
 * one in was the commonest reason a copyable film was re-encoded: 41 of the
 * 47 burns in testing up to 24 October were PGS. Drawn here, a viewer with
 * them on shares the room's copy like anybody with text subtitles on.
 *
 * ffmpeg copies the track out of the film into a .sup (the stream as a Blu-ray
 * carries it), which means reading the whole file: minutes for a remux. So it
 * is cut in pieces the player fetches as they grow. The first runs from a
 * little before where the player is (LEAD_S) to the end; once that is done,
 * a second from the start up to there. A player near the start gets one, from
 * the start. When all of it is made the pieces become one file, kept on disk
 * (FFMPEG_PGS_MAX_GB, least recently used first) for the next time. A sidecar
 * .sup is the file it is, fetched once.
 *
 * Timestamps are the film's own (-copyts -start_at_zero), as the engine's
 * copies are, which is the player's clock.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { logEvent } from "../logger.js";
import { ffmpegPath } from "./config.js";

/** The first piece starts this far before the player: a line up when it
 *  starts was put up before. */
const LEAD_S = 30;
/** A player closer than this to the start reads from the start, in one piece. */
const ONE_PIECE_BELOW_S = 120;
/** The most of the server's disk kept for them, unless FFMPEG_PGS_MAX_GB says. */
const DEFAULT_MAX_GB = 2;
/**
 * A piece taking longer than this is stopped. Not one making nothing for a
 * while: a forced-only track can go twenty minutes between lines while the
 * film is read through, and a remux read off the mount takes ten.
 */
const MAX_MS = 45 * 60_000;
/** Cuts going on at once, server-wide: each reads a whole film. */
const AT_ONCE = 2;
/** A cut nobody has asked about for this long is stopped, and forgotten. */
const IDLE_MS = 10 * 60_000;
/** Past this, it isn't a subtitle. */
const MAX_BYTES = 256 * 1024 * 1024;

export interface PgsPiece {
  id: number;
  /** Film time it starts at, seconds; and where it stops, null for the end. */
  fromS: number;
  toS: number | null;
  /** Bytes written so far. */
  bytes: number;
  done: boolean;
}

export interface PgsStatus {
  pieces: PgsPiece[];
  /** All of it is there. */
  done: boolean;
  /** Why it can't be had, when it can't. */
  failed: string | null;
}

/** Where the subtitle comes from: a track in the film, or a file of its own. */
export type PgsSource =
  | { kind: "film"; input: string[]; index: number }
  | { kind: "file"; bytes: () => Promise<Buffer | null> };

interface Piece extends PgsPiece {
  file: string;
  proc: ChildProcess | null;
  failed: string | null;
  started: boolean;
}

interface Job {
  key: string;
  /** Null until it is known where it comes from. */
  source: PgsSource | null;
  pieces: Piece[];
  failed: string | null;
  lastAsked: number;
  startedAt: number;
}

const jobs = new Map<string, Job>();
const waiting: Array<() => void> = [];
let running = 0;

function dataDir(): string {
  const data = process.env.THUMB_CACHE_DIR
    ? path.resolve(process.env.THUMB_CACHE_DIR)
    : path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "../../../data");
  return path.join(data, "subtitles-pgs");
}

function maxBytes(): number {
  const gb = Number(process.env.FFMPEG_PGS_MAX_GB);
  return (Number.isFinite(gb) && gb > 0 ? gb : DEFAULT_MAX_GB) * 1024 ** 3;
}

/** The whole subtitle, made before: one piece, done. */
function made(key: string): Piece | null {
  const file = path.join(dataDir(), `${key}.sup`);
  try {
    const { size } = fs.statSync(file);
    const now = new Date();
    fs.utimesSync(file, now, now);
    return { id: 0, fromS: 0, toS: null, bytes: size, done: true, file, proc: null, failed: null, started: true };
  } catch {
    return null;
  }
}

function statusOf(job: Job): PgsStatus {
  return {
    pieces: job.pieces.map(({ id, fromS, toS, bytes, done }) => ({ id, fromS, toS, bytes, done })),
    done: job.pieces.length > 0 && job.pieces.every((p) => p.done),
    failed: job.failed,
  };
}

/** ffmpeg's arguments for a piece: the track copied out, as it is, film time. */
export function pgsArgs(input: string[], index: number, fromS: number, toS: number | null, out: string): string[] {
  return [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    ...(fromS > 0 ? ["-ss", fromS.toFixed(3)] : []),
    ...(toS !== null ? ["-to", toS.toFixed(3)] : []),
    "-copyts", "-start_at_zero",
    ...input,
    "-map", `0:${index}`, "-c:s", "copy",
    // Each display set on disk as it is cut, for the player asking as it grows.
    "-flush_packets", "1",
    "-f", "sup", "-y", out,
  ];
}

function slot(): Promise<void> {
  if (running < AT_ONCE) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(() => {
    running++;
    resolve();
  }));
}

function release(): void {
  running--;
  waiting.shift()?.();
}

/** Cut one piece; resolves when it is done or failed. */
async function cut(job: Job, piece: Piece): Promise<void> {
  if (job.source?.kind !== "film") return;
  const source = job.source;
  await slot();
  if (jobs.get(job.key) !== job || job.failed) {
    release();
    return;
  }
  piece.started = true;
  await new Promise<void>((resolve) => {
    let stderr = "";
    let proc: ChildProcess;
    try {
      fs.mkdirSync(path.dirname(piece.file), { recursive: true });
      proc = spawn(ffmpegPath(), pgsArgs(source.input, source.index, piece.fromS, piece.toS, piece.file),
        { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      piece.failed = err instanceof Error ? err.message : String(err);
      resolve();
      return;
    }
    piece.proc = proc;
    const began = Date.now();
    const watch = setInterval(() => {
      try {
        piece.bytes = fs.statSync(piece.file).size;
      } catch {
        // Not written yet.
      }
      const idle = Date.now() - job.lastAsked > IDLE_MS;
      if (idle || Date.now() - began > MAX_MS || piece.bytes > MAX_BYTES) {
        if (!piece.failed) piece.failed = idle ? "nobody asked for it" : piece.bytes > MAX_BYTES ? "too big" : "it took too long";
        proc.kill("SIGKILL");
      }
    }, 500);
    proc.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-600);
    });
    proc.on("error", (err) => {
      piece.failed = piece.failed ?? `ffmpeg: ${err.message}`;
    });
    proc.on("close", (code, signal) => {
      clearInterval(watch);
      piece.proc = null;
      try {
        piece.bytes = fs.statSync(piece.file).size;
      } catch {
        piece.bytes = 0;
      }
      if (code === 0 && !piece.failed) piece.done = true;
      else piece.failed = piece.failed ?? `ffmpeg exited ${code ?? signal}${stderr.trim() ? `: ${stderr.trim().split("\n").pop()}` : ""}`;
      resolve();
    });
  });
  release();
}

/** All of a film's pieces done: one file, kept; or the job failed. */
function finish(job: Job): void {
  const failed = job.pieces.find((p) => p.failed);
  if (failed) {
    job.failed = failed.failed;
    logEvent("Subtitles", "couldn't cut a picture subtitle out of the film", {
      key: job.key, why: job.failed, ms: Date.now() - job.startedAt,
    });
    return;
  }
  if (!job.pieces.every((p) => p.done)) return;
  const final = path.join(dataDir(), `${job.key}.sup`);
  try {
    // The start first, then the rest; where they overlap the player keeps one
    // of each display set.
    const ordered = [...job.pieces].sort((a, b) => a.fromS - b.fromS);
    const tmp = `${final}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, Buffer.concat(ordered.map((p) => fs.readFileSync(p.file))));
    fs.renameSync(tmp, final);
    const bytes = fs.statSync(final).size;
    logEvent("Subtitles", "a picture subtitle cut out of the film for players to draw", {
      key: job.key, pieces: job.pieces.length, bytes, ms: Date.now() - job.startedAt,
    });
    // Pieces a player is part way through stay readable until the job is let go.
    trim();
  } catch (err) {
    logEvent("Subtitles", "couldn't keep a picture subtitle", { key: job.key, why: String(err) });
  }
}

/** Least recently used first, down to FFMPEG_PGS_MAX_GB. */
function trim(): void {
  try {
    const dir = dataDir();
    const kept = fs.readdirSync(dir)
      .filter((n) => n.endsWith(".sup"))
      .map((n) => {
        const st = fs.statSync(path.join(dir, n));
        return { file: path.join(dir, n), bytes: st.size, at: st.mtimeMs };
      })
      .sort((a, b) => a.at - b.at);
    let total = kept.reduce((sum, k) => sum + k.bytes, 0);
    for (const k of kept) {
      if (total <= maxBytes()) break;
      fs.rmSync(k.file, { force: true });
      total -= k.bytes;
    }
  } catch {
    // Nothing kept yet.
  }
}

async function run(job: Job, atS: number): Promise<void> {
  if (!job.source) return;
  if (job.source.kind === "file") {
    const bytes = await job.source.bytes().catch(() => null);
    if (!bytes || bytes.length === 0) {
      job.failed = "the file couldn't be read";
      return;
    }
    const file = path.join(dataDir(), `${job.key}.sup`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    job.pieces = [{ id: 0, fromS: 0, toS: null, bytes: bytes.length, done: true, file, proc: null, failed: null, started: true }];
    trim();
    return;
  }
  const dir = path.join(dataDir(), "cutting", job.key);
  const from = atS < ONE_PIECE_BELOW_S ? 0 : Math.max(0, atS - LEAD_S);
  const piece = (id: number, fromS: number, toS: number | null): Piece => ({
    id, fromS, toS, bytes: 0, done: false, file: path.join(dir, `${id}.sup`), proc: null, failed: null, started: false,
  });
  // From where the player is to the end; then the start, up to a little past
  // where the first began, so a line across the join is in one of them whole.
  job.pieces = from > 0 ? [piece(0, from, null), piece(1, 0, from + LEAD_S)] : [piece(0, 0, null)];
  logEvent("Subtitles", "cutting a picture subtitle out of the film for players to draw", {
    key: job.key, fromS: Math.round(from), pieces: job.pieces.length,
  });
  for (const p of job.pieces) {
    await cut(job, p);
    if (p.failed || jobs.get(job.key) !== job) break;
  }
  // Its pieces are still what players are reading, until it is let go; the
  // next to ask after that gets the one file.
  finish(job);
}

/**
 * Where this subtitle's pieces are: made before, being cut, or now started
 * from `atS` (film seconds, where the player is). `key` names the subtitle
 * and the file it is in (its part, its size, its stream).
 */
export function pgsStatus(key: string, source: () => Promise<PgsSource | null>, atS: number): PgsStatus {
  let job = jobs.get(key);
  if (!job) {
    const whole = made(key);
    job = { key, source: null, pieces: whole ? [whole] : [], failed: null, lastAsked: Date.now(), startedAt: Date.now() };
    jobs.set(key, job);
    if (!whole) {
      // Asked again before it is known where it comes from: the same job.
      const started = job;
      void (async () => {
        started.source = await source().catch(() => null);
        if (!started.source) started.failed = "it couldn't be found";
        else await run(started, Math.max(0, atS));
      })().catch((err) => {
        started.failed = started.failed ?? String(err);
      });
    }
  }
  job.lastAsked = Date.now();
  return statusOf(job);
}

/** A piece's bytes from `from` to what is written; null for no such piece. */
export async function pgsBytes(key: string, id: number, from: number): Promise<Buffer | null> {
  const job = jobs.get(key);
  const piece = job?.pieces.find((p) => p.id === id);
  if (!job || !piece) return null;
  job.lastAsked = Date.now();
  if (!piece.started) return Buffer.alloc(0);
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(piece.file, "r");
  } catch {
    return Buffer.alloc(0);
  }
  try {
    const { size } = await handle.stat();
    const length = Math.max(0, Math.min(size, MAX_BYTES) - from);
    const out = Buffer.alloc(length);
    const { bytesRead } = await handle.read(out, 0, length, from);
    return out.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// Cuts nobody asks about any more are let go (their ffmpeg stops itself:
// see cut), and whatever a stopped server left half cut.
setInterval(() => {
  for (const [key, job] of jobs) {
    const busy = job.pieces.some((p) => p.proc);
    // A failed one is let go sooner, so a later ask tries again.
    if (!busy && Date.now() - job.lastAsked > (job.failed ? 60_000 : IDLE_MS)) {
      jobs.delete(key);
      fs.promises.rm(path.join(dataDir(), "cutting", key), { recursive: true, force: true }).catch(() => {});
    }
  }
}, 60_000).unref();
try {
  fs.rmSync(path.join(dataDir(), "cutting"), { recursive: true, force: true });
} catch {
  // Nothing there.
}

/** For tests: forget every cut. */
export function forgetPgs(): void {
  for (const job of jobs.values()) for (const p of job.pieces) p.proc?.kill("SIGKILL");
  jobs.clear();
}
