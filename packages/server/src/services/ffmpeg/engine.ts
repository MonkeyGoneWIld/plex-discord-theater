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
 * The run stays LEAD_S ahead of whoever is watching and is paused there
 * (SIGSTOP), so a film isn't read to its end for nobody; it carries on once
 * they catch up. Everything it wrote is kept, on disk in STREAM_CACHE_DIR,
 * until the stream ends, so going back is served from here. A run that dies
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
import { ffmpegPath } from "./config.js";
import { cpuUse, gpuUse, readUse, sampleGpu, type GpuSample } from "./gpu-use.js";
import { COPY_CLOCK_OFFSET_S } from "./plan.js";

/** How far past the watcher a run gets before it is paused — as a Plex copy is
 *  measured (direct-stream.ts), past the player's own 150 s window. */
const LEAD_S = Number(process.env.PDT_FFMPEG_LEAD_S) || 180;
/** And how close they come before it carries on. */
const RESUME_S = LEAD_S - Math.min(30, LEAD_S / 2);
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
  dir: string;
  baseDir: string;
  /** Where the run was asked to start, film time. */
  offsetS: number;
  proc: ChildProcess | null;
  /** SIGSTOPped: far enough ahead of the watcher. */
  paused: boolean;
  /** Paused at least once: how fast it got there has been said. */
  pausedOnce: boolean;
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

/** Pause the run far enough ahead of the watcher; carry on once they near it. */
function throttle(run: Run): void {
  // No SIGSTOP on Windows, where only development runs; the run goes on to the end there.
  if (process.platform === "win32" || !run.proc || run.proc.exitCode !== null || run.stopped) return;
  const edge = run.segments[run.segments.length - 1]?.end ?? run.offsetS;
  try {
    if (!run.paused && edge > run.positionS + LEAD_S) {
      run.proc.kill("SIGSTOP");
      run.paused = true;
      if (!run.pausedOnce) {
        run.pausedOnce = true;
        // How fast it got there, never paused before: on Intel's GPU a 1080p
        // re-encode runs many times faster than the film plays, on the CPU a
        // few. From here on it runs in short bursts as the watcher nears.
        const madeS = edge - (run.segments[0]?.start ?? run.offsetS);
        const tookS = (Date.now() - run.startedAt) / 1000;
        logEvent("FFmpeg", "far enough ahead of the watcher, paused until they near it", {
          session: short(run.sessionId), encode: run.encode, aheadS: round3(edge - run.positionS),
          madeS: round3(madeS), tookS: round3(tookS), speedX: Math.round((madeS / Math.max(tookS, 0.001)) * 10) / 10,
          ...(run.encode && run.proc.pid ? use(run, sampleGpu(run.proc.pid)) : {}),
        });
      }
    } else if (run.paused && edge < run.positionS + RESUME_S) {
      run.proc.kill("SIGCONT");
      run.paused = false;
    }
  } catch {
    // Gone already.
  }
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
    key, sessionId: o.sessionId, ratingKey: o.ratingKey, codec: o.codec, encode: !!o.encode, dir,
    baseDir: `/video/:/transcode/universal/session/${key}/base/`,
    offsetS: o.offsetS, proc: null, paused: false, pausedOnce: false, stopped: false,
    segments: [], byPath: new Map(), clockOffset: null, ended: false, failed: null,
    targetDuration: MIN_TARGET_DURATION, handedOut: false, positionS: o.offsetS,
    waiters: [], queue: Promise.resolve(), stdoutRest: "", stderrTail: [], gpuAtStart: null,
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
          session: short(run.sessionId), segments: run.segments.length,
          endS: round3(run.segments[run.segments.length - 1]?.end ?? run.offsetS),
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
 *  for this session's own, which a start replaces. */
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

// What every other stop missed; and the pause catching up with a watcher
// whose pings stopped coming while the room's clock went on.
setInterval(() => {
  const now = Date.now();
  for (const run of [...runs.values()]) {
    if (now - run.lastAlive > IDLE_MS) stopRun(run, "nobody asked for it in 10 minutes");
    else throttle(run);
  }
}, 15_000).unref();
