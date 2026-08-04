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
import { existsSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { plexUrl, plexJSON, plexFetch } from "./plex.js";
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

/**
 * Hardware DECODE (VAAPI only, opt-in via HWACCEL_DECODE=1). Off by default so the
 * proven software-decode path is untouched unless explicitly enabled. When on and
 * HWACCEL=vaapi, the source is decoded on the GPU too — not just encoded — which is
 * what gives a heavy 4K/HEVC source (e.g. Dolby Vision) the headroom to burn
 * subtitles in realtime instead of stuttering. Subtitle drawing (libass / overlay)
 * is a software filter, so a burn round-trips the frames GPU→CPU→GPU
 * (hwdownload → draw → hwupload); with no burn they never leave the GPU. Only vaapi
 * is wired up (the Intel path in use); qsv keeps software decode. Trade-off: if the
 * GPU can't decode a given input codec, ffmpeg errors instead of falling back to
 * software — hence opt-in, so it's flipped and tested per deployment.
 */
const HWDECODE = HWACCEL === "vaapi" &&
  ["1", "true", "yes"].includes((process.env.HWACCEL_DECODE || "").toLowerCase());
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

/**
 * Optional prefix rewrites from Plex's on-disk paths to this container's mount.
 * Plex reports each part's path (Part.file) as *Plex* sees it; when the media
 * library is mounted here at a different location, MEDIA_PATH_MAP rewrites the
 * prefix so ffmpeg can read the file straight off disk (far faster than pulling
 * it over HTTP, especially for subtitle extraction). Format: comma-separated
 * `plexPrefix=>localPrefix` pairs, e.g. "/media=>/mnt/media,/data=>/library".
 * Empty when the mount matches Plex's path (or no mount is used).
 */
const MEDIA_PATH_MAP: Array<[from: string, to: string]> = (process.env.MEDIA_PATH_MAP || "")
  .split(",")
  .map((pair) => pair.split("=>"))
  .filter((parts): parts is [string, string] => parts.length === 2 && parts[0].trim() !== "")
  .map(([from, to]) => [from.trim(), to.trim()]);

/**
 * Resolve a Plex part path to a readable local file, or null when it isn't mounted
 * here. Applies the first matching MEDIA_PATH_MAP prefix (or uses the path as-is)
 * and only returns it if the file actually exists — so a missing/mis-mapped path
 * silently falls back to the HTTP URL rather than failing.
 */
function localMediaPath(partFile?: string): string | null {
  if (!partFile) return null;
  let candidate = partFile;
  for (const [from, to] of MEDIA_PATH_MAP) {
    if (partFile.startsWith(from)) {
      candidate = to + partFile.slice(from.length);
      break;
    }
  }
  return existsSync(candidate) ? candidate : null;
}
/**
 * Format we keep a text subtitle in. ASS/SSA are kept as ASS so their styling and
 * on-screen positioning (PlayResX/Y, fonts, alignment) survive — converting them
 * to SRT drops all of that and libass then renders huge, mispositioned text.
 * Everything else becomes SRT.
 */
function subFormat(codec?: string): "ass" | "srt" {
  const c = (codec ?? "").toLowerCase();
  return c === "ass" || c === "ssa" ? "ass" : "srt";
}
/** The current track's subtitle format for a session. */
function subFmtOf(s: Session): "ass" | "srt" {
  return subFormat(s.source.subStreams[s.subOrdinal]?.codec);
}
/** Subtitle filename (relative to the session tmp dir, which is ffmpeg's cwd). */
function subFileName(s: Session): string {
  return `subs.${subFmtOf(s)}`;
}
function subPartialName(s: Session): string {
  return `subs.partial.${subFmtOf(s)}`;
}
/** Separate partial for the Plex fetch, so it can run alongside extraction without
 *  clobbering the extractor's partial (they race for the same final subs file). */
function subPlexPartialName(s: Session): string {
  return `subs.plex.partial.${subFmtOf(s)}`;
}
/** The background whole-track extraction writes here, then swaps onto the live subs
 *  file once complete — so it never clobbers a head window still being burned. */
function subFullName(s: Session): string {
  return `subs.full.${subFmtOf(s)}`;
}
function subFullPartialName(s: Session): string {
  return `subs.full.partial.${subFmtOf(s)}`;
}

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
  /** Plex codec name, e.g. "srt", "ass", "pgs", "vobsub". */
  codec?: string;
}

/**
 * Image-based subtitle codecs. These can't be extracted to text (.ass) — they're
 * burned in by overlaying the decoded subtitle stream onto the video directly.
 * Text codecs (srt/ass/…) are extracted to a file and drawn by the subtitles filter.
 */
const BITMAP_SUB_CODECS = new Set([
  "pgs", "pgssub", "hdmv_pgs_subtitle",
  "vobsub", "dvdsub", "dvd_subtitle",
  "dvbsub", "dvb_subtitle", "xsub",
]);
function isBitmapSub(codec?: string): boolean {
  return !!codec && BITMAP_SUB_CODECS.has(codec.toLowerCase());
}

/**
 * Text subtitle codecs. Known-text tracks are drawn by the subtitles filter; if we
 * can't obtain the text we must NOT fall back to the bitmap overlay (which can't
 * render text — it just fails and thrashes) — we drop the burn instead.
 */
const TEXT_SUB_CODECS = new Set([
  "srt", "subrip", "ass", "ssa", "mov_text", "text", "webvtt", "vtt", "eia_608", "subviewer",
]);
function isTextSub(codec?: string): boolean {
  return !!codec && TEXT_SUB_CODECS.has(codec.toLowerCase());
}

interface SourceInfo {
  inputUrl: string;
  /** Whether inputUrl is a local file (mounted media) rather than the Plex HTTP URL. */
  local: boolean;
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
  /** The in-flight head/one-shot subtitle-extraction process, or null. */
  subExtractProc: ChildProcess | null;
  /** The in-flight background whole-track extraction process, or null. */
  subFullProc: ChildProcess | null;
  /** Shared promise for preparing the subtitle, so concurrent first-segment
   *  requests block on ONE fetch/extraction rather than each starting their own. */
  subReadyPromise: Promise<void> | null;
  /** The background whole-track extraction, started once and shared. */
  subFullPromise: Promise<boolean> | null;
  /**
   * True once the whole subtitle track is extracted and in place. Until then the
   * burn may be running off a short leading *window* (subCover*), so a huge remux
   * that Plex won't serve and can't be fully demuxed in time still starts subtitled
   * fast; the full track swaps in (and the encoder reloads) when it's ready.
   */
  subFullReady: boolean;
  /** Movie-time span (seconds) the current subs file covers: [start, end). When
   *  subFullReady it's the whole runtime; while windowed it's the head window. */
  subCoverStartSec: number;
  subCoverEndSec: number;
  /** Whether we've already tried the fast Plex subtitle fetch for this track. */
  subFetchAttempted: boolean;
  /** Whether we've already logged a fast-fetch miss (so the poll loop stays quiet). */
  subFetchMissLogged: boolean;
  /** Whether the current encoder run is burning subtitles (for thrash detection). */
  runBurning: boolean;
  /** Set when subtitle burn keeps failing — playback then continues without it. */
  subsDisabled: boolean;
  /**
   * Force the bitmap `overlay` burn path even if the codec looked like text.
   * Set when text extraction fails, so a mislabeled or unrecognised image
   * subtitle still gets a chance before we give up on the burn entirely.
   */
  subForceOverlay: boolean;
  /** Consecutive encoder failures on a subtitle-burning run. */
  subFailCount: number;
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
            /** Path to the file as Plex sees it — used to read the mounted media directly. */
            file?: string;
            duration?: number;
            Stream?: Array<{ id: number; streamType: number; selected?: boolean; codec?: string }>;
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
  // Prefer the file on a local mount when we can reach it — ffmpeg reading off disk
  // is far faster (especially subtitle extraction) than pulling it over HTTP. Fall
  // back to Plex's direct-file URL: plexUrl appends the server token, and the
  // Part.key endpoint streams the raw file honouring HTTP Range so -ss can seek.
  const localPath = localMediaPath(part.file);
  return {
    inputUrl: localPath ?? plexUrl(part.key),
    local: localPath !== null,
    durationSec: durationMs / 1000,
    audioStreams: streams.filter((s) => s.streamType === 2).map((s) => ({ id: s.id, selected: !!s.selected, codec: s.codec })),
    subStreams: streams.filter((s) => s.streamType === 3).map((s) => ({ id: s.id, selected: !!s.selected, codec: s.codec })),
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
    subFullProc: null,
    subReadyPromise: null,
    subFullPromise: null,
    subFullReady: false,
    subCoverStartSec: 0,
    subCoverEndSec: 0,
    subFetchAttempted: false,
    subFetchMissLogged: false,
    runBurning: false,
    subsDisabled: false,
    subForceOverlay: false,
    subFailCount: 0,
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
    decode: HWDECODE ? "hw" : "sw",
    source: source.local ? "local" : "http",
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
  // A newly-selected subtitle track deserves a fresh attempt.
  s.subsDisabled = false;
  s.subForceOverlay = false;
  s.subFetchAttempted = false;
  s.subFetchMissLogged = false;
  s.subFullPromise = null;
  s.subFullReady = false;
  s.subCoverStartSec = 0;
  s.subCoverEndSec = 0;
  s.subFailCount = 0;
  s.windowStartSeg = 0;
  s.procExited = false;
  s.pendingRestartMin = Infinity;
  try {
    for (const name of readdirSync(s.tmpDir)) {
      if (/\.(ts|m3u8|ass|srt)$/.test(name)) await rm(path.join(s.tmpDir, name), { force: true });
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
      // The session may have been stopped during the debounce — don't restart it.
      if (sessions.get(s.sessionId) !== s) return;
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

  // Make the burned subtitle ready BEFORE producing any segment, so playback
  // starts already-subtitled instead of catching the subtitle up later. This
  // blocks the first requests (the client shows its buffering spinner) but is a
  // one-off per session — the result is cached for every later segment and seek.
  // It sits outside the produce-timeout loop below so the wait doesn't count
  // against a segment's own deadline. Passing idx lets a huge file that can't be
  // fully extracted in time start on a short window at the play position.
  await ensureSubtitleReady(s, idx);

  const p = segPath(s, idx);
  const deadline = Date.now() + PRODUCE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    // Bail if the session was stopped mid-loop (its tmp dir is deleted, so any
    // restart would spawn ffmpeg in a missing cwd → ENOENT and thrash). Without
    // this, in-flight loops keep restarting a dead session until their deadline.
    if (sessions.get(sessionId) !== s) throw new Error(`Session ${sessionId} stopped`);
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
  // Never act on a stopped session — stopSession deletes its tmp dir, and spawning
  // ffmpeg with a now-missing cwd throws ENOENT (the loop then retries forever).
  if (sessions.get(s.sessionId) !== s) return;

  // Thrash guard: if the run we're about to replace was burning subtitles and
  // produced nothing, count it. A subtitle ffmpeg can't draw (bad overlay, a
  // codec VAAPI won't take) dies instantly and gets restarted on the next segment
  // request, and because the restart SIGKILLs it the exit-handler never sees a
  // non-zero code — so without this the burn thrashes forever. After a few empty
  // burning runs, drop the burn and let playback continue without it.
  if (s.proc && s.runBurning) {
    if (currentHead(s) < s.windowStartSeg) {
      if (!s.subsDisabled && ++s.subFailCount >= 3) {
        s.subsDisabled = true;
        s.subForceOverlay = false;
        logEvent("FFmpeg", "disabling subtitle burn after repeated empty runs", {
          session: s.sessionId.substring(0, 8),
        });
      }
    } else {
      s.subFailCount = 0; // a burning run that produced output — healthy
    }
  }

  killProc(s);
  s.windowStartSeg = startSeg;
  s.lastRestartAt = Date.now();
  const startT = startSeg * SEG_SECONDS;

  // The subtitle is already prepared by ensureSegment (which blocks on it before
  // any segment request reaches a restart), so we can build the burn args directly.
  const args = buildFfmpegArgs(s, startSeg, startT);
  const wasBurning = burnKind(s) !== "none";
  s.runBurning = wasBurning;
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
    if (code && code !== 0 && signal == null) {
      logEvent("FFmpeg", "encoder exited non-zero", {
        session: s.sessionId.substring(0, 8),
        code,
        startSeg,
      });
      // Safety net: a burning run that keeps failing (a subtitle libav can't
      // draw) must not thrash forever. After a couple of strikes, drop the burn
      // and restart so playback continues without subtitles.
      if (wasBurning && !s.subsDisabled && ++s.subFailCount >= 2) {
        s.subsDisabled = true;
        logEvent("FFmpeg", "disabling subtitle burn after repeated encoder failures", {
          session: s.sessionId.substring(0, 8),
        });
        void requestRestart(s, s.windowStartSeg);
      }
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
 * Fetch the selected text subtitle straight from Plex (fast — Plex serves just
 * the subtitle, no whole-file demux), in its native format so ASS styling is
 * kept. Validates that the payload really is that format (Plex sometimes hands
 * back a converted or empty body); returns whether it produced a usable file.
 */
async function fetchPlexSubtitle(s: Session): Promise<boolean> {
  const sub = s.source.subStreams[s.subOrdinal];
  if (!sub) return false;
  const fmt = subFmtOf(s);
  const sid = s.sessionId.substring(0, 8);
  // Log why the fast path missed only once per session so a poll loop doesn't spam:
  // the first miss is the diagnostic (404 = Plex hasn't extracted the embedded sub
  // yet; empty/not-srt = it handed back something unusable). Later polls stay quiet.
  const bail = (reason: string, extra?: Record<string, unknown>) => {
    if (!s.subFetchMissLogged) {
      s.subFetchMissLogged = true;
      logEvent("FFmpeg", "Plex subtitle fetch missed — will extract", {
        session: sid, stream: sub.id, codec: sub.codec, fmt, reason, ...extra,
      });
    }
    return false;
  };
  try {
    const res = await plexFetch(`/library/streams/${sub.id}.${fmt}`);
    if (!res.ok) return bail("http-status", { status: res.status });
    const text = await res.text();
    if (!text || text.trim().length < 10) return bail("empty-body", { bytes: text.length });
    // Make sure we actually got the format we asked for — an ASS body must carry
    // its script header, or its styling isn't there and we'd rather extract.
    if (fmt === "ass" && !/\[Script Info\]|\bDialogue:/i.test(text)) return bail("not-ass", { bytes: text.length });
    if (fmt === "srt" && !text.includes("-->")) return bail("not-srt", { bytes: text.length });
    const partial = path.join(s.tmpDir, subPlexPartialName(s));
    writeFileSync(partial, text);
    renameSync(partial, path.join(s.tmpDir, subFileName(s)));
    logEvent("FFmpeg", "fetched subtitle from Plex", {
      session: sid, stream: sub.id, codec: sub.codec, fmt, bytes: text.length,
    });
    return true;
  } catch (err) {
    return bail("exception", { err: String(err) });
  }
}

/** Bound on the slow whole-file extraction fallback (a big HTTP demux). */
const SUB_EXTRACT_TIMEOUT_MS = 90_000;

/**
 * Length of the leading window we extract for a fast subtitled start when the whole
 * track can't be obtained quickly. Generous so playback stays inside it until the
 * background whole-track extraction finishes and swaps in.
 */
const SUB_HEAD_WINDOW_SEC = envInt("SUB_HEAD_WINDOW_SEC", 300);
/**
 * How long to wait for the whole-track extraction before falling back to a head
 * window. Normal files finish within this, so they never window or reload — behaviour
 * is unchanged for them.
 */
const SUB_QUICK_BUDGET_MS = envInt("SUB_QUICK_BUDGET_MS", 12_000);

/** Whether the live subs file already covers movie-time `t` (seconds). */
function subCovers(s: Session, t: number): boolean {
  if (!existsSync(path.join(s.tmpDir, subFileName(s)))) return false;
  return s.subFullReady || (t >= s.subCoverStartSec && t < s.subCoverEndSec);
}

/** Mark the whole track in place (covers the entire runtime). */
function markSubFullReady(s: Session): void {
  s.subFullReady = true;
  s.subCoverStartSec = 0;
  s.subCoverEndSec = s.source.durationSec;
}

/**
 * Make the selected text subtitle ready to burn for a run starting at `startSeg`,
 * BLOCKING until the subs covering that point exist, so the first segment we encode
 * is already subtitled. Shared per position so a burst of first-segment requests wait
 * on ONE preparation; loops so a seek that lands outside the current window prepares
 * for its own position. Bitmap / forced-overlay subs are overlaid live and return
 * immediately. If the text can't be obtained the burn is dropped so playback proceeds.
 */
async function ensureSubtitleReady(s: Session, startSeg: number): Promise<void> {
  if (s.subMode !== "burn" || s.subsDisabled) return;
  const sub = s.source.subStreams[s.subOrdinal];
  if (!sub) return;
  if (isBitmapSub(sub.codec) || s.subForceOverlay) return; // overlaid live
  const startT = startSeg * SEG_SECONDS;

  while (!subCovers(s, startT)) {
    if (sessions.get(s.sessionId) !== s) return;
    if (!s.subReadyPromise) {
      s.subReadyPromise = prepareSubtitle(s, startSeg).finally(() => { s.subReadyPromise = null; });
    }
    await s.subReadyPromise.catch(() => {});
    // Prep may have decided the burn can't happen (disabled / handed to overlay).
    if (s.subMode !== "burn" || s.subsDisabled || s.subForceOverlay) return;
    // Nothing usable was produced at all — don't spin; let playback proceed.
    if (!existsSync(path.join(s.tmpDir, subFileName(s))) && !s.subFullReady) return;
  }
}

/** The actual fetch/extract work for a start position, awaited by ensureSubtitleReady. */
async function prepareSubtitle(s: Session, startSeg: number): Promise<void> {
  const sub = s.source.subStreams[s.subOrdinal];
  if (!sub) return;
  const startT = startSeg * SEG_SECONDS;

  // Fast path: Plex serves the whole subtitle directly (sidecar or already-extracted).
  if (!s.subFetchAttempted) {
    s.subFetchAttempted = true;
    if (await fetchPlexSubtitle(s)) { markSubFullReady(s); return; }
  }
  if (subCovers(s, startT)) return;

  // Kick off (once) the background whole-track extraction; it swaps onto the live
  // file and reloads the encoder when done.
  const full = startFullExtraction(s);

  // Give the whole-track extraction a short budget. Normal files land here — done,
  // with no window and no reload.
  const quick = await Promise.race([
    full.then((ok) => (ok ? "ok" : "fail")),
    sleep(SUB_QUICK_BUDGET_MS).then(() => "pending" as const),
  ]);
  if (quick === "ok") return;
  if (quick === "fail") { handleSubUnavailable(s, sub); return; }

  // Slow/huge file (e.g. a 4K remux Plex won't serve): extract a short leading window
  // now for an immediate subtitled start; the background full swaps in + reloads soon.
  if (await extractHeadWindow(s, startT)) return;

  // Couldn't even window it — wait the full extraction out as a last resort.
  if (await full) return;
  handleSubUnavailable(s, sub);
}

/**
 * Start (once, shared) the background whole-track extraction. On success it swaps the
 * complete track onto the live subs file atomically and reloads the running encoder so
 * it burns the full track from here on — replacing any head window that got us started.
 */
function startFullExtraction(s: Session): Promise<boolean> {
  if (s.subFullPromise) return s.subFullPromise;
  s.subFullPromise = (async () => {
    const ok = await runSubtitleExtract(s, {
      out: subFullName(s), partial: subFullPartialName(s), procField: "subFullProc",
    });
    if (sessions.get(s.sessionId) !== s || !ok) return false;
    try {
      renameSync(path.join(s.tmpDir, subFullName(s)), path.join(s.tmpDir, subFileName(s)));
    } catch {
      return false;
    }
    markSubFullReady(s);
    logEvent("FFmpeg", "whole subtitle track ready", { session: s.sessionId.substring(0, 8) });
    requestSubtitleReload(s);
    return true;
  })();
  return s.subFullPromise;
}

/** Extract just the leading window [startT, startT+HEAD) onto the live subs file. */
async function extractHeadWindow(s: Session, startT: number): Promise<boolean> {
  if (s.subFullReady) return true; // full already in place
  const endT = Math.min(startT + SUB_HEAD_WINDOW_SEC, s.source.durationSec);
  const ok = await runSubtitleExtract(s, {
    out: subFileName(s), partial: subPartialName(s), procField: "subExtractProc",
    window: { startT, endT }, guardFullReady: true,
  });
  if (!ok) return false;
  if (!s.subFullReady) {
    s.subCoverStartSec = startT;
    s.subCoverEndSec = endT;
  }
  logEvent("FFmpeg", "subtitle head window ready", {
    session: s.sessionId.substring(0, 8), fromS: Math.round(startT), toS: Math.round(endT),
  });
  return true;
}

/** Restart the running encoder so it picks up the freshly-swapped full subtitle track. */
function requestSubtitleReload(s: Session): void {
  if (s.subMode !== "burn" || s.subsDisabled) return;
  if (!s.proc || s.procExited) return; // nothing running to reload
  if (burnKind(s) === "none") return;
  const target = Math.max(s.windowStartSeg, currentHead(s));
  logEvent("FFmpeg", "reloading encoder for full subtitle track", {
    session: s.sessionId.substring(0, 8), target,
  });
  void requestRestart(s, target);
}

/** Drop the burn (or hand off to the image overlay) when the text can't be obtained. */
function handleSubUnavailable(s: Session, sub: StreamRef): void {
  if (isTextSub(sub.codec)) {
    // Genuinely text but unreadable — the bitmap overlay can't draw text, so drop
    // the burn rather than thrash; playback continues without subtitles.
    s.subsDisabled = true;
    logEvent("FFmpeg", "text subtitle unavailable — disabling burn", {
      session: s.sessionId.substring(0, 8), codec: sub.codec,
    });
  } else {
    // Unknown codec: maybe a mislabeled image sub — let the encode overlay it.
    s.subForceOverlay = true;
    logEvent("FFmpeg", "subtitle extraction failed — trying overlay burn", {
      session: s.sessionId.substring(0, 8), codec: sub.codec,
    });
  }
}

interface SubExtractOpts {
  /** Final subs file to produce (relative to tmp dir). */
  out: string;
  /** Partial written first, then atomically renamed to `out`. */
  partial: string;
  /** Which session field tracks this process (so it can be killed / not clobbered). */
  procField: "subExtractProc" | "subFullProc";
  /** When set, extract only [startT, endT) with absolute (copyts) timestamps. */
  window?: { startT: number; endT: number };
  /** Skip the rename if the whole track landed meanwhile (head must not clobber full). */
  guardFullReady?: boolean;
}

/** Run one ffmpeg subtitle extraction (atomic, timeout-bounded). */
function runSubtitleExtract(s: Session, opts: SubExtractOpts): Promise<boolean> {
  const outPath = path.join(s.tmpDir, opts.out);
  const partialPath = path.join(s.tmpDir, opts.partial);
  const fmt = subFmtOf(s);
  const args = ["-nostdin", "-loglevel", "error", "-y"];
  // Windowed: input-seek + -copyts keeps absolute movie-time stamps (so burned subs
  // still line up under the encode's -copyts) and -to bounds the read to the window,
  // so a huge file is read proportionally instead of end-to-end.
  if (opts.window) args.push("-ss", String(opts.window.startT), "-copyts");
  args.push("-i", s.source.inputUrl, "-map", `0:s:${s.subOrdinal}`, "-c:s", fmt);
  if (opts.window) args.push("-to", String(opts.window.endT));
  args.push(opts.partial);
  logEvent("FFmpeg", "extracting subtitle", {
    session: s.sessionId.substring(0, 8),
    ordinal: s.subOrdinal,
    codec: s.source.subStreams[s.subOrdinal]?.codec,
    // Whether the demux reads off the local mount (~1s) or over Plex HTTP (~20s).
    source: s.source.local ? "local" : "http",
    window: opts.window
      ? `${Math.round(opts.window.startT)}-${Math.round(opts.window.endT)}s`
      : "full",
  });
  return new Promise<boolean>((resolve) => {
    const proc = spawn(FFMPEG_PATH, args, { cwd: s.tmpDir, stdio: "ignore" });
    s[opts.procField] = proc;
    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* gone */ } }, SUB_EXTRACT_TIMEOUT_MS);
    const finish = (code: number | null) => {
      clearTimeout(timer);
      if (s[opts.procField] === proc) s[opts.procField] = null;
      if (code === 0 && existsSync(partialPath)) {
        // A concurrent whole-track commit may have already put the full subs in
        // place — don't overwrite it with a head window.
        if (opts.guardFullReady && s.subFullReady) {
          rm(partialPath, { force: true }).catch(() => {});
          resolve(true);
          return;
        }
        try {
          renameSync(partialPath, outPath);
          resolve(true);
          return;
        } catch { /* fall through */ }
      }
      rm(partialPath, { force: true }).catch(() => {});
      resolve(false);
    };
    proc.on("exit", (code) => finish(code));
    proc.on("error", () => finish(-1));
  });
}

/** Kill any in-flight subtitle extraction (head and background full) for a session. */
function killSubExtraction(s: Session): void {
  for (const field of ["subExtractProc", "subFullProc"] as const) {
    const proc = s[field];
    if (!proc) continue;
    s[field] = null;
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
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
        // With hw decode the device is set up as a named hwaccel device (`va`) that
        // the decoder, filters and encoder all share; without it we only need the
        // encoder's vaapi device. hwDecodeFilterArgs handles the filter chain in the
        // hw-decode case, so vfSuffix is only consumed by the software-decode path.
        preInput: HWDECODE
          ? [
              "-init_hw_device", `vaapi=va:${HWACCEL_DEVICE}`,
              "-hwaccel", "vaapi", "-hwaccel_device", "va",
              "-hwaccel_output_format", "vaapi", "-filter_hw_device", "va",
            ]
          : ["-vaapi_device", HWACCEL_DEVICE],
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

/** Whether a burn should be attempted right now, and how. */
function burnKind(s: Session): "none" | "text" | "bitmap" {
  if (s.subMode !== "burn" || s.subsDisabled) return "none";
  const sub = s.source.subStreams[s.subOrdinal];
  if (!sub) return "none";
  if (isBitmapSub(sub.codec) || s.subForceOverlay) return "bitmap";
  // Text subtitles are only burned once extraction has produced the file.
  return existsSync(path.join(s.tmpDir, subFileName(s))) ? "text" : "none";
}

/**
 * Build the video filter + stream-map args. Scaling is always applied (1080p cap);
 * subtitles are either drawn from the extracted text file (subtitles filter) or,
 * for image subs, overlaid straight from the decoded subtitle stream — which needs
 * a filter_complex and mapping its labelled output instead of `0:v`. `vfSuffix` is
 * the hardware-upload tail (empty for software) appended to whichever chain runs.
 */
function videoFilterArgs(s: Session, vfSuffix: string): string[] {
  if (HWDECODE) return hwDecodeFilterArgs(s);
  const scale = "scale=min(1920\\,iw):-2"; // escape the min() comma
  switch (burnKind(s)) {
    case "bitmap":
      // Overlay the decoded image-subtitle stream onto the video, THEN scale — so
      // a full-res (e.g. 1080p) PGS/VobSub bitmap lines up even when we downscale.
      // No extraction: the sub comes from the same (already-seeked) input demux.
      return [
        "-filter_complex",
        `[0:v][0:s:${s.subOrdinal}]overlay,${scale}${vfSuffix}[vout]`,
        "-map", "[vout]",
      ];
    case "text":
      return ["-map", "0:v:0", "-vf", `${scale},subtitles=${subFileName(s)}${vfSuffix}`];
    default:
      return ["-map", "0:v:0", "-vf", `${scale}${vfSuffix}`];
  }
}

/**
 * Filter chain when the source is decoded on the GPU (HWDECODE). Frames arrive as
 * VAAPI surfaces. Without a burn they stay on the GPU (scale_vaapi → encoder). For a
 * burn the sub filter is software, so we normalise/downscale on the GPU, hwdownload,
 * draw, then hwupload back for the encoder. scale_vaapi's `format=nv12` also folds
 * 10-bit HDR (p010) down to 8-bit on the GPU so the download is a clean nv12 frame.
 */
function hwDecodeFilterArgs(s: Session): string[] {
  // GPU downscale (aspect kept via -2) + convert to nv12.
  const scaleVaapi = "scale_vaapi=w=min(1920\\,iw):h=-2:format=nv12";
  switch (burnKind(s)) {
    case "bitmap":
      // Convert to nv12 on the GPU at native res (no resize), download, overlay the
      // decoded image sub so it lines up full-size, THEN downscale in software and
      // re-upload for the encoder — mirrors the software path's overlay-before-scale.
      return [
        "-filter_complex",
        `[0:v]scale_vaapi=format=nv12,hwdownload,format=nv12[v];` +
          `[v][0:s:${s.subOrdinal}]overlay,scale=min(1920\\,iw):-2,format=nv12,hwupload[vout]`,
        "-map", "[vout]",
      ];
    case "text":
      // Downscale on the GPU, download, let libass draw at 1080p (cheap), re-upload.
      return [
        "-map", "0:v:0", "-vf",
        `${scaleVaapi},hwdownload,format=nv12,subtitles=${subFileName(s)},format=nv12,hwupload`,
      ];
    default:
      // No burn: never leave the GPU.
      return ["-map", "0:v:0", "-vf", scaleVaapi];
  }
}

/** Assemble the ffmpeg argv for one run starting at segment `startSeg` (time `startT`). */
function buildFfmpegArgs(s: Session, startSeg: number, startT: number): string[] {
  const { preInput, vfSuffix, encoder } = videoEncodeParts();
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
    ...videoFilterArgs(s, vfSuffix),
    "-map", `0:a:${s.audioOrdinal}`,
    ...encoder,
    // A keyframe on every segment boundary → each segment is independently
    // decodable, so MSE appends cleanly across a seek.
    "-force_key_frames", `expr:gte(t,n_forced*${SEG_SECONDS})`,
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

/**
 * Whether a burn is still waiting on its subtitle to be prepared (a text track
 * being fetched/extracted). Once this flips false the burned segments exist, so
 * the client can reload to pick them up without a manual seek. False for non-burn,
 * disabled, bitmap/overlay (ready immediately), or once the text file is in hand.
 */
export function subtitlePending(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s || s.subMode !== "burn" || s.subsDisabled) return false;
  const sub = s.source.subStreams[s.subOrdinal];
  if (!sub || isBitmapSub(sub.codec) || s.subForceOverlay) return false;
  return !existsSync(path.join(s.tmpDir, subFileName(s)));
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
