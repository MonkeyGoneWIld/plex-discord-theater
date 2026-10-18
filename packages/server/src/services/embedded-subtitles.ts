/**
 * Text subtitles stored inside a media file, read out through Plex so the
 * player can draw them — which is what lets the video be copied rather than
 * re-encoded with the subtitle burned into it.
 *
 * Plex's own apps do this with a subtitle-only transcode,
 * /subtitles/:/transcode/universal/start, which answers with the item's
 * selected subtitle track as text. Getting all of it means Plex reading the
 * whole file, because the track is spread across all of it: a second or two for
 * an episode, a minute for a big remux (American Honey, 17.7 GB: 66 seconds).
 * Plex sends the lines as it goes, in the film's order, at over a hundred times
 * the speed anyone watches — the first within a second or two — and the player
 * draws them as they come. The finished read is kept on disk, so each subtitle
 * is only ever read once.
 *
 * What had come was thrown away until the read was over, which is what started
 * films on "Loading subtitles…" for as long as it took. It was made into cues
 * up to the last blank line, so a half-arrived cue would wait; but Plex sends
 * ASS, one line per event and Windows line ends, and no blank line ever came.
 * It is cut into whole lines now (Lines), and made into cues every quarter of a
 * second.
 *
 * Someone who starts, or skips, somewhere the read from the start hasn't got to
 * is read the lines around them on their own (want): out of the file itself,
 * through its index (mkv-subtitles.ts), or by Plex reading from there. Plex
 * honours where to start for a subtitle it converts, though not for one it
 * copies — see mkv-subtitles.ts. The player says where it is when it asks, and
 * is answered as soon as there are lines for there.
 *
 * The first version asked /video/:/transcode/universal/subtitles instead. Plex
 * answers that by starting a second transcode of the whole film, video and all,
 * and sending it — a real deployment downloaded 2 GB of Matroska from it, and
 * timed out on two others while Plex re-encoded them.
 *
 * One Plex can't read out is reported unreadable, and the player then asks for
 * a stream with it burned in instead.
 *
 * A title's other text subtitles are read too, one at a time behind whatever
 * someone is actually waiting on (prefetchEmbeddedSubtitles), so switching to
 * one later finds it ready. What is kept is the file Plex sent as well as the
 * cues made from it: a better parser re-reads the kept text rather than the
 * film, and a file that has changed since — told apart by a fingerprint of the
 * media part it came from — is read again.
 *
 * Every read is stopped on Plex once it is over. Letting go of the answer isn't
 * enough: Plex goes on reading the file to the end for nobody.
 */

import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { plexFetch, plexUrl } from "./plex.js";
import { parseSubtitles, parseTimestamp, SUBTITLE_PARSER_VERSION, type Cue } from "./subtitles.js";
import { logEvent } from "./logger.js";
import { LruMap } from "./lru.js";
import { ffmpegPath } from "./ffmpeg/config.js";

/**
 * How long an ask waits for a read to finish before answering with the lines
 * read so far. Most finish well inside it; the player asks again for the rest.
 * Also how long the item stays locked waiting for Plex to start answering.
 */
export const ANSWER_WAIT_MS = 4_000;
/** How long a whole read may take: a big remux on spinning disks. */
const READ_TIMEOUT_MS = 15 * 60_000;
/** Remembered as unreadable for this long before it is tried again. */
const RETRY_AFTER_MS = 60 * 60_000;
/**
 * Bigger than any real subtitle. Most are well under a megabyte, but fansubbed
 * anime with heavy typesetting is not: every sign redrawn each frame, with its
 * masks as vector drawings, made Kaguya-sama's 8.4 MB — over the 8 MB this used
 * to allow, so it was burned in instead. A video file is gigabytes.
 */
const MAX_BYTES = 64 * 1024 * 1024;
/** How often lines that have come are made into cues, at the most. */
const PARSE_EVERY_MS = 250;
/**
 * How far before a place lines around it are read from: one that started that
 * long ago can still be up.
 */
const AROUND_BEFORE_S = 30;
/** What is read out of the file first, to answer with. */
const AROUND_FIRST_S = 120;
/**
 * How far past someone lines are kept ready while the read from the start is
 * behind them. Asked again when they are within half of it of the end.
 */
const AROUND_AHEAD_S = 600;
/** And how far past them a Plex read from somewhere goes before it stops. */
const PLEX_AHEAD_S = 1200;
/** No Plex read from somewhere this close ahead of the read from the start:
 *  that is there within a second or so. */
const PLEX_NOT_FOR_S = 120;
/** Where someone said they were counts for this long. */
const WANTED_FOR_MS = 30_000;
/** How often a read is checked for whether it should stop, between lines. */
const STOP_CHECK_MS = 1_000;

const dbDir = process.env.THUMB_CACHE_DIR
  ? path.resolve(process.env.THUMB_CACHE_DIR)
  : path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      "../../data",
    );
fs.mkdirSync(dbDir, { recursive: true });
const db = new Database(path.join(dbDir, "subtitles.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS embedded_subtitles (
    stream_id TEXT PRIMARY KEY,
    rating_key TEXT NOT NULL,
    format TEXT NOT NULL,
    cues_json TEXT NOT NULL,
    cached_at INTEGER NOT NULL
  );
`);
// Added later. A row from before has none of them: its cues were made by an
// older parser, from text that wasn't kept, so it is read again.
for (const column of [
  "parser_version INTEGER NOT NULL DEFAULT 0",
  "raw BLOB",
  "fingerprint TEXT",
]) {
  try {
    db.exec(`ALTER TABLE embedded_subtitles ADD COLUMN ${column}`);
  } catch {
    // Already there.
  }
}
interface Row {
  rating_key: string;
  cues_json: string;
  parser_version: number;
  raw: Buffer | null;
  fingerprint: string | null;
}
const readStmt = db.prepare<[string], Row>(
  "SELECT rating_key, cues_json, parser_version, raw, fingerprint FROM embedded_subtitles WHERE stream_id = ?",
);
const writeStmt = db.prepare(`
  INSERT OR REPLACE INTO embedded_subtitles
    (stream_id, rating_key, format, cues_json, cached_at, parser_version, raw, fingerprint)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const reparsedStmt = db.prepare(
  "UPDATE embedded_subtitles SET format = ?, cues_json = ?, parser_version = ? WHERE stream_id = ?",
);

/** Finished reads, in front of the table. Keyed by stream id, unique per file,
 *  with the fingerprint of the file they were read from. */
const ready = new LruMap<string, { cues: Cue[]; fingerprint: string | null }>(100);
/** Stream ids Plex couldn't read out, with when. */
const unreadable = new LruMap<string, number>(500);

/** Seconds: where every line has come, from and to — to null for the end. */
export type Span = [number, number | null];

/** Lines from around one place, for someone the read from the start hasn't
 *  reached. */
interface Window {
  from: number;
  /** Every line starting from `from` up to this has come. */
  to: number;
  /** Where it is going: the end of what the file is read for, or where a Plex
   *  read from `from` stops — moved on while someone watches inside it. */
  until: number;
  cues: Cue[];
  /** Still coming. */
  open: boolean;
  /** A Plex read's: ends it now. */
  stop?: () => void;
}

/** How the lines around a place are had: out of the file, by Plex reading
 *  from there, or not at all (they wait for the read from the start). */
type Around =
  | { kind: "file"; read: (from: number, to: number) => Promise<string | null> }
  | { kind: "plex" }
  | { kind: "none" };

interface Reading {
  streamId: string;
  ratingKey: string;
  /** Cues from the read from the start, so far. */
  cues: Cue[];
  /** Every line starting before this has come in the read from the start. */
  frontier: number;
  /** Settles when the read is over, whichever way it went. */
  done: Promise<void>;
  windows: Window[];
  around: Promise<Around> | null;
  /** Where the players reading it said they were, and when. */
  wanted: Array<{ at: number; t: number }>;
  /** Told whenever what there is to draw changes. */
  listeners: Set<() => void>;
}
const reading = new Map<string, Reading>();

export type EmbeddedSubtitle =
  | { state: "ready"; cues: Cue[] }
  | { state: "reading"; cues: Cue[]; covered: Span[] }
  | { state: "unreadable" };

/**
 * What is known about one, without starting anything. Null: never tried — or
 * read from a file that has since changed, when `fingerprint` says so.
 */
export function embeddedSubtitleState(streamId: string, fingerprint?: string | null): EmbeddedSubtitle | null {
  const cues = readyCues(streamId, fingerprint ?? null);
  if (cues) return { state: "ready", cues };
  const r = reading.get(streamId);
  if (r) return { state: "reading", cues: linesSoFar(r), covered: covered(r) };
  const failedAt = unreadable.get(streamId);
  if (failedAt !== undefined && Date.now() - failedAt < RETRY_AFTER_MS) return { state: "unreadable" };
  return null;
}

/** Whether cues kept for a file still describe it: a caller that knows the
 *  file's fingerprint, against a read that recorded one, must match it. */
function sameFile(kept: string | null, now: string | null): boolean {
  return kept === null || now === null || kept === now;
}

function readyCues(streamId: string, fingerprint: string | null): Cue[] | null {
  const hit = ready.get(streamId);
  if (hit) return sameFile(hit.fingerprint, fingerprint) ? hit.cues : null;
  try {
    const row = readStmt.get(streamId);
    if (!row || !sameFile(row.fingerprint, fingerprint)) return null;
    let cues: Cue[];
    if (row.parser_version === SUBTITLE_PARSER_VERSION) {
      cues = JSON.parse(row.cues_json) as Cue[];
    } else {
      // Made by an older parser. The text it came from was kept, so it is
      // parsed again here rather than read out of the film again — unless it
      // is a row from before the text was kept, which has to be.
      if (!row.raw) return null;
      const parsed = parseSubtitles(gunzipSync(row.raw).toString("utf-8"));
      if (!parsed || parsed.cues.length === 0) return null;
      cues = parsed.cues;
      reparsedStmt.run(parsed.format, JSON.stringify(cues), SUBTITLE_PARSER_VERSION, streamId);
    }
    ready.set(streamId, { cues, fingerprint: row.fingerprint });
    return cues;
  } catch {
    return null;
  }
}

export interface ReadOptions {
  streamId: string;
  ratingKey: string;
  mediaIndex: number;
  /** Which file the subtitle is inside, so cues kept from an earlier version of
   *  it aren't served for this one. Null when it isn't known. */
  fingerprint?: string | null;
  /**
   * Runs the start of the request with the subtitle selected on the item and
   * nothing else allowed to change that until it returns: Plex takes no stream
   * id here, and reads whichever subtitle the item has selected.
   */
  withTrackSelected: <T>(start: () => Promise<T>) => Promise<T>;
  /** How long to wait for Plex's answer. */
  waitMs?: number;
  /**
   * Runs inside the hold on the item's selection once Plex has answered — has
   * read which subtitle is selected — to put back what selecting this one
   * changed. A read nobody asked for (prefetchEmbeddedSubtitles) must not leave
   * the item set to some other language. Not run when Plex was too slow to
   * answer within the hold: changing the selection then could have it read the
   * wrong subtitle.
   */
  afterAnswer?: () => Promise<void>;
  /**
   * How to read the lines around a place straight out of the file — through
   * its index, mkv-subtitles.ts — or null when the file can't be read that
   * way. Asked once, the first time someone is somewhere the read from the
   * start hasn't got to.
   */
  fileLines?: () => Promise<((from: number, to: number) => Promise<string | null>) | null>;
  /**
   * Whether Plex can be asked to read it from somewhere other than the start.
   * Not a subtitle it copies (ASS): a copy started mid-film holds every line
   * back until the end of the file.
   */
  readsFromAnywhere?: boolean;
  /**
   * The subtitle in the file mounted here, for ffmpeg to read it out of
   * (PLAYBACK_ENGINE=ffmpeg): no track selected on the item and no lock held,
   * and from anywhere, an ASS track too. Plex reads it without one, or when
   * ffmpeg fails before a line has come.
   */
  fromFile?: FileSubtitle | null;
}

/** A subtitle stream in a file mounted here: its path and ffmpeg's -map index. */
export interface FileSubtitle {
  file: string;
  index: number;
  codec: string | null;
}

/**
 * Where a subtitle stands, starting a read if there isn't one: "ready" with all
 * its cues, "reading" while Plex is sending it (or hasn't answered within the
 * wait — the player asks again, and hears "unreadable" then if it failed), or
 * "unreadable".
 *
 * `at` is where the player asking is, in seconds. Lines for there are read on
 * their own if the read from the start hasn't got there (see want), and the
 * answer comes as soon as they have: what is drawn there, and `covered`, the
 * stretches where every line has come. Without it, the answer waits for the
 * whole read, up to the wait.
 */
export async function readEmbeddedSubtitle(opts: ReadOptions, at?: number): Promise<EmbeddedSubtitle> {
  const known = embeddedSubtitleState(opts.streamId, opts.fingerprint);
  if (known && known.state !== "reading") return known;

  const r = reading.get(opts.streamId) ?? begin(opts);
  const waitMs = opts.waitMs ?? ANSWER_WAIT_MS;
  if (at === undefined) {
    await settled(r, () => false, waitMs);
  } else {
    want(r, opts, at);
    await settled(r, () => covers(r, at), waitMs);
  }
  return embeddedSubtitleState(opts.streamId, opts.fingerprint)
    ?? { state: "reading", cues: linesSoFar(r), covered: covered(r) };
}

/** Until `done` holds, the read is over, or `ms` have gone by. */
function settled(r: Reading, done: () => boolean, ms: number): Promise<void> {
  if (done()) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => { if (done()) finish(); };
    const finish = () => {
      clearTimeout(timer);
      r.listeners.delete(check);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    r.listeners.add(check);
    void r.done.then(finish);
  });
}

function changed(r: Reading): void {
  for (const listener of [...r.listeners]) listener();
}

/** Everything there is to draw: the read from the start, and the lines read
 *  around places it hasn't got to. */
function linesSoFar(r: Reading): Cue[] {
  const extra: Cue[] = [];
  const seen = new Set<string>();
  for (const w of r.windows) {
    for (const c of w.cues) {
      // The read from the start has its own copy of these.
      if (c.start <= r.frontier) continue;
      const key = `${c.start.toFixed(2)}|${c.end.toFixed(2)}|${c.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      extra.push(c);
    }
  }
  if (extra.length === 0) return r.cues;
  return [...r.cues, ...extra].sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Where every line has come, in time order, joined up. */
function stretches(r: Reading): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  if (r.frontier > 0) spans.push([0, r.frontier]);
  for (const w of r.windows) if (w.to > w.from) spans.push([w.from, w.to]);
  spans.sort((a, b) => a[0] - b[0]);
  const joined: Array<[number, number]> = [];
  for (const [from, to] of spans) {
    const last = joined.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else joined.push([from, to]);
  }
  return joined;
}

function covered(r: Reading): Span[] {
  const round = (s: number) => Math.round(s * 100) / 100;
  return stretches(r).map(([from, to]) => [round(from), Number.isFinite(to) ? round(to) : null]);
}

function covers(r: Reading, at: number): boolean {
  return stretches(r).some(([from, to]) => from <= at && at < to);
}

/**
 * Someone reading this subtitle is at `at`.
 *
 * If the read from the start is past there, nothing more is needed: it reads
 * far faster than anyone watches. If not, the lines around them are read on
 * their own, from AROUND_BEFORE_S before to AROUND_AHEAD_S after, and read on
 * from there while they are within half of that of the end and the read from
 * the start still hasn't caught up.
 */
function want(r: Reading, opts: ReadOptions, at: number): void {
  const now = Date.now();
  r.wanted = r.wanted.filter((w) => now - w.t < WANTED_FOR_MS);
  r.wanted.push({ at, t: now });
  // A Plex read from somewhere goes on while it is ahead of someone.
  for (const w of r.windows) {
    if (w.stop && w.open && w.from <= at && at <= w.to) w.until = Math.max(w.until, at + PLEX_AHEAD_S);
  }
  if (r.frontier > at) return;
  const stretch = stretches(r).find(([from, to]) => from <= at && at < to);
  if (stretch && stretch[1] - at >= AROUND_AHEAD_S / 2) return;
  const from = stretch ? stretch[1] : Math.max(0, at - AROUND_BEFORE_S);
  // Already on its way.
  if (r.windows.some((w) => w.open && w.from <= from && from < w.until)) return;
  readAround(r, opts, from, at);
}

function readAround(r: Reading, opts: ReadOptions, from: number, at: number): void {
  const w: Window = { from, to: from, until: at + AROUND_AHEAD_S, cues: [], open: true };
  r.windows.push(w);
  r.around ??= howAround(opts);
  void r.around
    .then(async (around) => {
      if (reading.get(r.streamId) !== r) return;
      if (around.kind === "file") await fileWindow(r, opts, w, around.read, Math.max(from, at) + AROUND_FIRST_S);
      // A second Plex read for somewhere the first is about to get to is the
      // file read twice over for a second's head start.
      else if (around.kind === "plex" && at - r.frontier > PLEX_NOT_FOR_S) {
        w.until = at + PLEX_AHEAD_S;
        await plexWindow(r, opts, w);
      }
    })
    .catch((err) => console.warn("[Subtitles] couldn't read lines around a place:", err))
    .finally(() => {
      w.open = false;
      // One nothing came of is no use to anyone.
      const at = r.windows.indexOf(w);
      if (w.to <= w.from && at !== -1) r.windows.splice(at, 1);
      changed(r);
    });
}

async function howAround(opts: ReadOptions): Promise<Around> {
  try {
    const read = await opts.fileLines?.();
    if (read) return { kind: "file", read };
  } catch {
    // Plex, then, if it can.
  }
  return opts.readsFromAnywhere ? { kind: "plex" } : { kind: "none" };
}

/** Lines around a place out of the file: first what is needed to answer
 *  with, then the rest. A file that can't be read is left for Plex. */
async function fileWindow(
  r: Reading, opts: ReadOptions, w: Window,
  read: (from: number, to: number) => Promise<string | null>, firstUntil: number,
): Promise<void> {
  const startedAt = Date.now();
  for (const until of firstUntil < w.until ? [firstUntil, w.until] : [w.until]) {
    const text = await read(w.to, until);
    if (reading.get(r.streamId) !== r) return;
    if (text === null) {
      logEvent("Subtitles", "couldn't read lines out of the file, so Plex reads them", {
        ratingKey: r.ratingKey, streamId: r.streamId, from: Math.round(w.to), to: Math.round(until),
      });
      r.around = Promise.resolve(opts.readsFromAnywhere ? { kind: "plex" } : { kind: "none" });
      return;
    }
    const lines = text ? parseSubtitles(text)?.cues ?? [] : [];
    w.cues.push(...lines);
    w.to = until;
    changed(r);
    if (until === firstUntil || firstUntil >= w.until) {
      logEvent("Subtitles", "read the lines around a place out of the file", {
        ratingKey: r.ratingKey, streamId: r.streamId, from: Math.round(w.from), to: Math.round(until),
        cues: w.cues.length, ms: Date.now() - startedAt, behind: Math.round(r.frontier),
      });
    }
  }
}

/** Lines around a place by Plex reading from there, until it has gone
 *  `until`, the read from the start has caught it up, or that is over. */
async function plexWindow(r: Reading, opts: ReadOptions, w: Window): Promise<void> {
  const startedAt = Date.now();
  let firstMs: number | null = null;
  const details = { ratingKey: r.ratingKey, streamId: r.streamId, from: Math.round(w.from) };
  const who = opts.fromFile ? "ffmpeg" : "Plex";
  const result = await readSubtitle(opts, w.from, {
    lines: (cues, upTo) => {
      if (firstMs === null && cues.length > 0) {
        firstMs = Date.now() - startedAt;
        logEvent("Subtitles", `${who} is reading a subtitle from where someone is`, { ...details, firstLineMs: firstMs });
      }
      w.cues.push(...cues);
      w.to = Math.max(w.to, upTo);
      changed(r);
    },
    started: (stop) => { w.stop = stop; },
    stopped: () => !w.open || reading.get(r.streamId) !== r || w.to >= w.until || r.frontier >= w.to + AROUND_BEFORE_S,
  });
  logEvent("Subtitles", `${who} read from where someone is`, {
    ...details, to: Math.round(w.to), cues: w.cues.length, firstLineMs: firstMs, ms: Date.now() - startedAt,
    ...(result.failure ? { failed: result.failure.why } : {}),
  });
}

/**
 * Reads nobody is waiting on yet: a title's other text subtitles, so switching
 * to one finds it ready instead of waiting a minute for Plex to go through the
 * film — and the one someone is likely to want next, for a title they are
 * looking at or the episode after this one.
 */
interface Queued {
  read: ReadOptions;
  /** For the stream playing or the episode about to: ahead of anything that
   *  is only a guess. */
  soon: boolean;
  /** What asked, for a guess: a newer one from the same place replaces it. */
  from: string | null;
  /** Asked again when its turn comes; false drops it unread. */
  stillWanted?: () => boolean;
}
const prefetchQueue: Queued[] = [];
let prefetching = false;

export interface PrefetchOptions {
  /** Wanted soon — read before anything that is only browsing. */
  soon?: boolean;
  /**
   * Where a guess came from, e.g. the page someone has open. A newer guess
   * from the same place drops the older one's reads that haven't started:
   * browsing past ten titles shouldn't queue ten titles' worth of reads.
   */
  from?: string;
  /**
   * Whether these are still worth reading when their turn comes. A title's
   * other subtitles are read for switching to while it plays; once nobody is
   * watching it they would be Plex going through the whole film, again and
   * again, under whatever is playing next.
   */
  stillWanted?: () => boolean;
}

/**
 * Read these in the background, one at a time.
 *
 * Each read is Plex going through the whole film, so they are never run side by
 * side — with each other or with a read someone is waiting on, which goes
 * first. Any already read, being read, queued or known unreadable are left
 * alone. Returns how many were queued.
 */
export function prefetchEmbeddedSubtitles(reads: ReadOptions[], opts: PrefetchOptions = {}): number {
  const soon = opts.soon ?? true;
  const from = soon ? null : opts.from ?? null;
  if (from !== null) {
    for (let i = prefetchQueue.length - 1; i >= 0; i--) {
      if (prefetchQueue[i].from === from) prefetchQueue.splice(i, 1);
    }
  }
  let queued = 0;
  for (const read of reads) {
    if (embeddedSubtitleState(read.streamId, read.fingerprint)) continue;
    const existing = prefetchQueue.findIndex((q) => q.read.streamId === read.streamId);
    if (existing !== -1) {
      // Already waiting — as a guess, perhaps, and now wanted soon.
      if (soon && !prefetchQueue[existing].soon) prefetchQueue.splice(existing, 1);
      else continue;
    }
    const entry: Queued = { read, soon, from, ...(opts.stillWanted && { stillWanted: opts.stillWanted }) };
    if (soon) {
      // After the other reads wanted soon, ahead of every guess.
      const firstGuess = prefetchQueue.findIndex((q) => !q.soon);
      prefetchQueue.splice(firstGuess === -1 ? prefetchQueue.length : firstGuess, 0, entry);
    } else {
      prefetchQueue.push(entry);
    }
    queued++;
  }
  if (queued > 0) void pumpPrefetch();
  return queued;
}

async function pumpPrefetch(): Promise<void> {
  if (prefetching) return;
  prefetching = true;
  try {
    for (;;) {
      // Behind anything already reading: someone switched to it, or opened a
      // title with it on.
      while (reading.size > 0) {
        await Promise.race([...reading.values()].map((r) => r.done));
      }
      const next = prefetchQueue.shift();
      if (!next) break;
      if (embeddedSubtitleState(next.read.streamId, next.read.fingerprint)) continue;
      if (next.stillWanted && !next.stillWanted()) {
        logEvent("Subtitles", "not reading a subtitle ahead: nobody is watching it now", {
          ratingKey: next.read.ratingKey, streamId: next.read.streamId, queued: prefetchQueue.length,
        });
        continue;
      }
      logEvent("Subtitles", "reading a subtitle ahead", {
        ratingKey: next.read.ratingKey, streamId: next.read.streamId,
        why: next.soon ? "playing or up next" : "a title being looked at", queued: prefetchQueue.length,
      });
      await begin(next.read).done;
    }
  } finally {
    prefetching = false;
  }
}

function begin(opts: ReadOptions): Reading {
  const r: Reading = {
    streamId: opts.streamId,
    ratingKey: opts.ratingKey,
    cues: [],
    frontier: 0,
    done: Promise.resolve(),
    windows: [],
    around: null,
    wanted: [],
    listeners: new Set(),
  };
  r.done = run(r, opts).finally(() => {
    if (reading.get(r.streamId) === r) reading.delete(r.streamId);
    for (const w of r.windows) {
      w.open = false;
      w.stop?.();
    }
    changed(r);
  });
  reading.set(opts.streamId, r);
  return r;
}

/** Plex's answer is a media file, not text — the mistake the first version made. */
function isMediaType(type: string): boolean {
  return /^(video|audio|image)\//i.test(type);
}

/** The first bytes of a container rather than of text. */
function looksBinary(head: Uint8Array): boolean {
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return true; // Matroska
  if (head.length >= 8 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) return true; // MP4
  if (head.length >= 1 && head[0] === 0x47 && (head.length < 189 || head[188] === 0x47)) return true; // MPEG-TS
  return head.slice(0, 512).some((b) => b === 0);
}

/** Text from a subtitle's bytes: UTF-8 if it is valid, Windows-1252 if not. */
export function decodeSubtitle(raw: Uint8Array | ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return new TextDecoder("windows-1252").decode(raw);
  }
}

/** The common Plex params for one subtitle session, reading from `offset`
 *  seconds on. copyts keeps the times the film's own wherever it starts. */
function sessionParams(ratingKey: string, mediaIndex: number, session: string, offset = 0): Record<string, string> {
  return {
    hasMDE: "1",
    path: `/library/metadata/${ratingKey}`,
    mediaIndex: String(mediaIndex),
    partIndex: "0",
    protocol: "http",
    directPlay: "1",
    directStream: "1",
    directStreamAudio: "1",
    subtitles: "sidecar",
    // ASS as text, which is how a sidecar ASS is drawn too.
    advancedSubtitles: "text",
    copyts: "1",
    offset: String(Math.max(0, Math.floor(offset))),
    session,
    location: "lan",
  };
}

function plexHeaders(session: string): Record<string, string> {
  return {
    "X-Plex-Client-Identifier": "plex-discord-theater",
    "X-Plex-Product": "Plex Discord Theater",
    "X-Plex-Platform": "Chrome",
    "X-Plex-Device": "Browser",
    "X-Plex-Session-Identifier": session,
  };
}

/**
 * What Plex's decision says about the subtitle, for the log. The official
 * apps ask for one before the subtitle transcode, with the same session.
 */
async function subtitleDecision(params: Record<string, string>, headers: Record<string, string>): Promise<string> {
  try {
    const res = await plexFetch("/video/:/transcode/universal/decision", params, headers);
    if (!res.ok) return `status ${res.status}`;
    const body = (await res.json()) as {
      MediaContainer?: { Metadata?: Array<{ Media?: Array<{ Part?: Array<{ Stream?: Array<Record<string, unknown>> }> }> }> };
    };
    const streams = body.MediaContainer?.Metadata?.[0]?.Media?.[0]?.Part?.[0]?.Stream ?? [];
    const sub = streams.find((s) => s.streamType === 3);
    return sub ? `${String(sub.decision ?? "?")}/${String(sub.location ?? "?")}/${String(sub.codec ?? "?")}` : "none";
  } catch (err) {
    return `failed: ${String(err)}`;
  }
}

/** Ends a subtitle session on Plex, which otherwise reads the file to the end
 *  whether anyone takes what it sends or not. */
function stopOnPlex(session: string): void {
  void plexFetch("/video/:/transcode/universal/stop", { session })
    .then((res) => res.body?.cancel())
    .catch(() => {});
}

/**
 * Plex's text cut into whole lines as it comes: an ASS file's header, then one
 * event to a line; or SRT and VTT, one cue to each block between blank lines.
 * Windows line ends are made Unix ones on the way, a "\r" at the very end of
 * what has come being half of one.
 */
class Lines {
  /** What is there before the first event: an ASS file's script info, styles
   *  and Format line, or VTT's heading. Null until it is all in. */
  header: string | null = null;
  /** Which of the two it is, once known. */
  kind: "ass" | "blocks" | null = null;
  private rest = "";
  private head = "";
  private cut: string[] = [];
  private readonly decoder = new TextDecoder("utf-8");

  push(chunk: Uint8Array): void {
    this.split(this.decoder.decode(chunk, { stream: true }), false);
  }

  end(): void {
    this.split(this.decoder.decode(), true);
    if (this.header === null) this.header = this.head;
  }

  /** The lines cut since this was last asked. */
  take(): string[] {
    const lines = this.cut;
    this.cut = [];
    return lines;
  }

  private split(more: string, final: boolean): void {
    let text = (this.rest + more).replace(/\r\n/g, "\n");
    if (this.kind === null) {
      const opening = text.trimStart();
      if (opening.length < 16 && !final) {
        this.rest = text;
        return;
      }
      this.kind = /^\[(Script Info|V4\+? Styles)\]/i.test(opening) ? "ass" : "blocks";
      if (this.kind === "blocks") this.header = /^WEBVTT/.test(opening) ? "WEBVTT\n\n" : "";
    }
    if (this.kind === "ass") {
      const end = final ? text.length : text.lastIndexOf("\n") + 1;
      this.rest = text.slice(end);
      const whole = text.slice(0, end).split("\n");
      if (whole.at(-1) === "") whole.pop();
      for (const line of whole) {
        const event = /^(Dialogue|Comment)\s*:/i.test(line);
        if (this.header === null && !event) {
          this.head += `${line}\n`;
          continue;
        }
        if (this.header === null) this.header = this.head;
        if (event) this.cut.push(line);
      }
      return;
    }
    const blocks = text.split(/\n{2,}/);
    this.rest = final ? "" : blocks.pop() ?? "";
    for (const block of blocks) if (block.trim()) this.cut.push(block.trim());
  }
}

/** When a cut line starts, in seconds: an ASS event's Start, an SRT or VTT
 *  cue's first time. Null for an ASS comment, which isn't on screen. */
function startOf(line: string): number | null {
  const event = /^Dialogue\s*:\s*[^,]*,\s*([^,]+),/i.exec(line);
  if (event) return parseTimestamp(event[1]);
  if (/^Comment\s*:/i.test(line)) return null;
  const cue = /(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})\s*-->/.exec(line);
  return cue ? parseTimestamp(cue[1]) : null;
}

/** What a Plex read is handed and asked as it goes. */
interface Sink {
  /** Lines that have come, as cues, and the latest start among them: every
   *  line starting before it has come. */
  lines(cues: Cue[], upTo: number): void;
  /** Once Plex has answered: how to end the read. */
  started?(stop: () => void): void;
  /** Asked as it goes, and every STOP_CHECK_MS: true ends the read. */
  stopped?(): boolean;
}

interface ReadResult {
  /** All Plex sent, for keeping. */
  raw: Buffer;
  /** Why it failed — null when it was read to the end, or stopped. */
  failure: { why: string; extra?: Record<string, unknown> } | null;
  /** Ended early, by `stopped`. */
  stopped: boolean;
  firstByteMs: number | null;
}

/**
 * One read of the subtitle from `offset` seconds on: by ffmpeg out of the file
 * when it is mounted here (opts.fromFile), else by Plex — and by Plex too when
 * ffmpeg fails before a line has come.
 */
async function readSubtitle(
  opts: ReadOptions, offset: number, sink: Sink, announce?: Record<string, unknown>,
): Promise<ReadResult> {
  if (opts.fromFile) {
    let handed = false;
    const result = await ffmpegRead(opts.fromFile, offset, {
      ...sink,
      lines: (cues, upTo) => {
        handed ||= cues.length > 0;
        sink.lines(cues, upTo);
      },
    }, announce);
    if (!result.failure || handed) return result;
    logEvent("Subtitles", "ffmpeg couldn't read a subtitle out of the file; Plex reads it", {
      ...announce, from: Math.round(offset), why: result.failure.why, ...result.failure.extra,
    });
  }
  return plexRead(opts, offset, sink, announce);
}

/** Lines as they come, handed to `sink` whole, and made into cues at most
 *  every PARSE_EVERY_MS. */
function lineFeed(sink: Sink, offset: number): { push(chunk: Uint8Array): void; end(): void } {
  const lines = new Lines();
  let parsedAt = 0;
  const hand = (final: boolean) => {
    if (!final && Date.now() - parsedAt < PARSE_EVERY_MS) return;
    parsedAt = Date.now();
    const cut = lines.take();
    if (cut.length === 0 || lines.header === null) return;
    let upTo = -Infinity;
    for (const line of cut) upTo = Math.max(upTo, startOf(line) ?? -Infinity);
    const parsed = parseSubtitles(lines.header + cut.join(lines.kind === "ass" ? "\n" : "\n\n") + "\n");
    sink.lines(parsed?.cues ?? [], Number.isFinite(upTo) ? upTo : offset);
  };
  return {
    push: (chunk) => { lines.push(chunk); hand(false); },
    end: () => { lines.end(); hand(true); },
  };
}

/**
 * One read of the subtitle by ffmpeg, out of the file, from `offset` seconds
 * on: ASS as it is, everything else as SRT, on the film's own clock (-copyts,
 * as the engine's streams are). Stopped however it ends.
 */
async function ffmpegRead(
  sub: FileSubtitle, offset: number, sink: Sink, announce?: Record<string, unknown>,
): Promise<ReadResult> {
  const startedAt = Date.now();
  const ass = ["ass", "ssa"].includes((sub.codec ?? "").toLowerCase());
  const args = [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    ...(offset > 0 ? ["-ss", String(offset)] : []),
    "-copyts", "-start_at_zero",
    "-protocol_whitelist", "file", "-i", sub.file,
    "-map", `0:${sub.index}`, "-c:s", ass ? "copy" : "srt", "-f", ass ? "ass" : "srt", "pipe:1",
  ];
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let firstByteMs: number | null = null;
  let stopped = false;
  const stderr: string[] = [];
  const result = (failure: ReadResult["failure"]): ReadResult =>
    ({ raw: Buffer.concat(chunks), failure, stopped, firstByteMs });

  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn(ffmpegPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    return result({ why: `couldn't start ffmpeg: ${err instanceof Error ? err.message : String(err)}` });
  }
  const stop = () => {
    stopped = true;
    try { proc.kill("SIGKILL"); } catch { /* gone */ }
  };
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stop(); }, READ_TIMEOUT_MS);
  const check = setInterval(() => { if (sink.stopped?.()) stop(); }, STOP_CHECK_MS);
  sink.started?.(stop);
  if (announce) {
    logEvent("Subtitles", "ffmpeg is reading an embedded subtitle out of the file", {
      ...announce, from: Math.round(offset), codec: sub.codec, stream: sub.index,
    });
  }
  const feed = lineFeed(sink, offset);
  let tooBig = false;
  proc.stderr?.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) if (line.trim()) stderr.push(line.trim().slice(0, 200));
    if (stderr.length > 10) stderr.splice(0, stderr.length - 10);
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      proc.stdout?.on("data", (value: Buffer) => {
        if (stopped || tooBig) return;
        if (sink.stopped?.()) return stop();
        if (firstByteMs === null) firstByteMs = Date.now() - startedAt;
        chunks.push(value);
        bytes += value.length;
        if (bytes > MAX_BYTES) {
          tooBig = true;
          return stop();
        }
        feed.push(value);
      });
      proc.on("error", reject);
      proc.on("close", (c) => resolve(c));
    });
    if (tooBig) return result({ why: "too large to be a subtitle", extra: { bytes } });
    if (stopped) return result(timedOut ? { why: `timed out after ${READ_TIMEOUT_MS / 60_000} min` } : null);
    if (code !== 0) return result({ why: `ffmpeg exited ${code}`, extra: { stderr: stderr.slice(-3).join(" | ") || "none" } });
    feed.end();
    return result(null);
  } catch (err) {
    return result({ why: `ffmpeg: ${err instanceof Error ? err.message : String(err)}` });
  } finally {
    clearTimeout(timer);
    clearInterval(check);
  }
}

/**
 * One read of the subtitle from Plex, from `offset` seconds on, its lines
 * handed to `sink` as they come — whole, and made into cues at most every
 * PARSE_EVERY_MS. Stopped on Plex however it ends.
 */
async function plexRead(
  opts: ReadOptions, offset: number, sink: Sink, announce?: Record<string, unknown>,
): Promise<ReadResult> {
  const startedAt = Date.now();
  const session = randomUUID();
  const params = sessionParams(opts.ratingKey, opts.mediaIndex, session, offset);
  const headers = plexHeaders(session);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  let stopped = false;
  const stop = () => {
    stopped = true;
    controller.abort();
  };
  const check = setInterval(() => { if (sink.stopped?.()) stop(); }, STOP_CHECK_MS);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let firstByteMs: number | null = null;
  const result = (failure: ReadResult["failure"]): ReadResult =>
    ({ raw: Buffer.concat(chunks), failure, stopped, firstByteMs });

  try {
    // Plex answers once it has started, and has read which subtitle is
    // selected by then; waiting longer than that holds the item for nothing.
    const { pending, decision } = await opts.withTrackSelected(async () => {
      const decision = await subtitleDecision(params, headers);
      const pending = fetch(plexUrl("/subtitles/:/transcode/universal/start", params), {
        headers: { ...headers, Accept: "text/srt, application/x-subrip, text/vtt, text/plain;q=0.9, */*;q=0.1" },
        signal: controller.signal,
      });
      pending.catch(() => {});
      let hold: ReturnType<typeof setTimeout> | undefined;
      const answered = await Promise.race([
        pending.then(() => true, () => false),
        new Promise<boolean>((resolve) => { hold = setTimeout(() => resolve(false), ANSWER_WAIT_MS); }),
      ]);
      clearTimeout(hold);
      if (answered && opts.afterAnswer) {
        try {
          await opts.afterAnswer();
        } catch (err) {
          console.warn("[Subtitles] couldn't put the item's subtitle back:", err);
        }
      }
      return { pending, decision };
    });

    const res = await pending;
    sink.started?.(stop);
    const type = res.headers.get("content-type") ?? "none";
    const answer = { decision, status: res.status, type };
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      return result({ why: "Plex refused", extra: { ...answer, start: JSON.stringify(text.slice(0, 120)) } });
    }
    if (isMediaType(type)) {
      res.body.cancel().catch(() => {});
      return result({ why: "Plex sent a media file rather than a subtitle", extra: answer });
    }
    if (announce) {
      logEvent("Subtitles", "Plex is reading an embedded subtitle out of the file", {
        ...announce, ...answer, ms: Date.now() - startedAt,
      });
    }

    const feed = lineFeed(sink, offset);
    const reader = res.body.getReader();
    for (;;) {
      if (sink.stopped?.()) {
        stop();
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      if (firstByteMs === null) {
        firstByteMs = Date.now() - startedAt;
        if (looksBinary(value)) {
          return result({ why: "Plex sent something other than text", extra: {
            ...answer, start: JSON.stringify(decodeSubtitle(value.slice(0, 60))),
          } });
        }
      }
      chunks.push(value);
      bytes += value.length;
      if (bytes > MAX_BYTES) return result({ why: "too large to be a subtitle", extra: { ...answer, bytes } });
      feed.push(value);
    }
    if (!stopped) feed.end();
    return result(null);
  } catch (err) {
    if (stopped) return result(null);
    return result({
      why: controller.signal.aborted ? `timed out after ${READ_TIMEOUT_MS / 60_000} min` : String(err),
    });
  } finally {
    clearTimeout(timer);
    clearInterval(check);
    controller.abort();
    stopOnPlex(session);
  }
}

/** The read from the start: what is drawn until it's done, and what is kept. */
async function run(r: Reading, opts: ReadOptions): Promise<void> {
  const startedAt = Date.now();
  const details: Record<string, unknown> = { ratingKey: r.ratingKey, streamId: r.streamId };
  let firstLineMs: number | null = null;

  const fail = (why: string, extra: Record<string, unknown> = {}) => {
    unreadable.set(r.streamId, Date.now());
    logEvent("Subtitles", "couldn't read an embedded subtitle out of the file", {
      ...details, why, ...extra, ms: Date.now() - startedAt,
    });
  };

  const result = await readSubtitle(opts, 0, {
    lines: (cues, upTo) => {
      if (firstLineMs === null && cues.length > 0) firstLineMs = Date.now() - startedAt;
      const last = r.cues.at(-1);
      r.cues = last && cues.length > 0 && cues[0].start < last.start
        ? [...r.cues, ...cues].sort((a, b) => a.start - b.start || a.end - b.end)
        : r.cues.concat(cues);
      r.frontier = Math.max(r.frontier, upTo);
      changed(r);
    },
  }, details);
  if (result.failure) {
    fail(result.failure.why, result.failure.extra);
    return;
  }

  const raw = result.raw;
  const parsed = parseSubtitles(decodeSubtitle(raw));
  if (!parsed || parsed.cues.length === 0) {
    fail(raw.length === 0 ? "nothing came" : "not a subtitle that came", {
      bytes: raw.length,
      start: JSON.stringify(decodeSubtitle(raw.subarray(0, 120))),
    });
    return;
  }
  const fingerprint = opts.fingerprint ?? null;
  ready.set(r.streamId, { cues: parsed.cues, fingerprint });
  try {
    writeStmt.run(
      r.streamId, r.ratingKey, parsed.format, JSON.stringify(parsed.cues), Date.now(),
      SUBTITLE_PARSER_VERSION, gzipSync(raw), fingerprint,
    );
  } catch (err) {
    console.warn("[Subtitles] couldn't keep a read-out subtitle:", err);
  }
  logEvent("Subtitles", "read an embedded subtitle out of the file", {
    ...details, by: opts.fromFile ? "ffmpeg" : "plex", format: parsed.format, cues: parsed.cues.length, bytes: raw.length,
    firstByteMs: result.firstByteMs, firstLineMs, ms: Date.now() - startedAt,
  });
}

/** For tests: forget everything known, on disk too. */
export function resetEmbeddedSubtitles(): void {
  ready.clear();
  unreadable.clear();
  prefetchQueue.length = 0;
  db.exec("DELETE FROM embedded_subtitles");
}
