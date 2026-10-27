/**
 * PGS subtitles cut out of the film for the player to draw over the picture
 * (PictureSubtitleLayer), rather than burned into a re-encode of it. Burning
 * one in was the commonest reason a copyable film was re-encoded: 41 of the
 * 47 burns in testing up to 24 October were PGS. Drawn here, a viewer with
 * them on shares the room's copy like anybody with text subtitles on.
 *
 * ffmpeg copies the track out of the film into a .sup (the stream as a Blu-ray
 * carries it), which means reading the whole file: minutes for a remux. So it
 * is cut in pieces the player fetches as they grow, one at a time for a film.
 * The first runs from a little before where the player is (LEAD_S) to the
 * end. A player that skips past where the cut has read to (CATCH_UP_S) has it
 * stopped there and a new one started a little before it: in run 23 a skip
 * through Project Hail Mary waited minutes for a cut reading the whole remux
 * from the start. What no piece has, before and between, is cut after, the
 * stretch the player is in first. When all of it is made the pieces become
 * one file, kept on disk (FFMPEG_PGS_MAX_GB, least recently used first) for
 * the next time. A sidecar .sup is the file it is, fetched once.
 *
 * Each piece being cut says how far it has read the film (`reachedS`, from the
 * times of the picture's packets as ffmpeg reads them): every line before that
 * is in it. Between two lines, then, the player knows there is nothing to
 * show, rather than taking the quiet for a subtitle still on its way.
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

/** A piece for where the player is starts this far before it: a line up when
 *  it starts was put up before. */
const LEAD_S = 30;
/** A player closer than this to the start reads from the start, in one piece. */
const ONE_PIECE_BELOW_S = 120;
/**
 * A player this far past where the running cut has read to has it stopped
 * and a new one started for it. Closer, the running one gets there first: a
 * remux is read at 10 to 20 times the film's speed, and a new cut takes a
 * second or two to start.
 */
const CATCH_UP_S = 60;
/** Lines are read a little behind the picture's packets at the same time:
 *  how far a cut has read is taken this far back from the picture's. */
const REACH_SLACK_S = 5;
/** Pieces overlap this much where one starts at another's end. */
const JOIN_S = 5;
/** The most of the server's disk kept for them, unless FFMPEG_PGS_MAX_GB says. */
const DEFAULT_MAX_GB = 2;
/**
 * A piece taking longer than this is stopped. Not one making nothing for a
 * while: a forced-only track can go twenty minutes between lines while the
 * film is read through, and a remux read off the mount takes ten.
 */
const MAX_MS = 45 * 60_000;
/** Cuts going on at once, server-wide: each reads a film. One a film. */
const AT_ONCE = 3;
/** A cut nobody has asked about for this long is stopped, and forgotten. */
const IDLE_MS = 10 * 60_000;
/** Past this, it isn't a subtitle. */
const MAX_BYTES = 256 * 1024 * 1024;
/** About how much of a made subtitle a piece of it is: 40 lines or so. */
const PIECE_BYTES = 1024 * 1024;
/**
 * A made subtitle's pieces are numbered from here, apart from a cut's (0
 * up), so an id names the same bytes whether the file was made just now or
 * before: the player's browser keeps them by it.
 */
const MADE_FIRST_ID = 1000;
/** A cut's bytes past this, asked for, go gzipped. */
const GZIP_FROM_BYTES = 64 * 1024;

let pieceBytes = PIECE_BYTES;
const gzipped = promisify(gzip);

export interface PgsPiece {
  id: number;
  /** Film time it starts at, seconds; and where it stops, null for the end.
   *  A cut stopped for a skip ends where it had read to. */
  fromS: number;
  toS: number | null;
  /** Bytes written so far. */
  bytes: number;
  done: boolean;
  /** A piece being cut: how far into the film it has read, seconds — every
   *  line before it is in its first `bytes`. Null before it knows, and for
   *  one done (it has all of fromS to toS). */
  reachedS?: number | null;
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
  /** How far the picture's packets have come, as ffmpeg reads them; and as
   *  of the last look, half a second before. That one is reachedS, with the
   *  bytes on disk now: a line read just before it has had the time to be
   *  written. */
  seenS: number | null;
  seenBefore?: number | null;
  /** Stopped for a skip, or to give way: done, up to where it had read. */
  stopped: boolean;
  /** For where the player is: ahead of cuts filling in what is left. */
  urgent: boolean;
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
  /** Where the player last said it was, film seconds. */
  atS: number;
  /** The piece being cut, or waiting for its turn to be. */
  cutting: Piece | null;
  nextId: number;
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
    file, offset, length, proc: null, failed: null, started: true, seenS: null, stopped: false, urgent: false,
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
 * A cut's pieces as one file in film order, each display set once: where
 * pieces overlap they have the same sets, and a piece stopped part way has
 * only whole ones (displaySets). One that can't be read as a .sup is put
 * together as it is.
 */
function joined(parts: Buffer[]): Buffer {
  const sets: Array<{ pts: number; bytes: Buffer }> = [];
  for (const buf of parts) {
    const found = displaySets(buf);
    if (buf.length > 0 && found.length === 0) return Buffer.concat(parts);
    for (const s of found) sets.push({ pts: s.pts, bytes: buf.subarray(s.at, s.end) });
  }
  // Stable: sets at the same time keep their order.
  sets.sort((a, b) => a.pts - b.pts);
  const out: Buffer[] = [];
  let at = -1;
  let here: Buffer[] = [];
  for (const s of sets) {
    if (s.pts !== at) {
      at = s.pts;
      here = [];
    }
    if (here.some((b) => b.equals(s.bytes))) continue;
    here.push(s.bytes);
    out.push(s.bytes);
  }
  return Buffer.concat(out);
}

function statusOf(job: Job): PgsStatus {
  return {
    pieces: job.pieces.map(({ id, fromS, toS, bytes, done, reachedS, length }) => ({
      id, fromS, toS, bytes, done, ...(length === null && !done ? { reachedS: reachedS ?? null } : {}),
    })),
    done: job.v !== null,
    failed: job.failed,
    v: job.v,
  };
}

/**
 * ffmpeg's arguments for a piece: the track copied out, as it is, film time.
 * The picture's packets are read too and thrown away, with their times on
 * stderr (-debug_ts): how far the cut has read, lines or none (reachOf).
 */
export function pgsArgs(input: string[], index: number, fromS: number, toS: number | null, out: string): string[] {
  return [
    "-hide_banner", "-nostdin", "-nostats", "-loglevel", "info", "-debug_ts",
    ...(fromS > 0 ? ["-ss", fromS.toFixed(3)] : []),
    ...(toS !== null ? ["-to", toS.toFixed(3)] : []),
    "-copyts", "-start_at_zero",
    ...input,
    "-map", `0:${index}`, "-c:s", "copy",
    // Each display set on disk as it is cut, for the player asking as it grows.
    "-flush_packets", "1",
    "-f", "sup", "-y", out,
    "-map", "0:v:0?", "-c", "copy", "-f", "null", "-",
  ];
}

/** The latest picture packet's time in a stretch of ffmpeg's -debug_ts output. */
export function reachOf(text: string): number | null {
  let at = text.lastIndexOf("type:video");
  while (at >= 0) {
    const m = /^type:video\b[^\n]*?\bpkt_dts_time:(\d+(?:\.\d+)?)/.exec(text.slice(at, at + 400));
    if (m) return Number(m[1]);
    at = text.lastIndexOf("type:video", at - 1);
  }
  return null;
}

/** ffmpeg's lines that say what went wrong, not its -debug_ts ones. */
function complaint(text: string): string {
  return text.split("\n").filter((l) => l.trim() && !/->|<-|pkt_pts|^\s|^(Input|Output|Stream|Press|Duration)\b/.test(l))
    .join("\n");
}

function slot(urgent: boolean): Promise<void> {
  if (running < AT_ONCE) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const go = () => {
      running++;
      resolve();
    };
    // Where somebody is watching goes before filling in what is left.
    if (urgent) waiting.unshift(go);
    else waiting.push(go);
  });
}

function release(): void {
  running--;
  waiting.shift()?.();
}

/** Cut one piece; resolves when it is done, stopped or failed. */
async function cut(job: Job, piece: Piece): Promise<void> {
  if (job.source?.kind !== "film") return;
  const source = job.source;
  await slot(piece.urgent);
  if (jobs.get(job.key) !== job || job.failed || piece.stopped) {
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
    let said = "";
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
    const measure = (closed = false) => {
      // How far it had read, then what is on disk: all of that is in it.
      const seen = closed ? piece.seenS : piece.seenBefore ?? null;
      piece.seenBefore = piece.seenS;
      try {
        piece.bytes = fs.statSync(piece.file).size;
      } catch {
        // Not written yet.
      }
      if (seen !== null) piece.reachedS = Math.max(piece.fromS, seen - REACH_SLACK_S);
    };
    const watch = setInterval(() => {
      measure();
      const idle = Date.now() - job.lastAsked > IDLE_MS;
      if (idle || Date.now() - began > MAX_MS || piece.bytes > MAX_BYTES) {
        if (!piece.failed) piece.failed = idle ? "nobody asked for it" : piece.bytes > MAX_BYTES ? "too big" : "it took too long";
        proc.kill("SIGKILL");
      }
    }, 500);
    proc.stderr?.on("data", (d: Buffer) => {
      const text = d.toString("latin1");
      const reach = reachOf(text);
      if (reach !== null && reach > (piece.seenS ?? -1)) piece.seenS = reach;
      const bad = complaint(text);
      if (bad) said = (said + bad).slice(-600);
    });
    proc.on("error", (err) => {
      piece.failed = piece.failed ?? `ffmpeg: ${err.message}`;
    });
    proc.on("close", (code, signal) => {
      clearInterval(watch);
      piece.proc = null;
      measure(true);
      if (piece.stopped && !piece.failed) {
        // Has everything before where it had read to.
        piece.toS = piece.reachedS ?? piece.fromS;
        piece.done = true;
      } else if (code === 0 && !piece.failed) {
        piece.done = true;
      } else {
        piece.failed = piece.failed ?? `ffmpeg exited ${code ?? signal}${said.trim() ? `: ${said.trim().split("\n").pop()}` : ""}`;
      }
      piece.reachedS = null;
      resolve();
    });
  });
  release();
}

/** What of the film the pieces done have, in order, joined where they meet. */
function doneSpans(job: Job): Array<[number, number]> {
  const spans = job.pieces
    .filter((p) => p.done && (p.toS === null || p.toS > p.fromS))
    .map((p): [number, number] => [p.fromS, p.toS ?? Infinity])
    .sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [from, to] of spans) {
    const last = out[out.length - 1];
    if (last && from <= last[1] + 0.5) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

/** What of the film no piece done has: [from, to] stretches, to Infinity for the end. */
function gaps(job: Job): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let at = 0;
  for (const [from, to] of doneSpans(job)) {
    if (from > at + 0.5) out.push([at, from]);
    at = Math.max(at, to);
  }
  if (at !== Infinity) out.push([at, Infinity]);
  return out;
}

/** Whether `atS` is in a piece done, or one being cut will be there soon. */
function covered(job: Job, atS: number): boolean {
  if (doneSpans(job).some(([from, to]) => from <= atS && atS < to)) return true;
  const c = job.cutting;
  if (!c || atS < c.fromS || (c.toS !== null && atS >= c.toS)) return false;
  return atS <= (c.reachedS ?? c.fromS) + CATCH_UP_S;
}

/**
 * The next piece to cut: the stretch where the player is, from a little
 * before it, when no piece has it; else what is left, earliest first. None
 * left: all of it is made into one file.
 */
function next(job: Job): void {
  if (jobs.get(job.key) !== job || job.failed || job.source?.kind !== "film") return;
  const left = gaps(job);
  if (!left.length) {
    finish(job);
    return;
  }
  const here = left.find(([from, to]) => from <= job.atS && job.atS < to);
  const [gapFrom, gapTo] = here ?? left[0];
  const fromS = here
    ? Math.max(gapFrom > 0 ? gapFrom - JOIN_S : 0, job.atS < ONE_PIECE_BELOW_S ? 0 : job.atS - LEAD_S)
    : gapFrom > 0 ? gapFrom - JOIN_S : 0;
  const toS = gapTo === Infinity ? null : gapTo + JOIN_S;
  if (job.nextId >= MADE_FIRST_ID) {
    job.failed = "cut in too many pieces";
    return;
  }
  const id = job.nextId++;
  const piece: Piece = {
    id, fromS: Math.max(0, fromS), toS, bytes: 0, done: false,
    file: path.join(dataDir(), "cutting", job.key, `${id}.sup`), offset: 0, length: null,
    proc: null, failed: null, started: false, seenS: null, reachedS: null, stopped: false, urgent: !!here,
  };
  job.pieces.push(piece);
  job.cutting = piece;
  logEvent("Subtitles", "cutting a picture subtitle out of the film for players to draw", {
    key: job.key, piece: id, fromS: Math.round(piece.fromS), toS: toS === null ? "end" : Math.round(toS),
    for: here ? "where the player is" : "what is left",
  });
  void cut(job, piece).then(() => {
    if (job.cutting === piece) job.cutting = null;
    if (piece.failed) {
      job.failed = piece.failed;
      logEvent("Subtitles", "couldn't cut a picture subtitle out of the film", {
        key: job.key, piece: id, why: job.failed, ms: Date.now() - job.startedAt,
      });
      return;
    }
    next(job);
  });
}

/**
 * The player is at `atS`: when no piece has it and the one being cut won't be
 * there soon, that one is stopped where it has read to and the next is cut
 * from there — or, still waiting its turn, moved there.
 */
function follow(job: Job, atS: number): void {
  job.atS = atS;
  if (job.source?.kind !== "film" || job.v !== null || job.failed || !job.cutting || covered(job, atS)) return;
  const c = job.cutting;
  if (!c.started) {
    c.fromS = atS < ONE_PIECE_BELOW_S ? 0 : Math.max(0, atS - LEAD_S);
    c.urgent = true;
    const after = doneSpans(job).find(([from]) => from > c.fromS);
    c.toS = after ? after[0] + JOIN_S : null;
    return;
  }
  if (c.stopped) return;
  c.stopped = true;
  logEvent("Subtitles", "a picture subtitle's cut stopped for a skip past it", {
    key: job.key, piece: c.id, fromS: Math.round(c.fromS), reachedS: Math.round(c.reachedS ?? c.fromS), atS: Math.round(atS),
  });
  c.proc?.kill("SIGKILL");
}

/** All of a film's pieces done: one file, kept. */
function finish(job: Job): void {
  const final = path.join(dataDir(), `${job.key}.sup`);
  try {
    const order = [...job.pieces].sort((a, b) => a.fromS - b.fromS);
    const buf = joined(order.map((p) => fs.readFileSync(p.file)));
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

async function run(job: Job): Promise<void> {
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
  next(job);
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
  follow(job, Math.max(0, atS));
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
      failed: null, lastAsked: Date.now(), startedAt: Date.now(), atS: Math.max(0, atS),
      cutting: null, nextId: 0, wanted,
    };
    jobs.set(key, job);
    if (!whole) {
      // Asked again before it is known where it comes from: the same job.
      const started = job;
      void (async () => {
        started.source = await source().catch(() => null);
        if (!started.source) started.failed = "it couldn't be found";
        else await run(started);
      })().catch((err) => {
        started.failed = started.failed ?? String(err);
      });
    }
  }
  return job;
}

/**
 * A piece's bytes from `from` to what is written, gzipped when asked: all of a
 * made one's (kept so), or a cut's when there is enough to be worth it. Null
 * for no such piece. `whole` for all of a made one's, which is the same for as
 * long as `v` is.
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
  // A cut's: through Discord's proxy, megabytes of it at a time after a skip.
  if (gzip && bytes.length > GZIP_FROM_BYTES) return answer(await gzipped(bytes), true);
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

/** For tests: a cut's pieces made one. */
export const joinPgsPiecesForTests = joined;
