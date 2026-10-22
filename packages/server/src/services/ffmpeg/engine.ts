/**
 * The ffmpeg playback engine: streams this server makes from the file itself,
 * rather than asking Plex's transcoder for them (PLAYBACK_ENGINE=ffmpeg).
 *
 * Each stream (a session id, which the room and its players share) has one
 * run at a time: one ffmpeg, started where the player asked — the start, or a
 * seek's `?offset=` — writing numbered MPEG-TS segments into a folder of its
 * own and announcing each one on stdout when it is complete. Every segment is
 * measured as it arrives (ts-timestamps.ts) and listed at its true length, in
 * film time, in an EVENT playlist the same shape as a Plex copy's
 * (measured-playlist.ts) — so the player, its seeks and its pop-outs treat the
 * two the same. A seek past what is listed restarts the run there, as it does
 * for a Plex copy.
 *
 * The run goes on flat out to the end of the film: a copy is done in a minute
 * or two, a re-encode in ten to thirty, and from then on a seek anywhere plays
 * at once, from here. Plex's copies are held a few minutes ahead because Plex
 * ends a session that reaches the end of the file; nothing here does.
 * FFMPEG_LOOKAHEAD holds a run that far ahead of whoever is watching instead
 * (SIGSTOP), carrying on once they near it. A start goes first: runs already
 * well ahead of their watchers give way to it for a few seconds (giveWay).
 * Everything a run wrote is kept, on disk in STREAM_CACHE_DIR, until the
 * stream ends, so going back is served from here.
 *
 * A run started mid-film — a resume, a seek — makes what it skipped as well,
 * once it has reached the end of the file: a second ffmpeg, from the start of
 * the film up to where the run's picture begins (Before). A seek back into
 * that is then served from what was made, as is any restart into the run's
 * own stretch: the run under a new key, listed whole, rather than a new
 * ffmpeg (rekey). A run that dies
 * answers 410 for its playlist, which the player meets by restarting where it
 * is; a title that keeps dying is left to Plex.
 *
 * The URLs are Plex-shaped — /video/:/transcode/universal/session/<key>/base/
 * — with a key of this server's own, so the segment route, the VPS relay's
 * nginx rule and the player all work unchanged. Nothing with one of these keys
 * is ever sent to Plex.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { firstKeyframe, videoSpan } from "../ts-timestamps.js";
import { directStreamCacheDir, type CopiedSegment } from "../direct-stream.js";
import { measuredPlaylist, round3, type MeasuredSegment } from "../measured-playlist.js";
import { logEvent } from "../logger.js";
import { LruMap } from "../lru.js";
import { streamBandwidth, type Bandwidth } from "../stream-bandwidth.js";
import { ffmpegPath, lookaheadS, maxEncodes } from "./config.js";
import { cpuUse, gpuUse, readUse, sampleGpu, type GpuSample } from "./gpu-use.js";
import { dropHot, hotSegment, keepHot } from "./hot-segments.js";
import { COPY_CLOCK_OFFSET_S } from "./plan.js";

/** How far past the watcher a run is when its speed is logged, unless
 *  FFMPEG_LOOKAHEAD pauses it before. */
const SPEED_AFTER_S = 180;
/** Runs this far past their watchers give way to a start (giveWay)... */
const GIVE_WAY_AHEAD_S = 90;
/** ...until it has this much made past where it started, */
const GIVE_WAY_UNTIL_S = 60;
/** or for this long at most: their watchers are still 70 s from their edge. */
const GIVE_WAY_MAX_MS = 20_000;
/** Seconds listed before the first playlist is handed out — see direct-stream.ts. */
const READY_SPAN_S = 30;
/**
 * A re-encode's: four segments. It went out with the next segment listed, one
 * or two, and a player started on those knew nothing of the rest until hls.js
 * next read the playlist: on 18 October every start of one went on 1 to 3 s
 * in hand and stopped a few seconds later. Thirty seconds cost 3.5 s before
 * the first picture on Intel's GPU, too long; twelve is about 1.5 s.
 */
const READY_SPAN_ENCODE_S = 12;
/** How long the first playlist waits for READY_SPAN_S: inside hls.js's 10 s. */
const READY_TIMEOUT_MS = 6_000;
/** How long a start waits for the first segment before leaving the stream to Plex. */
const FIRST_SEGMENT_TIMEOUT_MS = Number(process.env.PDT_FFMPEG_FIRST_SEGMENT_MS) || 10_000;
/** Never advertised lower than this. */
const MIN_TARGET_DURATION = 6;
/** A run nobody has asked about for this long is stopped: the room's own
 *  keep-alive comes every 30 s, so this only catches what everything forgot. */
const IDLE_MS = 10 * 60_000;
/** A run started closer than this to the start of the film leaves what is
 *  before it to a restart: a few seconds aren't worth a second ffmpeg. */
const BEFORE_FROM_S = 10;
/** How long a run made whole — Before and all — is kept once its session
 *  stops, for a new session of its driver's to take over (takeOver). The
 *  player asks for that new one straight after it stops the old. */
const SPARE_MS = 15_000;
/** Runs of one title that die within this long of each other leave it to Plex. */
const CRASH_WINDOW_MS = 15 * 60_000;
const CRASHES_TO_REFUSE = 2;

const CACHE_DIR = path.join(directStreamCacheDir(), "ffmpeg");
// Whatever a server that stopped without ending its streams left behind.
try {
  fs.rmSync(CACHE_DIR, { recursive: true, force: true });
} catch {
  // Not there.
}

interface Segment extends MeasuredSegment {
  file: string;
}

/**
 * What a run started mid-film skipped: the same stream from the start of the
 * film up to where the run's picture begins, made once the run has reached
 * the end of the file. Its segments are the run's, under its key ("b" before
 * their numbers), but listed only once all of it is made, and only under a
 * new key (rekey): a playlist grows at its end, never at its start.
 */
interface Before {
  proc: ChildProcess | null;
  dir: string;
  /** Where it stops, film time: where the run's picture starts. */
  toS: number;
  segments: Segment[];
  /** Its segments' clock minus film time, fixed by the first. */
  clockOffset: number | null;
  ended: boolean;
  failed: string | null;
  /** Stopped with its run. */
  stopped: boolean;
  /** SIGSTOPped while a stream starts (giveWay): how many. */
  yielding: number;
  queue: Promise<void>;
  stdoutRest: string;
  stderrTail: string[];
  startedAt: number;
}

interface Run {
  key: string;
  sessionId: string;
  ratingKey: string;
  codec: string;
  /** A re-encode, not a copy: holds one of FFMPEG_MAX_ENCODES. */
  encode: boolean;
  /** What one viewer downloads of it as planned, kbps, when known — see ffmpegBandwidth. */
  targetKbps: number | null;
  /** Without one, the average of the first of it made, worked out once — see ffmpegBandwidth. */
  averageKbps: number | null;
  dir: string;
  baseDir: string;
  /** The same stream's arguments from the start of the film up to `toS`: for its Before. */
  fromStart: ((toS: number) => string[]) | null;
  /** Those arguments, which are the same for every run of the same stream
   *  wherever it starts: a restart into one is served from what it made. */
  same: string | null;
  /** What it skipped, being made or made; null until it reaches the end of the file. */
  before: Before | null;
  /** Where the run was asked to start, film time. */
  offsetS: number;
  proc: ChildProcess | null;
  /** SIGSTOPped: FFMPEG_LOOKAHEAD ahead of the watcher. */
  paused: boolean;
  /** SIGSTOPped for a while, while other streams start (giveWay): how many. */
  yielding: number;
  /** How fast it got ahead of the watcher has been said. */
  speedSaid: boolean;
  /** Stopped by us: its exit is nothing to report. */
  stopped: boolean;
  segments: Segment[];
  byPath: Map<string, Segment>;
  /** The segments' clock minus film time, fixed by the first. */
  clockOffset: number | null;
  ended: boolean;
  failed: string | null;
  targetDuration: number;
  handedOut: boolean;
  /** The watcher's position, film time. */
  positionS: number;
  waiters: Array<() => void>;
  /** Segments are measured one after another, in the order ffmpeg finished them. */
  queue: Promise<void>;
  stdoutRest: string;
  stderrTail: string[];
  startedAt: number;
  /** A re-encode's GPU counts at its first segment, to say what it used — see gpu-use.ts. */
  gpuAtStart: GpuSample | null;
  /** And lately, for what it used by the time it ended, when they can't be read any more. */
  gpuLately: GpuSample | null;
  lastAlive: number;
}

const runs = new Map<string, Run>();
const bySession = new Map<string, Run>();
/** Keys of runs that have ended: their URLs answer 410, never anything from Plex. */
const retired = new LruMap<string, number>(2_000);
/** Sessions whose runs have ended: a stop or a ping for one is nothing of Plex's. */
const retiredSessions = new LruMap<string, number>(2_000);
/** Runs made whole whose sessions stopped, by session, kept SPARE_MS. */
const spare = new Map<string, Run>();
/** When each title's runs died, recently. */
const crashes = new Map<string, number[]>();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const short = (id: string) => id.substring(0, 8);

function notify(run: Run): void {
  for (const resolve of run.waiters.splice(0)) resolve();
}

function published(run: Run): Segment[] {
  return run.ended ? run.segments : run.segments.slice(0, -1);
}

function ready(run: Run): boolean {
  if (run.ended || run.failed) return true;
  const list = published(run);
  const last = list[list.length - 1];
  return !!last && last.end - Math.max(run.offsetS, list[0].start) >= (run.encode ? READY_SPAN_ENCODE_S : READY_SPAN_S);
}

/** What a re-encode used of the GPU and the CPU since its first segment, and how fast it read, for the log. */
function use(run: Run, now: GpuSample | null): { gpu: string; cpu: string; read: string } {
  return { gpu: gpuUse(run.gpuAtStart, now), cpu: cpuUse(run.gpuAtStart, now), read: readUse(run.gpuAtStart, now) };
}

/** Where the run has made the film to, film time. */
function edgeOf(run: Run): number {
  return run.segments[run.segments.length - 1]?.end ?? run.offsetS;
}

/** How much it has made and how fast, for the log. */
function speed(run: Run): { madeS: number; tookS: number; speedX: number } {
  const madeS = edgeOf(run) - (run.segments[0]?.start ?? run.offsetS);
  const tookS = (Date.now() - run.startedAt) / 1000;
  return { madeS: round3(madeS), tookS: round3(tookS), speedX: Math.round((madeS / Math.max(tookS, 0.001)) * 10) / 10 };
}

/**
 * Say how fast the run got well ahead of the watcher, once: on Intel's GPU a
 * 1080p re-encode runs many times faster than the film plays, on the CPU a
 * few. With FFMPEG_LOOKAHEAD, pause it there and carry on once the watcher
 * nears it — within a sixth of it, 30 s at most.
 */
function throttle(run: Run): void {
  if (!run.proc || run.proc.exitCode !== null || run.stopped || run.yielding > 0) return;
  const edge = edgeOf(run);
  const lead = lookaheadS();
  const far = edge > run.positionS + (lead ?? SPEED_AFTER_S);
  if (far && !run.speedSaid) {
    run.speedSaid = true;
    logEvent("FFmpeg", lead === null
      ? "3 minutes ahead of the watcher, going on to the end"
      : "far enough ahead of the watcher, paused until they near it", {
      session: short(run.sessionId), encode: run.encode, aheadS: round3(edge - run.positionS), ...speed(run),
      ...(run.encode && run.proc.pid ? use(run, sampleGpu(run.proc.pid)) : {}),
    });
  }
  // No SIGSTOP on Windows, where only development runs: the run goes on to the end there.
  if (process.platform === "win32") return;
  try {
    if (lead !== null && !run.paused && far) {
      run.proc.kill("SIGSTOP");
      run.paused = true;
    } else if (run.paused && (lead === null || edge < run.positionS + lead - Math.min(30, lead / 2))) {
      run.proc.kill("SIGCONT");
      run.paused = false;
    }
  } catch {
    // Gone already.
  }
}

/**
 * Hold the runs already well ahead of their watchers (GIVE_WAY_AHEAD_S) while
 * `run` makes its first minute, GIVE_WAY_MAX_MS at most. With every run going
 * flat out to the end, the one a viewer is waiting on would otherwise share
 * the GPU and the disk with others nobody needs yet: a seek's first picture
 * should cost what it did when they were paused.
 */
async function giveWay(run: Run): Promise<void> {
  if (process.platform === "win32") return;
  const held: Array<Run | Before> = [...runs.values()].filter((o) => o !== run && !o.paused && !o.stopped && !o.ended && !o.failed &&
    o.proc?.exitCode === null && (o.yielding > 0 || edgeOf(o) > o.positionS + GIVE_WAY_AHEAD_S));
  // And whatever is making what a run skipped, which nobody is waiting on.
  for (const o of runs.values()) if (o.before && making(o.before)) held.push(o.before);
  if (!held.length) return;
  for (const o of held) {
    try {
      if (o.yielding === 0) o.proc!.kill("SIGSTOP");
      o.yielding++;
    } catch {
      // Gone already.
    }
  }
  const startedAt = Date.now();
  const deadline = startedAt + GIVE_WAY_MAX_MS;
  while (!run.stopped && !run.failed && !run.ended && edgeOf(run) - run.offsetS < GIVE_WAY_UNTIL_S && Date.now() < deadline) {
    await Promise.race([new Promise<void>((r) => run.waiters.push(r)), sleep(500)]);
  }
  for (const o of held) {
    if (o.yielding === 0 || --o.yielding > 0 || o.stopped) continue;
    try {
      o.proc!.kill("SIGCONT");
    } catch {
      // Gone already.
    }
    if ("key" in o) throttle(o);
  }
  logEvent("FFmpeg", "others gave way to a start", {
    session: short(run.sessionId), held: held.length, ms: Date.now() - startedAt, madeS: round3(edgeOf(run) - run.offsetS),
  });
}

function fail(run: Run, why: string): void {
  if (run.failed || run.stopped) return;
  run.failed = why;
  const times = (crashes.get(run.ratingKey) ?? []).filter((t) => Date.now() - t < CRASH_WINDOW_MS);
  times.push(Date.now());
  crashes.set(run.ratingKey, times);
  logEvent("FFmpeg", "run failed", {
    session: short(run.sessionId), ratingKey: run.ratingKey, why, segments: run.segments.length,
    fromS: run.offsetS, stderr: run.stderrTail.slice(-6).join(" | ") || "none",
    leftToPlex: times.length >= CRASHES_TO_REFUSE,
  });
  try {
    run.proc?.kill("SIGKILL");
  } catch {
    // Gone already.
  }
  notify(run);
}

/** One segment ffmpeg has finished: measured, and listed. */
async function measure(run: Run, name: string): Promise<void> {
  if (run.stopped || run.failed) return;
  const file = path.join(run.dir, path.basename(name));
  let data: Buffer;
  try {
    data = await fs.promises.readFile(file);
  } catch {
    return;
  }
  const span = videoSpan(data);
  if (!span) {
    logEvent("FFmpeg", "a segment had no video in it", { session: short(run.sessionId), segment: name, bytes: data.length });
    return;
  }
  if (run.clockOffset === null) {
    // The segments carry the film's own time plus COPY_CLOCK_OFFSET_S (plan.ts).
    // The first one opens on the keyframe at or before where the run was asked
    // to start; if it doesn't fit that, it is taken to begin there instead, and
    // said so.
    const filmStart = span.start - COPY_CLOCK_OFFSET_S;
    const plausible = filmStart <= run.offsetS + 1 && filmStart >= run.offsetS - 30;
    run.clockOffset = plausible ? COPY_CLOCK_OFFSET_S : span.start - run.offsetS;
    logEvent("FFmpeg", "first segment", {
      session: short(run.sessionId), ratingKey: run.ratingKey, fromS: run.offsetS,
      encode: run.encode, startS: round3(span.start), clockOffsetS: round3(run.clockOffset), assumed: !plausible,
      audioLeadS: span.audioStart === null ? "none" : round3(span.start - span.audioStart),
      ms: Date.now() - run.startedAt,
    });
    if (run.encode && run.proc?.pid) run.gpuAtStart = sampleGpu(run.proc.pid);
    // A plain I-frame where a copy opens: an open-GOP Blu-ray, which browsers
    // can't start from (keyframes.ts). Plex's engine handles those.
    if (!run.encode && run.codec === "h264" && firstKeyframe(data) === "not-idr" && !run.handedOut) {
      fail(run, "its keyframes aren't IDR frames (open GOP)");
      return;
    }
  }
  const videoStart = span.start - run.clockOffset;
  const audioStart = span.audioStart === null ? null : span.audioStart - run.clockOffset;
  const seg: Segment = {
    path: `${run.baseDir}${path.basename(name)}`,
    file,
    start: audioStart === null ? videoStart : Math.min(videoStart, audioStart),
    end: span.end - run.clockOffset,
    videoStart,
    audioStart,
    bytes: data.length,
  };
  run.segments.push(seg);
  run.byPath.set(seg.path, seg);
  keepHot(file, data);
  throttle(run);
  notify(run);
}

function stopRun(run: Run, why: string, keep = false): void {
  // Before it goes, while its files are open.
  const used = run.gpuAtStart && run.proc?.pid && run.proc.exitCode === null ? use(run, sampleGpu(run.proc.pid)) : null;
  run.stopped = true;
  try {
    run.proc?.kill("SIGKILL");
  } catch {
    // Gone already.
  }
  if (run.before) {
    run.before.stopped = true;
    try {
      run.before.proc?.kill("SIGKILL");
    } catch {
      // Gone already.
    }
  }
  runs.delete(run.key);
  if (bySession.get(run.sessionId) === run) bySession.delete(run.sessionId);
  retired.set(run.key, Date.now());
  retiredSessions.set(run.sessionId, Date.now());
  notify(run);
  logEvent("FFmpeg", "run stopped", {
    session: short(run.sessionId), why, segments: run.segments.length,
    reachedS: round3(run.segments[run.segments.length - 1]?.end ?? run.offsetS),
    ...used,
  });
  dropHot(run.dir);
  if (keep && run.ended && !run.failed && run.before?.ended) {
    // The player stops its old session before it asks for the new one.
    const sessionId = run.sessionId;
    spare.set(sessionId, run);
    setTimeout(() => {
      if (spare.get(sessionId) !== run) return;
      spare.delete(sessionId);
      removeDir(run.dir);
    }, SPARE_MS).unref();
    return;
  }
  removeDir(run.dir);
}

/** A run's files, gone. Asked again while a killed ffmpeg still holds or
 *  writes one: on Windows the first try failed, and its folder stayed. */
function removeDir(dir: string): void {
  void fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
}

/** Whether a run's Before is being made. */
function making(b: Before): boolean {
  return !b.ended && !b.failed && !b.stopped && b.proc?.exitCode === null;
}

/**
 * Once a run started mid-film has reached the end of the file, make what it
 * skipped (Before). A re-encode's waits for a free encode slot, asked again
 * every 15 s, and takes none: a start is never left to Plex for one.
 */
function startBefore(run: Run): void {
  const first = run.segments[0];
  if (run.before || !run.fromStart || !run.ended || run.stopped || run.failed || !first || first.videoStart < BEFORE_FROM_S) return;
  if (run.encode) {
    const busy = ffmpegEncodesRunning() + [...runs.values()].filter((o) => o.encode && o.before && making(o.before)).length;
    if (busy >= maxEncodes()) return;
  }
  const b: Before = {
    proc: null, dir: path.join(run.dir, "before"), toS: first.videoStart, segments: [], clockOffset: null,
    ended: false, failed: null, stopped: false, yielding: 0, queue: Promise.resolve(), stdoutRest: "", stderrTail: [],
    startedAt: Date.now(),
  };
  run.before = b;
  const said = { session: short(run.sessionId), ratingKey: run.ratingKey, encode: run.encode, toS: round3(b.toS) };
  try {
    fs.mkdirSync(b.dir, { recursive: true });
    b.proc = spawn(ffmpegPath(), run.fromStart(b.toS), { cwd: b.dir, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    b.failed = err instanceof Error ? err.message : String(err);
    logEvent("FFmpeg", "couldn't start making what was before where the run started", { ...said, why: b.failed });
    return;
  }
  logEvent("FFmpeg", "making what was before where the run started", said);
  b.proc.stdout?.on("data", (d: Buffer) => {
    const lines = (b.stdoutRest + d.toString()).split("\n");
    b.stdoutRest = lines.pop() ?? "";
    for (const line of lines) {
      const name = line.split(",")[0]?.trim();
      if (name) b.queue = b.queue.then(() => measureBefore(run, b, name));
    }
  });
  b.proc.stderr?.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) if (line.trim()) b.stderrTail.push(line.trim().slice(0, 300));
    if (b.stderrTail.length > 30) b.stderrTail.splice(0, b.stderrTail.length - 30);
  });
  b.proc.on("error", (err) => {
    if (!b.stopped && !b.ended) b.failed = `ffmpeg: ${err.message}`;
  });
  b.proc.on("close", (code, signal) => {
    void b.queue.then(() => {
      if (b.stopped) return;
      const last = b.segments[b.segments.length - 1];
      // It has to meet the run's first segment: a hole between them would be
      // jumped, and a stretch twice over is a second to fetch for nothing. A
      // frame or two over is how a copy cut in decode order ends.
      b.failed = b.failed ?? (code !== 0 ? `ffmpeg exited ${code ?? signal}`
        : !last ? "it made nothing"
        : last.end < b.toS - 0.1 || last.end > b.toS + 1 ? `it ended at ${round3(last.end)} s` : null);
      b.ended = !b.failed;
      logEvent("FFmpeg", b.ended ? "made what was before where the run started" : "couldn't make what was before where the run started", {
        ...said, segments: b.segments.length, tookS: round3((Date.now() - b.startedAt) / 1000),
        ...(b.failed ? { why: b.failed, stderr: b.stderrTail.slice(-3).join(" | ") || "none" } : {}),
      });
    });
  });
}

/** One segment of a Before: measured, and kept for when it is listed. */
async function measureBefore(run: Run, b: Before, name: string): Promise<void> {
  if (b.stopped || b.failed) return;
  const file = path.join(b.dir, path.basename(name));
  let data: Buffer;
  try {
    data = await fs.promises.readFile(file);
  } catch {
    return;
  }
  const span = videoSpan(data);
  if (!span) return;
  // From the start of the film, on the run's clock (measure).
  if (b.clockOffset === null) {
    const filmStart = span.start - COPY_CLOCK_OFFSET_S;
    b.clockOffset = filmStart <= 1 && filmStart >= -30 ? COPY_CLOCK_OFFSET_S : span.start;
  }
  const videoStart = span.start - b.clockOffset;
  // The run has that already.
  if (videoStart >= b.toS - 0.001) return;
  const audioStart = span.audioStart === null ? null : span.audioStart - b.clockOffset;
  b.segments.push({
    path: `${run.baseDir}b${path.basename(name)}`,
    file,
    start: audioStart === null ? videoStart : Math.min(videoStart, audioStart),
    end: span.end - b.clockOffset,
    videoStart,
    audioStart,
    bytes: data.length,
  });
}

/**
 * Whether a restart at `offsetS` can be served from what this run made: the
 * same stream, made from before there to the end of the file. A spare one too.
 */
function servesFrom(run: Run, same: string | null, offsetS: number): boolean {
  if (same === null || run.same !== same || !run.ended || run.failed) return false;
  if (run.stopped && spare.get(run.sessionId) !== run) return false;
  return offsetS >= (run.before?.ended ? 0 : run.segments[0]?.start ?? Infinity);
}

/**
 * A new session of the stream a driver replaces — a seek to before where a
 * stream began starts it again under a new session (Player.tsx) — takes over
 * what the old one made, running or spare, when it is the same stream made
 * that far. Hot Fuzz and 1917 on 22 October: made whole, and never used.
 */
function takeOver(sessionId: string, replaces: string[], same: string | null, offsetS: number): string | null {
  for (const id of replaces) {
    const run = bySession.get(id) ?? spare.get(id);
    if (!run || id === sessionId || !servesFrom(run, same, offsetS)) continue;
    if (spare.get(id) === run) {
      spare.delete(id);
      run.stopped = false;
    } else {
      bySession.delete(id);
      retiredSessions.set(id, Date.now());
    }
    logEvent("FFmpeg", "a new session takes over what the one it replaces made", {
      session: short(sessionId), from: short(id), ratingKey: run.ratingKey,
    });
    run.sessionId = sessionId;
    bySession.set(sessionId, run);
    return rekey(run, offsetS);
  }
  return null;
}

/**
 * A restart into what this session's run has made, served from it: the run
 * under a new key, listed whole — what it skipped first, once that is made —
 * and started where the player asked. Its old key answers 410, as a replaced
 * run's does.
 */
function rekey(run: Run, offsetS: number): string {
  const key = randomUUID();
  const baseDir = `/video/:/transcode/universal/session/${key}/base/`;
  const b = run.before;
  const joined = !!b?.ended && run.segments[0] !== b.segments[0];
  if (joined) {
    // Listed from its picture: a re-encode's copied sound opens a second or so
    // before it (1.2 s in the tests), and what was made before has that sound
    // already. Listed from the sound, it began before the last of those, which
    // went out with a length below zero.
    run.segments[0].start = run.segments[0].videoStart;
    run.segments = [...b!.segments, ...run.segments];
  }
  const moved = (seg: Segment) => {
    seg.path = baseDir + seg.path.slice(seg.path.lastIndexOf("/") + 1);
  };
  run.segments.forEach(moved);
  b?.segments.forEach(moved);
  run.byPath = new Map(run.segments.map((seg) => [seg.path, seg]));
  runs.delete(run.key);
  retired.set(run.key, Date.now());
  logEvent("FFmpeg", "a restart served from what was made", {
    session: short(run.sessionId), ratingKey: run.ratingKey, fromS: offsetS, wasFromS: run.offsetS,
    listedFromS: round3(run.segments[0]?.start ?? 0), joinedBefore: joined, segments: run.segments.length,
  });
  run.key = key;
  run.baseDir = baseDir;
  run.offsetS = offsetS;
  run.positionS = offsetS;
  run.handedOut = false;
  run.targetDuration = MIN_TARGET_DURATION;
  run.lastAlive = Date.now();
  runs.set(key, run);
  return key;
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Start a run for `sessionId` — replacing the one it has — with ffmpeg
 * `args` (plan.ts), and wait for its first segment. Fails without one in
 * FIRST_SEGMENT_TIMEOUT_MS, or if ffmpeg dies first, so the caller can leave
 * the stream to Plex. A restart into what the session's run has made of the
 * same stream is served from that instead (rekey).
 */
export async function startFfmpegRun(o: {
  sessionId: string;
  ratingKey: string;
  codec: string;
  encode?: boolean;
  /** A copy's: the file's average. A re-encode's: its video target and its sound. */
  targetKbps?: number | null;
  offsetS: number;
  args: string[];
  /** The same stream's arguments from the start of the film up to `toS`: see Before. */
  fromStart?: (toS: number) => string[];
  /** The sessions of the streams its driver has, which this one replaces: see takeOver. */
  replaces?: string[];
}): Promise<{ ok: true; key: string } | { ok: false; why: string }> {
  const previous = bySession.get(o.sessionId);
  const same = o.fromStart ? o.fromStart(0).join("\n") : null;
  if (previous && servesFrom(previous, same, o.offsetS)) return { ok: true, key: rekey(previous, o.offsetS) };
  const taken = previous ? null : takeOver(o.sessionId, o.replaces ?? [], same, o.offsetS);
  if (taken) return { ok: true, key: taken };
  if (previous) stopRun(previous, "restarted");
  const key = randomUUID();
  const dir = path.join(CACHE_DIR, o.sessionId.replace(/[^\w-]/g, "_"), key);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch (err) {
    return { ok: false, why: `couldn't make ${dir}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const run: Run = {
    key, sessionId: o.sessionId, ratingKey: o.ratingKey, codec: o.codec, encode: !!o.encode,
    targetKbps: o.targetKbps && o.targetKbps > 0 ? o.targetKbps : null, averageKbps: null, dir,
    baseDir: `/video/:/transcode/universal/session/${key}/base/`,
    fromStart: o.fromStart ?? null, same, before: null,
    offsetS: o.offsetS, proc: null, paused: false, yielding: 0, speedSaid: false, stopped: false,
    segments: [], byPath: new Map(), clockOffset: null, ended: false, failed: null,
    targetDuration: MIN_TARGET_DURATION, handedOut: false, positionS: o.offsetS,
    waiters: [], queue: Promise.resolve(), stdoutRest: "", stderrTail: [], gpuAtStart: null, gpuLately: null,
    startedAt: Date.now(), lastAlive: Date.now(),
  };
  runs.set(key, run);
  bySession.set(o.sessionId, run);

  let proc: ChildProcess;
  try {
    proc = spawn(ffmpegPath(), o.args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    stopRun(run, "couldn't start ffmpeg");
    return { ok: false, why: `couldn't start ffmpeg: ${err instanceof Error ? err.message : String(err)}` };
  }
  run.proc = proc;
  void giveWay(run);
  proc.stdout?.on("data", (d: Buffer) => {
    const text = run.stdoutRest + d.toString();
    const lines = text.split("\n");
    run.stdoutRest = lines.pop() ?? "";
    for (const line of lines) {
      const name = line.split(",")[0]?.trim();
      if (name) run.queue = run.queue.then(() => measure(run, name));
    }
  });
  proc.stderr?.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (line.trim()) run.stderrTail.push(line.trim().slice(0, 300));
    }
    if (run.stderrTail.length > 30) run.stderrTail.splice(0, run.stderrTail.length - 30);
  });
  proc.on("error", (err) => fail(run, `ffmpeg: ${err.message}`));
  proc.on("close", (code, signal) => {
    void run.queue.then(() => {
      if (run.stopped || run.failed) return;
      if (code === 0) {
        run.ended = true;
        logEvent("FFmpeg", "reached the end of the file", {
          session: short(run.sessionId), encode: run.encode, segments: run.segments.length,
          endS: round3(edgeOf(run)), ...speed(run),
          ...(run.gpuLately ? use(run, run.gpuLately) : {}),
        });
        notify(run);
        startBefore(run);
      } else {
        fail(run, `ffmpeg exited ${code ?? signal}`);
      }
    });
  });

  // The first segment, or the reason there won't be one.
  const deadline = Date.now() + FIRST_SEGMENT_TIMEOUT_MS;
  while (run.segments.length === 0 && !run.failed && !run.ended && !run.stopped && Date.now() < deadline) {
    await Promise.race([new Promise<void>((r) => run.waiters.push(r)), sleep(250)]);
  }
  if (run.segments.length === 0) {
    const why = run.failed ?? (run.ended ? "ffmpeg wrote nothing" : `no segment in ${FIRST_SEGMENT_TIMEOUT_MS / 1000} s`);
    if (!run.stopped) stopRun(run, "never started");
    return { ok: false, why: `${why}${run.stderrTail.length ? ` (${run.stderrTail.slice(-2).join(" | ")})` : ""}` };
  }
  return { ok: true, key };
}

/** Re-encodes running — a paused one included, not one that has ended — but
 *  for this session's own, which a start replaces. One that has made the
 *  whole film frees its slot. */
export function ffmpegEncodesRunning(exceptSession?: string): number {
  let n = 0;
  for (const run of runs.values()) if (run.encode && !run.ended && !run.failed && run.sessionId !== exceptSession) n++;
  return n;
}

/** Whether this session's stream is made here, by ffmpeg. */
export function isFfmpegSession(sessionId: string): boolean {
  return bySession.has(sessionId);
}

/**
 * Whether this session's stream is or was made here: one stopped already is
 * still nothing of Plex's. Stopped twice — its owner's page and the room both
 * stop a stream left behind — the second went to Plex, which answered 404 to a
 * "stopped" for ratingKey 0.
 */
export function ffmpegSessionKnown(sessionId: string): boolean {
  return bySession.has(sessionId) || retiredSessions.has(sessionId);
}

/** Whether a URL's key is a run's of this engine. */
export function isFfmpegKey(key: string): boolean {
  return runs.has(key);
}

/** Whether a key was one of this engine's, now ended: answered 410. */
export function ffmpegKeyRetired(key: string): boolean {
  return retired.has(key);
}

/** Whether any run is playing this title. */
export function ffmpegTitleStreaming(ratingKey: string): boolean {
  for (const run of runs.values()) if (run.ratingKey === ratingKey) return true;
  return false;
}

/** Whether this title has died in ffmpeg often enough lately to leave it to Plex. */
export function ffmpegRefused(ratingKey: string): boolean {
  const times = (crashes.get(ratingKey) ?? []).filter((t) => Date.now() - t < CRASH_WINDOW_MS);
  return times.length >= CRASHES_TO_REFUSE;
}

/**
 * What one viewer of this session's stream downloads, kbps, for the upload
 * budget (routes/qbt-manager.ts): one figure for the stream — a copy's file
 * average, a re-encode's video target and its sound — see stream-bandwidth.ts.
 * Plex has none to give: Phase 0 (17 October) saw a stream made here listed
 * as Direct Play at the file's bitrate, which a re-encode's is nothing like,
 * with no Session — so no bandwidth, and no id to match it by.
 */
export function ffmpegBandwidth(sessionId: string): Bandwidth | null {
  const run = bySession.get(sessionId);
  return run ? streamBandwidth(run) : null;
}

/**
 * A run's playlist — see measured-playlist.ts. Null for no such run, or one
 * that died (the player restarts where it is); "retry" while nothing is
 * listed yet.
 */
export async function ffmpegPlaylist(
  key: string,
  urlFor: (path: string, bytes: number) => string,
): Promise<string | "retry" | null> {
  const run = runs.get(key);
  if (!run || run.failed) return null;
  run.lastAlive = Date.now();
  // Every segment written wakes the waiters, so this looks again after each
  // one until READY_SPAN_S (a re-encode's READY_SPAN_ENCODE_S) is listed. A
  // single wait went out at the next segment: on 18 October every re-encode's
  // first playlist still listed one or two, and every start and skip stopped
  // 3 s in.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!ready(run) && !run.stopped && Date.now() < deadline) {
    await Promise.race([new Promise<void>((r) => run.waiters.push(r)), sleep(deadline - Date.now())]);
  }
  if (run.failed || run.stopped) return null;
  const list = published(run);
  if (list.length === 0 && !run.ended) return "retry";
  const { text, targetDuration } = measuredPlaylist({
    segments: run.segments,
    published: list.length,
    offsetS: run.offsetS,
    ended: run.ended,
    targetDuration: run.targetDuration,
    urlFor,
  });
  run.targetDuration = targetDuration;
  run.handedOut = true;
  return text;
}

/** A run's segment, from its folder: "gone" once the run has let it go. */
export function ffmpegSegment(key: string, segPath: string): CopiedSegment | "gone" | null {
  const run = runs.get(key);
  const seg = run?.byPath.get(segPath);
  if (!run || !seg) return null;
  run.lastAlive = Date.now();
  // In memory while rooms are on it (hot-segments.ts); its file otherwise.
  const kept = hotSegment(seg.file);
  if (kept) return { bytes: kept.length, read: async (start, end) => kept.subarray(start, end) };
  if (!fs.existsSync(seg.file)) return "gone";
  return {
    bytes: seg.bytes,
    read: async (start, end) => {
      const handle = await fs.promises.open(seg.file, "r");
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

/** Where this session's run is with what it skipped (Before), for the tests:
 *  "none", "making", "made", or why it couldn't. */
export function ffmpegBeforeState(sessionId: string): string {
  const b = bySession.get(sessionId)?.before;
  return !b ? "none" : b.ended ? "made" : b.failed ? `failed: ${b.failed}` : "making";
}

/** Where the watcher is, from the driver's pings and the room's clock. */
export function updateFfmpegPosition(sessionId: string, positionS: number): void {
  const run = bySession.get(sessionId);
  if (!run || !Number.isFinite(positionS) || positionS < 0) return;
  run.positionS = positionS;
  run.lastAlive = Date.now();
  throttle(run);
}

/** The room's keep-alive: false once the stream is gone, so it stops asking. */
export function keepFfmpegAlive(sessionId: string): boolean {
  const run = bySession.get(sessionId);
  if (!run) return false;
  run.lastAlive = Date.now();
  return true;
}

export function stopFfmpegSession(sessionId: string, why = "stopped"): void {
  const run = bySession.get(sessionId);
  if (run) stopRun(run, why, true);
}

export function stopAllFfmpegSessions(why = "stopped"): number {
  const all = [...bySession.values()];
  for (const run of all) stopRun(run, why);
  return all.length;
}

// What every other stop missed; the pause catching up with a watcher whose
// pings stopped coming while the room's clock went on; what a re-encode
// has used so far, for when it ends; and a Before that waited for a slot.
setInterval(() => {
  const now = Date.now();
  for (const run of [...runs.values()]) {
    if (now - run.lastAlive > IDLE_MS) {
      stopRun(run, "nobody asked for it in 10 minutes");
      continue;
    }
    throttle(run);
    if (run.gpuAtStart && run.proc?.pid && run.proc.exitCode === null) run.gpuLately = sampleGpu(run.proc.pid) ?? run.gpuLately;
    // A re-encode's, once an encode slot is free.
    if (run.ended && !run.before) startBefore(run);
  }
}, 15_000).unref();
