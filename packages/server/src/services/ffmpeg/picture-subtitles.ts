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
 * A made one is handed out in pieces too, of about PIECE_BYTES each, every one
 * starting on a line drawn afresh: a film's is 20 to 40 MB, which through
 * Discord's proxy took a player joining half a minute to have any of, and one
 * starting part way in longer. In pieces it reads the one where it is first.
 * They are the same bytes for as long as the file is (`v`), so the player's
 * browser keeps them for the next time, and they go gzipped: about 2.3 times
 * smaller.
 *
 * A page somebody is looking at can have its cut started ahead (pgsAhead), as
 * a text subtitle is read ahead, so the film starts with it made.
 *
 * Timestamps are the film's own (-copyts -start_at_zero), as the engine's
 * copies are, which is the player's clock.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
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
/** About how much of a made subtitle a piece of it is: 40 lines or so. */
const PIECE_BYTES = 1024 * 1024;
/**
 * A made subtitle's pieces are numbered from here, apart from a cut's (0 and
 * 1), so an id names the same bytes whether the file was made just now or
 * before: the player's browser keeps them by it.
 */
const MADE_FIRST_ID = 1000;

let pieceBytes = PIECE_BYTES;
const gzipped = promisify(gzip);

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
  /** Names a made subtitle's bytes, for asking for its pieces by: they don't
   *  change while it does. Null while it is being cut. */
  v: string | null;
}

/** Where the subtitle comes from: a track in the film, or a file of its own. */
export type PgsSource =
  | { kind: "film"; input: string[]; index: number }
  | { kind: "file"; bytes: () => Promise<Buffer | null> };

interface Piece extends PgsPiece {
  file: string;
  /** Where in `file` it starts, and how long it is: null for all of a file
   *  still being written. */
  offset: number;
  length: number | null;
  proc: ChildProcess | null;
  failed: string | null;
  started: boolean;
  /** All of it gzipped, once asked for so. */
  gz?: Buffer;
}

interface Job {
  key: string;
  /** Null until it is known where it comes from. */
  source: PgsSource | null;
  pieces: Piece[];
  /** A cut's pieces, once the file they made is handed out in its own: a
   *  player part way through one reads on to its end. */
  old: Piece[];
  /** PgsStatus.v. */
  v: string | null;
  failed: string | null;
  lastAsked: number;
  startedAt: number;
  /** For a cut started ahead of anyone playing: still worth starting. */
  wanted?: () => boolean;
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

/** A display set: where it is in a .sup, when it goes up, and whether it is
 *  drawn afresh (an epoch start), needing nothing from a set before it. */
interface DisplaySet {
  at: number;
  end: number;
  pts: number;
  fresh: boolean;
}

/** The display sets in a .sup, in the order it has them; [] for one that isn't. */
export function displaySets(buf: Buffer): DisplaySet[] {
  const out: DisplaySet[] = [];
  let open: DisplaySet | null = null;
  let at = 0;
  while (at + 13 <= buf.length) {
    if (buf[at] !== 0x50 || buf[at + 1] !== 0x47) return [];
    const size = buf.readUInt16BE(at + 11);
    const end = at + 13 + size;
    if (end > buf.length) break;
    const type = buf[at + 10];
    if (type === 0x16) {
      open = { at, end, pts: buf.readUInt32BE(at + 2) / 90_000, fresh: size > 7 && (buf[at + 13 + 7] & 0x80) !== 0 };
    }
    if (open) open.end = end;
    if (type === 0x80 && open) {
      out.push(open);
      open = null;
    }
    at = end;
  }
  return out;
}

/**
 * A made subtitle in pieces of about pieceBytes, each from a set drawn afresh
 * to just before the next one's: so a line and the set that clears it are in
 * the same piece, and a piece drawn on its own draws right.
 */
function piecesOf(file: string, buf: Buffer): Piece[] {
  const piece = (i: number, offset: number, length: number, fromS: number, toS: number | null): Piece => ({
    id: MADE_FIRST_ID + i, fromS, toS, bytes: length, done: true,
    file, offset, length, proc: null, failed: null, started: true,
  });
  const pieces: Piece[] = [];
  let start = 0;
  let fromS = 0;
  for (const s of displaySets(buf)) {
    if (s.fresh && s.at - start >= pieceBytes) {
      pieces.push(piece(pieces.length, start, s.at - start, fromS, s.pts));
      start = s.at;
      fromS = s.pts;
    }
  }
  pieces.push(piece(pieces.length, start, buf.length - start, fromS, null));
  return pieces;
}

/** The whole subtitle, made before, in its pieces. */
function made(key: string): { pieces: Piece[]; v: string } | null {
  const file = path.join(dataDir(), `${key}.sup`);
  try {
    const buf = fs.readFileSync(file);
    const now = new Date();
    fs.utimesSync(file, now, now);
    return { pieces: piecesOf(file, buf), v: `${key}-${buf.length}` };
  } catch {
    return null;
  }
}

/**
 * A cut's two pieces as one file in film order, each display set once: the
 * start up to where the rest's first fresh set goes up, then the rest from
 * there — with anything of the rest's before that past the start's last (a
 * line cleared), so nothing is lost at the join.
 */
function joined(rest: Buffer, start: Buffer | null): Buffer {
  if (!start) return rest;
  const later = displaySets(rest);
  const earlier = displaySets(start);
  if ((rest.length > 0 && later.length === 0) || (start.length > 0 && earlier.length === 0)) {
    return Buffer.concat([start, rest]);
  }
  const join = later.find((s) => s.fresh)?.pts ?? Infinity;
  const startEnds = earlier.at(-1)?.pts ?? -1;
  return Buffer.concat([
    ...earlier.filter((s) => s.pts < join).map((s) => start.subarray(s.at, s.end)),
    ...later.filter((s) => s.pts >= join || s.pts > startEnds).map((s) => rest.subarray(s.at, s.end)),
  ]);
}

function statusOf(job: Job): PgsStatus {
  return {
    pieces: job.pieces.map(({ id, fromS, toS, bytes, done }) => ({ id, fromS, toS, bytes, done })),
    done: job.pieces.length > 0 && job.pieces.every((p) => p.done),
    failed: job.failed,
    v: job.v,
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
  if (job.wanted && !job.wanted()) {
    // Read ahead for a page left before its turn came: the next to ask starts again.
    jobs.delete(job.key);
    release();
    logEvent("Subtitles", "a picture subtitle cut ahead for a page left before it began, dropped", { key: job.key });
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
    const [rest, start] = job.pieces;
    const buf = joined(fs.readFileSync(rest.file), start ? fs.readFileSync(start.file) : null);
    const tmp = `${final}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, final);
    // From now on handed out as a made one is; whoever is part way through a
    // piece of the cut reads on to its end.
    job.old = job.pieces;
    job.pieces = piecesOf(final, buf);
    job.v = `${job.key}-${buf.length}`;
    logEvent("Subtitles", "a picture subtitle cut out of the film for players to draw", {
      key: job.key, pieces: job.old.length, bytes: buf.length, handedOutIn: job.pieces.length, ms: Date.now() - job.startedAt,
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
    job.pieces = piecesOf(file, bytes);
    job.v = `${job.key}-${bytes.length}`;
    trim();
    return;
  }
  const dir = path.join(dataDir(), "cutting", job.key);
  const from = atS < ONE_PIECE_BELOW_S ? 0 : Math.max(0, atS - LEAD_S);
  const piece = (id: number, fromS: number, toS: number | null): Piece => ({
    id, fromS, toS, bytes: 0, done: false, file: path.join(dir, `${id}.sup`), offset: 0, length: null,
    proc: null, failed: null, started: false,
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
  const job = jobFor(key, source, atS);
  job.lastAsked = Date.now();
  // A player wants it: no longer only ahead of one.
  job.wanted = undefined;
  return statusOf(job);
}

/** The pages that started a cut ahead, by who is looking: their next page's replaces it. */
const aheadBy = new Map<string, string>();

/**
 * Start cutting the subtitle a page somebody is looking at would play with,
 * from the start, unless it is made or under way. Not started if `by` has
 * moved on to another page's by the time a cut is free to.
 */
export function pgsAhead(key: string, source: () => Promise<PgsSource | null>, by: string): void {
  if (jobs.has(key)) return;
  aheadBy.set(by, key);
  const job = jobFor(key, source, 0, () => aheadBy.get(by) === key);
  if (job.pieces.length === 0) {
    logEvent("Subtitles", "cutting ahead the picture subtitle a title being looked at would start with", { key });
  }
}

function jobFor(key: string, source: () => Promise<PgsSource | null>, atS: number, wanted?: () => boolean): Job {
  let job = jobs.get(key);
  if (!job) {
    const whole = made(key);
    job = {
      key, source: null, pieces: whole?.pieces ?? [], old: [], v: whole?.v ?? null,
      failed: null, lastAsked: Date.now(), startedAt: Date.now(), wanted,
    };
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
  return job;
}

/**
 * A piece's bytes from `from` to what is written, gzipped when asked and it is
 * all of a made one's; null for no such piece. `whole` for all of a made
 * one's, which is the same for as long as `v` is.
 */
export async function pgsBytes(key: string, id: number, from: number, gzip = false): Promise<
  { bytes: Buffer; gzipped: boolean; whole: boolean; v: string | null } | null
> {
  const job = jobs.get(key);
  const piece = job?.pieces.find((p) => p.id === id) ?? job?.old.find((p) => p.id === id);
  if (!job || !piece) return null;
  job.lastAsked = Date.now();
  const whole = piece.done && piece.length !== null && from === 0;
  const answer = (bytes: Buffer, zipped = false) => ({ bytes, gzipped: zipped, whole, v: job.v });
  if (whole && gzip && piece.gz) return answer(piece.gz, true);
  if (!piece.started) return answer(Buffer.alloc(0));
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(piece.file, "r");
  } catch {
    // A made one gone from the disk is gone; a cut's not written yet.
    return piece.length !== null ? null : answer(Buffer.alloc(0));
  }
  let bytes: Buffer;
  try {
    const { size } = await handle.stat();
    const end = piece.length !== null ? piece.offset + piece.length : Math.min(size, MAX_BYTES);
    const length = Math.max(0, end - piece.offset - from);
    const out = Buffer.alloc(length);
    const { bytesRead } = await handle.read(out, 0, length, piece.offset + from);
    bytes = out.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  if (whole && gzip && bytes.length > 1024) {
    piece.gz = await gzipped(bytes);
    return answer(piece.gz, true);
  }
  return answer(bytes);
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
  aheadBy.clear();
}

/** For tests: how much of a made subtitle a piece is. */
export function pgsPieceBytesForTests(bytes: number): void {
  pieceBytes = bytes;
}

/** For tests: a cut's two pieces made one. */
export const joinPgsPiecesForTests = joined;
