/**
 * Direct Stream: playing Plex's copied video through a playlist that tells the
 * truth.
 *
 * When Plex copies a video stream into HLS instead of re-encoding it, the
 * segments it writes are clean — every one opens on a keyframe, the timestamps
 * run on without a gap — but its playlist is fiction. Plex cuts a segment at
 * every keyframe, one to ten seconds apart, and the playlist claims three
 * seconds for every one of them. Against a real film the playlist was a minute
 * out after five minutes and forty after an hour, and its last third listed
 * segments that were empty. Anything that trusted it — a seek, a restart, a
 * viewer joining — landed somewhere else, which is why Direct Stream was turned
 * off in July. scripts/diagnose-direct-stream.mjs is what found this.
 *
 * So for a copied stream the playlist is built here instead, from what the
 * segments actually hold. One session per copied transcode fetches Plex's
 * segments in order, reads where each one's video starts and ends
 * (ts-timestamps.ts), keeps the bytes for serving, and lists only what it has
 * measured, at its true length. The playlist is an EVENT playlist that grows as
 * Plex copies — far faster than real time — staying LEAD_S ahead of whoever is
 * watching, and ends where Plex starts handing out empty segments.
 *
 * Two rules keep Plex's numbering intact, and both come from watching it:
 *
 *  - Segments are only ever requested from Plex in order, one at a time. Ask it
 *    for one far from where it is copying and it starts over from that
 *    segment's nominal time (index × 3s), renumbering everything after — the
 *    measurements already taken would then describe a different stream.
 *  - Nothing a client asks for is ever passed through to Plex. Clients are
 *    served from here, and a segment let go to stay within memory answers 410,
 *    which the player meets by restarting where it is.
 *
 * Timestamps are on Plex's own clock, which runs PLEX_TS_OFFSET_S ahead of the
 * film; the playlist is laid out in film time, with the part before the
 * session's first segment marked as a gap, so that currentTime means the same
 * thing it does for a re-encoded stream.
 *
 * A segment starts where its audio or its video does, whichever is first,
 * because that is where hls.js puts it: it pins the first segment it loads to
 * the playlist by the earlier of the two, and places everything after by
 * timestamp. Laid out by the video alone, a copy whose audio led was played
 * shifted by the lead. Deadpool started at 3:39 had audio from ten seconds
 * before its first keyframe, so its whole stream landed ten seconds late: the
 * player waited at 3:39 on a picture that began at 3:49, and once hls.js had
 * corrected its own idea of where segments were, a playlist reload put that
 * back and it skipped a segment, leaving a second hole.
 *
 * Every segment a session measures is kept until the stream ends, so going
 * back anywhere in it is served from here: in memory up to
 * DIRECT_STREAM_MEMORY_MB for every session together, and past that on disk,
 * in STREAM_CACHE_DIR, with no limit but the disk. Plex can't be asked for an
 * old segment again (see the two rules above), so letting one go means
 * restarting the stream there.
 */

import fs from "node:fs";
import path from "node:path";
import { plexFetchSegment } from "./plex.js";
import { firstKeyframe, videoSpan } from "./ts-timestamps.js";
import { logEvent } from "./logger.js";

/**
 * How far past the playhead to measure. The player fetches 150s ahead of
 * itself (Player.tsx, highDemandTimeWindow), and the playhead here comes from
 * a keep-alive ping that can be ten seconds old, so this has to clear both or
 * the player's own buffer stops short of what it asks for.
 */
const LEAD_S = 180;
/**
 * Memory for every copied session together, from DIRECT_STREAM_MEMORY_MB: 6 GB
 * unless set. Past it segments go to disk (STREAM_CACHE_DIR) — what has been
 * watched first, oldest first, then what is furthest ahead — and are served
 * from there.
 *
 * It was 2 GB with no disk behind it, and kept only the last three minutes
 * behind each playhead whatever room there was: sized like the player's
 * memory, which has Discord's 3 GB to stay inside. A copy is the file's own
 * bitrate — 30 Mbps and more for a Blu-ray, 13.5 GB an hour.
 */
let memoryBudgetBytes = (() => {
  const mb = Number(process.env.DIRECT_STREAM_MEMORY_MB?.trim() || 6144);
  return (Number.isFinite(mb) && mb > 0 ? mb : 6144) * 1024 * 1024;
})();
/** The memory every copied session together may hold — see memoryBudgetBytes. */
export function directStreamMemoryBytes(): number {
  return memoryBudgetBytes;
}
/** For the tests: a memory budget small enough to see segments go to disk. */
export function setDirectStreamMemoryBytes(bytes: number): void {
  memoryBudgetBytes = bytes;
}
/**
 * Where segments past the memory budget are kept, one folder per session,
 * removed when its stream ends: STREAM_CACHE_DIR, or stream-cache in the data
 * folder. Best on an SSD: a skip back reads from it.
 */
const CACHE_DIR = process.env.STREAM_CACHE_DIR?.trim()
  ? path.resolve(process.env.STREAM_CACHE_DIR.trim())
  : path.join(
      process.env.THUMB_CACHE_DIR
        ? path.resolve(process.env.THUMB_CACHE_DIR)
        : path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "../../data"),
      "stream-cache",
    );
/** Where segments past the memory budget go — see CACHE_DIR. */
export function directStreamCacheDir(): string {
  return CACHE_DIR;
}
// Whatever a server that stopped without ending its streams left behind.
try {
  fs.rmSync(CACHE_DIR, { recursive: true, force: true });
} catch {
  // Not there, or not ours to clear: segments are written per session anyway.
}
/** How far Plex's MPEG-TS clock runs ahead of the film. Measured at 10s on a
 *  real server, for sessions started at the beginning and mid-film alike. */
const PLEX_TS_OFFSET_S = 10;
/** Plex is asked for 3s segments, which fixes the index a mid-film start begins
 *  at, even though its copied segments are nothing like 3s long. */
const SECONDS_PER_SEGMENT = 3;
/**
 * How long each gap entry before a mid-film session's first segment is.
 *
 * Long, because hls.js walks them: until the element has jumped to the start
 * position it reads 0:00, and hls.js fills from there, one gap entry at a time,
 * a few milliseconds each. At 10s a session started an hour and a half in had
 * 540 of them.
 *
 * They are left out of the target duration, which hls.js doesn't hold an entry
 * to. It does time reloads by it: the first load of a playlist happens with
 * nothing buffered, so hls.js measures the player as being at 0:00, far from
 * the end, and waits a whole target duration to reload. With the gap entries
 * counted that was a minute, and a session started mid-film played the half
 * minute its first playlist listed and then sat waiting for the rest.
 */
const FILLER_STEP_S = 60;
/** Never advertised lower than this. Copied segments run to ~10.5s. */
const MIN_TARGET_DURATION = 12;
/**
 * Seconds of film listed past the start before the first playlist is handed
 * out. With only a couple of segments in it, the player can reach the end of
 * the first playlist before it has loaded the second, and stall there.
 */
const READY_SPAN_S = 30;
/** Plex not producing the next segment for this long means it isn't going to. */
const STUCK_MS = 60_000;
/** How long a fresh session's first playlist waits for READY_SPAN_S, at most —
 *  well inside hls.js's 10s timeout for loading a playlist, so the player hears
 *  "try again" (503) rather than giving up on a request that never answered. */
const READY_TIMEOUT_MS = 6_000;
/** How often to ask Plex for its own playlist while waiting on a segment — see
 *  primePlexPlaylist. */
const PRIME_EVERY_MS = 5_000;

interface Measured {
  /** Plex's segment number. */
  index: number;
  /** Its path on Plex, which is also how clients name it. */
  path: string;
  /** Film time, seconds: the earlier of where its audio and its video start —
   *  see the module comment — and where its video ends. */
  start: number;
  end: number;
  /** Where its picture starts, and its sound (null with none), film time. */
  videoStart: number;
  audioStart: number | null;
  /** Its size, kept after the bytes are let go: it is part of the segment's
   *  URL in the playlist, which mustn't change between reloads. */
  bytes: number;
  /** In memory; null once on disk, or let go. */
  data: Buffer | null;
  /** On disk, once moved there. */
  file: string | null;
  /** Being written to disk. */
  spilling: boolean;
}

interface CopySession {
  sessionId: string;
  plexKey: string;
  ratingKey: string;
  baseDir: string;
  /** Where the session was asked to start, film time. */
  offsetS: number;
  nextIndex: number;
  /** Plex's clock minus film time, fixed by the first segment. */
  clockOffset: number | null;
  segments: Measured[];
  byPath: Map<string, Measured>;
  ended: boolean;
  failed: boolean;
  /** The watcher's position, film time — from the driver's keep-alive pings. */
  positionS: number;
  cachedBytes: number;
  targetDuration: number;
  abort: AbortController;
  /** Interrupts the pump's wait when something has changed. */
  wake: (() => void) | null;
  /** Waiting for the first playlist. */
  readyWaiters: Array<() => void>;
  /** Segments whose audio and video start far apart, logged — a few, not all. */
  skewLogged: number;
  /** A segment the disk refused, logged — once. */
  spillFailedLogged: boolean;
  /** A playlist has been handed out. */
  handedOut: boolean;
  /** Its keyframes turned out not to be IDR frames — see keyframes.ts. */
  openGop: boolean;
}

const sessions = new Map<string, CopySession>();
const byPlexKey = new Map<string, CopySession>();
/**
 * Titles whose copy couldn't be measured, or that Plex stopped copying. The
 * next start of one is re-encoded instead: a restart is how the player recovers
 * from a stream that stops growing, and restarting into the same copy would
 * only fail the same way.
 */
const refused = new Set<string>();

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function segmentPath(s: CopySession, index: number): string {
  return `${s.baseDir}${String(index).padStart(5, "0")}.ts`;
}

/** Wait for `ms`, or until something wakes the pump. */
function rest(s: CopySession, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      if (s.wake === done) s.wake = null;
      resolve();
    }
    s.wake = done;
  });
}

/** What every copied session holds in memory together, bytes. */
function totalCached(): number {
  let total = 0;
  for (const s of sessions.values()) total += s.cachedBytes;
  return total;
}
/** Of that, what is on its way to disk. */
let spillingBytes = 0;

/** Let a segment go altogether — its stream has ended, or the disk refused it. */
function drop(s: CopySession, seg: Measured): void {
  if (seg.data) s.cachedBytes -= seg.data.length;
  seg.data = null;
  seg.file = null;
}

function sessionDir(s: CopySession): string {
  return path.join(CACHE_DIR, s.sessionId.replace(/[^\w-]/g, "_"));
}

/** Move a segment from memory to disk; it is served from memory until it is there. */
async function spill(s: CopySession, seg: Measured): Promise<void> {
  if (!seg.data || seg.spilling) return;
  const data = seg.data;
  seg.spilling = true;
  spillingBytes += data.length;
  const file = path.join(sessionDir(s), `${seg.index}.ts`);
  try {
    await fs.promises.mkdir(sessionDir(s), { recursive: true });
    await fs.promises.writeFile(file, data);
    if (sessions.get(s.sessionId) !== s) {
      await fs.promises.rm(file, { force: true });
      return;
    }
    if (seg.data === data) {
      s.cachedBytes -= data.length;
      seg.data = null;
      seg.file = file;
    }
  } catch (err) {
    // A full or missing disk: memory can't hold it either, so it goes, and a
    // player that wants it again restarts there.
    if (sessions.get(s.sessionId) === s && !s.spillFailedLogged) {
      s.spillFailedLogged = true;
      logEvent("DirectStream", "couldn't keep a segment on disk, letting it go", {
        session: s.sessionId.substring(0, 8),
        dir: CACHE_DIR,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (seg.data === data) drop(s, seg);
  } finally {
    seg.spilling = false;
    spillingBytes -= data.length;
  }
}

/**
 * Keep memory within its budget by moving segments to disk: what a playhead
 * has passed first, oldest first, from every session; then, only if that
 * isn't enough, what is furthest ahead. Nothing is let go.
 */
function evict(_s: CopySession): void {
  const over = () => totalCached() - spillingBytes > memoryBudgetBytes;
  if (!over()) return;
  const inMemory = [...sessions.values()].flatMap((s) =>
    s.segments.filter((seg) => seg.data && !seg.spilling).map((seg) => ({ s, seg })));
  const behind = inMemory.filter(({ s, seg }) => seg.end < s.positionS).sort((a, b) => a.seg.start - b.seg.start);
  const ahead = inMemory.filter(({ s, seg }) => seg.end >= s.positionS)
    .sort((a, b) => (b.seg.start - b.s.positionS) - (a.seg.start - a.s.positionS));
  for (const { s, seg } of [...behind, ...ahead]) {
    if (!over()) return;
    void spill(s, seg);
  }
}

/** Whether the pump should fetch another segment now. */
function wantsMore(s: CopySession): boolean {
  if (s.ended || s.failed) return false;
  const last = s.segments[s.segments.length - 1];
  const measuredTo = last ? last.end : s.offsetS;
  return measuredTo < s.positionS + LEAD_S;
}

/** Segments whose length is settled: all but the newest, until the end is known. */
function published(s: CopySession): Measured[] {
  return s.ended ? s.segments : s.segments.slice(0, -1);
}

/** Whether the first playlist has enough in it to hand out. */
function ready(s: CopySession): boolean {
  if (s.ended || s.failed) return true;
  const list = published(s);
  const last = list[list.length - 1];
  return !!last && last.end - Math.max(s.offsetS, list[0].start) >= READY_SPAN_S;
}

function notifyReady(s: CopySession): void {
  if (!ready(s)) return;
  for (const resolve of s.readyWaiters.splice(0)) resolve();
}

function fail(s: CopySession, reason: string, detail: Record<string, unknown> = {}): void {
  s.failed = true;
  refused.add(s.ratingKey);
  logEvent("DirectStream", "giving up on copying this title; it will be re-encoded from its next start", {
    session: s.sessionId.substring(0, 8),
    ratingKey: s.ratingKey,
    reason,
    measured: s.segments.length,
    ...detail,
  });
  for (const resolve of s.readyWaiters.splice(0)) resolve();
}

/**
 * Ask Plex for its own playlist for the session.
 *
 * Plex doesn't start copying until something asks for it. Every client that
 * plays one of its HLS sessions loads that playlist before any segment — the
 * re-encode prefetcher polls it, the diagnosis script loaded it — and the first
 * version of this tracker went straight to segment 0 instead, and was answered
 * 404 for as long as anyone waited. The playlist itself is no use here (that is
 * the point of this module); asking for it is.
 */
async function primePlexPlaylist(s: CopySession): Promise<number> {
  try {
    const res = await plexFetchSegment(`${s.baseDir}index.m3u8`);
    await res.text().catch(() => "");
    return res.status;
  } catch {
    return 0;
  }
}

/**
 * Fetch Plex's segments one at a time, in order, for as long as the watcher
 * needs more — see the module comment for why never out of order.
 */
async function pump(s: CopySession): Promise<void> {
  let missingSince: number | null = null;
  let misses = 0;
  let primedAt = Date.now();
  const primed = await primePlexPlaylist(s);
  let waitLogged = false;
  if (primed !== 200) {
    logEvent("DirectStream", "Plex's playlist for the session didn't load", {
      session: s.sessionId.substring(0, 8),
      status: primed,
    });
  }
  while (!s.abort.signal.aborted && !s.ended && !s.failed) {
    if (!wantsMore(s)) {
      await rest(s, 2000);
      continue;
    }
    const path = segmentPath(s, s.nextIndex);
    let res: Awaited<ReturnType<typeof plexFetchSegment>>;
    try {
      res = await plexFetchSegment(path);
    } catch {
      if (s.abort.signal.aborted) return;
      await rest(s, 1000);
      continue;
    }
    if (s.abort.signal.aborted) {
      res.body?.cancel().catch(() => {});
      return;
    }
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      // 404 is "not copied yet" — this has caught up with Plex, which copies
      // in bursts. Retry soon, then less often. Nothing for a minute is Plex
      // having stopped.
      missingSince ??= Date.now();
      if (Date.now() - missingSince > STUCK_MS) {
        fail(s, "Plex stopped producing segments", { index: s.nextIndex, status: res.status });
        return;
      }
      // Nudge it again while waiting, in case the first ask was too early.
      if (Date.now() - primedAt > PRIME_EVERY_MS) {
        primedAt = Date.now();
        await primePlexPlaylist(s);
      }
      if (!waitLogged && s.segments.length === 0 && Date.now() - missingSince > 10_000) {
        waitLogged = true;
        logEvent("DirectStream", "still waiting for Plex's first copied segment", {
          session: s.sessionId.substring(0, 8),
          index: s.nextIndex,
          status: res.status,
          waitedS: Math.round((Date.now() - missingSince) / 1000),
        });
      }
      await rest(s, res.status === 404 ? Math.min(1000, 100 * 2 ** misses++) : 2000);
      continue;
    }
    missingSince = null;
    misses = 0;

    let data: Buffer;
    try {
      data = Buffer.from(await res.arrayBuffer());
    } catch {
      if (s.abort.signal.aborted) return;
      await rest(s, 1000);
      continue;
    }
    if (s.abort.signal.aborted) return;

    const span = videoSpan(data);
    if (!span) {
      // Not MPEG-TS at all — an error page, or JSON, answered with a 200. Not
      // a segment and not the end either; treated like one not copied yet.
      if (data.length === 0 || data[0] !== 0x47) {
        missingSince ??= Date.now();
        if (Date.now() - missingSince > STUCK_MS) {
          fail(s, "Plex answered with something other than a segment", { index: s.nextIndex, bytes: data.length });
          return;
        }
        await rest(s, Math.min(1000, 100 * 2 ** misses++));
        continue;
      }
      // Plex's copied streams end with segments of a single packet. Anything
      // bigger with no video in it is something this can't read, and listing
      // past it would be guessing.
      if (data.length <= 4 * 188) {
        s.ended = true;
        logEvent("DirectStream", "reached the end of the copied stream", {
          session: s.sessionId.substring(0, 8),
          segments: s.segments.length,
          endS: round3(s.segments[s.segments.length - 1]?.end ?? s.offsetS),
        });
        notifyReady(s);
      } else {
        fail(s, "a segment had no readable video timestamps", { index: s.nextIndex, bytes: data.length });
      }
      return;
    }
    missingSince = null;
    misses = 0;

    if (s.clockOffset === null) {
      // Plex's clock is 10s ahead of the film. Checked against where the session
      // was asked to start — the first segment opens on the keyframe at or just
      // before it — and if that doesn't fit, the session's own offset is taken
      // as the film time of its first frame instead.
      const filmStart = span.start - PLEX_TS_OFFSET_S;
      const plausible = filmStart <= s.offsetS + 1 && filmStart >= s.offsetS - 30;
      s.clockOffset = plausible ? PLEX_TS_OFFSET_S : span.start - s.offsetS;
      logEvent("DirectStream", "first copied segment", {
        session: s.sessionId.substring(0, 8),
        index: s.nextIndex,
        rawStartS: round3(span.start),
        clockOffsetS: round3(s.clockOffset),
        assumed: !plausible,
        // Positive: sound from before the first picture, which the layout
        // has to allow for — see the module comment.
        audioLeadS: span.audioStart === null ? "none" : round3(span.start - span.audioStart),
      });
    } else if (span.audioStart !== null && Math.abs(span.start - span.audioStart) > 1 && s.skewLogged < 3) {
      s.skewLogged++;
      logEvent("DirectStream", "a copied segment's audio and video start apart", {
        session: s.sessionId.substring(0, 8),
        index: s.nextIndex,
        audioLeadS: round3(span.start - span.audioStart),
      });
    }
    // A segment opening on a plain I-frame: a film to re-encode from its next
    // start (services/keyframes.ts reads most such files before they are
    // copied; this is for the rest). One nobody has been given yet is given
    // up on now, and the player starts over on the re-encode.
    if (!s.openGop && firstKeyframe(data) === "not-idr") {
      s.openGop = true;
      refused.add(s.ratingKey);
      logEvent("DirectStream", "this copy's keyframes aren't IDR frames; it will be re-encoded from its next start", {
        session: s.sessionId.substring(0, 8),
        ratingKey: s.ratingKey,
        index: s.nextIndex,
        handedOut: s.handedOut,
      });
      if (!s.handedOut) {
        fail(s, "its keyframes aren't IDR frames (an open-GOP Blu-ray)");
        return;
      }
    }
    const videoStart = span.start - s.clockOffset;
    const audioStart = span.audioStart === null ? null : span.audioStart - s.clockOffset;
    const seg: Measured = {
      index: s.nextIndex,
      path,
      start: audioStart === null ? videoStart : Math.min(videoStart, audioStart),
      end: span.end - s.clockOffset,
      videoStart,
      audioStart,
      bytes: data.length,
      data,
      file: null,
      spilling: false,
    };
    s.segments.push(seg);
    s.byPath.set(path, seg);
    s.cachedBytes += data.length;
    s.nextIndex++;
    evict(s);
    notifyReady(s);
  }
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Begin measuring a copied transcode. `offsetS` is where it was asked to start;
 * Plex numbers its first segment from that, at 3s a segment.
 */
export function startDirectStream(sessionId: string, plexKey: string, ratingKey: string, offsetS: number): void {
  stopDirectStream(sessionId);
  const s: CopySession = {
    sessionId,
    plexKey,
    ratingKey,
    baseDir: `/video/:/transcode/universal/session/${plexKey}/base/`,
    offsetS,
    nextIndex: Math.floor(offsetS / SECONDS_PER_SEGMENT),
    clockOffset: null,
    segments: [],
    byPath: new Map(),
    ended: false,
    failed: false,
    positionS: offsetS,
    cachedBytes: 0,
    targetDuration: MIN_TARGET_DURATION,
    abort: new AbortController(),
    wake: null,
    readyWaiters: [],
    skewLogged: 0,
    spillFailedLogged: false,
    handedOut: false,
    openGop: false,
  };
  sessions.set(sessionId, s);
  byPlexKey.set(plexKey, s);
  logEvent("DirectStream", "copying", {
    session: sessionId.substring(0, 8),
    plexKey: plexKey.substring(0, 8),
    ratingKey,
    fromS: offsetS,
    firstIndex: s.nextIndex,
  });
  pump(s).catch((err) => {
    console.error("[DirectStream] pump failed:", err);
    fail(s, "internal error");
  });
}

export function stopDirectStream(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.abort.abort();
  s.wake?.();
  for (const resolve of s.readyWaiters.splice(0)) resolve();
  for (const seg of s.segments) drop(s, seg);
  sessions.delete(sessionId);
  if (byPlexKey.get(s.plexKey) === s) byPlexKey.delete(s.plexKey);
  // What it put on disk goes with it.
  void fs.promises.rm(sessionDir(s), { recursive: true, force: true }).catch(() => {});
}

/** Whether this Plex transcode key is a copied stream measured here. */
export function isDirectStreamKey(plexKey: string): boolean {
  return byPlexKey.has(plexKey);
}

/** Whether a title should be re-encoded rather than copied — see `refused`. */
export function directStreamRefused(ratingKey: string): boolean {
  return refused.has(ratingKey);
}

/** Where the driver is watching, from its keep-alive ping. */
export function updateDirectStreamPosition(sessionId: string, positionS: number): void {
  const s = sessions.get(sessionId);
  if (!s || !Number.isFinite(positionS) || positionS < 0) return;
  s.positionS = positionS;
  evict(s);
  s.wake?.();
}

/**
 * The playlist for a copied stream, in film time: a gap up to where the session
 * starts, then every measured segment at its true length. Waits for the first
 * few segments on a fresh session, so the player gets something to play rather
 * than an empty list it would only reload in twelve seconds.
 *
 * `urlFor` turns a Plex segment path into the URL clients fetch it from, which
 * is routes/plex.ts's business (the proxy, or the VPS relay). It is given the
 * segment's size too, which the player uses to fetch it in parts — see
 * segmentPart.
 */
export async function directStreamPlaylist(
  plexKey: string,
  urlFor: (plexPath: string, bytes: number) => string,
): Promise<string | "retry" | null> {
  const s = byPlexKey.get(plexKey);
  if (!s) return null;
  if (!ready(s)) {
    await Promise.race([
      new Promise<void>((resolve) => s.readyWaiters.push(resolve)),
      sleep(READY_TIMEOUT_MS),
    ]);
  }
  // Given up on before anyone had it: gone, so the player starts over — on a
  // re-encode, since the title is refused now.
  if (s.openGop && !s.handedOut) return null;

  const list = published(s);
  // Nothing measured yet: say so, and hls.js asks again shortly. An empty
  // playlist would be an error to it, and a request left hanging past its own
  // timeout is one it stops waiting for.
  if (list.length === 0 && !s.ended) return "retry";
  const first = list[0] ?? s.segments[0];
  const lines: string[] = [];

  // Up to the first segment: gaps, in steps the target duration can cover.
  const fillTo = first ? round3(Math.max(0, first.start)) : 0;
  let filled = 0;
  while (fillTo - filled > 0.0005) {
    const step = round3(Math.min(FILLER_STEP_S, fillTo - filled));
    lines.push(`#EXTINF:${step.toFixed(3)},`, "#EXT-X-GAP", "gap.ts");
    filled = round3(filled + step);
  }

  // The target duration is the segments' alone — see FILLER_STEP_S.
  let longest = 0;
  // Each segment runs to where the next one starts, so the running total is
  // exactly the timestamps — the last one, once the end is known, to its own end.
  for (let i = 0; i < list.length; i++) {
    const seg = list[i];
    const next = s.segments[i + 1];
    const duration = round3((next ? round3(next.start) : round3(seg.end)) - round3(seg.start));
    longest = Math.max(longest, duration);
    lines.push(`#EXTINF:${duration.toFixed(3)},`, urlFor(seg.path, seg.bytes));
  }
  // Raised when a segment needs it and never lowered: a target duration that
  // shrank between reloads would be a different playlist as far as the spec goes.
  s.targetDuration = Math.max(s.targetDuration, Math.ceil(longest));

  const head = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-PLAYLIST-TYPE:EVENT",
    `#EXT-X-TARGETDURATION:${s.targetDuration}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
  ];
  // Always, from the start of the title too: a playlist that is still growing
  // is live as far as hls.js is concerned, and without a start it begins near
  // the end of what is listed — minutes into the film. Never before both
  // picture and sound have begun, which with a lead in the audio is later
  // than the first segment's start.
  const playable = first
    ? Math.max(first.videoStart, first.audioStart ?? first.videoStart)
    : fillTo;
  head.push(`#EXT-X-START:TIME-OFFSET=${round3(Math.max(s.offsetS, playable)).toFixed(3)},PRECISE=YES`);
  const tail = s.ended ? ["#EXT-X-ENDLIST"] : [];
  s.handedOut = true;
  return [...head, ...lines, ...tail].join("\n") + "\n";
}

/** The most parts a segment is served in — see segmentPart. */
export const MAX_SEGMENT_PARTS = 8;

/**
 * Part `part` of `parts` of a segment: the bytes from ⌊size × part / parts⌋ up
 * to ⌊size × (part + 1) / parts⌋, the split the player's lib/segmentParts.ts
 * makes too. Null for a part that doesn't exist.
 *
 * A copied segment is a whole keyframe interval at the film's own bitrate —
 * 7 MB for a DVD-quality film, 28 MB for a Blu-ray — and a single download of
 * it through Discord's proxy runs at its own pace, 7 to 25 Mbps however many
 * others run beside it. The first segment of a stream took up to half a
 * minute that way. Asked for in parts, all at once, it takes a fraction of it.
 */
export function segmentPart(data: Buffer, part: number, parts: number): Buffer | null {
  const bounds = partBounds(data.length, part, parts);
  return bounds ? data.subarray(bounds[0], bounds[1]) : null;
}

/** Where part `part` of `parts` of a segment of `size` bytes begins and ends — see segmentPart. */
export function partBounds(size: number, part: number, parts: number): [number, number] | null {
  if (!Number.isInteger(part) || !Number.isInteger(parts)) return null;
  if (parts < 1 || parts > MAX_SEGMENT_PARTS || part < 0 || part >= parts) return null;
  return [Math.floor((size * part) / parts), Math.floor((size * (part + 1)) / parts)];
}

/** A copied segment, wherever it is kept: its size, and its bytes from `start` up to `end`. */
export interface CopiedSegment {
  bytes: number;
  read(start: number, end: number): Promise<Buffer>;
}

/**
 * A copied segment, for a client — from memory or from disk. "gone" when it
 * was measured but has since been let go (its stream ended, or the disk
 * refused it) — the client restarts where it is — and null when it isn't one
 * this session has measured at all, which a client following the playlist
 * never asks for.
 */
export function directStreamSegment(plexKey: string, plexPath: string): CopiedSegment | "gone" | null {
  const s = byPlexKey.get(plexKey);
  const seg = s?.byPath.get(plexPath);
  if (!seg) return null;
  const data = seg.data;
  if (data) return { bytes: data.length, read: async (start, end) => data.subarray(start, end) };
  const file = seg.file;
  if (!file) return "gone";
  return {
    bytes: seg.bytes,
    read: async (start, end) => {
      const handle = await fs.promises.open(file, "r");
      try {
        const out = Buffer.alloc(Math.max(0, end - start));
        const { bytesRead } = await handle.read(out, 0, out.length, start);
        return out.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
  };
}
