/**
 * Text subtitles stored inside a media file, read out through Plex so the
 * player can draw them — which is what lets the video be copied rather than
 * re-encoded with the subtitle burned into it.
 *
 * Plex's own apps do this with a subtitle-only transcode,
 * /subtitles/:/transcode/universal/start, which answers with the item's
 * selected subtitle track as text. Getting it means Plex reading the whole file,
 * because the track is spread across all of it: seconds for a small file, a
 * minute or two for a big one. So nothing waits for it. A start waits only to
 * hear that Plex is sending a subtitle at all (a few seconds at most), the
 * player draws cues as they arrive and polls for the rest, and the result is kept
 * on disk, so each title is only ever read once.
 *
 * The first version asked /video/:/transcode/universal/subtitles instead. Plex
 * answers that by starting a second transcode of the whole film, video and all,
 * and sending it — a real deployment downloaded 2 GB of Matroska from it, and
 * timed out on two others while Plex re-encoded them.
 *
 * When a read fails after the stream has started without the subtitle burned
 * in, listeners registered with onEmbeddedSubtitleLost are told, so the stream
 * can be restarted with it burned in instead.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { plexFetch, plexUrl } from "./plex.js";
import { parseSubtitles, type Cue } from "./subtitles.js";
import { logEvent } from "./logger.js";
import { LruMap } from "./lru.js";

/** How long a start waits to hear whether Plex is sending a subtitle. */
export const VERDICT_MS = 4_000;
/** How long a whole read may take: a big remux on spinning disks. */
const READ_TIMEOUT_MS = 15 * 60_000;
/** Remembered as unreadable for this long before it is tried again. */
const RETRY_AFTER_MS = 60 * 60_000;
/** Bigger than any real subtitle: a three-hour ASS with full typesetting is ~1 MB. */
const MAX_BYTES = 8 * 1024 * 1024;
/** How often cues are re-parsed from what has arrived so far. */
const PARTIAL_PARSE_MS = 1_000;

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
const readStmt = db.prepare<[string], { cues_json: string }>(
  "SELECT cues_json FROM embedded_subtitles WHERE stream_id = ?",
);
const writeStmt = db.prepare(`
  INSERT OR REPLACE INTO embedded_subtitles (stream_id, rating_key, format, cues_json, cached_at)
  VALUES (?, ?, ?, ?, ?)
`);

/** Finished reads, in front of the table. Keyed by stream id, unique per file. */
const ready = new LruMap<string, Cue[]>(100);
/** Stream ids Plex couldn't read out, with when. */
const unreadable = new LruMap<string, number>(500);

interface Reading {
  streamId: string;
  ratingKey: string;
  /** Cues parsed from what has arrived so far. */
  cues: Cue[];
  /** Inside the item lock, track selected — see withTrackSelected. */
  started: boolean;
  /** Settles true once Plex is sending a subtitle, false if it refused. */
  verdict: Promise<boolean>;
  settle: (ok: boolean) => void;
  settled: boolean;
}
const reading = new Map<string, Reading>();

type LostListener = (streamId: string) => void;
const lostListeners: LostListener[] = [];

/** Told when a read fails after Plex had said it was sending the subtitle. */
export function onEmbeddedSubtitleLost(listener: LostListener): void {
  lostListeners.push(listener);
}

export type EmbeddedSubtitle =
  | { state: "ready"; cues: Cue[] }
  | { state: "reading"; cues: Cue[] }
  | { state: "unreadable" };

/** What is known about one, without starting anything. Null: never tried. */
export function embeddedSubtitleState(streamId: string): EmbeddedSubtitle | null {
  const cues = readyCues(streamId);
  if (cues) return { state: "ready", cues };
  const r = reading.get(streamId);
  if (r) return { state: "reading", cues: r.cues };
  const failedAt = unreadable.get(streamId);
  if (failedAt !== undefined && Date.now() - failedAt < RETRY_AFTER_MS) return { state: "unreadable" };
  return null;
}

function readyCues(streamId: string): Cue[] | null {
  const hit = ready.get(streamId);
  if (hit) return hit;
  try {
    const row = readStmt.get(streamId);
    if (!row) return null;
    const cues = JSON.parse(row.cues_json) as Cue[];
    ready.set(streamId, cues);
    return cues;
  } catch {
    return null;
  }
}

export interface ReadOptions {
  streamId: string;
  ratingKey: string;
  mediaIndex: number;
  /**
   * Runs the start of the request with the subtitle selected on the item and
   * nothing else allowed to change that until it returns: Plex takes no stream
   * id here, and reads whichever subtitle the item has selected. A caller that
   * already holds the item lock with the track selected passes `(start) => start()`.
   */
  withTrackSelected: <T>(start: () => Promise<T>) => Promise<T>;
  /** Already holding the item lock — so a read queued behind it can't be waited for. */
  lockHeld?: boolean;
  /** How long to wait for Plex's answer. */
  waitMs?: number;
}

/**
 * Where a subtitle stands, starting a read if there isn't one: "ready" with all
 * its cues, "reading" while Plex is sending it (or hasn't answered within the
 * wait — assumed to be coming, and taken back through onEmbeddedSubtitleLost if
 * not), or "unreadable".
 */
export async function readEmbeddedSubtitle(opts: ReadOptions): Promise<EmbeddedSubtitle> {
  const known = embeddedSubtitleState(opts.streamId);
  if (known && known.state !== "reading") return known;

  let r = reading.get(opts.streamId);
  if (!r) {
    r = begin(opts);
  } else if (opts.lockHeld && !r.started) {
    // Queued behind the lock this caller holds: waiting for it would be
    // waiting for ourselves.
    return { state: "reading", cues: r.cues };
  }
  const waitMs = opts.waitMs ?? VERDICT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    r.verdict,
    new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); }),
  ]);
  clearTimeout(timer);
  return embeddedSubtitleState(opts.streamId) ?? { state: "reading", cues: r.cues };
}

function begin(opts: ReadOptions): Reading {
  let settle!: (ok: boolean) => void;
  const verdict = new Promise<boolean>((resolve) => { settle = resolve; });
  const r: Reading = {
    streamId: opts.streamId,
    ratingKey: opts.ratingKey,
    cues: [],
    started: false,
    verdict,
    settle: (ok) => { if (!r.settled) { r.settled = true; settle(ok); } },
    settled: false,
  };
  reading.set(opts.streamId, r);
  void run(r, opts).finally(() => {
    r.settle(false);
    if (reading.get(r.streamId) === r) reading.delete(r.streamId);
  });
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
    const wasSending = r.settled;
    logEvent("Subtitles", "couldn't read an embedded subtitle out of the file", {
      ...details, why, ...extra, ms: Date.now() - startedAt,
    });
    if (wasSending) for (const listener of lostListeners) listener(r.streamId);
  };

  try {
    // Plex answers once it has started, and has read which subtitle is
    // selected by then; waiting longer than that holds the item for nothing.
    const { pending } = await opts.withTrackSelected(async () => {
      r.started = true;
      details.decision = await subtitleDecision(params, headers);
      const pending = fetch(plexUrl("/subtitles/:/transcode/universal/start", params), {
        headers: { ...headers, Accept: "text/srt, application/x-subrip, text/vtt, text/plain;q=0.9, */*;q=0.1" },
        signal: controller.signal,
      });
      pending.catch(() => {});
      let hold: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        pending.catch(() => {}),
        new Promise<void>((resolve) => { hold = setTimeout(resolve, VERDICT_MS); }),
      ]);
      clearTimeout(hold);
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
    r.settle(true);

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
      if (Date.now() - parsedAt >= PARTIAL_PARSE_MS) {
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
    ready.set(r.streamId, parsed.cues);
    try {
      writeStmt.run(r.streamId, r.ratingKey, parsed.format, JSON.stringify(parsed.cues), Date.now());
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
  db.exec("DELETE FROM embedded_subtitles");
}
