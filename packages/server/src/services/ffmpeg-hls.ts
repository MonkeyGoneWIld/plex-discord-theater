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

/**
 * Hardware-accelerated H.264 encoding. "none" = software libx264 (the portable
 * default). "vaapi" and "qsv" both offload the encode to an Intel QuickSync (or
 * other VAAPI) GPU — on Linux QuickSync is reached through VAAPI, so "vaapi" is
 * the recommended Intel path and "qsv" the Intel-native oneVPL/MediaSDK one.
 * Decoding stays in software so the subtitle-burn filter has frames it can draw
 * on; only the CPU-heavy encode moves to the GPU.
 */
type HwAccel = "none" | "vaapi" | "qsv";
const HWACCEL: HwAccel = ((): HwAccel => {
  const v = (process.env.HWACCEL || "none").toLowerCase();
  return v === "vaapi" || v === "qsv" ? v : "none";
})();
const HWACCEL_DEVICE = process.env.HWACCEL_DEVICE || "/dev/dri/renderD128";
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
/** Extracted subtitle file (relative to a session's tmp dir) for burn-in. */
const SUBS_FILE = "subs.ass";

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
/**
 * Debounce window for coalescing restarts. A seek makes hls.js request several
 * adjacent segments within a few ms; collecting them before starting one encoder
 * (at the lowest index) stops the requests from each spawning a competing ffmpeg
 * that kills the others.
 */
const RESTART_COALESCE_MS = 150;
/** How often the wait loop re-checks for a produced segment. */
const POLL_INTERVAL_MS = 120;
/**
 * After a restart, forward requests (idx at/after the new run's start) wait for
 * the fresh encoder to advance rather than triggering another restart — even if
 * its head hasn't caught up to them yet. Without this, a request that lands while
 * the run is still spinning up sees a low head, restarts again, and kills the run
 * the sibling requests are waiting on; that ping-pong is what stalled seeks.
 */
const RESTART_GRACE_MS = 6_000;

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
  /** When the current run was (re)started — used for the post-restart grace. */
  lastRestartAt: number;
  /** Selected audio ordinal among audioStreams. */
  audioOrdinal: number;
  /** "burn" burns subOrdinal into the video; "none" omits subtitles. */
  subMode: "burn" | "none";
  /** Selected subtitle ordinal among subStreams (for burn). */
  subOrdinal: number;
  /** The in-flight subtitle-extraction process, or null. */
  subExtractProc: ChildProcess | null;
  lastAccess: number;
  /** The in-flight restart (spawn), so requests wait on it rather than racing. */
  restarting: Promise<void> | null;
  /**
   * Coalescing state for restarts. When a seek makes hls.js request a cluster of
   * segments at once, each one that needs a restart records its index here; after
   * a short debounce ONE restart fires at the minimum, so the requests share a
   * single encoder instead of each spawning one that kills the others.
   */
  pendingRestartMin: number;
  pendingRestart: Promise<void> | null;
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
    lastRestartAt: 0,
    audioOrdinal: defaultOrdinal(source.audioStreams),
    subMode: "none",
    subOrdinal: defaultOrdinal(source.subStreams),
    subExtractProc: null,
    lastAccess: Date.now(),
    restarting: null,
    pendingRestartMin: Infinity,
    pendingRestart: null,
  };
  applySelection(s, sel);
  sessions.set(sessionId, s);

  logEvent("FFmpeg", "session created", {
    session: sessionId.substring(0, 8),
    ratingKey,
    durationS: Math.round(source.durationSec),
    segments: s.segmentCount,
    encoder: HWACCEL === "none" ? "libx264" : `h264_${HWACCEL}`,
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
  // Cancel any in-flight extraction: the selection changed, so its output would
  // be for the wrong track (and would clash on the same file as the re-extract).
  killSubExtraction(s);
  s.windowStartSeg = 0;
  s.procExited = false;
  s.pendingRestartMin = Infinity;
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
 * Coalesced restart. Records `idx` as a candidate start point and, after a short
 * debounce, fires a single restart at the lowest index requested in that window.
 * Concurrent callers all await the same promise, so a seek's burst of segment
 * requests produces exactly one encoder run — no competing spawns killing each
 * other (which stranded playback in an endless "encoder ended" loop).
 */
function requestRestart(s: Session, idx: number): Promise<void> {
  s.pendingRestartMin = Math.min(s.pendingRestartMin, idx);
  if (!s.pendingRestart) {
    s.pendingRestart = (async () => {
      await sleep(RESTART_COALESCE_MS);
      const target = s.pendingRestartMin;
      s.pendingRestartMin = Infinity;
      s.pendingRestart = null;
      const run = restartAt(s, target);
      s.restarting = run;
      try {
        await run;
      } finally {
        if (s.restarting === run) s.restarting = null;
      }
    })();
  }
  return s.pendingRestart;
}

/**
 * Return the on-disk path to segment `idx`, starting or restarting ffmpeg as
 * needed. A single loop unifies "wait for the running encoder to reach it" and
 * "move the encoder here": it never spawns a restart while one is already in
 * flight, so overlapping requests after a seek converge on one run instead of
 * thrashing. Rejects if the segment can't be produced within the time budget.
 */
export async function ensureSegment(sessionId: string, idx: number): Promise<string> {
  const s = sessions.get(sessionId);
  if (!s) throw new Error(`No session ${sessionId}`);
  s.lastAccess = Date.now();

  const p = segPath(s, idx);
  const deadline = Date.now() + PRODUCE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (existsSync(p)) return p; // produced by this run or a previous one

    // A restart is actively spawning — its target is fixed now, so just wait it out.
    if (s.restarting) {
      await s.restarting.catch(() => {});
      continue;
    }

    const running = s.proc !== null && !s.procExited;
    const head = currentHead(s);
    // The running encoder will reach idx soon when: idx is within tolerance of its
    // advancing head, or — right after a restart, before the head has caught up —
    // idx is within tolerance of the run's start (the run was started for idx's
    // neighbourhood). A far seek satisfies neither and must restart.
    const forwardOfRun = idx >= s.windowStartSeg;
    const nearHead = idx <= head + FORWARD_TOLERANCE_SEGS;
    const nearRunStart =
      idx <= s.windowStartSeg + FORWARD_TOLERANCE_SEGS &&
      Date.now() - s.lastRestartAt < RESTART_GRACE_MS;
    const canWait = running && forwardOfRun && (nearHead || nearRunStart);

    // Wait only when we can AND no sibling has scheduled a restart — otherwise the
    // encoder we'd wait on is about to be killed, so join the restart instead. All
    // restart-or-join goes through requestRestart, which tracks the cluster minimum
    // so the shared run starts at the lowest requested index.
    if (canWait && !s.pendingRestart) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    await requestRestart(s, idx).catch(() => {});
  }

  throw new Error("timed out producing segment");
}

/** Kill the current encoder (if any) and start a fresh run at `startSeg`. */
async function restartAt(s: Session, startSeg: number): Promise<void> {
  killProc(s);
  s.windowStartSeg = startSeg;
  s.lastRestartAt = Date.now();
  const startT = startSeg * SEG_SECONDS;

  // Kick subtitle extraction if needed, but never block the encoder on it — the
  // stream starts (subtitle-less) immediately and picks the burn up once ready.
  if (s.subMode === "burn" && s.source.subStreams.length > 0) {
    kickSubExtraction(s);
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
    // A restart may have already replaced us; a killed run's exit fires
    // asynchronously and must NOT stamp procExited onto the new encoder — doing
    // so made the session read as "not running" and thrash into more restarts.
    if (s.proc !== proc) return;
    s.procExited = true;
    s.proc = null;
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
    if (s.proc !== proc) return;
    s.procExited = true;
    s.proc = null;
    logEvent("FFmpeg", "spawn error", { session: s.sessionId.substring(0, 8), err: String(err) });
  });
}

/**
 * Extract the selected subtitle track to a local file, once, in the background.
 *
 * Reading an embedded subtitle stream out of the source is slow over HTTP (ffmpeg
 * has to demux the whole file for the sparse subtitle packets), so this must NOT
 * block the encoder — doing that made a burn-in stream "load forever" before the
 * first frame. Instead the encode starts without subtitles and, when extraction
 * finishes, we restart the current run so the burn picks up. The track is
 * extracted with its original absolute timestamps, which -copyts on the encoder
 * makes line up at any seek position — so it's extracted just once, not per seek.
 */
function kickSubExtraction(s: Session): void {
  const subPath = path.join(s.tmpDir, SUBS_FILE);
  if (s.subExtractProc || existsSync(subPath)) return;
  const args = [
    "-nostdin", "-loglevel", "error", "-y",
    "-i", s.source.inputUrl,
    "-map", `0:s:${s.subOrdinal}`,
    "-c:s", "ass",
    SUBS_FILE,
  ];
  if (DEBUG) console.log("[FFmpeg] extracting subtitles", s.sessionId.substring(0, 8), "sub ordinal", s.subOrdinal);
  const proc = spawn(FFMPEG_PATH, args, { cwd: s.tmpDir, stdio: "ignore" });
  s.subExtractProc = proc;
  const done = () => {
    // A reset (track change) or stop may have superseded this extraction.
    if (s.subExtractProc !== proc) return;
    s.subExtractProc = null;
    if (!sessions.has(s.sessionId) || s.subMode !== "burn" || !existsSync(subPath)) return;
    if (DEBUG) console.log("[FFmpeg] subtitles ready, restarting to burn", s.sessionId.substring(0, 8));
    // Re-encode from the current window so forward segments carry the burn.
    void requestRestart(s, s.windowStartSeg);
  };
  proc.on("exit", done);
  proc.on("error", done);
}

/** Kill any in-flight subtitle extraction for a session. */
function killSubExtraction(s: Session): void {
  const proc = s.subExtractProc;
  if (!proc) return;
  s.subExtractProc = null;
  try {
    proc.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * Video-codec args for the current HWACCEL mode: the device-init flags that go
 * *before* the input, the filter-chain suffix that lands the frames where the
 * encoder wants them, and the `-c:v …` encoder args. Software decode is kept in
 * every mode so the (software) subtitle-burn filter has frames to draw on.
 */
function videoEncodeParts(): { preInput: string[]; vfSuffix: string; encoder: string[] } {
  const bv = `${VIDEO_BITRATE_KBPS}k`;
  const peak = `${VIDEO_PEAK_BITRATE_KBPS}k`;
  const bufsize = `${VIDEO_PEAK_BITRATE_KBPS * 2}k`;

  switch (HWACCEL) {
    case "vaapi":
      return {
        preInput: ["-vaapi_device", HWACCEL_DEVICE],
        // Upload the (software-filtered) frames to the GPU as NV12 surfaces.
        vfSuffix: ",format=nv12,hwupload",
        // No forced_idr option here — h264_vaapi has none; it already emits an
        // IDR at each -force_key_frames point, which keeps segments independent.
        encoder: [
          "-c:v", "h264_vaapi", "-profile:v", "high",
          "-b:v", bv, "-maxrate", peak, "-bufsize", bufsize,
        ],
      };
    case "qsv":
      return {
        preInput: ["-init_hw_device", `qsv=hw:${HWACCEL_DEVICE}`, "-filter_hw_device", "hw"],
        vfSuffix: ",hwupload=extra_hw_frames=64,format=qsv",
        encoder: [
          "-c:v", "h264_qsv", "-preset", FFMPEG_PRESET, "-profile:v", "high",
          // qsv honours -force_key_frames only when it's allowed to force IDRs.
          "-forced_idr", "1",
          "-b:v", bv, "-maxrate", peak, "-bufsize", bufsize,
        ],
      };
    default:
      return {
        preInput: [],
        vfSuffix: "",
        encoder: [
          "-c:v", "libx264", "-preset", FFMPEG_PRESET, "-profile:v", "high", "-level", "4.1",
          "-pix_fmt", "yuv420p",
          "-b:v", bv, "-maxrate", peak, "-bufsize", bufsize,
        ],
      };
  }
}

/** Assemble the ffmpeg argv for one run starting at segment `startSeg` (time `startT`). */
function buildFfmpegArgs(s: Session, startSeg: number, startT: number): string[] {
  const { preInput, vfSuffix, encoder } = videoEncodeParts();

  // Cap at 1080p; -2 keeps aspect and an even height. Escape the min() comma so
  // it isn't read as a filter separator. Software filters (scale, subtitle burn)
  // run first, then vfSuffix hands the result to the GPU when hardware encoding.
  let vf = "scale=min(1920\\,iw):-2";
  // Burn subtitles only once the track has been extracted (see kickSubExtraction).
  // Extraction is slow over HTTP and runs in the background, so early segments
  // play without subtitles rather than blocking the whole stream on it.
  if (s.subMode === "burn" && existsSync(path.join(s.tmpDir, SUBS_FILE))) {
    vf += `,subtitles=${SUBS_FILE}`; // resolved relative to cwd (the session tmp dir)
  }
  vf += vfSuffix;

  return [
    "-nostdin", "-loglevel", "warning", "-y",
    ...preInput,
    // Input-side seek: fast. -copyts keeps the source timestamps, so each segment
    // carries its true, absolute movie-time PTS. That is what lets a post-seek
    // segment slot into the whole-timeline playlist at the right place — without
    // it every run restarts PTS at 0 and the player can't position anything past
    // the first run, so seeks "load forever" and never play. It also makes the
    // absolute-time burned subtitles line up at any seek.
    "-ss", String(startT),
    "-i", s.source.inputUrl,
    "-copyts",
    "-map", "0:v:0",
    "-map", `0:a:${s.audioOrdinal}`,
    ...encoder,
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
  killSubExtraction(s);
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
