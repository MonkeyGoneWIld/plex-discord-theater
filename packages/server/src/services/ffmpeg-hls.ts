/**
 * ffmpeg-based HLS session manager.
 *
 * Replaces Plex's universal transcoder. For each streaming session (keyed by the
 * client-minted UUID, same id the sync layer shares across a room) we run our own
 * ffmpeg, reading the source over Plex's direct-file HTTP URL and producing
 * MPEG-TS HLS segments on disk.
 *
 * The model is JIT (just-in-time) whole-timeline segmenting, à la Jellyfin: the
 * route hands the client a VOD playlist covering the entire runtime up front
 * (pure arithmetic — no ffmpeg yet), and each segment request lazily ensures an
 * ffmpeg process is producing the requested index. A seek is therefore just the
 * client requesting a different segment; when that index falls outside the
 * running encoder's window we transparently kill and restart ffmpeg at that
 * point. The client sees a stable playlist and instant seeks; it never reloads a
 * manifest or passes an offset.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { plexUrl, plexJSON } from "./plex.js";
import { logEvent } from "./logger.js";

const DEBUG = process.env.DEBUG === "1" || process.env.NODE_ENV !== "production";

/** Parse a positive-integer env var, falling back to a default. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
const FFMPEG_PRESET = process.env.FFMPEG_PRESET || "veryfast";
/** Segment length in seconds — the unit of the whole-timeline playlist. */
const SEG_SECONDS = envInt("SEG_SECONDS", 4);
/** One full 1080p encode per session; cap how many run at once. */
const MAX_SESSIONS = envInt("MAX_TRANSCODE_SESSIONS", 4);
const VIDEO_BITRATE_KBPS = envInt("VIDEO_BITRATE_KBPS", 12000);
const VIDEO_PEAK_BITRATE_KBPS = envInt(
  "VIDEO_PEAK_BITRATE_KBPS",
  Math.max(20000, VIDEO_BITRATE_KBPS),
);
/** Where per-session segment dirs live. Under /data in the container. */
const HLS_TMP_DIR = process.env.HLS_TMP_DIR || path.join(tmpdir(), "pdt-hls");

/** Reap a session with no segment/ping access for this long. */
const IDLE_TIMEOUT_MS = 90_000;
/** How long we'll wait for the encoder to produce a requested segment. */
const PRODUCE_TIMEOUT_MS = 20_000;
/**
 * If a requested index is at most this many segments ahead of the encoder head
 * we wait for it (the encoder is walking toward it); further ahead — or anywhere
 * behind the current window — we restart at the requested index instead. ~48s.
 */
const FORWARD_TOLERANCE_SEGS = 12;

interface StreamRef {
  id: number;
  selected: boolean;
}

interface SourceInfo {
  inputUrl: string;
  durationSec: number;
  /** Audio streams, in file order; ordinal is the `-map 0:a:<n>` index. */
  audioStreams: StreamRef[];
  /** Subtitle streams, in file order; ordinal is the `-map 0:s:<n>` index. */
  subStreams: StreamRef[];
}

/** Ordinal of the stream Plex marks selected, or 0 (the first) as the default. */
function defaultOrdinal(streams: StreamRef[]): number {
  const i = streams.findIndex((s) => s.selected);
  return i >= 0 ? i : 0;
}

interface Session {
  sessionId: string;
  ratingKey: string;
  source: SourceInfo;
  segmentCount: number;
  tmpDir: string;
  /** ffmpeg for the current run, or null when nothing is encoding. */
  proc: ChildProcess | null;
  /** Whether `proc` has exited (so waiters stop waiting on a dead encoder). */
  procExited: boolean;
  /** `-start_number` of the current run; nothing below this is being produced. */
  windowStartSeg: number;
  /** Selected audio ordinal among audioStreams. */
  audioOrdinal: number;
  /** "burn" burns subOrdinal into the video; "none" omits subtitles. */
  subMode: "burn" | "none";
  /** Selected subtitle ordinal among subStreams (for burn). */
  subOrdinal: number;
  lastAccess: number;
  /** Serializes restarts so a scrub burst coalesces instead of thrashing. */
  restarting: Promise<void> | null;
}

const sessions = new Map<string, Session>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Path to segment `idx` in a session's temp dir. */
function segPath(s: Session, idx: number): string {
  return path.join(s.tmpDir, `${idx}.ts`);
}

/** Resolve a ratingKey to its direct-file URL, duration, and track lists. */
async function resolveSource(ratingKey: string): Promise<SourceInfo> {
  const data = await plexJSON<{
    MediaContainer: {
      Metadata?: Array<{
        duration?: number;
        Media?: Array<{
          Part?: Array<{
            key?: string;
            duration?: number;
            Stream?: Array<{ id: number; streamType: number; selected?: boolean }>;
          }>;
        }>;
      }>;
    };
  }>(`/library/metadata/${ratingKey}`);

  const m = data.MediaContainer.Metadata?.[0];
  const part = m?.Media?.[0]?.Part?.[0];
  if (!part?.key) throw new Error(`No playable part for ratingKey ${ratingKey}`);

  const durationMs = m?.duration ?? part.duration ?? 0;
  if (!durationMs) throw new Error(`No duration for ratingKey ${ratingKey}`);

  const streams = part.Stream ?? [];
  return {
    // plexUrl appends the server token; the Part.key endpoint streams the raw
    // file and honours HTTP Range, which is what lets ffmpeg -ss seek into it.
    inputUrl: plexUrl(part.key),
    durationSec: durationMs / 1000,
    audioStreams: streams.filter((s) => s.streamType === 2).map((s) => ({ id: s.id, selected: !!s.selected })),
    subStreams: streams.filter((s) => s.streamType === 3).map((s) => ({ id: s.id, selected: !!s.selected })),
  };
}

export interface TrackSelection {
  /** Plex stream id of the audio track to use; undefined keeps the current one. */
  audioStreamId?: number;
  /** Plex stream id of the subtitle to burn; undefined + subMode burn keeps current. */
  subtitleStreamId?: number;
  subMode?: "burn" | "none";
}

export interface EnsureResult {
  durationSec: number;
  segSeconds: number;
  segmentCount: number;
}

/**
 * Ensure a session exists (idempotent) and return the numbers the route needs to
 * build the whole-timeline playlist. Does not start ffmpeg — that happens lazily
 * on the first segment request.
 */
export async function ensureSession(
  sessionId: string,
  ratingKey: string,
  sel: TrackSelection = {},
): Promise<EnsureResult> {
  let s = sessions.get(sessionId);

  if (s && s.ratingKey === ratingKey) {
    s.lastAccess = Date.now();
    // A subtitle/audio change on a live session must re-encode: cached segments
    // carry the old burn/track, so discard them and let the next segment request
    // start a fresh run with the new selection.
    if (applySelection(s, sel)) await resetEncode(s);
    return { durationSec: s.source.durationSec, segSeconds: SEG_SECONDS, segmentCount: s.segmentCount };
  }

  // A session pointed at a different title (rare — new item reuses the id): tear
  // the old encode down before repointing it.
  if (s) await stopSession(sessionId);

  if (sessions.size >= MAX_SESSIONS) {
    // Try to make room by reaping anything idle before rejecting.
    reapIdle();
    if (sessions.size >= MAX_SESSIONS) {
      throw new Error(`Transcode session limit reached (${MAX_SESSIONS})`);
    }
  }

  const source = await resolveSource(ratingKey);
  const tmpDir = path.join(HLS_TMP_DIR, sessionId);
  await mkdir(tmpDir, { recursive: true });

  s = {
    sessionId,
    ratingKey,
    source,
    segmentCount: Math.ceil(source.durationSec / SEG_SECONDS),
    tmpDir,
    proc: null,
    procExited: false,
    windowStartSeg: 0,
    audioOrdinal: defaultOrdinal(source.audioStreams),
    subMode: "none",
    subOrdinal: defaultOrdinal(source.subStreams),
    lastAccess: Date.now(),
    restarting: null,
  };
  applySelection(s, sel);
  sessions.set(sessionId, s);

  logEvent("FFmpeg", "session created", {
    session: sessionId.substring(0, 8),
    ratingKey,
    durationS: Math.round(source.durationSec),
    segments: s.segmentCount,
  });
  return { durationSec: source.durationSec, segSeconds: SEG_SECONDS, segmentCount: s.segmentCount };
}

/**
 * Map a track selection (Plex stream ids) onto file-relative ordinals.
 * Returns true when anything actually changed — the caller re-encodes only then.
 */
function applySelection(s: Session, sel: TrackSelection): boolean {
  let changed = false;
  if (sel.subMode && sel.subMode !== s.subMode) {
    s.subMode = sel.subMode;
    changed = true;
  }
  if (sel.audioStreamId != null) {
    const i = s.source.audioStreams.findIndex((a) => a.id === sel.audioStreamId);
    if (i >= 0 && i !== s.audioOrdinal) {
      s.audioOrdinal = i;
      changed = true;
    }
  }
  if (sel.subtitleStreamId != null) {
    const i = s.source.subStreams.findIndex((t) => t.id === sel.subtitleStreamId);
    if (i >= 0 && (i !== s.subOrdinal || s.subMode !== "burn")) {
      s.subOrdinal = i;
      s.subMode = "burn";
      changed = true;
    }
  }
  return changed;
}

/**
 * Discard everything a session has produced and stop its encoder, so the next
 * segment request starts a clean run. Used when the track selection changes.
 */
async function resetEncode(s: Session): Promise<void> {
  if (s.restarting) await s.restarting.catch(() => {});
  killProc(s);
  s.windowStartSeg = 0;
  s.procExited = false;
  try {
    for (const name of readdirSync(s.tmpDir)) {
      if (/\.(ts|m3u8|ass)$/.test(name)) await rm(path.join(s.tmpDir, name), { force: true });
    }
  } catch {
    /* dir gone — nothing to clear */
  }
}

/** Highest produced segment index at/after the current window start (−1 if none). */
function currentHead(s: Session): number {
  let head = s.windowStartSeg - 1;
  try {
    for (const name of readdirSync(s.tmpDir)) {
      const m = name.match(/^(\d+)\.ts$/);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (n >= s.windowStartSeg && n > head) head = n;
    }
  } catch {
    /* dir gone — treat as nothing produced */
  }
  return head;
}

/**
 * Return the on-disk path to segment `idx`, starting or restarting ffmpeg as
 * needed. Rejects if the encoder can't produce it in time.
 */
export async function ensureSegment(sessionId: string, idx: number): Promise<string> {
  const s = sessions.get(sessionId);
  if (!s) throw new Error(`No session ${sessionId}`);
  s.lastAccess = Date.now();

  const p = segPath(s, idx);
  if (existsSync(p)) return p; // already produced (this or a previous run)

  // Wait for any in-flight restart to settle, then decide against fresh state.
  if (s.restarting) await s.restarting.catch(() => {});
  if (existsSync(p)) return p;

  const head = currentHead(s);
  const needRestart =
    s.proc === null ||
    s.procExited ||
    idx < s.windowStartSeg ||
    idx > head + FORWARD_TOLERANCE_SEGS;

  if (needRestart) {
    // Coalesce concurrent seek-driven restarts onto one promise.
    const run = restartAt(s, idx);
    s.restarting = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  await waitForFile(s, p);
  return p;
}

/** Kill the current encoder (if any) and start a fresh run at `startSeg`. */
async function restartAt(s: Session, startSeg: number): Promise<void> {
  killProc(s);
  s.windowStartSeg = startSeg;
  const startT = startSeg * SEG_SECONDS;

  if (s.subMode === "burn" && s.source.subStreams.length > 0) {
    await extractSubs(s, startT);
  }

  const args = buildFfmpegArgs(s, startSeg, startT);
  if (DEBUG) console.log("[FFmpeg] start", s.sessionId.substring(0, 8), "seg", startSeg, "@", startT + "s");

  const proc = spawn(FFMPEG_PATH, args, { cwd: s.tmpDir, stdio: ["ignore", "ignore", "pipe"] });
  s.proc = proc;
  s.procExited = false;

  proc.stderr?.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line && DEBUG) console.log("[FFmpeg:%s] %s", s.sessionId.substring(0, 8), line.slice(0, 300));
  });
  proc.on("exit", (code, signal) => {
    s.procExited = true;
    if (s.proc === proc) s.proc = null;
    // A non-zero exit that we didn't signal is a real encode failure worth surfacing.
    if (code && code !== 0 && signal == null) {
      logEvent("FFmpeg", "encoder exited non-zero", {
        session: s.sessionId.substring(0, 8),
        code,
        startSeg,
      });
    }
  });
  proc.on("error", (err) => {
    s.procExited = true;
    if (s.proc === proc) s.proc = null;
    logEvent("FFmpeg", "spawn error", { session: s.sessionId.substring(0, 8), err: String(err) });
  });
}

/**
 * Extract the selected subtitle track, rebased to the run's start, so its event
 * times line up with the (0-based) output timestamps of an `-ss` input seek.
 * Runs synchronously before the encode so `subtitles=subs.ass` resolves.
 */
async function extractSubs(s: Session, startT: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const args = [
      "-nostdin", "-loglevel", "error", "-y",
      "-ss", String(startT),
      "-i", s.source.inputUrl,
      "-map", `0:s:${s.subOrdinal}`,
      "-c:s", "ass",
      "subs.ass",
    ];
    const proc = spawn(FFMPEG_PATH, args, { cwd: s.tmpDir, stdio: "ignore" });
    // Never let a subtitle-extraction failure block playback — resolve either way.
    proc.on("exit", () => resolve());
    proc.on("error", () => resolve());
  });
}

/** Assemble the ffmpeg argv for one run starting at segment `startSeg` (time `startT`). */
function buildFfmpegArgs(s: Session, startSeg: number, startT: number): string[] {
  // Cap at 1080p; -2 keeps aspect and an even height. Escape the min() comma so
  // it isn't read as a filter separator.
  let vf = "scale=min(1920\\,iw):-2";
  if (s.subMode === "burn" && s.source.subStreams.length > 0) {
    vf += ",subtitles=subs.ass"; // resolved relative to cwd (the session tmp dir)
  }

  return [
    "-nostdin", "-loglevel", "warning", "-y",
    // Input-side seek: fast, and (without -copyts) output PTS restart at 0 so the
    // per-segment force_key_frames grid lands on the global segment boundaries.
    "-ss", String(startT),
    "-i", s.source.inputUrl,
    "-map", "0:v:0",
    "-map", `0:a:${s.audioOrdinal}`,
    "-c:v", "libx264", "-preset", FFMPEG_PRESET, "-profile:v", "high", "-level", "4.1",
    "-pix_fmt", "yuv420p",
    "-b:v", `${VIDEO_BITRATE_KBPS}k`,
    "-maxrate", `${VIDEO_PEAK_BITRATE_KBPS}k`,
    "-bufsize", `${VIDEO_PEAK_BITRATE_KBPS * 2}k`,
    // A keyframe on every segment boundary → each segment is independently
    // decodable, so MSE appends cleanly across a seek.
    "-force_key_frames", `expr:gte(t,n_forced*${SEG_SECONDS})`,
    "-vf", vf,
    "-c:a", "aac", "-b:a", "256k", "-ac", "2",
    "-f", "hls",
    "-hls_time", String(SEG_SECONDS),
    "-hls_list_size", "0",
    // temp_file: the final `<n>.ts` only appears once fully written, so a reader
    // never sees a half-flushed segment. independent_segments: no cross-segment deps.
    "-hls_flags", "independent_segments+temp_file",
    "-hls_segment_type", "mpegts",
    "-start_number", String(startSeg),
    "-hls_segment_filename", "%d.ts",
    "internal.m3u8",
  ];
}

/** Poll until segment file `p` exists, or the encoder dies / we time out. */
async function waitForFile(s: Session, p: string): Promise<void> {
  const deadline = Date.now() + PRODUCE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(p)) return;
    if (s.procExited || s.proc === null) {
      // Encoder ended. If it flushed the file on the way out, great; otherwise the
      // index is unreachable (past EOF, or a failed run).
      await sleep(150);
      if (existsSync(p)) return;
      throw new Error("encoder ended before producing segment");
    }
    await sleep(120);
  }
  throw new Error("timed out waiting for segment");
}

/** SIGKILL the current encoder and detach it. */
function killProc(s: Session): void {
  const proc = s.proc;
  if (!proc) return;
  s.proc = null;
  try {
    proc.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * Refresh keep-alive for a session (called by the client ping loop and the
 * server-side room ping). Returns whether the session still exists.
 */
export function pingSession(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  s.lastAccess = Date.now();
  return true;
}

/** Change audio/subtitle selection and drop stale segments so it re-encodes. */
export async function setTracks(sessionId: string, sel: TrackSelection): Promise<void> {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.lastAccess = Date.now();
  if (applySelection(s, sel)) await resetEncode(s);
}

/** The ratingKey a session is playing, or undefined. */
export function getSessionRatingKey(sessionId: string): string | undefined {
  return sessions.get(sessionId)?.ratingKey;
}

/** Kill a session's encoder and delete its segments. Idempotent. */
export async function stopSession(sessionId: string): Promise<void> {
  const s = sessions.get(sessionId);
  if (!s) return;
  sessions.delete(sessionId);
  killProc(s);
  logEvent("FFmpeg", "session stopped", { session: sessionId.substring(0, 8) });
  try {
    await rm(s.tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Tear down every session — used on graceful shutdown. */
export async function stopAllSessions(): Promise<void> {
  await Promise.all([...sessions.keys()].map((id) => stopSession(id)));
}

/** Reap sessions no client has touched recently. */
function reapIdle(): void {
  const cutoff = Date.now() - IDLE_TIMEOUT_MS;
  for (const [id, s] of sessions) {
    if (s.lastAccess < cutoff) {
      logEvent("FFmpeg", "reaping idle session", { session: id.substring(0, 8) });
      void stopSession(id);
    }
  }
}

setInterval(reapIdle, 30_000).unref();
