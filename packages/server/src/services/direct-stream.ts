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
 */

import { plexFetchSegment } from "./plex.js";
import { videoSpan } from "./ts-timestamps.js";
import { logEvent } from "./logger.js";

/** How far past the playhead to measure — over the player's 120s buffer target,
 *  the same lead the re-encode prefetcher keeps. */
const LEAD_S = 150;
/** How long a segment's bytes are kept once the playhead has passed it, so a
 *  short step back is served rather than restarted. The player restarts for
 *  anything further back than COPY_BACK_WINDOW_S (Player.tsx), which is less. */
const BACK_S = 180;
/** Memory for every copied session together; each gets an equal share. */
const GLOBAL_BUDGET_BYTES = 512 * 1024 * 1024;
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
 * 540 of them. The target duration has to cover the longest entry, which is
 * harmless here — hls.js reloads a playlist this close to its end at the length
 * of the last segment, not at the target duration.
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
/** How long a fresh session's first playlist waits for READY_SPAN_S, at most;
 *  inside hls.js's own timeout for loading a playlist. */
const READY_TIMEOUT_MS = 10_000;

interface Measured {
  /** Plex's segment number. */
  index: number;
  /** Its path on Plex, which is also how clients name it. */
  path: string;
  /** Film time, seconds. */
  start: number;
  end: number;
  /** Null once let go. */
  data: Buffer | null;
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

function share(): number {
  return Math.floor(GLOBAL_BUDGET_BYTES / Math.max(1, sessions.size));
}

function drop(s: CopySession, seg: Measured): void {
  if (!seg.data) return;
  s.cachedBytes -= seg.data.length;
  seg.data = null;
}

/**
 * Let go of what the watcher is done with: anything BACK_S behind them, then —
 * only if this session is over its share — the oldest of what is behind them at
 * all. Nothing ahead of the playhead is ever dropped; when memory is short the
 * pump stops fetching ahead instead.
 */
function evict(s: CopySession): void {
  for (const seg of s.segments) {
    if (seg.end < s.positionS - BACK_S) drop(s, seg);
  }
  const limit = share();
  for (const seg of s.segments) {
    if (s.cachedBytes <= limit) break;
    if (seg.end < s.positionS) drop(s, seg);
  }
}

/** Whether the pump should fetch another segment now. */
function wantsMore(s: CopySession): boolean {
  if (s.ended || s.failed) return false;
  const last = s.segments[s.segments.length - 1];
  const measuredTo = last ? last.end : s.offsetS;
  if (measuredTo >= s.positionS + LEAD_S) return false;
  return s.cachedBytes < share();
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
 * Fetch Plex's segments one at a time, in order, for as long as the watcher
 * needs more — see the module comment for why never out of order.
 */
async function pump(s: CopySession): Promise<void> {
  let missingSince: number | null = null;
  let misses = 0;
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
      });
    }
    const seg: Measured = {
      index: s.nextIndex,
      path,
      start: span.start - s.clockOffset,
      end: span.end - s.clockOffset,
      data,
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
 * is routes/plex.ts's business (the proxy, or the VPS relay).
 */
export async function directStreamPlaylist(
  plexKey: string,
  urlFor: (plexPath: string) => string,
): Promise<string | null> {
  const s = byPlexKey.get(plexKey);
  if (!s) return null;
  if (!ready(s)) {
    await Promise.race([
      new Promise<void>((resolve) => s.readyWaiters.push(resolve)),
      sleep(READY_TIMEOUT_MS),
    ]);
  }

  const list = published(s);
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

  // The longest gap entry has to fit the target duration too.
  let longest = filled > 0 ? Math.min(FILLER_STEP_S, fillTo) : 0;
  // Each segment runs to where the next one starts, so the running total is
  // exactly the timestamps — the last one, once the end is known, to its own end.
  for (let i = 0; i < list.length; i++) {
    const seg = list[i];
    const next = s.segments[i + 1];
    const duration = round3((next ? round3(next.start) : round3(seg.end)) - round3(seg.start));
    longest = Math.max(longest, duration);
    lines.push(`#EXTINF:${duration.toFixed(3)},`, urlFor(seg.path));
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
  // the end of what is listed — minutes into the film.
  head.push(`#EXT-X-START:TIME-OFFSET=${round3(Math.max(s.offsetS, fillTo)).toFixed(3)},PRECISE=YES`);
  const tail = s.ended ? ["#EXT-X-ENDLIST"] : [];
  return [...head, ...lines, ...tail].join("\n") + "\n";
}

/**
 * A copied segment's bytes, for a client. "gone" when it was measured but has
 * since been let go — the client restarts where it is — and null when it isn't
 * one this session has measured at all, which a client following the playlist
 * never asks for.
 */
export function directStreamSegment(plexKey: string, plexPath: string): Buffer | "gone" | null {
  const s = byPlexKey.get(plexKey);
  const seg = s?.byPath.get(plexPath);
  if (!seg) return null;
  return seg.data ?? "gone";
}
