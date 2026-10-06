/**
 * Text subtitles stored inside a media file, read out through Plex so the
 * player can draw them — which is what lets the video be copied rather than
 * re-encoded with the subtitle burned into it.
 *
 * Plex's own apps do this with a subtitle-only transcode,
 * /subtitles/:/transcode/universal/start, which answers with the item's
 * selected subtitle track as text. Getting it means Plex reading the whole file,
 * because the track is spread across all of it: seconds for a small file, a
 * minute or two for a big one, though Plex has managed most in one to three
 * seconds. Nothing waits for it: the player's first ask waits a few seconds at
 * most to hear that Plex is sending a subtitle at all, the player draws cues as
 * they arrive and polls for the rest, and the result is kept on disk, so each
 * title is only ever read once.
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
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { plexFetch, plexUrl } from "./plex.js";
import { parseSubtitles, SUBTITLE_PARSER_VERSION, type Cue } from "./subtitles.js";
import { logEvent } from "./logger.js";
import { LruMap } from "./lru.js";

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
/** How often cues are re-parsed from what has arrived so far, at the least.
 *  A big file is re-parsed less often: each pass reads all of it again. */
const PARTIAL_PARSE_MS = 1_000;
/** Bytes a partial parse costs a millisecond of wait for. */
const PARTIAL_PARSE_BYTES_PER_MS = 4_000;

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

interface Reading {
  streamId: string;
  ratingKey: string;
  /** Cues parsed from what has arrived so far. */
  cues: Cue[];
  /** Settles when the read is over, whichever way it went. */
  done: Promise<void>;
}
const reading = new Map<string, Reading>();

export type EmbeddedSubtitle =
  | { state: "ready"; cues: Cue[] }
  | { state: "reading"; cues: Cue[] }
  | { state: "unreadable" };

/**
 * What is known about one, without starting anything. Null: never tried — or
 * read from a file that has since changed, when `fingerprint` says so.
 */
export function embeddedSubtitleState(streamId: string, fingerprint?: string | null): EmbeddedSubtitle | null {
  const cues = readyCues(streamId, fingerprint ?? null);
  if (cues) return { state: "ready", cues };
  const r = reading.get(streamId);
  if (r) return { state: "reading", cues: r.cues };
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
}

/**
 * Where a subtitle stands, starting a read if there isn't one: "ready" with all
 * its cues, "reading" while Plex is sending it (or hasn't answered within the
 * wait — the player asks again, and hears "unreadable" then if it failed), or
 * "unreadable".
 */
export async function readEmbeddedSubtitle(opts: ReadOptions): Promise<EmbeddedSubtitle> {
  const known = embeddedSubtitleState(opts.streamId, opts.fingerprint);
  if (known && known.state !== "reading") return known;

  const r = reading.get(opts.streamId) ?? begin(opts);
  const waitMs = opts.waitMs ?? ANSWER_WAIT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    r.done,
    new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); }),
  ]);
  clearTimeout(timer);
  return embeddedSubtitleState(opts.streamId, opts.fingerprint) ?? { state: "reading", cues: r.cues };
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
    const entry: Queued = { read, soon, from };
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
    done: Promise.resolve(),
  };
  r.done = run(r, opts).finally(() => {
    if (reading.get(r.streamId) === r) reading.delete(r.streamId);
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

/** The common Plex params for one subtitle session. */
function sessionParams(ratingKey: string, mediaIndex: number, session: string): Record<string, string> {
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
    offset: "0",
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

async function run(r: Reading, opts: ReadOptions): Promise<void> {
  const startedAt = Date.now();
  const session = randomUUID();
  const params = sessionParams(opts.ratingKey, opts.mediaIndex, session);
  const headers = plexHeaders(session);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  const details: Record<string, unknown> = { ratingKey: r.ratingKey, streamId: r.streamId };

  let failed = false;
  const fail = (why: string, extra: Record<string, unknown> = {}) => {
    if (failed) return;
    failed = true;
    controller.abort();
    unreadable.set(r.streamId, Date.now());
    logEvent("Subtitles", "couldn't read an embedded subtitle out of the file", {
      ...details, why, ...extra, ms: Date.now() - startedAt,
    });
  };

  try {
    // Plex answers once it has started, and has read which subtitle is
    // selected by then; waiting longer than that holds the item for nothing.
    const { pending } = await opts.withTrackSelected(async () => {
      details.decision = await subtitleDecision(params, headers);
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
      return { pending };
    });

    const res = await pending;
    const type = res.headers.get("content-type") ?? "none";
    details.status = res.status;
    details.type = type;
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      fail("Plex refused", { start: JSON.stringify(text.slice(0, 120)) });
      return;
    }
    if (isMediaType(type)) {
      fail("Plex sent a media file rather than a subtitle");
      return;
    }
    logEvent("Subtitles", "Plex is reading an embedded subtitle out of the file", {
      ...details, ms: Date.now() - startedAt,
    });

    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let firstByteMs: number | null = null;
    let parsedAt = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      if (firstByteMs === null) {
        firstByteMs = Date.now() - startedAt;
        if (looksBinary(value)) {
          fail("Plex sent something other than text", {
            start: JSON.stringify(decodeSubtitle(value.slice(0, 60))),
          });
          return;
        }
      }
      chunks.push(value);
      bytes += value.length;
      if (bytes > MAX_BYTES) {
        fail("too large to be a subtitle", { bytes });
        return;
      }
      // Cues so far, cut at the last blank line so a half-arrived one waits.
      if (Date.now() - parsedAt >= Math.max(PARTIAL_PARSE_MS, bytes / PARTIAL_PARSE_BYTES_PER_MS)) {
        parsedAt = Date.now();
        const text = new TextDecoder("utf-8").decode(Buffer.concat(chunks));
        const cut = text.lastIndexOf("\n\n");
        const parsed = cut > 0 ? parseSubtitles(text.slice(0, cut + 1)) : null;
        if (parsed) r.cues = parsed.cues;
      }
    }

    const raw = Buffer.concat(chunks);
    const parsed = parseSubtitles(decodeSubtitle(raw));
    if (!parsed || parsed.cues.length === 0) {
      fail(raw.length === 0 ? "Plex sent nothing" : "not a subtitle Plex sent", {
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
      ...details, format: parsed.format, cues: parsed.cues.length, bytes: raw.length,
      firstByteMs, ms: Date.now() - startedAt,
    });
  } catch (err) {
    fail(controller.signal.aborted ? `timed out after ${READ_TIMEOUT_MS / 60_000} min` : String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** For tests: forget everything known, on disk too. */
export function resetEmbeddedSubtitles(): void {
  ready.clear();
  unreadable.clear();
  prefetchQueue.length = 0;
  db.exec("DELETE FROM embedded_subtitles");
}
