import { useEffect, useRef, useState, useCallback } from "react";
import Hls from "hls.js";
import { HlsJsP2PEngine } from "p2p-media-loader-hlsjs";
import { Controls, type ControlsHandle } from "./Controls";
import { StatsOverlay } from "./StatsOverlay";
import type { P2PStats } from "./StatsOverlay";
import { TrackSwitcher } from "./TrackSwitcher";
import { QueuePanel } from "./QueuePanel";
import { NextUpButton } from "./NextUpButton";
import { EndCard } from "./EndCard";
import { PeoplePanel } from "./PeoplePanel";
import { SkipMarkerButton } from "./SkipMarkerButton";
import { hlsMasterUrl, pingSession, stopSession, getSessionToken, fetchConfig, setStreams, fetchMeta, fetchSiblingEpisodes, invalidateMeta } from "../lib/api";
import { formatMediaTitle } from "../lib/format";
import { logEvent, logWarn, logError } from "../lib/log";
import { loadVolume, saveVolume } from "../lib/volume";
import type { PlexItem, SkipMarker } from "../lib/api";
import type { SyncState, SyncActions, QueueItem } from "../hooks/useSync";
import type { InviteResult } from "../hooks/useDiscord";

const PING_INTERVAL_MS = 10_000; // 10s — matches Plex API recommendation for LAN timeline updates
const HEARTBEAT_INTERVAL_MS = 5_000;
const DRIFT_THRESHOLD_S = 2;
/**
 * Drift past which a viewer is yanked into place with a seek rather than eased
 * there — see the soft-sync constants below.
 *
 * This used to be 3s and it was the *only* correction: under it nothing
 * happened, so a room settled at whatever offset it had drifted to and stayed
 * there, and over it every heartbeat could fire a seek, which throws away the
 * fragment in flight and rebuffers. Two or three viewers hovering around the
 * threshold produced a stutter each, every few seconds, for the whole film.
 */
const HARD_SYNC_DRIFT_S = 4;
/** Inside this, we're in sync — don't touch the rate at all. */
const SOFT_SYNC_DEAD_ZONE_S = 0.35;
/**
 * Drift at which the rate nudge reaches its maximum. Matches HARD_SYNC_DRIFT_S,
 * so the adjustment ramps smoothly right up to the point where a seek takes over.
 */
const SOFT_SYNC_FULL_SCALE_S = HARD_SYNC_DRIFT_S;
/**
 * Largest speed change used to converge. 8% closes 4s of drift in under a
 * minute and is below the threshold where the pitch-corrected audio reads as
 * anything but normal — the point being that nobody should be able to tell this
 * is happening.
 */
const MAX_RATE_ADJUST = 0.08;
/** Never speed up into a buffer thinner than this: catching up is what drains it. */
const SOFT_SYNC_MIN_BUFFER_S = 6;
// Minimum spacing between viewer drift corrections. Heartbeats land every 5s,
// and a correction that fires faster than the media can service it cancels the
// fragment load that would have satisfied the previous one.
const DRIFT_CORRECTION_COOLDOWN_MS = 8_000;
// How long a viewer may sit seeking with no buffer progress before we stop
// re-seeking and rebuild the HLS pipeline instead.
const SEEK_STALL_REBUILD_MS = 15_000;
const MAX_VIEWER_RETRIES = 3;
const MAX_NETWORK_RETRIES = 5;
/** Consecutive hls.js media-error recoveries before we stop nudging and rebuild. */
const MAX_MEDIA_ERROR_RECOVERIES = 3;
/** Clean playback for this long means the next media error starts a fresh budget. */
const MEDIA_ERROR_RESET_MS = 60_000;
// After an in-place seek to an unbuffered position, how long to wait for
// segments before giving up and restarting the transcode at the target.
const SEEK_STALL_TIMEOUT_MS = 6_000;
// How far past the delivered buffer an unbuffered forward seek may reach before
// we skip the in-place attempt and restart the transcode outright. Plex
// transcodes linearly, so a large forward jump lands past the transcode head —
// those segments don't exist yet and never arrive, so the in-place seek can only
// stall. Modest jumps stay in-place: Plex has usually transcoded a bit ahead of
// what hls.js has buffered, and the stall timeout recovers if it hasn't.
const FAR_SEEK_THRESHOLD_S = 120;
// Quiet window before a seek actually tears the transcode down. Long enough to
// swallow a burst of scrub clicks, short enough that a single deliberate seek
// still feels immediate. The room is told about the seek straight away — only
// the local restart waits.
const SEEK_RESTART_DEBOUNCE_MS = 350;
/**
 * How long a committed restart may go unanswered before we stop treating it as
 * in flight. Past this the manifest isn't coming and a later seek must not be
 * held back waiting for it.
 */
const RESTART_PENDING_MAX_MS = 20_000;
/**
 * Longest a newer seek target will wait for an in-flight restart to produce its
 * manifest before tearing it down anyway.
 *
 * The whole point is not to kill a transcode Plex is still spinning up. In one
 * captured minute two people scrubbed at roughly one seek every 400ms and the
 * player started thirteen transcodes, eleven of which were destroyed before
 * Plex had even answered the manifest request — the shortest lived four
 * milliseconds. Plex still forks an encoder for each of those, and `stop`
 * doesn't reach them (see the server's transcode control), so they linger.
 */
const RESTART_INFLIGHT_MAX_WAIT_MS = 5_000;
// Cadence of the periodic player health sample. Matches the ping interval so
// client and server lines interleave one-for-one in the merged log.
const HEALTH_SAMPLE_MS = 10_000;
// Media kept behind and ahead of the playhead. These bound how much decoded
// video sits in the SourceBuffer, which is the tab's dominant memory cost:
// Discord runs this in an Electron renderer, and at these bitrates an untrimmed
// buffer reached ~3GB and took the tab out with
// "RangeError: Array buffer allocation failed" roughly once an hour.
// BACK_BUFFER_S mirrors hlsConfig.backBufferLength; FORWARD_BUFFER_FLUSH_S
// mirrors maxBufferLength, so trimming never fights the loader for ground it is
// actively trying to fill.
const BACK_BUFFER_S = 30;
const FORWARD_BUFFER_FLUSH_S = 120;
// Don't bother flushing slivers — avoids issuing a remove on every tick for a
// second or two of overshoot.
const BUFFER_TRIM_SLACK_S = 10;

/** Put playback back to normal speed. Safe to call on anything, including null. */
function resetPlaybackRate(video: HTMLVideoElement | null): void {
  if (video && video.playbackRate !== 1) video.playbackRate = 1;
}

/** Whether the video has enough buffered data at `t` to play from there. */
function isPositionBuffered(video: HTMLVideoElement, t: number): boolean {
  const { buffered } = video;
  for (let i = 0; i < buffered.length; i++) {
    if (t >= buffered.start(i) - 0.1 && t < buffered.end(i) - 0.3) return true;
  }
  return false;
}

/**
 * Convert a server-resolved episode into a QueueItem for playback.
 *
 * Copies `showTitle` rather than folding it into `parentTitle`: server items put
 * the season in parentTitle and the show in showTitle, so collapsing them would
 * render "Season 2 — S2E1 · Title". See lib/format.ts.
 */
/**
 * Copy the frame currently on screen into an offscreen canvas.
 *
 * Every path that rebuilds the HLS pipeline detaches the media element, which
 * paints black until the replacement has decoded its first frame. Holding the
 * last frame over that gap is what makes a rebuild read as a pause rather than
 * as the stream dying. Returns null when there is nothing to copy — before the
 * first frame, or when the element has already been torn down.
 */
function captureFrame(video: HTMLVideoElement | null): HTMLCanvasElement | null {
  if (!video || video.videoWidth === 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(video, 0, 0);
  } catch {
    // Tainted or not yet renderable — no frame is better than a broken one.
    return null;
  }
  return canvas;
}

function toQueueItem(ep: PlexItem | null, subtitles: boolean): QueueItem | null {
  if (!ep) return null;
  return {
    ratingKey: ep.ratingKey,
    title: ep.title,
    type: ep.type,
    thumb: ep.thumb,
    subtitles, // inherit the current burn-in setting
    parentTitle: ep.parentTitle,
    showTitle: ep.showTitle,
    parentIndex: ep.parentIndex,
    index: ep.index,
    year: ep.year,
  };
}

/**
 * End of the furthest buffered range — approximates how far Plex has delivered.
 * Null when nothing is buffered at all.
 *
 * The null matters. This used to fall back to `currentTime`, which reads as a
 * real boundary but isn't one: mid-restart the element is empty and sitting at
 * 0, so every seek target measured against it looked like a jump of the target's
 * full value and took the "far forward, must restart" branch. That turned a
 * burst of scrub clicks into a restart per click, each killing the transcode
 * before it produced a segment. Callers now have to say what "unknown" means
 * for them.
 */
function bufferedEnd(video: HTMLVideoElement): number | null {
  const { buffered } = video;
  return buffered.length > 0 ? buffered.end(buffered.length - 1) : null;
}

/** Seconds of contiguous buffer ahead of the current playhead (0 if none). */
function bufferAheadSeconds(video: HTMLVideoElement): number {
  const { buffered, currentTime } = video;
  for (let i = 0; i < buffered.length; i++) {
    if (currentTime >= buffered.start(i) - 0.1 && currentTime <= buffered.end(i) + 0.1) {
      return Math.max(0, buffered.end(i) - currentTime);
    }
  }
  return 0;
}

/**
 * Everything worth knowing about the playhead at the instant something
 * happened. Attached to every teardown/restart log so a stop in the file can be
 * read without guessing what the player looked like when it was decided.
 */
function snapshot(video: HTMLVideoElement | null): Record<string, unknown> {
  if (!video) return { video: "none" };
  const { buffered } = video;
  // bufStartS/bufSpanS are the memory numbers. bufAheadS only describes what is
  // still to play; what actually occupies the SourceBuffer — and killed the tab
  // at ~3GB — is everything from bufStartS to bufEndS. A bufStartS that stays
  // near the session's start offset while playback advances means eviction is
  // not happening, which is precisely the thing that needs to be visible.
  const bufStart = buffered.length > 0 ? buffered.start(0) : null;
  const bufEnd = bufferedEnd(video);
  return {
    posS: video.currentTime,
    bufAheadS: bufferAheadSeconds(video),
    bufStartS: bufStart ?? "none",
    bufEndS: bufEnd ?? "none",
    bufSpanS: bufStart !== null && bufEnd !== null ? bufEnd - bufStart : "none",
    ranges: buffered.length,
    paused: video.paused,
    seeking: video.seeking,
    readyState: video.readyState,
    networkState: video.networkState,
    // Only when it isn't 1, so the ordinary case stays quiet and a line with
    // rateX in it means soft drift correction was actively pulling.
    ...(video.playbackRate !== 1 ? { rateX: video.playbackRate } : {}),
    ...(video.error ? { mediaError: `${video.error.code}: ${video.error.message}` } : {}),
  };
}

/**
 * Chromium's non-standard heap counters, when the embedder exposes them.
 *
 * Directional rather than exact: much of what this player holds lives in
 * ArrayBuffers and the MSE SourceBuffer, which Chrome accounts for outside the
 * JS heap, so this under-reports true tab footprint. What it is good for is the
 * shape of the curve — a number that climbs across a session and never comes
 * down is the signature that was missing while the tab kept dying at ~3 GB with
 * nothing in the log to show for it.
 */
function heapSample(): Record<string, unknown> {
  const mem = (performance as Performance & {
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
  }).memory;
  if (!mem) return {};
  return {
    heapUsedMB: mem.usedJSHeapSize / 1e6,
    heapLimitMB: mem.jsHeapSizeLimit / 1e6,
  };
}

/**
 * Drop buffered media outside [currentTime − BACK_BUFFER_S, currentTime +
 * FORWARD_BUFFER_S], returning what was trimmed.
 *
 * hls.js has `backBufferLength`/`frontBufferFlushThreshold` for this, but its
 * eviction runs from one place — `trimBuffers()` on FRAG_CHANGED — and this
 * player drives hls.js through the p2p-media-loader mixin, which owns the
 * fragment loader. Rather than depend on that path firing, evict on our own
 * clock too. `BUFFER_FLUSHING` with a falsy `type` is the same public event
 * hls.js's own back-buffer path raises, and it queues behind in-flight appends,
 * so this is idempotent: when hls.js has already trimmed, the guards below
 * make it a no-op.
 */
function trimMediaBuffer(hls: Hls, video: HTMLVideoElement): Record<string, unknown> | null {
  const { buffered } = video;
  if (buffered.length === 0) return null;
  const now = video.currentTime;
  const backTarget = now - BACK_BUFFER_S;
  const frontTarget = now + FORWARD_BUFFER_FLUSH_S;
  const start = buffered.start(0);
  const end = buffered.end(buffered.length - 1);

  const trimmed: Record<string, unknown> = {};
  if (backTarget > start + BUFFER_TRIM_SLACK_S) {
    hls.trigger(Hls.Events.BUFFER_FLUSHING, { startOffset: 0, endOffset: backTarget, type: null });
    trimmed.backFromS = start;
    trimmed.backToS = backTarget;
  }
  if (end > frontTarget + BUFFER_TRIM_SLACK_S) {
    hls.trigger(Hls.Events.BUFFER_FLUSHING, {
      startOffset: frontTarget,
      endOffset: Number.POSITIVE_INFINITY,
      type: null,
    });
    trimmed.frontFromS = frontTarget;
    trimmed.frontToS = end;
  }
  return Object.keys(trimmed).length > 0 ? { ...trimmed, spanBeforeS: end - start } : null;
}

/**
 * Pull the integer segment index out of an HLS segment URL — Plex/VPS segments
 * end in `00179.ts` (optionally `media-00179.ts`, optionally `?query`). Returns
 * -1 when the shape is unfamiliar, so callers can log "unknown" rather than NaN.
 */
function segIndexFromUrl(url: string | undefined | null): number {
  if (!url) return -1;
  const m = url.match(/(\d+)\.ts(?:[?#]|$)/);
  return m ? parseInt(m[1], 10) : -1;
}

/**
 * hls.js's stream-controller state and current fragment, read defensively off
 * fields hls.js does not expose in its types. This is the one signal that
 * distinguishes "the loader stopped asking for fragments" from "it is stuck
 * waiting on one" when a stall throws no error — see the stall watchdog.
 */
function hlsLoadingState(hls: unknown): Record<string, unknown> {
  const sc = (hls as { streamController?: {
    state?: string;
    fragCurrent?: { sn?: number; url?: string };
  } })?.streamController;
  if (!sc) return { hlsState: "unknown" };
  return {
    hlsState: sc.state ?? "unknown",
    hlsFragSn: sc.fragCurrent?.sn ?? "none",
    hlsFragSeg: segIndexFromUrl(sc.fragCurrent?.url),
  };
}

interface PlayerProps {
  item: PlexItem;
  isHost: boolean;
  /** Our own Discord user id — lets the people panel label and skip ourselves. */
  selfUserId?: string | null;
  subtitles: boolean;
  /** Seconds to start at, from the host's watch history. Consumed once, on mount:
   *  a later item (queue advance, next episode) starts from the beginning. */
  resumePosition?: number;
  onBack: () => void;
  /** Where an episode goes when it finishes, or when the end card is dismissed:
   *  the show's page. Omit to fall back to a plain back. */
  onFinished?: (item: PlexItem) => void;
  /** Opens Discord's invite dialog for this activity's channel. Omit to hide. */
  onInvite?: () => Promise<InviteResult>;
  syncState?: SyncState;
  syncActions?: SyncActions;
  onPlayNext?: (item: QueueItem) => void;
}

export function Player({ item, isHost, selfUserId = null, subtitles, resumePosition, onBack, onFinished, onInvite, syncState, syncActions, onPlayNext }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [vpsRelay, setVpsRelay] = useState<boolean | null>(null); // null = not yet loaded
  const [buffering, setBuffering] = useState(true);
  // Viewers-only: transient "host is seeking" flag, raised on each seek command
  // and auto-cleared shortly after (see effect below).
  const [hostSeeking, setHostSeeking] = useState(false);
  const [showTrackSwitcher, setShowTrackSwitcher] = useState(false);
  const [trackSwitching, setTrackSwitching] = useState<"audio" | "subtitle" | null>(null);
  // Transient play/pause acknowledgement. `at` is part of the key so a rapid
  // second toggle restarts the animation instead of being swallowed by React
  // seeing the same value.
  const [tapAck, setTapAck] = useState<{ kind: "play" | "pause"; at: number } | null>(null);
  // Target of an in-flight seek-restart, or null when playback is settled. The
  // scrub bar reads this so it stays where the viewer aimed instead of snapping
  // to 0:00 while the replacement transcode spins up.
  const [restartingTo, setRestartingTo] = useState<number | null>(null);
  // Whether the last frame is standing in for a stream that is being rebuilt.
  // Cleared the moment real frames resume — see the `playing` handler.
  const [holdingFrame, setHoldingFrame] = useState(false);
  const [showQueuePanel, setShowQueuePanel] = useState(false);
  const [showPeoplePanel, setShowPeoplePanel] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  // Next item to offer, auto-resolved from the series. Queue takes precedence
  // over this at render time — a queued item is a deliberate choice, this is a guess.
  const [nextEpisode, setNextEpisode] = useState<PlexItem | null>(null);
  // Previous episode, for the control-bar back button. Not used by the card.
  const [prevEpisode, setPrevEpisode] = useState<PlexItem | null>(null);
  const [nearEnd, setNearEnd] = useState(false);
  // The item has genuinely finished, as opposed to merely being close to the
  // end. Drives the end-of-playback screen; nearEnd only drives the corner card.
  const [playbackEnded, setPlaybackEnded] = useState(false);
  // Whether the "what comes after this" lookup has answered. The end screen has
  // to wait for it: an item that ends before the answer arrives would otherwise
  // look like it has no next episode and close the player on a series.
  const [siblingsResolved, setSiblingsResolved] = useState(false);
  // Which item the card was dismissed for. Compared against the live ratingKey,
  // so it self-clears on advance rather than latching.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const nextEpisodeRef = useRef<PlexItem | null>(null);
  nextEpisodeRef.current = nextEpisode;
  const prevEpisodeRef = useRef<PlexItem | null>(null);
  prevEpisodeRef.current = prevEpisode;
  // Cumulative P2P delivery counters, filled from the p2p-media-loader engine
  // events below and read by the StatsOverlay each poll.
  const p2pStatsRef = useRef<P2PStats>({ p2pBytes: 0, httpBytes: 0, uploadBytes: 0, peers: new Set() });
  // Rolling record of the p2p-media-loader engine's fragment-loader activity,
  // filled from its onSegment* events below. A silent mid-video stall parks the
  // buffer with no error thrown, and the health sample alone can't say whether
  // the engine stopped fetching segments or hls.js stopped appending them. This
  // captures the last thing the engine actually did so the stall watchdog can
  // attribute the freeze to one side or the other.
  const engineLoaderRef = useRef({
    lastStartSeg: -1, lastLoadedSeg: -1, lastErrorSeg: -1,
    lastEventAt: 0, lastError: null as string | null,
    starts: 0, loaded: 0, errors: 0, aborts: 0,
  });
  // Stall-watchdog bookkeeping: currentTime at the previous health tick, and
  // whether the current stall episode has already been logged — a multi-minute
  // freeze must produce one diagnostic, not one per tick.
  const lastTickTimeRef = useRef(-1);
  const stallLoggedRef = useRef(false);
  // Plex intro/credits markers for the current item, and whichever one the
  // playhead currently sits inside (null when outside every window).
  const [markers, setMarkers] = useState<SkipMarker[]>([]);
  const [activeMarker, setActiveMarker] = useState<SkipMarker | null>(null);
  // Plex part id for hover-preview frames, or null when this item has none.
  const [previewPartId, setPreviewPartId] = useState<number | null>(null);
  const [recovering, setRecovering] = useState(false);
  // Every automatic recovery has been spent and the session is torn down: the
  // only ways forward are the manual Retry button or leaving.
  const [playbackDead, setPlaybackDead] = useState(false);
  const recoveryAttemptRef = useRef(0);
  const recoveryPositionRef = useRef(0);
  const MAX_RECOVERY_ATTEMPTS = 2;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const retryCountRef = useRef(0);
  const hlsDeadRef = useRef(false);
  const networkRetryRef = useRef(0);
  // Media-error recovery budget, and when the last one fired — see the
  // MEDIA_ERROR branch of the fatal-error handler.
  const mediaErrorCountRef = useRef(0);
  const lastMediaErrorAtRef = useRef(0);
  const pendingStopRef = useRef<Promise<void> | null>(null);
  const bufferCleanupRef = useRef<(() => void) | null>(null);
  // Offset for the next transcode start. Seeded with the resume position so the
  // very first session starts there; the HLS effect clears it after each use, so
  // restarts and later items begin at 0 unless a seek sets it again.
  const seekOffsetRef = useRef<number | null>(
    resumePosition && resumePosition > 0 ? resumePosition : null,
  );
  // Last position this client is confident playback actually reached for the
  // current item. Updated only from a video that is genuinely playing, so it is
  // never polluted by the transient 0 a torn-down element reports mid-restart.
  // This is what a restart resumes from when no explicit offset is pending.
  const lastGoodPositionRef = useRef(resumePosition && resumePosition > 0 ? resumePosition : 0);
  // A new item must not inherit the previous one's position. Done during render
  // for the same reason subtitlesOnRef is: the HLS effect reads it, and an
  // effect-based reset would land after the transcode had already started.
  const lastGoodItemRef = useRef(item.ratingKey);
  if (lastGoodItemRef.current !== item.ratingKey) {
    lastGoodItemRef.current = item.ratingKey;
    lastGoodPositionRef.current = 0;
  }
  /**
   * Record a position, but only from a video that actually has media loaded.
   * The guard is the whole point: mid-restart the element reports
   * currentTime 0 with readyState 0, and trusting that would overwrite a real
   * position with the very zero this ref exists to defend against.
   */
  const noteGoodPosition = useCallback((video: HTMLVideoElement | null) => {
    if (!video) return;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    if (!(video.currentTime > 0)) return;
    lastGoodPositionRef.current = video.currentTime;
  }, []);
  // Offset the current transcode session started at — Plex has no segments
  // before this position, so seeks behind it always need a restart.
  // Note: a promoted host inherits the stream without knowing the original
  // offset (stays 0); the stall-timeout fallback still recovers in that case.
  const sessionStartOffsetRef = useRef(0);
  // seekSeq of the last seek this client has already acted on. Seeded from the
  // room's current value so a seek that happened before we joined isn't replayed
  // against us on the first command we see.
  const appliedSeekSeqRef = useRef(syncState?.seekSeq ?? 0);
  // Same idea for room snapshots — see the command effect and the host re-assert.
  const appliedStateSeqRef = useRef(syncState?.stateSeq ?? 0);
  const seekStallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Backstop that releases the scrub bar after a co-host's own seek — see
  // handleSeekCommand.
  const coHostSeekHoldRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Previous value of the HLS effect's dependency array, so a restart can name
  // the dep that triggered it rather than just appearing in the log.
  const hlsDepsRef = useRef<Record<string, unknown> | null>(null);
  const healthIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // When the viewer first noticed it was seeking without getting anywhere, and
  // when it last actually moved the playhead to follow the room. Together these
  // stop the heartbeat from cancelling its own seek every 5s.
  const stalledSeekSinceRef = useRef<number | null>(null);
  const lastDriftCorrectionRef = useRef(0);
  // Pending debounce for a seek-driven transcode restart, and whether one has
  // been committed but not yet produced a manifest. Both mean the video element
  // is not describing a live transcode.
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartPendingRef = useRef(false);
  // When the in-flight restart was committed, and when we first started holding
  // a newer target back for it. Both exist so neither wait can last forever —
  // see isRestartPending and the commit below.
  const restartPendingSinceRef = useRef(0);
  const restartDeferredSinceRef = useRef(0);
  /**
   * Is a restart committed and still waiting on its manifest?
   *
   * Time-bounded, because the alternative to a stuck `false` (a restart storm,
   * below) is a stuck `true`, which would route every seek for the rest of the
   * session through the restart path. A manifest that hasn't arrived in
   * RESTART_PENDING_MAX_MS isn't coming.
   */
  const isRestartPending = useCallback(
    () =>
      restartPendingRef.current &&
      Date.now() - restartPendingSinceRef.current < RESTART_PENDING_MAX_MS,
    [],
  );
  /** Mark a restart as committed (or not) — keeps the timestamp honest. */
  const setRestartPending = useCallback((pending: boolean) => {
    restartPendingRef.current = pending;
    if (pending) restartPendingSinceRef.current = Date.now();
  }, []);
  // Set once the master manifest for the current session actually goes out, so
  // teardown can tell a real session from an id the server never heard about.
  const sessionRegisteredRef = useRef(false);
  // Reaches the controls' skip accumulator, so the arrow keys stack the same way
  // the ±10s buttons do instead of seeking on every press.
  const controlsRef = useRef<ControlsHandle>(null);

  // Stable refs so the HLS effect doesn't re-run when these change
  const itemRef = useRef(item);
  itemRef.current = item;
  const syncActionsRef = useRef(syncActions);
  syncActionsRef.current = syncActions;
  const syncStateRef = useRef(syncState);
  syncStateRef.current = syncState;

  // Refs for isHost/ownsSession so the main HLS effect doesn't re-run on promotion.
  // The promoted host should keep the existing HLS stream, not tear it down.
  const isHostRef = useRef(isHost);
  isHostRef.current = isHost;
  const ownsSessionRef = useRef(isHost);

  // Whether the transcode should burn in subtitles.
  //
  // The `subtitles` prop is fixed at play time, but subtitles can be switched
  // mid-episode. Restarting with the launch-time value meant that picking a
  // track after starting with subtitles off set the stream in Plex and then
  // asked for subtitles=none anyway — so nothing was burned in and none
  // appeared. This follows the live selection instead.
  const subtitlesOnRef = useRef(subtitles);
  // A new item resets to whatever that item was launched with. Done during
  // render rather than in an effect so the value is correct before the HLS
  // effect reads it, without an extra render or a second transcode start.
  const subtitlesItemRef = useRef(item.ratingKey);
  // Which streams this room is actually on, so a request for the one already
  // playing doesn't cost everyone a transcode restart. Null means "not known
  // yet" — the first selection of a session always applies. Reset with the item,
  // alongside the burn-in flag, for the same reason.
  const currentAudioStreamRef = useRef<number | null>(null);
  const currentSubtitleStreamRef = useRef<number | null>(null);
  if (subtitlesItemRef.current !== item.ratingKey) {
    subtitlesItemRef.current = item.ratingKey;
    subtitlesOnRef.current = subtitles;
    currentAudioStreamRef.current = null;
    currentSubtitleStreamRef.current = null;
  }

  // Transport rights: the host, plus anyone the host has granted co-host.
  // Note this is UX only — the server independently enforces the same rule.
  // Session ownership stays strictly host-only (ownsSessionRef above): a co-host
  // never pings or stops the Plex transcode.
  const canControl = isHost || (syncState?.isCoHost ?? false);
  const canControlRef = useRef(canControl);
  canControlRef.current = canControl;

  // Whether this Player mounted as host. Still used for the decisions that are
  // genuinely about how this client started — which session it adopts, and
  // whether a recovery restart should trust room position over its own playhead.
  const mountedAsHostRef = useRef(isHost);

  const roomSessionId = syncState?.hlsSessionId ?? null;

  /**
   * The session this client should be playing when it doesn't own one.
   *
   * This used to be `mountedAsHost ? null : room.hlsSessionId`, so that
   * promotion couldn't flip it to null and tear a working stream down. That
   * covered promotion and missed the opposite case entirely: a host who hands
   * the role over keeps `mountedAsHost` forever, so it went on requesting
   * segments from a session the new host had already replaced. Those 410, the
   * viewer-retry path exhausts itself, and the rebuild picks
   * `sessionOwner ? newUuid : viewerHlsSessionId` — which for a demoted host is
   * null. "No session id yet, waiting for sync", forever. Whoever gave up the
   * host role was left on black with no way back short of leaving and rejoining.
   *
   * Latching on "the room has moved to a session we are not on" says the same
   * thing about promotion (a host follows nothing, so this never moves) while
   * also being true after a handover: nothing changes at the moment of
   * demotion — the ex-host is already on the right session — and when the new
   * host does restart, the ex-host follows it like any other viewer.
   */
  const [followSessionId, setFollowSessionId] = useState<string | null>(
    isHost ? null : roomSessionId,
  );
  useEffect(() => {
    if (isHostRef.current) return;
    if (!roomSessionId || roomSessionId === sessionIdRef.current) return;
    logEvent("HLS", "following the room onto a new session", {
      from: sessionIdRef.current?.substring(0, 8) ?? "none",
      to: roomSessionId.substring(0, 8),
    });
    setFollowSessionId((prev) => (prev === roomSessionId ? prev : roomSessionId));
  }, [roomSessionId, isHost]);

  // A host who mounts into an already-live stream (e.g. promoted while not in
  // the player) adopts that running session instead of starting a second
  // transcode. Captured once at mount and consumed on first use, so later
  // restarts (subtitle burn-in, retries) mint a fresh session as normal.
  const adoptSessionIdRef = useRef(mountedAsHostRef.current ? (syncState?.hlsSessionId ?? null) : null);
  // True while playing an adopted session: skip the position-resetting "play"
  // broadcast, and seek to the room's current position on load like a viewer.
  const didAdoptRef = useRef(false);

  // Handle promotion: start ping + heartbeat when viewer becomes host mid-playback
  useEffect(() => {
    if (!isHost || ownsSessionRef.current) return;

    // Promoted to host — take over session ownership
    ownsSessionRef.current = true;
    // A host defines the room's position rather than chasing it, so whatever
    // the drift corrector was holding stops here.
    resetPlaybackRate(videoRef.current);

    // Promotion changes who is allowed to stop the transcode and where a
    // recovery restart takes its position from, so it's a turning point for
    // anything that goes wrong afterwards.
    logEvent("Player", "promoted to host mid-playback", {
      session: sessionIdRef.current?.substring(0, 8) ?? "none",
      mountedAsHost: mountedAsHostRef.current,
      roomPosS: syncStateRef.current?.position ?? "none",
      hadPingInterval: pingIntervalRef.current !== null,
      ...snapshot(videoRef.current),
    });

    // Start pinging to keep transcode alive (the old host was doing this)
    if (pingIntervalRef.current === null) {
      pingIntervalRef.current = setInterval(() => {
        if (sessionIdRef.current) {
          const v = videoRef.current;
          const timeMs = v ? v.currentTime * 1000 : undefined;
          // playing=false only for a real pause; a stalled/buffering video is
          // still "playing" (paused === false), which is exactly what lets the
          // server distinguish a stall from a pause.
          pingSession(sessionIdRef.current, timeMs, v ? !v.paused : undefined,
            v ? bufferAheadSeconds(v) : undefined).catch(console.error);
        }
      }, PING_INTERVAL_MS);
    }

    // Start heartbeating to sync remaining viewers
    if (heartbeatIntervalRef.current === null) {
      heartbeatIntervalRef.current = setInterval(() => {
        const v = videoRef.current;
        if (v && v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          syncActionsRef.current?.sendHeartbeat(v.currentTime, !v.paused);
        }
      }, HEARTBEAT_INTERVAL_MS);
    }
  }, [isHost]);

  // Mirror of the promotion effect: a host who hands control to someone else
  // must relinquish session ownership. Without this, ownsSessionRef stays true
  // after demotion, so backing out (endPlayback) or hitting an HLS error would
  // stop or restart the Plex transcode the *new* host is still using — killing
  // their stream and forcing a fresh transcode (a phantom second stream).
  useEffect(() => {
    if (!isHost) {
      if (ownsSessionRef.current) {
        logEvent("Player", "demoted, releasing session ownership", {
          session: sessionIdRef.current?.substring(0, 8) ?? "none",
        });
      }
      ownsSessionRef.current = false;
    }
  }, [isHost]);

  const destroyLocal = useCallback(() => {
    // The element outlives every HLS rebuild, so a rate the drift corrector was
    // holding would carry into the replacement stream and quietly desync it in
    // the opposite direction.
    resetPlaybackRate(videoRef.current);
    if (seekStallTimerRef.current !== null) {
      clearTimeout(seekStallTimerRef.current);
      seekStallTimerRef.current = null;
    }
    if (pingIntervalRef.current !== null) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
    if (heartbeatIntervalRef.current !== null) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    if (healthIntervalRef.current !== null) {
      clearInterval(healthIntervalRef.current);
      healthIntervalRef.current = null;
    }
    // Deliberately does NOT clear sessionRegisteredRef: the recovery paths call
    // this and then decide whether to stop the session, and they need the flag
    // to still describe the session they just tore down. The HLS effect resets
    // it when it mints the next id.
    if (bufferCleanupRef.current) {
      bufferCleanupRef.current();
      bufferCleanupRef.current = null;
    }
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
  }, []);

  // Deliberately not folded into destroyLocal: that runs on every HLS rebuild,
  // and this timer has to survive one — the rebuild is the thing it's covering.
  useEffect(() => () => {
    if (coHostSeekHoldRef.current !== null) clearTimeout(coHostSeekHoldRef.current);
  }, []);

  // Apply the remembered volume, and persist any later change. One listener on
  // the element covers every source — the Controls slider, the mute button and
  // the keyboard shortcuts all write video.volume — so nothing else needs to
  // know about persistence.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = loadVolume();
    const onVolumeChange = () => saveVolume(video.volume);
    video.addEventListener("volumechange", onVolumeChange);
    return () => video.removeEventListener("volumechange", onVolumeChange);
  }, []);

  // Fetch VPS relay config once on mount — HLS init waits for this
  useEffect(() => {
    fetchConfig()
      .then((config) => setVpsRelay(config.vpsRelay))
      .catch(() => setVpsRelay(false)); // default to non-VPS (P2P mode) if config fails
  }, []);

  // Per-item metadata: intro/credits markers, and the part id for hover-preview
  // frames. The request runs for everyone — scrubbing previews are read-only, so
  // viewers get them — but markers stay gated, since the skip button is a control.
  //
  // Deliberately its own effect rather than part of the main HLS effect: that one
  // depends on retryKey, which handleSeekRestart bumps, so markers and the preview
  // part id would be refetched and blanked on every restart-seek. Keying on
  // item.ratingKey also covers queue auto-advance, which reuses this same Player.
  useEffect(() => {
    setMarkers([]);
    setActiveMarker(null);
    setPreviewPartId(null);
    let cancelled = false;
    fetchMeta(item.ratingKey)
      .then((meta) => {
        if (cancelled) return;
        if (canControl) setMarkers(meta.markers ?? []);
        // Null unless Plex actually has preview frames, so Controls renders a
        // plain timestamp rather than chasing images that don't exist.
        setPreviewPartId(meta.previewThumbs ? meta.partId : null);
        // Seed what's currently selected from Plex's own answer, so re-picking
        // the track already playing is recognised as a no-op the *first* time
        // as well as afterwards. Guarded on null so a selection made while this
        // was in flight wins. Subtitles fall back to 0, the switcher's "None".
        if (currentAudioStreamRef.current === null) {
          currentAudioStreamRef.current =
            meta.audioTracks?.find((t) => t.selected)?.id ?? null;
        }
        if (currentSubtitleStreamRef.current === null) {
          currentSubtitleStreamRef.current =
            meta.subtitleTracks?.find((t) => t.selected)?.id ?? 0;
        }
      })
      .catch(() => { /* both are optional — never surface an error over a working stream */ });
    return () => { cancelled = true; };
  }, [item.ratingKey, canControl]);

  // Resolve the next episode in the series. Same effect discipline as markers
  // above: its own effect (so retryKey restarts don't blank it) keyed on
  // ratingKey (so it re-resolves after an advance, which reuses this Player).
  //
  // Deliberately not gated on item.type === "episode" — a co-host's item is a
  // synthesized stub with type "movie" and no indices, so gating here would
  // silently break the button for every co-host. The server decides instead and
  // returns { next: null } for anything that isn't an episode.
  useEffect(() => {
    setNextEpisode(null);
    setPrevEpisode(null);
    setDismissedFor(null);
    // Must reset: `ended` latches nearEnd true, and without clearing it here the
    // card would appear instantly at the start of the episode we just advanced to.
    setPlaybackEnded(false);
    setNearEnd(false);
    setSiblingsResolved(false);
    // Viewers resolve this too now. They can't act on it — the transport
    // buttons stay host-only — but the end-of-playback screen shows everyone
    // what follows, and without this a viewer reached the end of an episode and
    // was told there was nothing after it.
    let cancelled = false;
    fetchSiblingEpisodes(item.ratingKey)
      .then((r) => {
        if (cancelled) return;
        setNextEpisode(r.next);
        setPrevEpisode(r.prev);
      })
      .catch(() => { /* optional polish — never surface an error over a working stream */ })
      .finally(() => { if (!cancelled) setSiblingsResolved(true); });
    return () => { cancelled = true; };
  }, [item.ratingKey]);

  // Single HLS session — no mid-stream switching
  useEffect(() => {
    // Wait for the VPS relay config before touching anything. It arrives a beat
    // after mount, so this effect always runs once with vpsRelay still null and
    // then again once it resolves — and the state below is consumed on read:
    // the adopted session id and the resume offset are both one-shot. Bailing
    // out here rather than inside start() is what keeps the second run from
    // finding them already spent (which started every resume at 0:00).
    //
    // It also avoids a double HLS start: initializing on the false default and
    // then tearing down and re-initializing when the real config lands.
    if (vpsRelay === null) return;

    let mounted = true;

    // Which dependency moved. This effect owns the whole HLS lifecycle, so
    // every restart in the log traces back to one of these — and "which one"
    // is otherwise unknowable from the outside.
    const deps = { ratingKey: item.ratingKey, subtitles, followSessionId, retryKey, vpsRelay };
    const prev = hlsDepsRef.current;
    const changed = prev
      ? (Object.keys(deps) as Array<keyof typeof deps>).filter((k) => deps[k] !== prev[k])
      : ["initial-mount"];
    // A new title starts clean. Everything else — a seek restart, a subtitle
    // change, a viewer following the host onto a new session — is the same
    // picture continuing, so the held frame stays up over the rebuild.
    if (prev && prev.ratingKey !== item.ratingKey) {
      canvasRef.current = null;
      setHoldingFrame(false);
    }
    hlsDepsRef.current = deps;

    logEvent("HLS", "session effect running", {
      trigger: changed.join(",") || "none",
      ratingKey: item.ratingKey,
      retryKey,
      isHost: isHostRef.current,
      ownsSession: ownsSessionRef.current,
      mountedAsHost: mountedAsHostRef.current,
      pendingOffsetS: seekOffsetRef.current,
      adopting: adoptSessionIdRef.current?.substring(0, 8) ?? "no",
    });

    destroyLocal();

    // Host creates a new session; viewer reuses the host's session
    const sessionOwner = ownsSessionRef.current;
    let sessionId: string | null;
    if (adoptSessionIdRef.current) {
      // Adopt the live stream we were promoted into — reuse its transcode and
      // sync to the room position rather than restarting from the top. One-shot.
      sessionId = adoptSessionIdRef.current;
      adoptSessionIdRef.current = null;
      didAdoptRef.current = true;
    } else {
      didAdoptRef.current = false;
      sessionId = sessionOwner ? crypto.randomUUID() : followSessionId;
    }

    if (!sessionId) {
      // Viewer doesn't have a session ID yet — wait for sync
      logEvent("HLS", "no session id yet, waiting for sync", { isHost: isHostRef.current });
      return;
    }

    sessionIdRef.current = sessionId;
    // Fresh id, not yet known to the server. Set again once the manifest request
    // actually goes out.
    sessionRegisteredRef.current = false;
    // From here until MANIFEST_PARSED the element describes nothing: it has been
    // detached, so its position is 0, its buffer is empty and its duration is
    // NaN. Any seek that lands in this window has to be told that, or it will
    // measure itself against those zeros and destroy the transcode currently
    // being brought up. Set here rather than only at the commit site so it also
    // covers the rebuilds nothing debounced — a subtitle change, a new item, a
    // viewer following the host onto a new session.
    setRestartPending(true);

    // The pending offset is one-shot: read it, spend it. That's correct for a
    // single restart, but this effect can run twice in the same burst — a
    // subtitle toggle sets the offset and bumps retryKey, then the `subtitles`
    // prop lands in a later commit and re-runs us ~10ms behind. The second run
    // finds the offset already spent and, with a bare 0, asks Plex to transcode
    // from the top while the room is an hour and a half in. That is the
    // "playback jumped back to 0:00" report, and it happened eight times in one
    // stress-test session.
    //
    // So 0 is treated as "nothing pending" rather than "start at the
    // beginning", and we fall back to the last position known to be real for
    // *this* item. Only a genuine fresh start leaves the fallback empty.
    // `null` means nothing pending — a number, including 0, is a real target.
    //
    // These used to be the same value. Seeking to 00:00 set the pending offset
    // to 0, which the check below read as "no seek requested", so the restart
    // took the fallback and resumed at the position the viewer had just seeked
    // away from. Dragging the bar to the start visibly reloaded and then jumped
    // back to where it was.
    let offset = seekOffsetRef.current;
    seekOffsetRef.current = null;
    if (sessionOwner && offset === null) {
      const fallback = lastGoodPositionRef.current;
      if (fallback > 0) {
        logWarn("HLS", "no pending offset on restart, resuming from last known position", {
          resumeAtS: fallback,
          session: sessionId.substring(0, 8),
        });
        offset = fallback;
      }
    }
    const startOffset = offset ?? 0;

    // The offset is the single most useful number in a restart: a transcode
    // starting somewhere other than where playback was is the signature of a
    // stale position having reached this client.
    logEvent("HLS", "starting session", {
      session: sessionId.substring(0, 8),
      owner: sessionOwner,
      adopted: didAdoptRef.current,
      offsetS: startOffset,
      lastGoodPosS: lastGoodPositionRef.current,
      subtitles: subtitlesOnRef.current,
      vpsRelay,
      roomPosS: syncStateRef.current?.position ?? "none",
    });

    const url = hlsMasterUrl(item.ratingKey, sessionId, {
      subtitles: subtitlesOnRef.current,
      offset: startOffset > 0 ? startOffset : undefined,
      // Carry the current track selection so a rebuild after a track change
      // re-encodes with it; omitted on a fresh session, where the server falls
      // back to the file's Plex-selected default tracks.
      audioStreamId: currentAudioStreamRef.current ?? undefined,
      subtitleStreamId: currentSubtitleStreamRef.current ?? undefined,
    });

    async function start() {
      if (pendingStopRef.current) {
        try { await pendingStopRef.current; } catch {}
        pendingStopRef.current = null;
        // Give Plex time to fully release transcode resources
        await new Promise(r => setTimeout(r, 500));
      }

      const video = videoRef.current;
      if (!mounted || !video) return;

      if (Hls.isSupported()) {
        const token = getSessionToken();

        const hlsConfig: Partial<import("hls.js").HlsConfig> = {
          maxBufferLength: 120,
          maxMaxBufferLength: 120,
          // hls.js also caps the forward buffer by bytes (default 60 MB, which at
          // 12-20 Mbps is only ~25-40s — silently undercutting maxBufferLength).
          // 120s at the 20 Mbps peak is ~300 MB, so this has to clear that or the
          // byte cap binds first and quietly undercuts the time target again.
          maxBufferSize: 320 * 1000 * 1000,
          // Back buffer competes with the forward buffer for the same SourceBuffer
          // memory, and 90s was ~135-225 MB of it. Trimmed to 30s to leave room for
          // the deeper forward buffer: backward seeks beyond 30s now refetch.
          backBufferLength: BACK_BUFFER_S,
          // hls.js defaults this to Infinity, meaning the forward buffer is never
          // reclaimed — only *capped* while loading. Seek backwards 30 minutes and
          // the half hour you skipped over stays resident, which is why such a
          // seek was instant and why the tab climbed to ~3GB before dying with
          // "Array buffer allocation failed". Bounding it to the same window we
          // load into makes the buffer a window rather than a recording.
          frontBufferFlushThreshold: FORWARD_BUFFER_FLUSH_S,
          maxBufferHole: 0.5,
          // Recover from stalls faster on cold start — default is 2s, but during
          // initial Plex transcode warm-up segments arrive slowly. A lower nudge
          // threshold helps skip past gaps sooner.
          highBufferWatchdogPeriod: 1,
          nudgeMaxRetry: 10,
          fragLoadingMaxRetry: 8,
          fragLoadingRetryDelay: 1000,
          fragLoadingMaxRetryTimeout: 30000,
          manifestLoadingMaxRetry: 4,
          manifestLoadingRetryDelay: 1000,
          manifestLoadingMaxRetryTimeout: 30000,
          levelLoadingMaxRetry: 6,
          levelLoadingRetryDelay: 1000,
          startFragPrefetch: true,
          xhrSetup: (xhr: XMLHttpRequest, urlStr: string) => {
            // Only send auth header to same-origin requests (manifests, pings).
            // VPS segment URLs are absolute (https://vps/seg/...) and authenticated
            // via ?key= query param. Sending Authorization to a cross-origin URL
            // triggers a CORS preflight that nginx's ?key= check would reject.
            const isSameOrigin = urlStr.startsWith("/") || urlStr.startsWith(location.origin);
            if (token && isSameOrigin) {
              xhr.setRequestHeader("Authorization", `Bearer ${token}`);
            }
          },
        };

        let hls: Hls;

        if (!vpsRelay) {
          // P2P mode — peers share segments via WebRTC
          const HlsWithP2P = HlsJsP2PEngine.injectMixin(Hls);
          hls = new HlsWithP2P({
            ...hlsConfig,
            p2p: {
              core: {
                swarmId: `pdt-${sessionId}`,
                announceTrackers: [
                  `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/tracker${token ? `?token=${encodeURIComponent(token)}` : ""}`,
                ],
                // The engine keeps every segment it downloads so it can serve
                // peers, and left to itself it will hold 4 GiB before evicting
                // anything: its desktop default. Worse, for VOD it only evicts
                // *at* the limit — `if (!isMemoryLimitReached && !isLiveStream)
                // return;` — so there is no steady-state trimming to save us on
                // the way up. Discord runs this in an Electron renderer that
                // dies around 3 GB, so the tab was always going to lose that
                // race: ~45 minutes in, "RangeError: Array buffer allocation
                // failed", fatal hls.js error, transcode restart. Bounding the
                // media element's own buffer didn't touch this, because this
                // cache is separate from the SourceBuffer.
                //
                // 512 MiB sits comfortably above the ~300 MB the 120s
                // high-demand window needs at our 20 Mbps peak — segments ahead
                // of the playhead are never evicted, so the limit has to clear
                // that or eviction runs on every append for nothing — while
                // capping the whole cache eight times lower than the default.
                segmentMemoryStorageLimit: 512,
                // This engine owns the fragment loader, so hls.js's buffer targets
                // are only advisory. With no peers connected, high-demand is the
                // *only* thing that triggers an HTTP fetch: p2p-downloadable is
                // gated on a peer already holding the segment, and http-downloadable
                // is read solely by loadRandomThroughHttp, which early-returns when
                // there are no peers. So this window decides how far ahead a solo
                // viewer buffers — at the old 15s it capped the buffer at 15s no
                // matter what hls.js was configured for.
                //
                // It must be STRICTLY GREATER than maxBufferLength (120), not equal.
                // hls.js requests fragments to fill up to maxBufferLength; the engine
                // fetches a requested fragment only if it falls inside high-demand
                // (no peers ⇒ no other path). When the two are equal, the fragment
                // that would top the buffer off sits exactly at the window edge, and
                // because hls.js measures its buffer and the engine measures its
                // window from currentTime sampled a beat apart, that fragment lands
                // just outside high-demand often enough to matter. The engine then
                // neither HTTP-fetches nor P2P-fetches it, the request hangs, hls.js
                // waits on a fragment that never arrives, and the buffer drains to a
                // hard stall with no error thrown — permanent "Loading…" mid-video,
                // all clients stuck at the same segment. 150 keeps every fragment
                // hls.js can ask for (≤120s ahead) comfortably inside the window with
                // a 30s / 10-segment margin, and matches the server's 150s prefetch
                // lead (segment-prefetch LEAD_SEGMENTS×3s). The effective buffer is
                // still 120s — maxBufferLength binds the append; high-demand only
                // guarantees the next fragment is already fetched.
                //
                // Trade-off: high-demand segments prefer HTTP over P2P, so with this
                // covering the whole buffer, peers contribute much less and more
                // traffic comes from the server. Deliberate. If bandwidth becomes a
                // problem, the fix is applyDynamicConfig() driven by onPeerConnect/
                // onPeerClose — widen only while connectedPeerCount is 0.
                highDemandTimeWindow: 150,
                p2pDownloadTimeWindow: 150,
                // Was 6, i.e. inverted below high-demand (library default is 3000).
                // Only consulted when peers exist, but it must not be the smaller of
                // the two or it makes no sense — keep it ≥ high-demand.
                httpDownloadTimeWindow: 150,
                simultaneousP2PDownloads: 3,
                simultaneousHttpDownloads: 2,
                rtcConfig: {
                  // Multiple STUN servers improve NAT traversal odds — every
                  // peer pair that fails to connect falls back to HTTP, costing
                  // server bandwidth.
                  iceServers: [
                    { urls: "stun:stun.l.google.com:19302" },
                    { urls: "stun:stun1.l.google.com:19302" },
                    { urls: "stun:stun2.l.google.com:19302" },
                  ],
                },
                httpRequestSetup: async (url, _byteRange, signal, requestByteRange) => {
                  const headers: Record<string, string> = {};
                  if (token) headers["Authorization"] = `Bearer ${token}`;
                  if (requestByteRange) {
                    const end = requestByteRange.end != null ? requestByteRange.end : "";
                    headers["Range"] = `bytes=${requestByteRange.start}-${end}`;
                  }
                  return new Request(url, { headers, signal });
                },
              },
              onHlsJsCreated: (hls) => {
                // Reset counters for the new stream/session.
                const stats = p2pStatsRef.current;
                stats.p2pBytes = 0;
                stats.httpBytes = 0;
                stats.uploadBytes = 0;
                stats.peers = new Set();

                const eng = engineLoaderRef.current;
                hls.p2pEngine.addEventListener("onSegmentLoaded", ({ segmentUrl, bytesLength, downloadSource }) => {
                  if (downloadSource === "p2p") stats.p2pBytes += bytesLength;
                  else stats.httpBytes += bytesLength;
                  eng.lastLoadedSeg = segIndexFromUrl(segmentUrl);
                  eng.lastEventAt = Date.now();
                  eng.loaded++;
                });
                // onSegmentStart/Error/Abort are the loader's own account of what
                // it tried, independent of hls.js. If a freeze shows the engine's
                // lastStartSeg stuck at the buffer edge with no matching load, the
                // engine stopped fetching (window/peer wedge); if it started and
                // errored, the fetch itself failed; if it loaded past the edge but
                // the media buffer didn't grow, the wedge is in hls.js's appending.
                hls.p2pEngine.addEventListener("onSegmentStart", ({ segment }) => {
                  eng.lastStartSeg = segment.externalId ?? segIndexFromUrl(segment.url);
                  eng.lastEventAt = Date.now();
                  eng.starts++;
                });
                hls.p2pEngine.addEventListener("onSegmentError", ({ segment, error, downloadSource }) => {
                  eng.lastErrorSeg = segment.externalId ?? segIndexFromUrl(segment.url);
                  eng.lastError = error instanceof Error ? error.message : String(error);
                  eng.lastEventAt = Date.now();
                  eng.errors++;
                  logWarn("P2P", "segment error", {
                    seg: eng.lastErrorSeg, source: downloadSource, error: eng.lastError,
                  });
                });
                hls.p2pEngine.addEventListener("onSegmentAbort", () => {
                  eng.aborts++;
                  eng.lastEventAt = Date.now();
                });
                hls.p2pEngine.addEventListener("onChunkUploaded", (bytesLength) => {
                  stats.uploadBytes += bytesLength;
                });
                hls.p2pEngine.addEventListener("onPeerConnect", ({ peerId }) => {
                  stats.peers.add(peerId);
                });
                hls.p2pEngine.addEventListener("onPeerClose", ({ peerId }) => {
                  stats.peers.delete(peerId);
                });
                hls.p2pEngine.addEventListener("onTrackerError", ({ error }) => {
                  console.error("[P2P] Tracker error:", error);
                });
              },
            },
          });
        } else {
          // VPS mode — segments come from VPS cache, no P2P needed
          hls = new Hls(hlsConfig);
        }

        hlsRef.current = hls;

        hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
          if (!mounted) return;
          logEvent("HLS", "manifest parsed", {
            session: sessionId?.substring(0, 8),
            levels: data?.levels?.length,
            startOffsetS: offset,
            roomPosS: syncStateRef.current?.position ?? "none",
            willSeekToRoom: (!isHostRef.current || didAdoptRef.current)
              && (syncStateRef.current?.position ?? 0) > DRIFT_THRESHOLD_S,
          });

          // The transcode is real from here on, so seek classification can trust
          // the element again — and only now do we know what offset the running
          // session actually started at. Recording the requested offset earlier
          // meant a seek could be compared against a transcode that had been
          // asked for but never existed.
          setRestartPending(false);
          if (sessionOwner && !didAdoptRef.current) {
            sessionStartOffsetRef.current = startOffset;
            // The playlist covers the whole runtime and always starts at 0, so a
            // resume or a post-rebuild restart (subtitle/track change, error
            // recovery) has to seek to where playback should be — the server no
            // longer bakes the offset into the stream.
            if (startOffset > 0) video.currentTime = startOffset;
          } else {
            // We didn't start this transcode, so `startOffset` describes nothing
            // — the room does. Without this a joiner (and every promoted host,
            // which is worse, because it owns the seeking) assumed the session
            // began at 0:00, took the in-place path for every backward seek, and
            // sat out the full stall timeout before restarting.
            sessionStartOffsetRef.current = syncStateRef.current?.sessionOffset ?? 0;
          }

          // Clear track switching overlay
          setTrackSwitching(null);
          canvasRef.current = null;

          // Clear recovery overlay
          setRecovering(false);
          // A manifest parsed means there is a live stream again, whatever got
          // us here — clear the terminal state too.
          setPlaybackDead(false);

          // Viewer joining mid-playback (or a host adopting a live session):
          // seek to the room's position immediately instead of waiting for the
          // 5s heartbeat drift threshold.
          const followingRoom = !isHostRef.current || didAdoptRef.current;
          if (followingRoom && syncActionsRef.current) {
            const syncPos = syncStateRef.current?.position;
            if (syncPos && syncPos > DRIFT_THRESHOLD_S) {
              video.currentTime = syncPos;
            }
          }

          // Pre-fetch cache ensures segments arrive instantly — play as soon as
          // the manifest is parsed, unless we're following a room that is
          // *paused*. That case used to autoplay anyway and then never correct
          // itself: the pause had already happened, so no command was coming,
          // and heartbeats deliberately don't drive transport. Joining a paused
          // film meant watching it alone while everyone else sat on a still.
          const roomPaused = followingRoom && syncStateRef.current?.playing === false;
          if (roomPaused) {
            logEvent("HLS", "manifest ready but room is paused — holding", {
              session: sessionId?.substring(0, 8),
              roomPosS: syncStateRef.current?.position ?? "none",
            });
            setBuffering(false);
          } else {
            video.play().catch((err) => console.warn("Autoplay prevented:", err));
          }

          // Host: broadcast play with sessionId when manifest is ready. Skip it
          // when adopting an already-live session — the room is already on it,
          // and "play" would reset everyone's position to 0.
          if (isHostRef.current && !didAdoptRef.current) {
            // Send the formatted title, not the bare episode name — viewers
            // reconstruct their item from sync state alone (no show/season
            // fields), so this string is all they have to display.
            //
            // The offset goes with it so the room's position starts where this
            // transcode does — a resume from history, or a seek that needed a
            // restart. Without it "play" resets everyone to 0:00 until the next
            // heartbeat drags them back.
            syncActionsRef.current?.sendPlay(
              item.ratingKey, formatMediaTitle(item), subtitlesOnRef.current, sessionId!,
              startOffset > 0 ? startOffset : undefined,
            );
          }
        });

        // Clear error banner and reset retry count when recovery succeeds
        hls.on(Hls.Events.FRAG_LOADED, () => {
          if (mounted) {
            setError(null);
            setBuffering(false);
            retryCountRef.current = 0;
            networkRetryRef.current = 0;
            recoveryAttemptRef.current = 0;
            mediaErrorCountRef.current = 0;
            hlsDeadRef.current = false;
          }
        });

        // Non-fatal errors are the early warning: a run of fragment timeouts or
        // gap-jumps usually precedes the fatal one by several seconds, and
        // without them the log shows a stream dying with no run-up.
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) return;
          logWarn("HLS", "non-fatal error", {
            type: data.type,
            details: data.details,
            session: sessionId?.substring(0, 8),
            frag: data.frag?.sn,
            httpStatus: data.response?.code,
            ...snapshot(videoRef.current),
          });
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          // A restart that dies before parsing a manifest would otherwise leave
          // this latched, and every later seek would skip the cheap in-place
          // path forever.
          setRestartPending(false);
          logError("HLS", "fatal error", {
            type: data.type,
            details: data.details,
            session: sessionId?.substring(0, 8),
            owner: ownsSessionRef.current,
            host: isHostRef.current,
            httpStatus: data.response?.code,
            url: data.frag?.url ?? data.url,
            ...snapshot(videoRef.current),
          });

          // MEDIA_ERROR: hls.js's own recovery, escalating and then giving up.
          //
          // This used to call recoverMediaError() unconditionally and return,
          // with no counter — the only error class here without one. A buffer
          // that stays broken then recovers, fails, recovers, forever, logging
          // each round and never reaching the teardown path below that would
          // restart the transcode and actually fix it. The escalation (swap the
          // audio codec on the second try) is hls.js's own documented sequence.
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            const sinceLast = Date.now() - lastMediaErrorAtRef.current;
            // A fresh episode of trouble rather than the same one repeating —
            // a stream that ran clean for a minute has earned a full budget.
            if (sinceLast > MEDIA_ERROR_RESET_MS) mediaErrorCountRef.current = 0;
            lastMediaErrorAtRef.current = Date.now();
            mediaErrorCountRef.current++;

            if (mediaErrorCountRef.current <= MAX_MEDIA_ERROR_RECOVERIES) {
              logWarn("HLS", "recoverMediaError", {
                details: data.details,
                attempt: mediaErrorCountRef.current,
                max: MAX_MEDIA_ERROR_RECOVERIES,
                swapAudioCodec: mediaErrorCountRef.current > 1,
              });
              if (mediaErrorCountRef.current > 1) hls.swapAudioCodec();
              hls.recoverMediaError();
              return;
            }
            logError("HLS", "media error recovery exhausted, falling through to restart", {
              details: data.details,
              attempts: mediaErrorCountRef.current,
            });
            // Falls through to the viewer-retry / host-recovery paths below,
            // which rebuild the pipeline instead of nudging the same broken one.
          }

          // NETWORK_ERROR: try hls.startLoad() first (transient failures)
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetryRef.current < MAX_NETWORK_RETRIES) {
            networkRetryRef.current++;
            logWarn("HLS", "network retry via startLoad", {
              attempt: networkRetryRef.current,
              max: MAX_NETWORK_RETRIES,
              details: data.details,
            });
            hls.startLoad();
            return;
          }

          // Viewer: retry by bumping retryKey
          if (!ownsSessionRef.current) {
            if (retryCountRef.current < MAX_VIEWER_RETRIES) {
              retryCountRef.current++;
              logWarn("Viewer", "fatal error, scheduling retry", {
                attempt: retryCountRef.current,
                max: MAX_VIEWER_RETRIES,
                inMs: 2000,
                type: data.type,
              });
              setTimeout(() => {
                if (mounted) setRetryKey((k) => k + 1);
              }, 2000);
            } else {
              logError("Viewer", "retries exhausted, marking stream dead", {
                type: data.type,
                details: data.details,
              });
              if (mounted) setError(`Playback error: ${data.type}`);
              hlsDeadRef.current = true;
            }
            return;
          }

          // Host: auto-recovery
          if (recoveryAttemptRef.current < MAX_RECOVERY_ATTEMPTS) {
            recoveryAttemptRef.current++;
            const video = videoRef.current;
            // A promoted host (one that didn't mount as host) lands here when the
            // departing host's transcode is torn down on transfer — its own
            // playhead may have drifted from the room. Resume at the room's
            // last-synced position (where the old host actually was) rather than
            // this client's drifted currentTime, so the fresh transcode starts at
            // the right place instead of somewhere ahead of or behind the room.
            const roomPos = syncStateRef.current?.position;
            recoveryPositionRef.current =
              !mountedAsHostRef.current && typeof roomPos === "number" && roomPos > 0
                ? roomPos
                : (video?.currentTime ?? 0);

            canvasRef.current = captureFrame(video) ?? canvasRef.current;

            if (mounted) {
              setRecovering(true);
              setError(null);
            }

            logWarn("Host", "stream interrupted, auto-recovery scheduled", {
              attempt: recoveryAttemptRef.current,
              max: MAX_RECOVERY_ATTEMPTS,
              // Which of the two sources the resume position came from — a
              // promoted host trusts room state over its own drifted playhead,
              // and that choice decides where the fresh transcode starts.
              resumeFrom: !mountedAsHostRef.current && typeof roomPos === "number" && roomPos > 0
                ? "roomPosition"
                : "currentTime",
              resumeAtS: recoveryPositionRef.current,
              roomPosS: roomPos ?? "none",
              currentTimeS: video?.currentTime ?? "none",
              inMs: 2000,
            });

            // Wait 2s then restart transcode at saved position
            setTimeout(() => {
              if (!mounted) return;
              destroyLocal();
              if (sessionIdRef.current && sessionRegisteredRef.current) {
                logEvent("Host", "stopping session for recovery restart", {
                  session: sessionIdRef.current.substring(0, 8),
                  restartAtS: recoveryPositionRef.current,
                });
                pendingStopRef.current = stopSession(sessionIdRef.current, "hls-recovery").catch(() => {});
              }
              sessionIdRef.current = null;
              seekOffsetRef.current = recoveryPositionRef.current;
              setRetryKey((k) => k + 1);
            }, 2000);
          } else {
            // Recovery exhausted — show manual retry
            logError("Host", "recovery exhausted, tearing down", {
              attempts: recoveryAttemptRef.current,
              session: sessionIdRef.current?.substring(0, 8) ?? "none",
              ...snapshot(videoRef.current),
            });
            if (mounted) {
              setError(null);
              setRecovering(false);
              // State, not a ref. The "Stream lost" panel used to be gated on
              // recoveryAttemptRef/sessionIdRef read during render, and mutating
              // a ref schedules nothing — whether the retry button ever appeared
              // depended on some unrelated re-render happening to follow.
              setPlaybackDead(true);
            }
            destroyLocal();
            if (sessionIdRef.current && sessionRegisteredRef.current) {
              pendingStopRef.current = stopSession(sessionIdRef.current, "recovery-exhausted").catch(() => {});
            }
            sessionIdRef.current = null;
          }
        });

        // This is the moment the server first hears about the session. Before
        // it, the id exists only in this tab — DELETEing it just makes the
        // server look up something it has never seen.
        sessionRegisteredRef.current = true;
        hls.loadSource(url);
        hls.attachMedia(video);

        // Buffering indicator events
        const onWaiting = () => {
          logWarn("Video", "waiting (buffer starved)", snapshot(video));
          if (!video.paused) setBuffering(true);
        };
        const onPlaying = () => {
          logEvent("Video", "playing", snapshot(video));
          noteGoodPosition(video);
          setBuffering(false);
          // Frames are moving again, so the element's own clock is the truth
          // once more and the bar can stop holding the seek target.
          setRestartingTo(null);
          setHoldingFrame(false);
        };
        const onSeeked = () => {
          logEvent("Video", "seeked", snapshot(video));
          noteGoodPosition(video);
          if (!video.paused) setBuffering(false);
        };
        // Cheap and frequent — this is what keeps the resume fallback current
        // between the coarser events above.
        const onTimeUpdate = () => noteGoodPosition(video);
        // The element's own failure and end-of-stream events. hls.js doesn't
        // surface all of these, and a `stalled` or `emptied` with no
        // corresponding HLS error is exactly the case the log couldn't explain
        // before: something detached the media without going through the error
        // handler above.
        const onStalled = () => logWarn("Video", "stalled (no data from network)", snapshot(video));
        const onSuspend = () => logEvent("Video", "suspend", snapshot(video));
        const onEmptied = () => logWarn("Video", "emptied (media detached)", snapshot(video));
        const onAbort = () => logWarn("Video", "abort", snapshot(video));
        const onEnded = () => logEvent("Video", "ended", snapshot(video));
        const onError = () => logError("Video", "element error", snapshot(video));
        const onPause = () => logEvent("Video", "pause", snapshot(video));

        video.addEventListener("waiting", onWaiting);
        video.addEventListener("playing", onPlaying);
        video.addEventListener("seeked", onSeeked);
        video.addEventListener("timeupdate", onTimeUpdate);
        video.addEventListener("stalled", onStalled);
        video.addEventListener("suspend", onSuspend);
        video.addEventListener("emptied", onEmptied);
        video.addEventListener("abort", onAbort);
        video.addEventListener("ended", onEnded);
        video.addEventListener("error", onError);
        video.addEventListener("pause", onPause);
        bufferCleanupRef.current = () => {
          video.removeEventListener("waiting", onWaiting);
          video.removeEventListener("playing", onPlaying);
          video.removeEventListener("seeked", onSeeked);
          video.removeEventListener("timeupdate", onTimeUpdate);
          video.removeEventListener("stalled", onStalled);
          video.removeEventListener("suspend", onSuspend);
          video.removeEventListener("emptied", onEmptied);
          video.removeEventListener("abort", onAbort);
          video.removeEventListener("ended", onEnded);
          video.removeEventListener("error", onError);
          video.removeEventListener("pause", onPause);
        };
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        const token = getSessionToken();
        const sep = url.includes("?") ? "&" : "?";
        const nativeUrl = token ? `${url}${sep}token=${encodeURIComponent(token)}` : url;
        sessionRegisteredRef.current = true; // same registration point as loadSource above
        video.src = nativeUrl;
        const onLoaded = () => {
          if (!mounted) return;
          video.play().catch((err) => console.warn("Autoplay prevented:", err));
          if (isHostRef.current && !didAdoptRef.current) {
            // Send the formatted title, not the bare episode name — viewers
            // reconstruct their item from sync state alone (no show/season
            // fields), so this string is all they have to display.
            syncActionsRef.current?.sendPlay(
              item.ratingKey, formatMediaTitle(item), subtitlesOnRef.current, sessionId!,
              startOffset > 0 ? startOffset : undefined,
            );
          }
        };
        video.addEventListener("loadedmetadata", onLoaded, { once: true });
      } else {
        setError("HLS playback is not supported in this browser");
        return;
      }

      // Only the session owner pings to keep the transcode alive.
      // Fire immediately to send the first timeline update ASAP — Plex
      // throttles HTTP segment delivery until it knows our playback position.
      if (sessionOwner) {
        // This assignment is unguarded, so if the promotion effect started an
        // interval while start() was still awaiting above, that one is orphaned
        // here and keeps pinging forever. Symptom in the server log: two ping
        // cadences for one session. Flagged rather than silently overwritten so
        // it's attributable if it shows up.
        if (pingIntervalRef.current !== null) {
          logWarn("Ping", "overwriting an existing ping interval (previous one is orphaned)", {
            session: sessionIdRef.current?.substring(0, 8) ?? "none",
          });
        }
        if (sessionIdRef.current) {
          pingSession(sessionIdRef.current, 0).catch(console.error);
        }
        pingIntervalRef.current = setInterval(() => {
          if (sessionIdRef.current) {
            const v = videoRef.current;
            const timeMs = v ? v.currentTime * 1000 : undefined;
            pingSession(sessionIdRef.current, timeMs, v ? !v.paused : undefined,
              v ? bufferAheadSeconds(v) : undefined).catch(console.error);
          }
        }, PING_INTERVAL_MS);
      }

      // Host: heartbeat every 5s (guard against double-start if promotion effect already set one)
      if (isHostRef.current && heartbeatIntervalRef.current === null) {
        heartbeatIntervalRef.current = setInterval(() => {
          const v = videoRef.current;
          if (v && v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            syncActionsRef.current?.sendHeartbeat(v.currentTime, !v.paused);
          }
        }, HEARTBEAT_INTERVAL_MS);
      }

      // Periodic health sample. Everything else here is edge-triggered, so
      // without this a stream that degrades slowly (buffer draining over a
      // minute, playback rate drifting) leaves no trace until it finally breaks
      // — and the log jumps from "started" straight to "stopped".
      healthIntervalRef.current = setInterval(() => {
        const v = videoRef.current;
        if (!v) return;

        // Reclaim media outside the window before sampling, so the numbers
        // logged below describe the buffer we intend to hold rather than
        // whatever accumulated. Belt and braces alongside hls.js's own
        // eviction — the cost of that not firing is the tab dying.
        const activeHls = hlsRef.current;
        if (activeHls && !v.seeking) {
          try {
            const trimmed = trimMediaBuffer(activeHls, v);
            if (trimmed) logEvent("Buffer", "trimmed", trimmed);
          } catch (err) {
            logWarn("Buffer", "trim failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const stats = p2pStatsRef.current;
        const amHost = isHostRef.current;
        const roomPos = syncStateRef.current?.position;
        logEvent("Health", "sample", {
          session: sessionIdRef.current?.substring(0, 8) ?? "none",
          role: amHost ? "host" : "viewer",
          owner: ownsSessionRef.current,
          roomPosS: roomPos ?? "none",
          // Drift is only meaningful for a viewer. The server excludes the
          // sender from its own broadcast, so the host's copy of the room
          // position is whatever it last *received* — it sits at the session
          // start offset all session and produced readings like driftS=466 on a
          // perfectly healthy stream, which is noise in exactly the log you go
          // to when something is wrong.
          driftS: !amHost && roomPos != null ? v.currentTime - roomPos : "n/a(host)",
          peers: stats.peers.size,
          p2pMB: stats.p2pBytes / 1e6,
          httpMB: stats.httpBytes / 1e6,
          ...heapSample(),
          ...snapshot(v),
        });

        // Stall watchdog. A stall that throws an error is handled by the
        // hls.js ERROR path; this catches the silent one — playback wedged
        // with the buffer parked and nothing logged. When the playhead has
        // not advanced between ticks while the element still believes it is
        // playing and the forward buffer is spent, dump the two states that
        // pin the cause: what the engine last fetched, and what hls.js's
        // stream controller is doing. Logged once per episode.
        const prevTime = lastTickTimeRef.current;
        const advanced = prevTime < 0 || v.currentTime - prevTime > 0.1;
        lastTickTimeRef.current = v.currentTime;
        // currentTime > 1 excludes cold-start pre-roll, where sitting at 0
        // while the first segments arrive is buffering, not a wedge.
        const wedged = v.currentTime > 1 && !v.paused && !v.seeking
          && !advanced && bufferAheadSeconds(v) < 1;
        if (wedged && !stallLoggedRef.current) {
          stallLoggedRef.current = true;
          const eng = engineLoaderRef.current;
          logWarn("Stall", "playhead wedged with buffer spent", {
            session: sessionIdRef.current?.substring(0, 8) ?? "none",
            role: amHost ? "host" : "viewer",
            peers: stats.peers.size,
            // Engine side: has it fetched anything past the buffer edge?
            engStartSeg: eng.lastStartSeg,
            engLoadedSeg: eng.lastLoadedSeg,
            engErrorSeg: eng.lastErrorSeg,
            engLastError: eng.lastError,
            engIdleMs: eng.lastEventAt ? Date.now() - eng.lastEventAt : "n/a",
            engCounts: `start=${eng.starts} loaded=${eng.loaded} err=${eng.errors} abort=${eng.aborts}`,
            // hls.js side: is the stream controller still trying to load?
            ...hlsLoadingState(hlsRef.current),
            ...snapshot(v),
          });
        } else if (advanced) {
          stallLoggedRef.current = false;
        }
      }, HEALTH_SAMPLE_MS);
    }

    start();

    return () => {
      mounted = false;
      // Grab the frame before the pipeline goes, so whatever comes next has
      // something to show instead of black. This runs for every rebuild: the
      // host's own seek restart, a subtitle change, and — the case that matters
      // most — a viewer being pulled onto the host's new session, which they
      // did not ask for and cannot anticipate.
      const held = captureFrame(videoRef.current);
      if (held) {
        canvasRef.current = held;
        setHoldingFrame(true);
      }
      destroyLocal();
      if (restartTimerRef.current !== null) {
        clearTimeout(restartTimerRef.current);
        restartTimerRef.current = null;
      }
      // Deliberately does NOT clear restartPendingRef.
      //
      // It used to, on the reasoning that whatever came next would re-establish
      // it. What comes next is *this effect re-running* — the cleanup fires
      // first, so the flag was cleared by the very commit that set it, and
      // "restart already pending" was true for about a millisecond in its
      // entire life. Every seek arriving during a rebuild therefore classified
      // itself against a detached element reporting position 0, no buffer and a
      // session offset from a transcode that had never existed, concluded it
      // needed a restart, and killed the one that was still starting up. That is
      // the storm: thirteen transcodes in one minute, eleven of them destroyed
      // before Plex answered. It is cleared where it actually stops being true —
      // MANIFEST_PARSED, a fatal error, or the age bound in isRestartPending.
      // Only the session owner stops the Plex transcode, and only if the server
      // was ever told the session exists. Without the second condition a seek
      // landing inside start()'s wait sends a DELETE for an id that only ever
      // lived in this tab — 25 of 30 teardowns in one stress-test run.
      if (ownsSessionRef.current && sessionIdRef.current && sessionRegisteredRef.current) {
        logEvent("HLS", "effect cleanup stopping session", {
          session: sessionIdRef.current.substring(0, 8),
          ...snapshot(videoRef.current),
        });
        pendingStopRef.current = stopSession(sessionIdRef.current, "effect-cleanup").catch(() => {});
        sessionIdRef.current = null;
      } else if (ownsSessionRef.current && sessionIdRef.current) {
        logEvent("HLS", "effect cleanup discarding unregistered session", {
          session: sessionIdRef.current.substring(0, 8),
        });
        sessionIdRef.current = null;
      } else {
        logEvent("HLS", "effect cleanup (not session owner, transcode left running)", {
          session: sessionIdRef.current?.substring(0, 8) ?? "none",
          ownsSession: ownsSessionRef.current,
        });
      }
    };
    // setRestartPending is a stable useCallback with no deps; listing it keeps
    // the lint rule honest without changing when this effect runs.
  }, [item.ratingKey, subtitles, destroyLocal, followSessionId, retryKey, vpsRelay, setRestartPending]);

  // Viewer: respond to explicit host commands (play/pause/resume/seek)
  // Does NOT fire on heartbeats — both clients share the same HLS stream
  // so they naturally stay in sync without constant seeking.
  // The host runs this too, because a co-host's transport commands arrive the
  // same way. The server excludes the sender from its broadcast, so anything the
  // host receives here necessarily originated elsewhere and is safe to apply.
  useEffect(() => {
    if (!syncState || syncState.commandSeq === 0) return;
    const amHost = isHostRef.current;

    // Viewer recovery: if HLS died after exhausting retries, a new host command
    // means the stream may be alive again — reset and retry
    if (!amHost && hlsDeadRef.current) {
      hlsDeadRef.current = false;
      retryCountRef.current = 0;
      setRetryKey((k) => k + 1);
      return;
    }

    const video = videoRef.current;
    if (!video) return;

    // Was this a full room snapshot (a join / reconnect) rather than someone's
    // command? Consumed here so it's answered exactly once.
    const isSnapshot = syncState.stateSeq !== appliedStateSeqRef.current;
    appliedStateSeqRef.current = syncState.stateSeq;

    // A host does not take playback instructions from a snapshot of its own
    // last report. After a socket blip that report is stale by up to a
    // heartbeat, and if the host paused while the socket was down the room
    // never heard about it at all — so applying the snapshot un-paused the
    // host, or dragged its playhead back to wherever it had last checked in,
    // and then broadcast that as the room's truth. The re-assert effect below
    // pushes the correction the other way, which is the right direction.
    if (amHost && isSnapshot && sessionIdRef.current) {
      logEvent("Sync", "host ignoring room snapshot (we are the authority)", {
        stateSeq: syncState.stateSeq,
        roomPosS: syncState.position,
        roomPlaying: syncState.playing,
        ownPosS: video.currentTime,
        ownPaused: video.paused,
      });
      appliedSeekSeqRef.current = syncState.seekSeq;
      return;
    }

    // Did this command carry a seek we haven't acted on, or is it a play/pause/
    // resume that merely came with a position attached? Consumed here so the
    // same seek can't be re-applied by the next unrelated command.
    const isNewSeek = syncState.seekSeq !== appliedSeekSeqRef.current;
    appliedSeekSeqRef.current = syncState.seekSeq;

    // Sync play/pause state
    if (syncState.playing && video.paused) {
      video.play().catch(() => {});
    } else if (!syncState.playing && !video.paused) {
      video.pause();
    }

    // Every command this client acts on, with both positions. This is where the
    // stale-position bug lived, so the decision is recorded whether or not it
    // ends up moving anything.
    logEvent("Sync", "command applied", {
      commandSeq: syncState.commandSeq,
      seekSeq: syncState.seekSeq,
      isNewSeek,
      roomPlaying: syncState.playing,
      roomPosS: syncState.position,
      driftS: syncState.position > 0 ? video.currentTime - syncState.position : "n/a",
      role: amHost ? "host" : "viewer",
      ...snapshot(video),
    });

    // Seek correction — only on explicit commands, with generous threshold
    if (syncState.position > 0) {
      const drift = Math.abs(video.currentTime - syncState.position);
      if (drift > DRIFT_THRESHOLD_S) {
        if (amHost) {
          // The host owns the transcode, so a co-host's seek has to go through
          // the smart path — a far jump needs a restart at the new offset, not a
          // bare currentTime write. broadcast=false stops it echoing back out.
          //
          // Gated on an actual seek, because that restart is expensive and the
          // host is the authority on position: pause/resume are rebroadcast with
          // the room's *cached* position (server sync.ts), which lags behind the
          // host's own playhead and can be minutes stale. Acting on those let a
          // co-host's pause drag the running transcode backwards and restart it
          // mid-episode. A real seek still lands; a stale position no longer does.
          if (isNewSeek) {
            handleHostSeekRef.current(syncState.position, false);
          } else {
            logWarn("Sync", "host ignoring drifting position on non-seek command", {
              commandSeq: syncState.commandSeq,
              roomPosS: syncState.position,
              ownPosS: video.currentTime,
              driftS: drift,
            });
          }
        } else if (video.readyState === HTMLMediaElement.HAVE_NOTHING) {
          // No media attached yet — this fires on the first command after a
          // viewer joins, before the HLS effect has even run. Writing
          // currentTime here does nothing except leave a bogus playhead for the
          // manifest handler to trip over; MANIFEST_PARSED positions us instead.
          logEvent("Sync", "viewer skipping correction (no media yet)", {
            toS: syncState.position,
            driftS: drift,
          });
        } else {
          logEvent("Sync", "viewer correcting to room position", {
            fromS: video.currentTime,
            toS: syncState.position,
            driftS: drift,
          });
          lastDriftCorrectionRef.current = Date.now();
          resetPlaybackRate(video);
          video.currentTime = syncState.position;
        }
      }
    }
  }, [syncState?.commandSeq]);

  /**
   * Host: re-assert the room's playback state after a (re)join.
   *
   * The room's copy of "what's playing, where, and whether" comes entirely from
   * this client, so anything the server holds while our socket is down is
   * whatever we last managed to send. On reconnect the snapshot is therefore
   * stale by construction — the command effect above refuses to act on it, and
   * this pushes the truth back out instead. Without both halves the room and
   * the host disagreed until the next heartbeat, and viewers spent that window
   * being corrected towards a position the host had already left.
   */
  useEffect(() => {
    const s = syncStateRef.current;
    if (!s || s.stateSeq === 0 || !isHostRef.current) return;
    const video = videoRef.current;
    const sid = sessionIdRef.current;
    const currentItem = itemRef.current;
    if (!video || !sid || !sessionRegisteredRef.current) return;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    // The room lost track of what we're playing (a stray stop, or it never heard
    // the restart) — re-announce it before correcting the position, or viewers
    // have nothing to attach to.
    if (s.hlsSessionId !== sid || s.ratingKey !== currentItem.ratingKey) {
      logEvent("Sync", "host re-announcing session after reconnect", {
        roomSession: s.hlsSessionId?.substring(0, 8) ?? "none",
        ownSession: sid.substring(0, 8),
        roomRatingKey: s.ratingKey ?? "none",
      });
      syncActionsRef.current?.sendPlay(
        currentItem.ratingKey, formatMediaTitle(currentItem), subtitlesOnRef.current, sid,
        video.currentTime > 0 ? video.currentTime : undefined,
        // The transcode's own start, not the playhead — a viewer told the wrong
        // floor treats every reachable backward seek as needing a restart.
        sessionStartOffsetRef.current,
      );
    }
    // Then the position and play state. A pause goes out as a real pause rather
    // than a heartbeat, because "play" above optimistically marks us playing and
    // because it is the pause the room most likely missed — it is the one that
    // happened while the socket was down.
    if (video.paused) syncActionsRef.current?.sendPause(video.currentTime);
    else syncActionsRef.current?.sendHeartbeat(video.currentTime, true);
  }, [syncState?.stateSeq]);

  /**
   * Everyone but the host: keep the element's play state matching the room's.
   *
   * The command effect only fires on explicit commands, and heartbeats
   * deliberately don't bump `commandSeq` — so any path that changes the room's
   * play state without a command reaching this client left it playing on its
   * own. Joining a paused room did exactly that: the manifest handler pressed
   * play, no command was coming (the pause had already happened), and the
   * heartbeats that said "paused" were ignored by design. One person watched
   * ahead while the room sat still, and only a later pause or seek pulled them
   * back.
   *
   * The host is excluded because it *is* the play state; a co-host is not, so it
   * follows the room like anyone else — its own presses are already reflected
   * optimistically, which makes this a no-op for them rather than a fight.
   */
  useEffect(() => {
    if (isHostRef.current || !syncState) return;
    const video = videoRef.current;
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    if (syncState.playing && video.paused) {
      logEvent("Sync", "following room into play", snapshot(video));
      video.play().catch(() => {});
    } else if (!syncState.playing && !video.paused) {
      logEvent("Sync", "following room into pause", snapshot(video));
      resetPlaybackRate(video);
      video.pause();
    }
  }, [syncState?.playing, syncState?.commandSeq, isHost]);

  // Viewer status: flash "Host is seeking…" for a moment after each seek command.
  // seekSeq bumps once per host seek; the flag auto-clears so it reads as a brief
  // transient rather than a stuck state. Host/co-hosts (who can control) skip it.
  useEffect(() => {
    if (!syncState || syncState.seekSeq === 0 || canControl) return;
    setHostSeeking(true);
    // Hold the bar at where the host is heading. A host seek that restarts the
    // transcode mints a new session id, which tears down and rebuilds every
    // viewer's HLS too — so viewers watched their own scrub bar drop to 0:00
    // and crawl back exactly like the host did.
    setRestartingTo(syncState.position);
    // Two different lifetimes. The "seeking" badge is a deliberate flash. The
    // held position has to survive as long as the reload does — clearing it on
    // the same 1.4s timer put the bar back to 0:00 partway through, which is
    // the very thing it exists to prevent. `playing` clears it; this is only a
    // backstop for a reload that never completes.
    const badge = setTimeout(() => setHostSeeking(false), 1400);
    const held = setTimeout(() => setRestartingTo(null), 20_000);
    return () => { clearTimeout(badge); clearTimeout(held); };
  }, [syncState?.seekSeq, canControl]);

  // Viewer: periodic drift correction on heartbeats (larger threshold than explicit commands).
  // Also fires on explicit command position updates, but the command-based effect above
  // already corrects at a tighter 2s threshold, making this a no-op in that case.
  //
  // Heavily guarded, because an unguarded version of this is a trap: heartbeats
  // arrive every 5s, and writing currentTime makes hls.js drop whatever fragment
  // it had in flight and restart loading at the new position. If the seek takes
  // longer than the heartbeat interval to satisfy — which it does on a cold
  // join — the next heartbeat cancels it again and the viewer never appends a
  // single byte. Observed in the wild as a permanently black screen: tens of MB
  // downloaded, buffer frozen at the transcode's first half-second, `seeking`
  // stuck true, and drift pinned at exactly one heartbeat because the playhead
  // never advanced between corrections. Rejoining didn't help, since the new
  // mount fell straight back into the same loop.
  useEffect(() => {
    const video = videoRef.current;
    if (isHostRef.current || !syncState) {
      resetPlaybackRate(video);
      return;
    }
    if (!video) return;
    if (!syncState.playing || video.paused || syncState.position <= 0) {
      resetPlaybackRate(video);
      return;
    }

    // Signed, because the direction decides whether we speed up or slow down.
    // Positive means this client is ahead of the room.
    const signedDrift = video.currentTime - syncState.position;
    const drift = Math.abs(signedDrift);

    if (drift <= HARD_SYNC_DRIFT_S) {
      // Close enough to close the gap by playing at a slightly different speed,
      // which nobody can see, instead of seeking, which everybody can. A seek
      // discards the fragment hls.js has in flight and reloads from the target,
      // so the "correction" is itself a stutter — and at a fixed threshold the
      // room settles just under it and stays permanently out of step.
      stalledSeekSinceRef.current = null;
      if (drift <= SOFT_SYNC_DEAD_ZONE_S) {
        resetPlaybackRate(video);
        return;
      }
      // Speeding up spends forward buffer. If there isn't any to spend, staying
      // behind is better than starving — the room will wait for us via the
      // host's own stall handling long before this matters.
      if (signedDrift < 0 && bufferAheadSeconds(video) < SOFT_SYNC_MIN_BUFFER_S) {
        resetPlaybackRate(video);
        return;
      }
      const scale = Math.min(1, drift / SOFT_SYNC_FULL_SCALE_S);
      const target = Math.round((1 + (signedDrift > 0 ? -1 : 1) * MAX_RATE_ADJUST * scale) * 1000) / 1000;
      if (Math.abs(video.playbackRate - target) < 0.005) return;
      video.playbackRate = target;
      return;
    }

    // Past the soft band: a real correction is coming, so stop nudging first —
    // otherwise the rate survives the seek and keeps pulling afterwards.
    resetPlaybackRate(video);

    // A seek already in flight is heading to the right place. Re-issuing it only
    // throws away the fragment that would have satisfied it.
    if (video.seeking || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      const since = stalledSeekSinceRef.current ?? Date.now();
      stalledSeekSinceRef.current = since;
      const stalledMs = Date.now() - since;

      // Long enough that the target clearly isn't reachable in this session —
      // the segments aren't coming, so re-seeking forever won't help. Rebuild
      // the HLS pipeline instead. This is the escape hatch that makes the frozen
      // case recoverable without the user leaving and rejoining (which didn't
      // work anyway).
      if (stalledMs > SEEK_STALL_REBUILD_MS) {
        logError("Viewer", "seek stalled with no progress, rebuilding HLS", {
          stalledMs,
          driftS: drift,
          targetS: syncState.position,
          ...snapshot(video),
        });
        stalledSeekSinceRef.current = null;
        setRetryKey((k) => k + 1);
        return;
      }

      logWarn("Viewer", "drift correction suppressed (seek in flight)", {
        driftS: drift,
        stalledMs,
        targetS: syncState.position,
        seeking: video.seeking,
        readyState: video.readyState,
      });
      return;
    }

    // Don't re-issue the same correction faster than the media can service it.
    const sinceLast = Date.now() - lastDriftCorrectionRef.current;
    if (sinceLast < DRIFT_CORRECTION_COOLDOWN_MS) {
      logWarn("Viewer", "drift correction suppressed (cooldown)", {
        driftS: drift,
        sinceLastMs: sinceLast,
      });
      return;
    }

    lastDriftCorrectionRef.current = Date.now();
    stalledSeekSinceRef.current = null;
    logWarn("Viewer", "heartbeat drift correction", {
      driftS: drift,
      fromS: video.currentTime,
      toS: syncState.position,
      ...snapshot(video),
    });
    video.currentTime = syncState.position;
  }, [syncState?.position]);

  // Seek, whole-timeline JIT edition. Every segment index is producible on
  // demand by our ffmpeg (a seek is just a fetch of a different segment), so
  // seeking is a plain playhead move — no transcode teardown, no restart. The
  // heavy coalescing/restart machinery the Plex transcode needed is gone.
  // `broadcast` is false when we're applying a seek that came *from* someone
  // else (a co-host) — re-sending it would echo the command around the room.
  const handleSeekRestart = useCallback((positionSeconds: number, broadcast = true) => {
    const video = videoRef.current;
    if (video) {
      resetPlaybackRate(video);
      if (!isPositionBuffered(video, positionSeconds)) setBuffering(true);
      video.currentTime = positionSeconds;
    }
    if (broadcast) syncActionsRef.current?.sendSeek(positionSeconds);
  }, []);

  // Host seek entry point. With JIT HLS this is always an in-place seek: hls.js
  // requests the target segment and the server produces it, so backward and
  // far-forward jumps are as cheap as a buffered one.
  const handleHostSeek = useCallback((positionSeconds: number, broadcast = true) => {
    const video = videoRef.current;
    if (!video) {
      if (broadcast) syncActionsRef.current?.sendSeek(positionSeconds);
      return;
    }
    if (seekStallTimerRef.current !== null) {
      clearTimeout(seekStallTimerRef.current);
      seekStallTimerRef.current = null;
    }
    resetPlaybackRate(video);
    const wasBuffered = isPositionBuffered(video, positionSeconds);
    logEvent("Seek", "host seek", {
      targetS: positionSeconds,
      broadcast,
      buffered: wasBuffered,
      ...snapshot(video),
    });
    video.currentTime = positionSeconds;
    if (broadcast) syncActionsRef.current?.sendSeek(positionSeconds);
    // Not buffered → hls.js is fetching (possibly a fresh encode after a big
    // jump); show the spinner until frames resume (the `playing` handler clears it).
    if (!wasBuffered) setBuffering(true);
  }, []);

  // Live ref so the command-handling effect (declared above) can reach the
  // current handleHostSeek without listing it as a dep — naming it directly in a
  // dep array would evaluate it during render, before this const is initialised.
  const handleHostSeekRef = useRef(handleHostSeek);
  handleHostSeekRef.current = handleHostSeek;

  /**
   * Seek entry point for whoever is driving. The host owns the Plex transcode so
   * it takes the smart path (in-place vs restart-at-offset). A co-host doesn't
   * own the session — it just moves its own playhead and sends the command; the
   * host receives it and does any transcode work, then re-announces the new
   * session id via sendPlay on MANIFEST_PARSED.
   */
  const handleSeekCommand = useCallback((positionSeconds: number) => {
    if (isHostRef.current) {
      handleHostSeek(positionSeconds);
      return;
    }
    const video = videoRef.current;
    if (video) {
      resetPlaybackRate(video);
      video.currentTime = positionSeconds;
      // A co-host's seek usually makes the host restart the transcode, which
      // tears this client's stream down and rebuilds it — and until it does,
      // the element reports 0. The host holds its scrub bar at the target
      // through that; the co-host who *asked* for the seek was the one person
      // watching their own bar drop to 0:00 and crawl back.
      if (!isPositionBuffered(video, positionSeconds)) {
        setBuffering(true);
        setRestartingTo(positionSeconds);
        // Frames resuming clears this (see the `playing` handler); the timer is
        // only a backstop for a rebuild that never completes, so the bar can't
        // be left pinned to a target nothing is heading for.
        if (coHostSeekHoldRef.current !== null) clearTimeout(coHostSeekHoldRef.current);
        coHostSeekHoldRef.current = setTimeout(() => {
          coHostSeekHoldRef.current = null;
          setRestartingTo(null);
        }, 20_000);
      }
    }
    syncActionsRef.current?.sendSeek(positionSeconds);
  }, [handleHostSeek]);

  /**
   * Toggle playback and announce it to the room. Shared by the spacebar shortcut
   * and by clicking the video itself, so both stay in step.
   *
   * Refs rather than state throughout: this is called from a window key listener
   * that is attached once, and re-binding it on every play/pause flip would drop
   * keystrokes during the swap.
   */
  const togglePlayPause = useCallback(() => {
    const video = videoRef.current;
    if (!video || !canControlRef.current) return;
    // On touch, the tap that brings the controls back shouldn't also pause. The
    // pointerdown that revealed them fires before this click, so Controls
    // records it and we ask rather than trying to observe it here.
    if (controlsRef.current?.consumeRevealTap()) return;
    const resuming = video.paused;
    if (resuming) {
      video.play();
      syncActionsRef.current?.sendResume(video.currentTime);
    } else {
      video.pause();
      syncActionsRef.current?.sendPause(video.currentTime);
    }
    // Acknowledge the input. Clicking the picture otherwise gives no feedback
    // until the frame moves, which on a paused-to-playing transition can be
    // long enough to leave you wondering whether the click registered.
    setTapAck({ kind: resuming ? "play" : "pause", at: Date.now() });
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const video = videoRef.current;
      if (!video) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      // Chords with Ctrl/Cmd/Alt belong to the browser or OS (Ctrl+Shift+I =
      // DevTools, Ctrl+Shift+M = device toolbar) — never treat them as ours
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      switch (e.key) {
        case "i":
        case "I":
          // Stats-for-nerds panel — available to every viewer (each has their
          // own HLS stream and buffer to inspect), not just the host.
          e.preventDefault();
          setShowStats((s) => !s);
          break;
        case " ":
          e.preventDefault();
          togglePlayPause();
          break;
        // Routed through the controls' skip accumulator rather than seeking
        // here, so holding or spamming an arrow key stacks into one seek and
        // shows the same running total as the on-screen ±10s buttons. Clamping
        // and the canControl check live in there too.
        case "ArrowLeft":
          e.preventDefault();
          controlsRef.current?.queueSkip(-10);
          break;
        case "ArrowRight":
          e.preventDefault();
          controlsRef.current?.queueSkip(10);
          break;
        case "m":
        case "M":
          e.preventDefault();
          if (video.volume > 0) {
            (video as any).__prevVolume = video.volume;
            video.volume = 0;
          } else {
            // Fall back to the remembered level rather than full volume — this
            // path is hit when something else (the slider) did the muting.
            video.volume = (video as any).__prevVolume ?? loadVolume();
          }
          break;
        case "ArrowUp":
          e.preventDefault();
          video.volume = Math.min(1, video.volume + 0.1);
          break;
        case "ArrowDown":
          e.preventDefault();
          video.volume = Math.max(0, video.volume - 0.1);
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // Everything the handler touches is a ref or a stable setter now that the
    // arrows go through controlsRef — the old handleHostSeek dep only existed to
    // keep the seek closure fresh, and rebinding the listener on every change of
    // it was never doing anything else.
  }, []);

  /** Tear the stream down without deciding where to go afterwards. */
  const teardownPlayback = useCallback((reason: string) => {
    logEvent("Player", "tearing down playback", {
      reason,
      isHost: isHostRef.current,
      ownsSession: ownsSessionRef.current,
      session: sessionIdRef.current?.substring(0, 8) ?? "none",
      ...snapshot(videoRef.current),
    });
    destroyLocal();
    if (restartTimerRef.current !== null) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    // Only the session owner stops the Plex transcode, and only one the server
    // knows about.
    if (ownsSessionRef.current && sessionIdRef.current && sessionRegisteredRef.current) {
      pendingStopRef.current = stopSession(sessionIdRef.current, "end-playback").catch(() => {});
    }
    if (ownsSessionRef.current) sessionIdRef.current = null;
    if (isHostRef.current) {
      syncActionsRef.current?.sendStop();
    }
  }, [destroyLocal]);

  const endPlayback = useCallback(() => {
    teardownPlayback("user left the player");
    onBack();
  }, [teardownPlayback, onBack]);

  /**
   * Leave a finished episode for the show it belongs to, rather than for the
   * episode's own page.
   *
   * Backing out of an episode normally returns to where you came from, which is
   * right when you chose to leave. Reaching the end of one is different: the
   * episode you just watched is the least useful thing to be looking at, and
   * the show is where the rest of it is. Falls back to a plain back when there
   * is no show to go to — a film, or an episode whose parent we never learned.
   */
  const exitToShow = useCallback(() => {
    teardownPlayback("item finished");
    if (item.type === "episode" && item.grandparentRatingKey && onFinished) {
      onFinished(item);
      return;
    }
    onBack();
  }, [teardownPlayback, onBack, onFinished, item]);

  const handleBack = useCallback(() => {
    // The host backing out ends the stream for the whole room, so confirm
    // first when anyone else is watching. Viewers only leave for themselves.
    const hasOtherViewers = (syncStateRef.current?.participants ?? []).some(
      (p) => p.userId !== selfUserId,
    );
    if (isHostRef.current && hasOtherViewers) {
      setConfirmingEnd(true);
      return;
    }
    endPlayback();
  }, [endPlayback, selfUserId]);

  const handleTrackChange = useCallback(async (partId: number, audioStreamID?: number, subtitleStreamID?: number) => {
    if (!sessionIdRef.current) return;

    // Selecting the track that is already playing costs the whole room a
    // transcode restart — several seconds of rebuffering for everyone — and
    // changes nothing when it comes back. Easy to hit: reopening the switcher
    // and tapping the ticked row, or two co-hosts choosing the same subtitles a
    // moment apart, which used to be two restarts back to back.
    const audioUnchanged =
      audioStreamID === undefined || currentAudioStreamRef.current === audioStreamID;
    const subtitleUnchanged =
      subtitleStreamID === undefined || currentSubtitleStreamRef.current === subtitleStreamID;
    if (audioUnchanged && subtitleUnchanged) {
      logEvent("Player", "track change skipped (already selected)", {
        partId,
        audioStreamID: audioStreamID ?? "unchanged",
        subtitleStreamID: subtitleStreamID ?? "unchanged",
      });
      setShowTrackSwitcher(false);
      return;
    }

    // Claimed before the await, so a second identical request arriving while
    // this one is in flight is recognised as a duplicate rather than starting a
    // second restart. Rolled back if Plex refuses.
    const prevAudio = currentAudioStreamRef.current;
    const prevSubtitle = currentSubtitleStreamRef.current;
    if (audioStreamID !== undefined) currentAudioStreamRef.current = audioStreamID;
    if (subtitleStreamID !== undefined) currentSubtitleStreamRef.current = subtitleStreamID;

    const video = videoRef.current;
    canvasRef.current = captureFrame(video) ?? canvasRef.current;

    // Show overlay
    setTrackSwitching(audioStreamID !== undefined ? "audio" : "subtitle");

    try {
      await setStreams(partId, { audioStreamID, subtitleStreamID });
    } catch (err) {
      logError("Player", "failed to set streams", {
        partId,
        audioStreamID,
        subtitleStreamID,
        error: err instanceof Error ? err.message : String(err),
      });
      currentAudioStreamRef.current = prevAudio;
      currentSubtitleStreamRef.current = prevSubtitle;
      setTrackSwitching(null);
      canvasRef.current = null;
      return;
    }

    // fetchMeta is cached for five minutes and carries the per-track `selected`
    // flags the switcher renders its checkmark from. Without dropping it, the
    // burn-in changes but reopening the switcher still shows the old choice —
    // "None" ticked while subtitles are plainly on screen. MovieDetail already
    // does this after its own setStreams; the in-playback path was missing it.
    invalidateMeta(item.ratingKey);

    logEvent("Player", "track changed", {
      partId,
      audioStreamID: audioStreamID ?? "unchanged",
      subtitleStreamID: subtitleStreamID ?? "unchanged",
      subtitlesOn: subtitleStreamID !== undefined ? subtitleStreamID !== 0 : subtitlesOnRef.current,
    });

    // Follow the new selection, so the restart below asks Plex to burn in
    // subtitles when a track is chosen (0 = None) rather than reusing whatever
    // the episode happened to start with. Without this, selecting a track after
    // starting with subtitles off restarts with subtitles=none and nothing
    // appears. Untouched for an audio-only change.
    if (subtitleStreamID !== undefined) {
      subtitlesOnRef.current = subtitleStreamID !== 0;
    }

    // Restart HLS session to apply new tracks, preserving current position
    if (video && video.currentTime > 0) {
      seekOffsetRef.current = video.currentTime;
    }
    setShowTrackSwitcher(false);
    setRetryKey((k) => k + 1);
    // ratingKey is a real dependency now that the meta cache is invalidated by
    // key — this Player is reused across a queue advance, so a captured initial
    // value would clear the wrong episode's entry.
  }, [item.ratingKey]);

  // Live ref so the host can apply a co-host's subtitle request from an effect
  // without listing handleTrackChange as a dep (it's declared above, but keeping
  // the pattern consistent with handleHostSeekRef).
  const handleTrackChangeRef = useRef(handleTrackChange);
  handleTrackChangeRef.current = handleTrackChange;

  /**
   * Track selection from the switcher. The host applies it directly — it owns
   * the transcode, and burned-in subtitles only change by restarting it. A
   * co-host can't do that, so it sends the request and the host performs it.
   */
  const handleTrackSelect = useCallback(
    (partId: number, audioStreamID?: number, subtitleStreamID?: number) => {
      if (isHostRef.current) {
        handleTrackChange(partId, audioStreamID, subtitleStreamID);
        return;
      }
      // Co-hosts are limited to subtitles; audio never reaches here because the
      // switcher renders in subtitlesOnly mode for them.
      if (subtitleStreamID !== undefined) {
        syncActionsRef.current?.sendSetSubtitle(partId, subtitleStreamID);
        // The host does the actual setStreams, so this client would otherwise
        // keep serving its own five-minute-old meta and show the pre-change
        // selection next time the switcher opens — same stale checkmark the
        // host used to get, reached by a different route.
        invalidateMeta(item.ratingKey);
      }
    },
    [handleTrackChange, item.ratingKey],
  );

  // Host: apply a subtitle change requested by a co-host.
  useEffect(() => {
    const req = syncState?.subtitleRequest;
    if (!req || !isHostRef.current) return;
    handleTrackChangeRef.current(req.partId, undefined, req.subtitleStreamID);
  }, [syncState?.subtitleRequest?.seq]);

  // Skip to the end of the active marker. Uses handleHostSeek (not
  // handleSeekRestart) so a typical 60-100s intro takes the cheap in-place path —
  // it's under FAR_SEEK_THRESHOLD_S, and the 6s stall timeout still covers the
  // case where those segments turn out not to be buffered. handleHostSeek also
  // calls sendSeek, so viewers follow with no sync-layer changes.
  const handleSkipMarker = useCallback(() => {
    if (!activeMarker) return;
    setActiveMarker(null); // instant feedback; the timeupdate tick would clear it ~250ms later
    handleSeekCommand(activeMarker.end);
  }, [activeMarker, handleSeekCommand]);

  /**
   * Advance to the next item: the queued one if there is one, else the
   * auto-resolved next episode. Nothing calls this automatically — playback
   * running to the end no longer advances on its own.
   */
  /** Switch the room to a specific item. Co-hosts relay; the host performs it. */
  const playItem = useCallback((target: QueueItem | null, fromQueue = false) => {
    if (!target) return;
    // Starting a title is host-only server-side, so a co-host asks the host to
    // do it rather than changing its own view to no room-wide effect.
    if (!isHostRef.current) {
      syncActionsRef.current?.sendPlayItem(target.ratingKey);
      return;
    }
    if (fromQueue) syncActionsRef.current?.sendQueueRemove(target.ratingKey);
    onPlayNext?.(target);
  }, [onPlayNext]);

  /**
   * The card's action: a queued item wins over the resolved sibling, since it's
   * a deliberate choice rather than a guess.
   */
  const playNextItem = useCallback(() => {
    const queue = syncStateRef.current?.queue;
    const queued = queue && queue.length > 0 ? queue[0] : null;
    if (queued) playItem(queued, true);
    else playItem(toQueueItem(nextEpisodeRef.current, subtitlesOnRef.current));
  }, [playItem, subtitles]);

  // Control-bar episode navigation. Deliberately ignores the queue: these mean
  // "move through the series", not "play whatever is queued next".
  const playPrevEpisode = useCallback(() => {
    playItem(toQueueItem(prevEpisodeRef.current, subtitlesOnRef.current));
  }, [playItem, subtitles]);

  const playNextEpisode = useCallback(() => {
    playItem(toQueueItem(nextEpisodeRef.current, subtitlesOnRef.current));
  }, [playItem, subtitles]);

  const playItemRef = useRef(playItem);
  playItemRef.current = playItem;

  // Host: perform a switch a co-host asked for. The ratingKey has to match one of
  // the candidates we already hold (queued item, next or previous episode) —
  // that doubles as a staleness guard, so a laggy press can't jump the room
  // somewhere unexpected after we've already moved on.
  useEffect(() => {
    const req = syncState?.playItemRequest;
    if (!req || !isHostRef.current) return;
    const queued = syncStateRef.current?.queue?.[0] ?? null;
    if (queued?.ratingKey === req.ratingKey) {
      playItemRef.current(queued, true);
      return;
    }
    for (const candidate of [nextEpisodeRef.current, prevEpisodeRef.current]) {
      if (candidate?.ratingKey === req.ratingKey) {
        playItemRef.current(toQueueItem(candidate, subtitlesOnRef.current));
        return;
      }
    }
  }, [syncState?.playItemRequest?.seq]);

  // Track whether we're near the end of the item. Replaces a version that
  // latched true and never cleared, so the card stayed up after rewinding —
  // this recomputes each tick like the marker effect and only sets on a flip.
  useEffect(() => {
    // Deliberately not gated on canControl. It used to be, which meant a viewer
    // never learned the item had finished — the end-of-playback screen is for
    // everyone, and a viewer sitting on black is exactly the case it exists for.
    // The corner "up next" card stays host-only; that gate lives on `showNextUp`,
    // not here.
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => {
      const d = video.duration;
      const remaining = d - video.currentTime;
      // No `remaining > 0` guard: once the episode finishes there is nothing on
      // screen but black, which is precisely when the card matters most. Nothing
      // auto-advances any more, so hiding it here would strand the room.
      const near = Number.isFinite(d) && d > 60 && remaining <= 30;
      setNearEnd((prev) => (prev === near ? prev : near));
    };
    // timeupdate stops firing at the end, so latch explicitly on `ended` too —
    // covers the video finishing without a final tick close enough to the end.
    // Confirmed against the server logs: `ended` does fire here, on viewers'
    // elements as well as the host's, so this is the trigger rather than a
    // guess at one.
    const onEnded = () => {
      logEvent("Video", "reached end of item", {
        ratingKey: item.ratingKey,
        canControl,
        ...snapshot(video),
      });
      setNearEnd(true);
      setPlaybackEnded(true);
    };
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("ended", onEnded);
    return () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("ended", onEnded);
    };
  }, [canControl, item.ratingKey]);

  // Track whether the playhead is inside an intro/credits window. Shown to
  // anyone with transport rights, since skipping is a transport action.
  // Recomputed from scratch each tick rather than latched, so the button clears
  // within ~250ms when playback leaves the window in either direction, and
  // reappears on a rewind back into it.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !canControl || markers.length === 0) return;
    const onTime = () => {
      const t = video.currentTime;
      const found = markers.find((m) => t >= m.start && t < m.end) ?? null;
      // Marker objects are stable for the item's lifetime, so identity comparison
      // is sound and keeps this to two re-renders per marker, not four per second.
      setActiveMarker((prev) => (prev === found ? prev : found));
    };
    video.addEventListener("timeupdate", onTime);
    return () => video.removeEventListener("timeupdate", onTime);
  }, [canControl, markers]);

  // Build rich display title for Controls top bar
  const displayTitle = formatMediaTitle(item);

  // What to offer next, and whether to offer it. A queued item wins over the
  // auto-resolved sibling — it's a deliberate choice rather than a guess.
  const queuedNext = syncState?.queue?.[0] ?? null;
  const upNextItem = queuedNext ?? nextEpisode;
  // Trigger on the credits marker OR near the end: credits markers aren't
  // guaranteed (libraries without Plex credit detection return none), so a
  // credits-only trigger would silently never fire for many users.
  const showNextUp =
    canControl &&
    !!upNextItem &&
    dismissedFor !== item.ratingKey &&
    (nearEnd || activeMarker?.type === "credits");
  const showSkip = !!activeMarker && canControl;

  // Finished, with nothing to follow it — a film, or the last episode of a run.
  // Leaving the player puts everyone back on the title's page, which is where
  // you'd go anyway; sitting on black was never a state anyone wanted to be in.
  //
  // Waits for the sibling lookup so a series never exits on a stale "nothing
  // next", and runs once — endPlayback tears down the session, and a second
  // call would try to stop a session that no longer exists.
  const exitedOnEndRef = useRef(false);
  useEffect(() => {
    if (!playbackEnded || !siblingsResolved || upNextItem) return;
    if (exitedOnEndRef.current) return;
    exitedOnEndRef.current = true;
    logEvent("Player", "playback finished with nothing next, leaving player", {
      ratingKey: item.ratingKey,
      type: item.type,
      isHost: isHostRef.current,
    });
    exitToShow();
  }, [playbackEnded, siblingsResolved, upNextItem, exitToShow, item.ratingKey, item.type]);
  useEffect(() => {
    exitedOnEndRef.current = false;
    setPlaybackDead(false);
  }, [item.ratingKey]);

  // Whether the socket has been down long enough to be worth saying so. The
  // delay is what keeps an ordinary reconnect — which takes well under a
  // second — from flashing a banner across the picture.
  const [showReconnecting, setShowReconnecting] = useState(false);
  const socketDown = syncState ? !syncState.connected : false;
  useEffect(() => {
    if (!socketDown) {
      setShowReconnecting(false);
      return;
    }
    const timer = setTimeout(() => setShowReconnecting(true), 2500);
    return () => clearTimeout(timer);
  }, [socketDown]);

  // Viewer status pill: what the host is doing to shared playback. Seeking is a
  // brief flash (takes precedence); paused persists while the stream sits paused.
  // Only for pure viewers, and never over an error/disconnect/recovery banner.
  const streamActive = !!syncState?.ratingKey && !error && !recovering && !syncState?.hostDisconnected;
  const hostPaused = !canControl && streamActive && syncState?.playing === false;
  const viewerStatus = !canControl && streamActive
    ? (hostSeeking ? "Host is seeking…" : hostPaused ? "Host paused the video" : null)
    : null;

  return (
    <div style={styles.container}>
      {syncState?.authFailed ? (
        <div style={styles.error}>Session expired — please close and restart the activity</div>
      ) : syncState?.reconnectFailed ? (
        // A retry, rather than only telling someone to leave the call and come
        // back. Twenty automatic attempts can all fail to a thirty-second
        // network blip, and the connection is usually fine by the time anyone
        // reads this.
        <div style={styles.error}>
          Connection lost
          <button style={styles.inlineRetryBtn} onClick={() => syncActions?.retryConnection()}>
            Reconnect
          </button>
        </div>
      ) : error ? (
        <div style={styles.error}>{error}</div>
      ) : showReconnecting ? (
        // A dropped socket used to be completely silent here until all twenty
        // automatic attempts had failed — over a minute of pressing pause and
        // watching nothing happen to anyone else, with no way to tell that from
        // the room simply ignoring you. Held back a couple of seconds so an
        // ordinary blip doesn't flash a banner over the film.
        <div style={styles.hostDisconnected}>
          Reconnecting to the watch party… (playback continues locally)
        </div>
      ) : syncState?.hostDisconnected ? (
        <div style={styles.hostDisconnected}>Host disconnected — waiting for reconnection...</div>
      ) : null}

      {/* Viewer status — what the host is doing to shared playback */}
      {viewerStatus && (
        <div style={styles.viewerStatus} role="status" aria-live="polite">
          {hostSeeking ? (
            <span style={styles.viewerStatusSpinner} />
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style={{ flexShrink: 0 }}>
              <rect x="4" y="3" width="3" height="10" rx="1" />
              <rect x="9" y="3" width="3" height="10" rx="1" />
            </svg>
          )}
          {viewerStatus}
        </div>
      )}

      {/* Buffering indicator */}
      {buffering && !error && (
        <div style={styles.bufferingOverlay}>
          <div style={styles.bufferingSpinner} />
          <span style={styles.bufferingText}>Loading...</span>
        </div>
      )}

      {/* Click the picture to play/pause, as every other video player does.
          togglePlayPause no-ops for a plain viewer, so the cursor is the only
          hint that differs. Overlays (controls, dialogs, skip buttons) sit above
          this and handle their own clicks, so they never fall through to here. */}
      <video
        ref={videoRef}
        style={canControl ? { ...styles.video, cursor: "pointer" } : styles.video}
        playsInline
        onClick={togglePlayPause}
      />

      {/* The last frame, standing in while the pipeline is rebuilt. Sits above
          the (currently blank) video and below every real overlay, so the
          buffering spinner and the seeking badge still read on top of it.
          Decorative only — clicks pass through to the video for play/pause. */}
      {holdingFrame && canvasRef.current && (
        <canvas
          aria-hidden="true"
          style={styles.heldFrame}
          ref={(el) => {
            const src = canvasRef.current;
            if (!el || !src) return;
            el.width = src.width;
            el.height = src.height;
            el.getContext("2d")?.drawImage(src, 0, 0);
          }}
        />
      )}

      {/* Play/pause acknowledgement — purely decorative, so it never takes
          pointer events away from the picture underneath. */}
      {tapAck && (
        <div key={tapAck.at} style={styles.tapAck} aria-hidden="true"
             onAnimationEnd={() => setTapAck(null)}>
          {tapAck.kind === "play" ? (
            <svg width="34" height="34" viewBox="0 0 22 22" fill="none">
              <path d="M5 3.5L18 11L5 18.5V3.5Z" fill="currentColor" />
            </svg>
          ) : (
            <svg width="34" height="34" viewBox="0 0 22 22" fill="none">
              <rect x="5" y="3.5" width="4.5" height="15" rx="1.2" fill="currentColor" />
              <rect x="12.5" y="3.5" width="4.5" height="15" rx="1.2" fill="currentColor" />
            </svg>
          )}
        </div>
      )}

      {/* Finished, with something to follow it. Full-screen rather than the
          corner card, because at this point there is nothing else on screen —
          and unlike that card, viewers see it too. Nothing auto-advances. */}
      {playbackEnded && upNextItem && (
        <EndCard
          item={upNextItem}
          source={queuedNext ? "queue" : "series"}
          onPlay={canControl ? playNextItem : undefined}
          onExit={exitToShow}
        />
      )}

      {/* Track switching freeze-frame overlay */}
      {trackSwitching && (
        <div style={styles.trackSwitchOverlay}>
          {canvasRef.current && (
            <canvas
              ref={(el) => {
                if (el && canvasRef.current) {
                  el.width = canvasRef.current.width;
                  el.height = canvasRef.current.height;
                  el.getContext("2d")!.drawImage(canvasRef.current, 0, 0);
                }
              }}
              style={styles.trackSwitchCanvas}
            />
          )}
          <div style={styles.trackSwitchMessage}>
            <div style={styles.bufferingSpinner} />
            <span style={styles.bufferingText}>
              {trackSwitching === "audio" ? "Switching audio..." : "Switching subtitles..."}
            </span>
          </div>
        </div>
      )}

      {/* Recovery overlay (stream interrupted) */}
      {recovering && (
        <div style={styles.trackSwitchOverlay}>
          {canvasRef.current && (
            <canvas
              ref={(el) => {
                if (el && canvasRef.current) {
                  el.width = canvasRef.current.width;
                  el.height = canvasRef.current.height;
                  el.getContext("2d")!.drawImage(canvasRef.current, 0, 0);
                }
              }}
              style={styles.trackSwitchCanvas}
            />
          )}
          <div style={styles.trackSwitchMessage}>
            <div style={styles.bufferingSpinner} />
            <span style={styles.bufferingText}>Stream interrupted — Reconnecting...</span>
          </div>
        </div>
      )}

      {/* Recovery exhausted — manual retry */}
      {playbackDead && !recovering && !error && (
        <div style={styles.trackSwitchOverlay}>
          <div style={styles.trackSwitchMessage}>
            <span style={{ color: "#e74c3c", fontSize: "16px", fontWeight: 600 }}>Stream lost</span>
            <button
              onClick={() => {
                recoveryAttemptRef.current = 0;
                mediaErrorCountRef.current = 0;
                recoveryPositionRef.current = recoveryPositionRef.current || 0;
                seekOffsetRef.current = recoveryPositionRef.current;
                setPlaybackDead(false);
                setRetryKey((k) => k + 1);
                setRecovering(true);
              }}
              style={{
                padding: "10px 24px", borderRadius: "8px", border: "none",
                background: "#e5a00d", color: "#000", fontSize: "14px",
                fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
              }}
            >
              Retry
            </button>
            <button
              onClick={handleBack}
              style={{
                padding: "8px 20px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.2)",
                background: "transparent", color: "#888", fontSize: "13px",
                cursor: "pointer", fontFamily: "inherit",
              }}
            >
              Go Back
            </button>
          </div>
        </div>
      )}

      {showStats && vpsRelay !== null && (
        <StatsOverlay
          videoRef={videoRef}
          hlsRef={hlsRef}
          vpsRelay={vpsRelay}
          sessionId={sessionIdRef.current}
          p2pStatsRef={p2pStatsRef}
          onClose={() => setShowStats(false)}
        />
      )}

      <Controls
        videoRef={videoRef}
        handleRef={controlsRef}
        isHost={isHost}
        title={displayTitle}
        onBack={handleBack}
        onToggleStats={() => setShowStats((s) => !s)}
        statsActive={showStats}
        canControl={canControl}
        onSyncPause={canControl ? syncActions?.sendPause : undefined}
        onSyncResume={canControl ? syncActions?.sendResume : undefined}
        onSyncSeek={canControl ? syncActions?.sendSeek : undefined}
        onSeekRestart={canControl ? handleSeekCommand : undefined}
        onOpenTrackSwitcher={canControl ? () => setShowTrackSwitcher(true) : undefined}
        onSurfaceClick={canControl ? togglePlayPause : undefined}
        restartingTo={restartingTo}
        queueCount={syncState?.queue?.length}
        onOpenQueue={isHost ? () => setShowQueuePanel(true) : undefined}
        peopleCount={syncState?.participants?.length}
        // Everyone, not just the host: seeing who else is in the room is
        // read-only information, and gating it meant a viewer had to leave the
        // video to find out. PeoplePanel already hides every role action behind
        // its own isHost prop, so a viewer opening this gets the roster and the
        // HOST/CO-HOST badges and no buttons.
        onOpenPeople={() => setShowPeoplePanel(true)}
        // Undefined at the series edges (and for movies), so Controls renders
        // no button rather than a dead one.
        onPrevEpisode={canControl && prevEpisode ? playPrevEpisode : undefined}
        onNextEpisode={canControl && nextEpisode ? playNextEpisode : undefined}
        // Undefined when the library has no generated preview thumbnails, so
        // Controls shows a plain timestamp instead of chasing missing images.
        previewPartId={previewPartId ?? undefined}
      />
      {showTrackSwitcher && (
        <TrackSwitcher
          ratingKey={item.ratingKey}
          onClose={() => setShowTrackSwitcher(false)}
          onTrackChange={handleTrackSelect}
          subtitlesOnly={!isHost}
        />
      )}
      {showQueuePanel && syncState && (
        <QueuePanel
          queue={syncState.queue}
          onRemove={(rk) => syncActions?.sendQueueRemove(rk)}
          onClear={() => syncActions?.sendQueueClear()}
          onReorder={(q) => syncActions?.sendQueueReorder(q)}
          onClose={() => setShowQueuePanel(false)}
        />
      )}
      {showPeoplePanel && syncState && (
        <PeoplePanel
          participants={syncState.participants}
          selfUserId={selfUserId}
          isHost={isHost}
          onPromoteHost={(uid) => {
            // Release the transcode the instant the handover is sent, rather
            // than waiting for the demotion to come back from the server.
            // Closing the tab in that window used to tear down the stream the
            // new host had just adopted. The server refuses a stop from a
            // non-host too; this just means the request is never made.
            ownsSessionRef.current = false;
            syncActions?.sendPromoteHost(uid);
            setShowPeoplePanel(false);
          }}
          onSetCoHost={(uid, value) => syncActions?.sendSetCoHost(uid, value)}
          onInvite={onInvite}
          onClose={() => setShowPeoplePanel(false)}
        />
      )}
      {confirmingEnd && (() => {
        const otherCount = (syncState?.participants ?? []).filter(
          (p) => p.userId !== selfUserId,
        ).length;
        return (
          <div style={styles.confirmBackdrop} onClick={() => setConfirmingEnd(false)}>
            <div style={styles.confirmDialog} onClick={(e) => e.stopPropagation()}>
              <div style={styles.confirmTitle}>End stream?</div>
              <p style={styles.confirmText}>
                {otherCount === 1
                  ? "1 other person is watching"
                  : `${otherCount} other people are watching`}
                {" — going back stops playback for everyone."}
              </p>
              <div style={styles.confirmActions}>
                <button
                  style={styles.confirmCancelBtn}
                  onClick={() => setConfirmingEnd(false)}
                >
                  Cancel
                </button>
                <button
                  style={styles.confirmEndBtn}
                  onClick={() => {
                    setConfirmingEnd(false);
                    endPlayback();
                  }}
                >
                  End stream
                </button>
              </div>
            </div>
          </div>
        );
      })()}
      {/* Bottom-right stack: owns placement so neither child positions itself and
          a third affordance costs one line. Bottom-anchored, so it grows upward
          and the skip button naturally sits above the card. */}
      {(showSkip || showNextUp) && (
        <div style={styles.bottomRightStack}>
          {showSkip && (
            <SkipMarkerButton type={activeMarker!.type} onSkip={handleSkipMarker} />
          )}
          {showNextUp && upNextItem && (
            <NextUpButton
              item={upNextItem}
              source={queuedNext ? "queue" : "series"}
              onPlay={playNextItem}
              onDismiss={() => {
                // Dismissing a queued item drops it from the queue (the old
                // Cancel behaviour), which correctly falls through to the
                // auto-resolved episode. Dismissing that just hides it for
                // this item.
                if (queuedNext) syncActions?.sendQueueRemove(queuedNext.ratingKey);
                else setDismissedFor(item.ratingKey);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  confirmBackdrop: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 110, display: "flex", alignItems: "center", justifyContent: "center" },
  confirmDialog: { width: "340px", maxWidth: "85vw", background: "#1a1a1a", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "12px", padding: "20px" },
  confirmTitle: { color: "#f0f0f0", fontSize: "16px", fontWeight: 600, marginBottom: "8px" },
  confirmText: { color: "#aaa", fontSize: "13px", lineHeight: 1.5, margin: "0 0 16px" },
  confirmActions: { display: "flex", justifyContent: "flex-end", gap: "8px" },
  confirmCancelBtn: { padding: "8px 14px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.15)", background: "transparent", color: "#ccc", fontSize: "13px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" },
  confirmEndBtn: { padding: "8px 14px", borderRadius: "8px", border: "none", background: "#e5a00d", color: "#000", fontSize: "13px", fontWeight: 700, cursor: "pointer", fontFamily: "inherit" },
  bottomRightStack: {
    position: "absolute",
    right: "20px",
    bottom: "80px",
    zIndex: 30,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: "12px",
  },
  container: {
    position: "fixed",
    inset: 0,
    background: "#000",
    overflow: "hidden",
    zIndex: 50,
  },
  video: {
    width: "100%",
    height: "100%",
    objectFit: "contain",
  },
  heldFrame: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    // `contain`, matching the video, so the standin sits exactly where the
    // picture was rather than stretching to the letterbox.
    objectFit: "contain",
    pointerEvents: "none",
    zIndex: 1,
  },
  tapAck: {
    position: "absolute",
    top: "50%",
    left: "50%",
    // The translate lives in the keyframes, which also drive the scale — setting
    // transform here as well would be overwritten the moment it starts.
    width: "82px",
    height: "82px",
    borderRadius: "50%",
    background: "rgba(0,0,0,0.55)",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    pointerEvents: "none",
    zIndex: 9,
    opacity: 0,
    animation: "tap-ack 0.5s ease-out forwards",
  },
  error: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    background: "#c0392b",
    color: "#fff",
    padding: "8px 16px",
    textAlign: "center",
    fontSize: "14px",
    zIndex: 20,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "12px",
  },
  inlineRetryBtn: {
    padding: "3px 12px",
    borderRadius: "999px",
    border: "1px solid rgba(255,255,255,0.55)",
    background: "rgba(255,255,255,0.12)",
    color: "#fff",
    fontSize: "12px",
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  hostDisconnected: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    background: "#e67e22",
    color: "#fff",
    padding: "8px 16px",
    textAlign: "center",
    fontSize: "14px",
    zIndex: 20,
  },
  bufferingOverlay: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(0,0,0,0.4)",
    zIndex: 5,
    pointerEvents: "none",
  },
  viewerStatus: {
    position: "absolute",
    top: "18px",
    left: "50%",
    transform: "translateX(-50%)",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "8px 16px",
    borderRadius: "999px",
    background: "rgba(0,0,0,0.72)",
    color: "rgba(255,255,255,0.92)",
    fontSize: "13px",
    fontWeight: 600,
    letterSpacing: "0.2px",
    zIndex: 16,
    pointerEvents: "none",
    backdropFilter: "blur(6px)",
    border: "1px solid rgba(255,255,255,0.1)",
    boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
  },
  viewerStatusSpinner: {
    width: "13px",
    height: "13px",
    flexShrink: 0,
    border: "2px solid rgba(229,160,13,0.35)",
    borderTopColor: "#e5a00d",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  },
  bufferingSpinner: {
    width: "48px",
    height: "48px",
    border: "3px solid rgba(229,160,13,0.3)",
    borderTopColor: "#e5a00d",
    borderRadius: "50%",
    animation: "spin 1s linear infinite",
  },
  bufferingText: {
    color: "rgba(255,255,255,0.7)",
    fontSize: "13px",
    fontWeight: 500,
    marginTop: "14px",
  },
  trackSwitchOverlay: {
    position: "absolute",
    inset: 0,
    background: "#000",
    zIndex: 15,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  trackSwitchCanvas: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "cover",
    filter: "brightness(0.5)",
  },
  trackSwitchMessage: {
    position: "relative",
    zIndex: 1,
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    gap: "14px",
  },
};
