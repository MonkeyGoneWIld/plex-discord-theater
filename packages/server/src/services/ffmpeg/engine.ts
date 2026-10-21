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
 * stream ends, so going back is served from here. A run that dies
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
import { ffmpegPath, lookaheadS } from "./config.js";
import { cpuUse, gpuUse, readUse, sampleGpu, type GpuSample } from "./gpu-use.js";
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
  const held = [...runs.values()].filter((o) => o !== run && !o.paused && !o.stopped && !o.ended && !o.failed &&
    o.proc?.exitCode === null && (o.yielding > 0 || edgeOf(o) > o.positionS + GIVE_WAY_AHEAD_S));
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
    throttle(o);
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
  throttle(run);
  notify(run);
}

function stopRun(run: Run, why: string): void {
  // Before it goes, while its files are open.
  const used = run.gpuAtStart && run.proc?.pid && run.proc.exitCode === null ? use(run, sampleGpu(run.proc.pid)) : null;
  run.stopped = true;
  try {
    run.proc?.kill("SIGKILL");
  } catch {
    // Gone already.
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
  void fs.promises.rm(run.dir, { recursive: true, force: true }).catch(() => {});
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Start a run for `sessionId` — replacing the one it has — with ffmpeg
 * `args` (plan.ts), and wait for its first segment. Fails without one in
 * FIRST_SEGMENT_TIMEOUT_MS, or if ffmpeg dies first, so the caller can leave
 * the stream to Plex.
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
}): Promise<{ ok: true; key: string } | { ok: false; why: string }> {
  const previous = bySession.get(o.sessionId);
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
  if (run) stopRun(run, why);
}

export function stopAllFfmpegSessions(why = "stopped"): number {
  const all = [...bySession.values()];
  for (const run of all) stopRun(run, why);
  return all.length;
}

// What every other stop missed; the pause catching up with a watcher whose
// pings stopped coming while the room's clock went on; and what a re-encode
// has used so far, for when it ends.
setInterval(() => {
  const now = Date.now();
  for (const run of [...runs.values()]) {
    if (now - run.lastAlive > IDLE_MS) {
      stopRun(run, "nobody asked for it in 10 minutes");
      continue;
    }
    throttle(run);
    if (run.gpuAtStart && run.proc?.pid && run.proc.exitCode === null) run.gpuLately = sampleGpu(run.proc.pid) ?? run.gpuLately;
  }
}, 15_000).unref();
