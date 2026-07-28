import { useState, useCallback, useRef, useEffect, useImperativeHandle } from "react";
import { authUrl } from "../lib/api";
import { loadVolume } from "../lib/volume";
import { useMediaQuery, COMPACT_CONTROLS_QUERY } from "../lib/useMediaQuery";

export interface ControlsHandle {
  /**
   * Add ±seconds to the pending skip, exactly as the on-screen ±10s buttons do.
   * Lets the player's keyboard shortcuts feed one accumulator rather than
   * keeping a second, competing one.
   */
  queueSkip: (amount: number) => void;
}

interface ControlsProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Imperative handle — see ControlsHandle. */
  handleRef?: React.Ref<ControlsHandle>;
  /** Host-only affordances: queue, track switcher, people panel. */
  isHost: boolean;
  /** Transport rights (play/pause/seek) — true for the host AND for co-hosts.
   *  Defaults to isHost so existing call sites keep their behaviour. */
  canControl?: boolean;
  title: string;
  onBack: () => void;
  onSyncPause?: (position: number) => void;
  onSyncResume?: (position: number) => void;
  onSyncSeek?: (position: number) => void;
  onSeekRestart?: (position: number) => void;
  onToggleMute?: () => void;
  onOpenTrackSwitcher?: () => void;
  onToggleStats?: () => void;
  statsActive?: boolean;
  showKeyboardHints?: boolean;
  queueCount?: number;
  onOpenQueue?: () => void;
  peopleCount?: number;
  onOpenPeople?: () => void;
  /** Episode navigation — omitted when there is no episode that way. */
  onPrevEpisode?: () => void;
  onNextEpisode?: () => void;
  /** Plex part id for BIF hover-preview frames. Omitted when the item has no
   *  generated preview thumbnails — the tooltip then shows the timestamp alone. */
  previewPartId?: number;
}

/**
 * Bucket size for preview-frame requests, in milliseconds.
 *
 * Plex stores BIF frames at a fixed interval and snaps any requested offset to
 * the nearest one, so any value works. Quantizing is about cache hits: without
 * it, every pixel of cursor travel produces a unique URL and neither the browser
 * cache nor the server's thumb cache ever hits.
 *
 * 10s rather than 2s: it aligns with the common interval, and where the index is
 * denser we show a slightly coarser frame in exchange for ~5x fewer distinct
 * requests — a 2h film is then ~720 possible frames instead of ~3600.
 */
const PREVIEW_BUCKET_MS = 10_000;

/**
 * Minimum gap between preview-frame requests while the cursor is moving.
 *
 * Buckets are dense relative to the bar — a 2h film is ~720 buckets across
 * ~800px, so roughly one per pixel. Without a throttle a single sweep queues
 * hundreds of loads. Leading-edge, so the first move still shows a frame
 * immediately, with a trailing flush so wherever the cursor stops always loads.
 */
const PREVIEW_THROTTLE_MS = 120;

/**
 * How many decoded frames to keep. Scrubbing back over ground you've already
 * covered is the common motion, and a hit here is instant — no request, no
 * decode, no flicker. ~200 frames is a couple of MB of already-decoded images.
 */
const PREVIEW_CACHE_MAX = 200;

function fmt(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
    : `${m}:${s.toString().padStart(2, "0")}`;
}

const HIDE_DELAY_MS = 3000;

/**
 * How long the ±10s buttons keep collecting before the seek actually happens.
 *
 * Every seek can restart the Plex transcode, so firing one per click makes
 * spamming the button the worst thing you can do to the stream. Clicks inside
 * this window fold into a single jump instead, the way YouTube's do — each one
 * pushes the deadline back, so a burst costs one seek no matter how long it is.
 */
const SKIP_STACK_MS = 700;

/** How long the accumulated total lingers after the seek lands. */
const SKIP_INDICATOR_LINGER_MS = 400;

export function Controls({
  videoRef,
  handleRef,
  isHost,
  canControl = isHost,
  title,
  onBack,
  onSyncPause,
  onSyncResume,
  onSyncSeek,
  onSeekRestart,
  onToggleMute,
  onOpenTrackSwitcher,
  onToggleStats,
  statsActive,
  showKeyboardHints = true,
  queueCount,
  onOpenQueue,
  peopleCount,
  onOpenPeople,
  onPrevEpisode,
  onNextEpisode,
  previewPartId,
}: ControlsProps) {
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(loadVolume);
  const [muted, setMuted] = useState(false);
  const [visible, setVisible] = useState(true);
  const [hoveringProgress, setHoveringProgress] = useState(false);
  // Fraction (0-1) of the bar under the cursor, null when not hovering —
  // drives the seek-preview timestamp tooltip and hover marker.
  const [hoverPct, setHoverPct] = useState<number | null>(null);
  // Fraction being dragged, null when not scrubbing. The fill and handle follow
  // this instead of playback, so the bar tracks the finger/cursor while the
  // video carries on underneath. Deliberately NOT seeking per move: each seek
  // can restart the Plex transcode, so a drag commits exactly once, on release.
  const [scrubPct, setScrubPct] = useState<number | null>(null);
  // Mirrors scrubPct for the handlers. A pointermove can arrive before React has
  // re-rendered with the state set by pointerdown, which would drop the drag.
  const draggingRef = useRef(false);
  const scrubPctRef = useRef(0);
  // Accumulated ±10s presses waiting to be applied as one seek, and where they
  // add up to. Null when nothing is pending. `delta` drives the on-screen total,
  // `target` is what the eventual seek uses.
  const [skipPreview, setSkipPreview] = useState<{ delta: number; target: number } | null>(null);
  const skipBaseRef = useRef(0);
  const skipDeltaRef = useRef(0);
  const skipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The frame we want (quantized) vs the one that has actually decoded. Two
  // values so a slow load keeps showing the previous frame rather than blanking
  // to an empty box mid-scrub.
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [loadedPreviewSrc, setLoadedPreviewSrc] = useState<string | null>(null);
  // Part whose frames turned out to be missing. previewThumbs can be optimistic
  // — a library indexed after the item was added, or only partly indexed — and
  // the thumb route forwards Plex's 404 without caching the negative, so without
  // this latch every hover would be a fresh live 404.
  const failedPartRef = useRef<number | null>(null);
  // Frames that have already decoded, keyed by URL. Insertion-ordered, so the
  // oldest key is the eviction candidate.
  const previewCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  // Latest bucket the cursor has been over, and the throttle timer. Held in refs
  // so mousemove never re-renders just to record where we're heading.
  const pendingPreviewRef = useRef<string | null>(null);
  const previewThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hintsVisible, setHintsVisible] = useState(showKeyboardHints);
  // Phone-sized: the volume slider moves into a vertical popover rather than
  // eating the width of a row that has nowhere to put it.
  const compact = useMediaQuery(COMPACT_CONTROLS_QUERY);
  // Discord's own chrome is kept clear by the safe-area insets baked into the
  // bar paddings, so nothing here needs to know the orientation.
  const [volumeOpen, setVolumeOpen] = useState(false);
  const volumeWrapRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hintsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousVolumeRef = useRef(volume);
  const [bufferedEnd, setBufferedEnd] = useState(0);

  // Mirror the element's volume, whoever changed it. Without this the slider
  // and mute icon go stale when the keyboard shortcuts adjust volume, since
  // those write video.volume directly. Also picks up the remembered level the
  // player applies on mount.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const sync = () => {
      setVolume(video.volume);
      setMuted(video.volume === 0);
      // Track the last audible level so unmuting restores it no matter which
      // control silenced it.
      if (video.volume > 0) previousVolumeRef.current = video.volume;
    };
    sync();
    video.addEventListener("volumechange", sync);
    return () => video.removeEventListener("volumechange", sync);
  }, [videoRef]);

  // Fade out keyboard hints after 10s
  useEffect(() => {
    if (!hintsVisible) return;
    hintsTimer.current = setTimeout(() => setHintsVisible(false), 10_000);
    return () => { if (hintsTimer.current) clearTimeout(hintsTimer.current); };
  }, [hintsVisible]);

  const resetHideTimer = useCallback(() => {
    setVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setVisible(false), HIDE_DELAY_MS);
  }, []);

  useEffect(() => {
    const parent = videoRef.current?.parentElement?.parentElement;
    if (!parent) return;
    const onMove = () => resetHideTimer();
    const onLeave = () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setVisible(false);
    };
    parent.addEventListener("mousemove", onMove);
    parent.addEventListener("mouseleave", onLeave);
    resetHideTimer();
    return () => {
      parent.removeEventListener("mousemove", onMove);
      parent.removeEventListener("mouseleave", onLeave);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [videoRef, resetHideTimer]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => {
      setPlaying(false);
      setVisible(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
    const onTime = () => {
      setCurrentTime(video.currentTime);
      if (video.buffered.length > 0) {
        setBufferedEnd(video.buffered.end(video.buffered.length - 1));
      }
    };
    const onDur = () => setDuration(video.duration || 0);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("loadedmetadata", onDur);
    video.addEventListener("durationchange", onDur);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("loadedmetadata", onDur);
      video.removeEventListener("durationchange", onDur);
    };
  }, [videoRef]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video || !canControl) return;
    if (video.paused) {
      video.play();
      onSyncResume?.(video.currentTime);
    } else {
      video.pause();
      onSyncPause?.(video.currentTime);
    }
  }, [videoRef, canControl, onSyncPause, onSyncResume]);

  /** Where along the bar a client X coordinate falls, 0-1. Null if unmeasurable. */
  const pctFromClientX = useCallback((clientX: number): number | null => {
    const el = progressRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return null;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }, []);

  const commitSeekToPct = useCallback(
    (pct: number) => {
      if (!canControl || !videoRef.current) return;
      if (!duration || !isFinite(duration)) return;
      const newTime = pct * duration;
      // onSeekRestart is the host's smart seek: in-place when the target is
      // reachable in the current transcode, transcode restart otherwise.
      if (onSeekRestart) {
        setCurrentTime(newTime); // show target time immediately while loading
        onSeekRestart(newTime);
      } else {
        videoRef.current.currentTime = newTime;
        onSyncSeek?.(newTime);
      }
    },
    [canControl, duration, videoRef, onSyncSeek, onSeekRestart],
  );

  const skipTo = useCallback(
    (newTime: number) => {
      if (!videoRef.current) return;
      if (onSeekRestart) {
        setCurrentTime(newTime);
        onSeekRestart(newTime);
      } else {
        videoRef.current.currentTime = newTime;
        onSyncSeek?.(newTime);
      }
    },
    [videoRef, onSyncSeek, onSeekRestart],
  );

  /**
   * Add to the pending skip rather than seeking now.
   *
   * The position a burst is measured from is captured on its first click, so
   * every click in the burst adds a clean ±10s to that same origin — reading
   * video.currentTime each time would fold in however much played during the
   * burst and make the total drift.
   */
  const queueSkip = useCallback((amount: number) => {
    const video = videoRef.current;
    if (!video || !canControl) return;
    const total = video.duration || duration || 0;

    const burstInProgress = skipTimerRef.current !== null;
    if (!burstInProgress) skipBaseRef.current = video.currentTime;
    skipDeltaRef.current = (burstInProgress ? skipDeltaRef.current : 0) + amount;

    const target = Math.max(0, Math.min(total || Infinity, skipBaseRef.current + skipDeltaRef.current));
    setSkipPreview({ delta: skipDeltaRef.current, target });

    if (skipTimerRef.current !== null) clearTimeout(skipTimerRef.current);
    skipTimerRef.current = setTimeout(() => {
      skipTimerRef.current = null;
      skipTo(target);
      // Held a beat past the seek so the total doesn't vanish the instant it
      // is applied, which reads as the click having been dropped.
      skipClearTimerRef.current = setTimeout(
        () => setSkipPreview(null),
        SKIP_INDICATOR_LINGER_MS,
      );
    }, SKIP_STACK_MS);

    // A new click during the linger cancels the fade — the burst is continuing.
    if (skipClearTimerRef.current !== null) {
      clearTimeout(skipClearTimerRef.current);
      skipClearTimerRef.current = null;
    }
    resetHideTimer();
  }, [videoRef, canControl, duration, skipTo, resetHideTimer]);

  const skipBack = useCallback(() => queueSkip(-10), [queueSkip]);
  const skipForward = useCallback(() => queueSkip(10), [queueSkip]);

  useImperativeHandle(handleRef, () => ({ queueSkip }), [queueSkip]);

  // Drop pending timers on unmount so a queued seek can't fire into a torn-down
  // player (or a transcode the next item has already replaced).
  useEffect(() => () => {
    if (skipTimerRef.current !== null) clearTimeout(skipTimerRef.current);
    if (skipClearTimerRef.current !== null) clearTimeout(skipClearTimerRef.current);
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (muted) {
      video.volume = previousVolumeRef.current;
      setVolume(previousVolumeRef.current);
      setMuted(false);
    } else {
      previousVolumeRef.current = volume;
      video.volume = 0;
      setVolume(0);
      setMuted(true);
    }
    onToggleMute?.();
  }, [videoRef, muted, volume, onToggleMute]);

  const handleVolume = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = parseFloat(e.target.value);
      setVolume(v);
      if (videoRef.current) videoRef.current.volume = v;
      if (v > 0 && muted) {
        setMuted(false);
        previousVolumeRef.current = v;
      } else if (v === 0 && !muted) {
        setMuted(true);
      }
    },
    [videoRef, muted],
  );

  /** Point the tooltip and preview frame at a position on the bar. Shared by
   *  hovering and dragging — a scrub wants exactly the same affordances. */
  const showPreviewAt = useCallback((pct: number) => {
    setHoverPct(pct);

    if (previewPartId == null || failedPartRef.current === previewPartId) return;
    if (!(duration > 0) || !isFinite(duration)) return;
    // Floor rather than round, so the frame is at or before the cursor.
    const bucketMs = Math.floor((pct * duration * 1000) / PREVIEW_BUCKET_MS) * PREVIEW_BUCKET_MS;
    // No w/h params: those divert the thumb route through /photo/:/transcode,
    // which can't resolve a BIF path. Frames are already small — size with CSS.
    const url = authUrl(`/api/plex/thumb/library/parts/${previewPartId}/indexes/sd/${bucketMs}`);
    if (pendingPreviewRef.current === url) return;
    pendingPreviewRef.current = url;

    // A cached frame is free — show it now and skip the throttle entirely, so
    // retracing ground you've already scrubbed tracks the cursor exactly.
    if (previewCacheRef.current.has(url)) {
      setPreviewSrc(url);
      setLoadedPreviewSrc(url);
      return;
    }

    // Leading edge, then a single trailing flush to wherever the cursor ended up.
    if (previewThrottleRef.current !== null) return;
    setPreviewSrc(url);
    previewThrottleRef.current = setTimeout(() => {
      previewThrottleRef.current = null;
      const latest = pendingPreviewRef.current;
      if (latest && latest !== url) setPreviewSrc(latest);
    }, PREVIEW_THROTTLE_MS);
  }, [previewPartId, duration]);

  // ─── Scrubbing ────────────────────────────────────────────────
  //
  // Pointer events rather than mouse events, so a finger drag on the Discord
  // mobile Activity works the same as a mouse drag. Pointer capture keeps the
  // events coming to the bar once the drag starts, so sliding off it (or off the
  // window entirely) still tracks and still commits.

  const handleProgressPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!canControl) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const pct = pctFromClientX(e.clientX);
    if (pct == null) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    scrubPctRef.current = pct;
    setScrubPct(pct);
    setHoveringProgress(true);
    showPreviewAt(pct);
    // Hold the controls open for the length of the drag. Touch produces no
    // mousemove, so the usual idle-hide would pull the bar out from under it.
    setVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, [canControl, pctFromClientX, showPreviewAt]);

  const handleProgressPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const pct = pctFromClientX(e.clientX);
    if (pct == null) return;
    // Hover affordances are for pointers that can hover; a dragging finger gets
    // them too, since it's asking the same question of the bar.
    if (e.pointerType === "mouse" || draggingRef.current) showPreviewAt(pct);
    if (!draggingRef.current) return;
    scrubPctRef.current = pct;
    setScrubPct(pct);
  }, [pctFromClientX, showPreviewAt]);

  const handleProgressPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    // A plain click is just a zero-distance drag, so it lands here too — which
    // is why the bar no longer needs its own onClick.
    const pct = pctFromClientX(e.clientX) ?? scrubPctRef.current;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setScrubPct(null);
    if (e.pointerType !== "mouse") {
      setHoveringProgress(false);
      setHoverPct(null);
    }
    commitSeekToPct(pct);
    resetHideTimer();
  }, [pctFromClientX, commitSeekToPct, resetHideTimer]);

  // Load the wanted frame, promoting it to the display only once decoded.
  //
  // A superseded load is deliberately NOT aborted: it costs nothing extra at this
  // point and lands in the cache, so sweeping across the bar warms the frames you
  // then scrub back over. The previous implementation reassigned one <img>'s src,
  // which aborted in flight — during a sweep almost nothing ever finished.
  useEffect(() => {
    if (!previewSrc) return;
    const cache = previewCacheRef.current;
    if (cache.has(previewSrc)) {
      setLoadedPreviewSrc(previewSrc);
      return;
    }
    let superseded = false;
    const img = new Image();
    img.onload = () => {
      cache.set(previewSrc, img);
      if (cache.size > PREVIEW_CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      if (!superseded) setLoadedPreviewSrc(previewSrc);
    };
    img.onerror = () => {
      // Latch even when superseded. Since loads are no longer aborted, a part
      // with no frames would otherwise keep firing 404s for the whole sweep
      // before a non-superseded one happened to land.
      if (previewPartId != null) failedPartRef.current = previewPartId;
      if (superseded) return;
      pendingPreviewRef.current = null;
      setPreviewSrc(null);
      setLoadedPreviewSrc(null);
    };
    img.src = previewSrc;
    return () => { superseded = true; };
  }, [previewSrc, previewPartId]);

  // Clear preview state when the item changes, including the failure latch and
  // the frame cache — those URLs belong to the previous part.
  useEffect(() => {
    setPreviewSrc(null);
    setLoadedPreviewSrc(null);
    failedPartRef.current = null;
    previewCacheRef.current.clear();
    pendingPreviewRef.current = null;
    if (previewThrottleRef.current !== null) {
      clearTimeout(previewThrottleRef.current);
      previewThrottleRef.current = null;
    }
  }, [previewPartId]);

  // Drop the throttle timer on unmount.
  useEffect(() => () => {
    if (previewThrottleRef.current !== null) clearTimeout(previewThrottleRef.current);
  }, []);

  // Dismiss the volume popover on a tap anywhere else. Pointerdown rather than
  // click so it closes on the press that starts an interaction elsewhere,
  // instead of hanging around over whatever the user is reaching for.
  useEffect(() => {
    if (!volumeOpen) return;
    const onDown = (e: PointerEvent) => {
      if (volumeWrapRef.current?.contains(e.target as Node)) return;
      setVolumeOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [volumeOpen]);

  // The popover is anchored to a button in the control bar, so it can't outlive
  // the bar fading out from under it.
  useEffect(() => {
    if (!visible) setVolumeOpen(false);
  }, [visible]);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  // Where the bar points: the drag if one is in progress, otherwise the pending
  // skip total, otherwise playback. Both show you the destination before the
  // seek that gets you there actually runs.
  const pendingTime =
    scrubPct != null
      ? scrubPct * duration
      : skipPreview != null
        ? skipPreview.target
        : null;
  const fillPct = pendingTime != null && duration > 0 ? (pendingTime / duration) * 100 : progress;
  const buffered = duration > 0 ? (bufferedEnd / duration) * 100 : 0;
  const barHeight = hoveringProgress || scrubPct != null ? 8 : 5;

  return (
    <>
      {/* Accumulated skip, on the side it's heading. Deliberately outside the
          overlay below: that fades out on idle, and spamming the buttons is
          exactly when you most need to see the running total. */}
      {skipPreview != null && skipPreview.delta !== 0 && (
        <div
          style={{
            ...styles.skipIndicator,
            ...(skipPreview.delta < 0
              ? { left: "6%", alignItems: "flex-start" }
              : { right: "6%", alignItems: "flex-end" }),
          }}
        >
          <div style={styles.skipChevrons}>
            {skipPreview.delta < 0 ? "«" : "»"}
          </div>
          <div style={styles.skipAmount}>
            {Math.abs(skipPreview.delta)} seconds
          </div>
        </div>
      )}

      <div
        style={{
          ...styles.overlay,
          opacity: visible ? 1 : 0,
          pointerEvents: visible ? "auto" : "none",
        }}
      >
      {/* Top bar: back + title */}
      <div style={styles.topBar}>
        <button onClick={onBack} style={styles.backBtn}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ marginRight: 4 }}>
            <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Back
        </button>
        <span style={styles.title}>{title}</span>
      </div>

      {/* Bottom bar */}
      <div style={{ ...styles.bottomBar, ...(compact ? styles.bottomBarCompact : {}) }}>
        {/* Chunky progress bar */}
        <div
          ref={progressRef}
          onPointerDown={handleProgressPointerDown}
          onPointerMove={handleProgressPointerMove}
          onPointerUp={handleProgressPointerUp}
          // Losing the pointer (a system gesture, a phone call) should still land
          // the scrub where the user left it rather than silently dropping it.
          onPointerCancel={handleProgressPointerUp}
          onPointerEnter={(e) => { if (e.pointerType === "mouse") setHoveringProgress(true); }}
          onPointerLeave={(e) => {
            if (e.pointerType !== "mouse" || draggingRef.current) return;
            setHoveringProgress(false);
            setHoverPct(null);
          }}
          style={{
            ...styles.progressHit,
            cursor: canControl ? (scrubPct != null ? "grabbing" : "pointer") : "default",
            // Without this the browser claims the gesture for scrolling and the
            // drag dies after a few pixels of vertical wobble.
            touchAction: "none",
          }}
        >
          {/* Seek preview: timestamp under the cursor. clamp() keeps the
              bubble from overflowing the bar edges. */}
          {hoverPct != null && duration > 0 && isFinite(duration) && (
            <div
              style={{
                ...styles.seekTooltip,
                ...(loadedPreviewSrc ? styles.seekTooltipWithPreview : null),
                // A bare M:SS bubble only needs 30px of edge margin; a 160px
                // preview needs half its width to avoid overflowing the bar.
                left: loadedPreviewSrc
                  ? `clamp(84px, ${hoverPct * 100}%, calc(100% - 84px))`
                  : `clamp(30px, ${hoverPct * 100}%, calc(100% - 30px))`,
              }}
            >
              {loadedPreviewSrc && (
                <img src={loadedPreviewSrc} alt="" style={styles.seekPreviewImg} />
              )}
              {fmt(hoverPct * duration)}
            </div>
          )}
          <div style={{ ...styles.progressTrack, height: barHeight, transition: "height 0.15s ease" }}>
            <div style={{ ...styles.progressBuffer, width: `${buffered}%` }} />
            <div style={{ ...styles.progressFill, width: `${fillPct}%` }} />
            {/* Redundant with the handle while dragging — the handle is already
                sitting exactly here, and two markers on one spot reads as a bug. */}
            {hoverPct != null && scrubPct == null && (
              <div style={{ ...styles.hoverMarker, left: `${hoverPct * 100}%` }} />
            )}
            <div
              style={{
                position: "absolute",
                left: `${fillPct}%`,
                top: "50%",
                transform: "translate(-50%, -50%)",
                // Grows under the finger/cursor while dragging, so it reads as
                // grabbed rather than merely hovered.
                width: scrubPct != null ? 18 : 14,
                height: scrubPct != null ? 18 : 14,
                borderRadius: "50%",
                background: "#e5a00d",
                boxShadow: scrubPct != null
                  ? "0 0 0 5px rgba(229,160,13,0.25), 0 0 10px rgba(229,160,13,0.6)"
                  : "0 0 8px rgba(229,160,13,0.5)",
                opacity: canControl && (hoveringProgress || scrubPct != null) ? 1 : 0,
                transition: "opacity 0.15s ease, width 0.12s ease, height 0.12s ease",
                pointerEvents: "none",
              }}
            />
          </div>
        </div>

        <div style={styles.controls}>
          <div style={{ ...styles.left, ...(compact ? styles.groupCompact : {}) }}>
            {canControl && (
              <>
                <button onClick={togglePlay} style={{ ...styles.playBtn, ...(compact ? styles.playBtnCompact : {}) }}>
                  {playing ? (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                      <rect x="3" y="2" width="4" height="12" rx="1"/>
                      <rect x="9" y="2" width="4" height="12" rx="1"/>
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M4 2.5L13 8L4 13.5V2.5Z"/>
                    </svg>
                  )}
                </button>
                <button onClick={skipBack} style={styles.skipBtn} title="Back 10s">
                  <span style={{ fontSize: 16 }}>{"\u21BA"}</span>
                  <span style={{ fontSize: 11 }}>10</span>
                </button>
                <button onClick={skipForward} style={styles.skipBtn} title="Forward 10s">
                  <span style={{ fontSize: 16 }}>{"\u21BB"}</span>
                  <span style={{ fontSize: 11 }}>10</span>
                </button>
                {/* Episode nav sits together after the ±10s seek pair. Each is
                    rendered only when that sibling exists, so there's never a
                    dead control — the player omits the handler at series edges. */}
                {onPrevEpisode && (
                  <button onClick={onPrevEpisode} style={styles.skipBtn} title="Previous episode">
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
                      <rect x="2" y="2.5" width="2" height="11" rx="0.75"/>
                      <path d="M13.5 3.2v9.6a.6.6 0 0 1-.93.5L5.6 8.5a.6.6 0 0 1 0-1l6.97-4.8a.6.6 0 0 1 .93.5Z"/>
                    </svg>
                  </button>
                )}
                {onNextEpisode && (
                  <button onClick={onNextEpisode} style={styles.skipBtn} title="Next episode">
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M2.5 3.2v9.6a.6.6 0 0 0 .93.5L10.4 8.5a.6.6 0 0 0 0-1L3.43 2.7a.6.6 0 0 0-.93.5Z"/>
                      <rect x="12" y="2.5" width="2" height="11" rx="0.75"/>
                    </svg>
                  </button>
                )}
              </>
            )}
            <span style={{ ...styles.time, ...(compact ? styles.timeCompact : {}) }}>
              {/* Reads out the pending destination — a drag in progress, or a
                  stack of ±10s presses — so the number agrees with where the
                  handle is rather than with playback behind it. */}
              {fmt(pendingTime ?? currentTime)} / {fmt(duration)}
            </span>
          </div>
          <div style={{ ...styles.right, ...(compact ? styles.rightCompact : {}) }}>
            {/* Not host-gated: the roster is read-only, and PeoplePanel decides
                for itself whether to offer role controls. Gating it here meant a
                viewer had to back out of the video to see who else was watching. */}
            {onOpenPeople && (
              <button
                onClick={onOpenPeople}
                style={styles.queueBtn}
                title={isHost ? "People & roles" : "Who's here"}
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                  <circle cx="6" cy="5" r="2.4" stroke="currentColor" strokeWidth="1.5"/>
                  <path d="M1.5 13.5c0-2.2 2-3.6 4.5-3.6s4.5 1.4 4.5 3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  <path d="M11 4.2a2.2 2.2 0 0 1 0 4.2M12.5 13.5c0-1.7-.7-2.9-2-3.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
                {peopleCount != null && peopleCount > 0 && (
                  <span style={styles.queueBadge}>{peopleCount}</span>
                )}
              </button>
            )}
            {isHost && queueCount != null && queueCount > 0 && onOpenQueue && (
              <button onClick={onOpenQueue} style={styles.queueBtn} title="Queue">
                <span style={{ fontSize: 14 }}>{"\u25B6"}</span>
                <span style={styles.queueBadge}>{queueCount}</span>
              </button>
            )}
            {onToggleStats && (
              <button
                onClick={onToggleStats}
                style={{
                  ...styles.gearBtn,
                  ...(compact ? styles.gearBtnCompact : {}),
                  color: statsActive ? "#e5a00d" : "#fff",
                }}
                title="Stats for nerds (i)"
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                  <path d="M2 14V2M2 14H14M5 11V8M8 11V5M11 11V9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            )}
            {canControl && onOpenTrackSwitcher && (
              <button onClick={onOpenTrackSwitcher} style={{ ...styles.gearBtn, ...(compact ? styles.gearBtnCompact : {}) }} title={isHost ? "Audio & Subtitles" : "Subtitles"}>
                {"\u2699"}
              </button>
            )}
            {compact ? (
              /* Vertical slider in a popover. A horizontal one needs ~80px of a
                 row with none to give on a phone, and it was the control being
                 pushed off the edge of the screen. */
              <div ref={volumeWrapRef} style={styles.volumeWrap}>
                {volumeOpen && (
                  <div style={styles.volumePopover}>
                    {/* A rotated element keeps its unrotated layout box, so the
                        wrapper carries the size the slider occupies on screen
                        and the slider itself overflows it invisibly. */}
                    <div style={styles.volumeVerticalWrap}>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={volume}
                        onChange={handleVolume}
                        aria-label="Volume"
                        style={{ ...styles.volume, ...styles.volumeVertical }}
                      />
                    </div>
                    <button
                      onClick={toggleMute}
                      style={styles.muteBtn}
                      title={muted ? "Unmute" : "Mute"}
                    >
                      {muted ? "\u{1F507}" : "\u{1F50A}"}
                    </button>
                  </div>
                )}
                <button
                  onClick={() => setVolumeOpen((o) => !o)}
                  style={styles.muteBtn}
                  title="Volume"
                  aria-expanded={volumeOpen}
                >
                  {muted ? "\u{1F507}" : "\u{1F50A}"}
                </button>
              </div>
            ) : (
              <>
                <button onClick={toggleMute} style={styles.muteBtn} title={muted ? "Unmute" : "Mute"}>
                  {muted ? "\u{1F507}" : "\u{1F50A}"}
                </button>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={volume}
                  onChange={handleVolume}
                  aria-label="Volume"
                  style={styles.volume}
                />
              </>
            )}
            {/* Keyboard hints have nothing to say on a touch device, and this
                is the row with no width to spare. */}
            {hintsVisible && !compact && (
              <div style={styles.hints}>
                <span style={styles.hintBadge}>Space</span>
                <span style={styles.hintBadge}>{"\u2190\u2192"}</span>
              </div>
            )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  skipIndicator: {
    position: "absolute",
    top: "50%",
    transform: "translateY(-50%)",
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    padding: "18px 26px",
    borderRadius: "999px",
    background: "rgba(0,0,0,0.55)",
    backdropFilter: "blur(6px)",
    color: "#f0f0f0",
    pointerEvents: "none",
    // Above the control overlay, which the indicator deliberately outlives.
    zIndex: 11,
  },
  skipChevrons: {
    fontSize: "26px",
    lineHeight: 1,
    fontWeight: 700,
    color: "#e5a00d",
  },
  skipAmount: {
    fontSize: "13px",
    fontWeight: 600,
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
  },
  overlay: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    transition: "opacity 0.3s ease",
    zIndex: 10,
  },
  topBar: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    // Base spacing plus whatever Discord reports it is covering — its header
    // strip in portrait, the Leave pill in landscape. Defined in index.html.
    paddingTop: "calc(16px + var(--sait, 0px))",
    paddingRight: "calc(20px + var(--sair, 0px))",
    paddingBottom: "16px",
    paddingLeft: "calc(20px + var(--sail, 0px))",
    background: "linear-gradient(to bottom, rgba(0,0,0,0.8), transparent)",
  },
  backBtn: {
    display: "flex",
    alignItems: "center",
    padding: "6px 14px",
    borderRadius: "8px",
    border: "1px solid rgba(255,255,255,0.15)",
    background: "rgba(255,255,255,0.08)",
    backdropFilter: "blur(12px)",
    color: "#f0f0f0",
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: 500,
    fontFamily: "inherit",
  },
  title: {
    fontSize: "15px",
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "#f0f0f0",
  },
  bottomBar: {
    // Insets on three sides — see the note on topBar. The bottom one clears
    // Discord's collapse chevron in landscape and the home indicator on iOS.
    paddingTop: "48px",
    paddingRight: "calc(20px + var(--sair, 0px))",
    paddingBottom: "calc(16px + var(--saib, 0px))",
    paddingLeft: "calc(20px + var(--sail, 0px))",
    background: "linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.4) 60%, transparent 100%)",
  },
  progressHit: {
    position: "relative",
    padding: "8px 0",
    cursor: "pointer",
    marginBottom: "4px",
  },
  seekTooltip: {
    position: "absolute",
    bottom: "22px",
    transform: "translateX(-50%)",
    background: "rgba(15,15,15,0.92)",
    border: "1px solid rgba(255,255,255,0.15)",
    color: "#f0f0f0",
    padding: "3px 8px",
    borderRadius: "5px",
    fontSize: "12px",
    fontWeight: 500,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
    pointerEvents: "none",
    zIndex: 1,
  },
  seekTooltipWithPreview: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 3,
    padding: 4,
  },
  seekPreviewImg: {
    width: 160,
    // Fixed height, so frames of differing dimensions don't jog the layout
    // as the cursor moves along the bar.
    height: 90,
    objectFit: "cover",
    borderRadius: 3,
    display: "block",
    background: "#000",
  },
  hoverMarker: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: "2px",
    transform: "translateX(-50%)",
    background: "rgba(255,255,255,0.6)",
    pointerEvents: "none",
  },
  progressTrack: {
    height: 5,
    background: "rgba(255,255,255,0.15)",
    borderRadius: "3px",
    position: "relative",
    overflow: "visible",
  },
  progressBuffer: {
    position: "absolute",
    height: "100%",
    background: "rgba(255,255,255,0.12)",
    borderRadius: "3px",
  },
  progressFill: {
    position: "absolute",
    height: "100%",
    background: "#e5a00d",
    borderRadius: "3px",
    transition: "width 0.1s linear",
  },
  controls: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "8px",
  },
  // ─── Phone-sized overrides ─────────────────────────────────────
  // Same row, tightened. The buttons all stay: they're the reason to open the
  // player at all, and the time readout is what gives when width runs short.
  bottomBarCompact: {
    // Tighter base spacing, still carrying the safe-area insets so the bar
    // stays clear of Discord's chrome on a phone.
    paddingTop: "28px",
    paddingRight: "calc(12px + var(--sair, 0px))",
    paddingBottom: "calc(10px + var(--saib, 0px))",
    paddingLeft: "calc(12px + var(--sail, 0px))",
  },
  groupCompact: {
    gap: "6px",
    // Lets the time truncate rather than shoving controls off the screen edge.
    minWidth: 0,
    overflow: "hidden",
  },
  rightCompact: {
    gap: "6px",
    // The controls side never gives — every item here is a target to tap.
    flexShrink: 0,
  },
  playBtnCompact: {
    width: "32px",
    height: "32px",
  },
  gearBtnCompact: {
    width: "28px",
    height: "28px",
  },
  timeCompact: {
    fontSize: "11px",
  },
  left: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
  },
  right: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
  },
  playBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "36px",
    height: "36px",
    borderRadius: "50%",
    border: "none",
    background: "#e5a00d",
    color: "#000",
    cursor: "pointer",
    transition: "transform 0.15s ease",
  },
  skipBtn: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    lineHeight: 1,
    background: "none",
    border: "none",
    color: "rgba(255,255,255,0.6)",
    cursor: "pointer",
    fontFamily: "inherit",
    padding: "2px 4px",
  },
  time: {
    fontSize: "13px",
    color: "rgba(255,255,255,0.7)",
    fontVariantNumeric: "tabular-nums",
    fontWeight: 500,
    // "2:06:07 / 2:23:55" broke across two lines once the row ran out of width,
    // which is what made the bar look twice as tall as it should.
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
  gearBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "32px",
    height: "32px",
    borderRadius: "50%",
    border: "none",
    background: "rgba(255,255,255,0.1)",
    color: "#fff",
    cursor: "pointer",
    fontSize: "16px",
    fontFamily: "inherit",
  },
  queueBtn: {
    display: "flex", alignItems: "center", gap: "4px",
    background: "rgba(255,255,255,0.1)", border: "none",
    borderRadius: "16px", padding: "4px 10px",
    color: "#fff", cursor: "pointer", fontSize: "12px", fontFamily: "inherit",
  },
  queueBadge: {
    background: "#e5a00d", color: "#000", borderRadius: "8px",
    padding: "1px 6px", fontSize: "11px", fontWeight: 700,
  },
  muteBtn: {
    background: "none",
    border: "none",
    color: "#fff",
    cursor: "pointer",
    fontSize: "16px",
    padding: "4px",
    fontFamily: "inherit",
  },
  volume: {
    width: "80px",
    accentColor: "#e5a00d",
  },
  volumeWrap: {
    position: "relative",
    display: "flex",
    alignItems: "center",
  },
  volumePopover: {
    position: "absolute",
    bottom: "calc(100% + 10px)",
    left: "50%",
    transform: "translateX(-50%)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "6px",
    padding: "14px 8px 8px",
    borderRadius: "12px",
    background: "rgba(15,15,15,0.95)",
    border: "1px solid rgba(255,255,255,0.15)",
    backdropFilter: "blur(12px)",
  },
  volumeVerticalWrap: {
    // The on-screen footprint of the rotated slider below. Fixed, so the slider
    // overflowing its own box doesn't stretch the popover.
    width: "26px",
    height: "110px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  volumeVertical: {
    // Rotation rather than `writing-mode: vertical-*`, which only lands a
    // usable vertical range input on very recent Chromium — and this runs in
    // whatever webview Discord ships on the device.
    width: "110px",
    transform: "rotate(-90deg)",
    // Drags belong to the slider, not to the page behind it.
    touchAction: "none",
  },
  hints: {
    display: "flex",
    gap: "4px",
    transition: "opacity 0.5s ease",
  },
  hintBadge: {
    background: "rgba(255,255,255,0.08)",
    padding: "2px 6px",
    borderRadius: "3px",
    color: "rgba(255,255,255,0.3)",
    fontSize: "10px",
    letterSpacing: "0.5px",
  },
};
