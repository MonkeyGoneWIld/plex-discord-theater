import { useState, useCallback, useRef, useEffect, useImperativeHandle } from "react";
import { authUrl } from "../lib/api";
import { loadVolume } from "../lib/volume";
import { useMediaQuery, COMPACT_CONTROLS_QUERY, PHONE_QUERY } from "../lib/useMediaQuery";

export interface ControlsHandle {
  /**
   * Add ±seconds to the pending skip, exactly as the on-screen ±10s buttons do.
   * Lets the player's keyboard shortcuts feed one accumulator rather than
   * keeping a second, competing one.
   */
  queueSkip: (amount: number) => void;
  /**
   * True when the tap that just landed was the one that brought the controls
   * back, and should therefore not also do anything else.
   *
   * Consuming, so it answers true once per reveal. Without it a tap on a phone
   * both revealed the bar and toggled playback, because the reveal listener and
   * the video's own click handler each see the same tap.
   */
  consumeRevealTap: () => boolean;
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
  /** Click on the empty picture area (not a control) — used for click-to-pause.
   *  Omit for a viewer without transport control. */
  onSurfaceClick?: () => void;
  /**
   * Opens the subtitle timing panel. Absent unless this client is drawing its
   * own subtitles, which is the only case where there is anything to time —
   * a burned-in subtitle is part of the picture by the time it arrives.
   */
  onOpenSubtitleTiming?: () => void;
  /** Whether that panel is currently open, so the button can show it. */
  subtitleTimingOpen?: boolean;
  /** Where a restart-in-progress is heading, in seconds, or null when playback
   *  is settled. A transcode restart detaches the media and the element reports
   *  0 until the replacement loads, which snapped the bar back to the start
   *  mid-seek; holding the target keeps it where the viewer aimed it. */
  restartingTo?: number | null;
  onToggleStats?: () => void;
  statsActive?: boolean;
  showKeyboardHints?: boolean;
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

/** How long the accumulated total is held at full strength after the seek. */
const SKIP_INDICATOR_LINGER_MS = 400;
/** And how long it then takes to fade, rather than blinking out of existence. */
const SKIP_INDICATOR_FADE_MS = 260;

/**
 * The D: a half-ellipse over the side of the picture that answered the tap,
 * its flat edge on the side of the screen and its curve facing the centre.
 *
 * The shape is the border-radius, not an element — rounding one side's corners
 * to 50% is the whole of it. That is the shape both the Plex and the YouTube
 * players draw, and it is what makes the gesture read as "this half of the
 * picture" rather than as a badge that happens to be over there.
 *
 * Nothing holds it on screen between taps: the D is drawn only while it is
 * swelling and fading, so the picture is never dimmed for longer than the tap
 * it is answering.
 */
const SEEK_D_RADIUS_BACK = "0 50% 50% 0 / 0 50% 50% 0";
const SEEK_D_RADIUS_FORWARD = "50% 0 0 50% / 50% 0 0 50%";
/**
 * How far the shape runs past the picture, above and below and outward.
 *
 * This is what stops it being a half-ellipse. A border-radius of 50% curves
 * from one corner to the other, so an element the size of the picture pinches
 * to nothing at the top and bottom of the screen — the shape came to a point in
 * both corners, which is not what a seek overlay looks like anywhere.
 *
 * Drawing the ellipse larger than the picture and letting the player clip it
 * leaves only the middle of the arc on screen: a shallow curve that keeps its
 * width from top to bottom. Measured against the Plex player's own overlay, the
 * boundary there sits 4.0% of the picture width further in at the middle than
 * at the edges; these two numbers reproduce that to three decimal places, and
 * hold at 21:9, 16:9, 4:3 and phone landscape. Without them it was 12.9%.
 */
const SEEK_D_BLEED = "-35%";
const SEEK_D_OVERHANG = "-30%";

/**
 * Phone gestures.
 *
 * Two taps inside this window, on the same side of the picture, are a skip.
 * Long enough for a deliberate double-tap on a small screen, short enough that
 * two separate taps to show and hide the bar aren't read as one.
 */
const DOUBLE_TAP_MS = 320;
/** Seconds a double-tap moves, matching the ±10s buttons on a desktop bar. */
const TAP_SKIP_SECONDS = 10;
/**
 * Fraction of the picture each side zone occupies. The middle third is left
 * alone: the play/pause button lives there, and a skip zone under it would fire
 * on every near-miss of the thing people are actually aiming at.
 */
const TAP_SIDE_ZONE = 0.35;

/**
 * The bare icon buttons in the desktop transport: episode navigation and the
 * two ten-second seeks.
 *
 * Sized here rather than at each <svg> because the spacer that stands in for an
 * absent episode button is derived from these. Left as two literals they drift
 * the moment one is nudged, and the symptom is play sliding off the centre of
 * the bar at the first and last episode of a series - which is a long way from
 * anything that looks like "the icon size changed".
 */
const BAR_EPISODE_ICON = 18;
const BAR_SEEK_ICON = 23;
const SKIP_BTN_PAD_X = 4;
const SKIP_BTN_PAD_Y = 2;

/**
 * The ten-second seek buttons.
 *
 * One shape, mirrored, rather than two drawings. Two hand-drawn arrows can end
 * up pointing the same way or the wrong way round without either looking wrong
 * on its own — mirroring makes that impossible: they are opposite by
 * construction, and swapping them is one flag rather than two redraws.
 *
 * Back is the mirrored one: its head sits at the top right.
 *
 * The number does not mirror. It sits outside the flipped group, which is the
 * whole reason the arrow is a group at all.
 */
function SeekTen({ back }: { back: boolean }) {
  return (
    <svg width={BAR_SEEK_ICON} height={BAR_SEEK_ICON} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <g transform={back ? "scale(-1,1) translate(-20,0)" : undefined}>
        {/* Open at the top; the gap is where the arrowhead goes. */}
        <path
          d="M12.19 4.59A6.4 6.4 0 1 1 7.81 4.59"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        {/* Sits in the gap at the top. Unmirrored this points left, which is
            the forward icon; back is the mirror of it. */}
        <path d="M4.4 4.6 8.9 2.2v4.8Z" fill="currentColor" />
      </g>
      <text
        x="10"
        y="13.6"
        textAnchor="middle"
        fontSize="7.4"
        fontWeight="600"
        fill="currentColor"
        fontFamily="inherit"
      >
        10
      </text>
    </svg>
  );
}

/**
 * The answer to a skip, drawn on the half of the picture it applies to.
 *
 * Modelled on the Plex and YouTube players: the gesture is a double-tap on one
 * side of the picture, so the acknowledgement belongs on that side — a
 * half-ellipse over that half, swelling and fading once per tap, with the
 * amount centred inside it.
 *
 * What this replaces was a pill pinned 6% from the edge with its contents
 * flush-aligned. Two things were wrong with that. 6% of the viewport is behind
 * Discord's own chrome on a phone, so the pill was clipped down the middle; and
 * flush alignment meant the chevron and the number were pinned to the pill's
 * edge instead of sitting under one another. Centring inside a zone fixes both
 * at once — the content lands ~19% in, clear of anything Discord draws.
 *
 * The D is for the gesture only. On a desktop a skip comes from the ±10s
 * buttons or the arrow keys, where darkening a third of the picture would be a
 * far louder answer than a button press asks for; there the same blades and
 * count appear on a small pill in the same place.
 */
function SeekIndicator({
  delta,
  gesture,
  fading,
  tapId,
}: {
  delta: number;
  /** A double-tap on the picture, rather than a button or an arrow key. Only a
   *  gesture gets the D; a button press gets the same readout on a pill. */
  gesture: boolean;
  fading: boolean;
  /** Bumped once per tap. Used as a key, so every element that animates is
   *  replaced and replays — an animation still running from the last tap does
   *  not read as an answer to this one. */
  tapId: number;
}) {
  const back = delta < 0;
  return (
    <div
      style={{
        ...styles.seekZone,
        // The same share of the picture that responds to the tap, so the D is
        // a picture of the hit zone rather than an approximation of it.
        width: `${TAP_SIDE_ZONE * 100}%`,
        ...(back ? { left: 0 } : { right: 0 }),
        opacity: fading ? 0 : 1,
        transition: `opacity ${SKIP_INDICATOR_FADE_MS}ms ease-out`,
      }}
    >
      {/* The whole shape swelling and fading, once per tap, anchored at the
          edge of the screen so it grows inward from the side that was tapped.
          This is the only thing that darkens the picture — there is no standing
          wash under it, so nothing is dimmed between taps. */}
      {gesture && (
        <div
          key={`pulse-${tapId}`}
          className="seek-pulse"
          style={{
            ...styles.seekPulse,
            borderRadius: back ? SEEK_D_RADIUS_BACK : SEEK_D_RADIUS_FORWARD,
            transformOrigin: back ? "left center" : "right center",
            // Overhangs the outer edge, so the arc's flat side is off the
            // screen rather than drawn on it. See SEEK_D_OVERHANG.
            ...(back ? { right: 0, left: SEEK_D_OVERHANG }
                     : { left: 0, right: SEEK_D_OVERHANG }),
          }}
        />
      )}
      {/* The readout: the chevron over the count, as it has always been.
          Keyed on the tap so both of its animations replay for each one.

          The plate underneath is desktop-only. A gesture already has the D
          behind it, and stacking a black pill on top of that is two grounds for
          one readout — which is the box that had no business being there. */}
      <div
        key={`body-${tapId}`}
        style={{
          ...styles.skipIndicator,
          ...(gesture ? styles.skipIndicatorOnD : styles.skipPlate),
        }}
      >
        <div
          className="seek-chevron"
          style={{
            ...styles.skipChevrons,
            animation: "seek-chevron 320ms cubic-bezier(0.2, 0, 0, 1)",
          }}
        >
          {back ? "\u00ab" : "\u00bb"}
        </div>
        <div style={styles.skipAmount}>
          {/* The digits are their own element so the warm and the tightening
              land on them alone. Applied to the whole line, the spacing would
              widen it by several pixels and slide it sideways in its own
              centring — movement, from the one design here chosen for having
              none. */}
          <span
            className="seek-amount"
            style={{ animation: "seek-amount 340ms ease-out" }}
          >
            {Math.abs(delta)}
          </span>
          {" seconds"}
        </div>
      </div>
    </div>
  );
}

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
  onSurfaceClick,
  onOpenSubtitleTiming,
  subtitleTimingOpen = false,
  restartingTo = null,
  onToggleStats,
  statsActive,
  showKeyboardHints = true,
  peopleCount,
  onOpenPeople,
  onPrevEpisode,
  onNextEpisode,
  previewPartId,
}: ControlsProps) {
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  // Only a genuinely different item invalidates the duration — see onDur below.
  useEffect(() => { setDuration(0); }, [title]);
  const [volume, setVolume] = useState(loadVolume);
  const [muted, setMuted] = useState(false);
  const [visible, setVisible] = useState(true);
  // Mirrors `visible` for the listeners below, which are attached once and would
  // otherwise close over its first value forever.
  const visibleRef = useRef(true);
  visibleRef.current = visible;
  const revealTapRef = useRef(false);
  // When and where the last picture tap landed, for the double-tap test below.
  const lastTapRef = useRef<{ at: number; zone: "back" | "forward" | null }>({ at: 0, zone: null });
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
  //
  // `tapId` counts presses rather than describing them: the indicator uses it as
  // a key, so each press replaces the animating elements and their animations
  // start again. Without it a second tap during a run would leave the first
  // one's animation playing, which reads as the tap having been ignored.
  const [skipPreview, setSkipPreview] = useState<{
    delta: number;
    target: number;
    tapId: number;
  } | null>(null);
  const tapIdRef = useRef(0);
  const skipBaseRef = useRef(0);
  const skipDeltaRef = useRef(0);
  const skipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The indicator is on its way out. Separate from `skipPreview` being null so
  // the last frame of it can fade rather than being cut, which is the half of
  // the Plex/YouTube read that a linger alone doesn't give.
  const [skipFading, setSkipFading] = useState(false);
  const skipFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  // A phone, where the picture itself is the control surface: play/pause is a
  // button in the middle of it, skipping is a double-tap to one side, and a
  // single tap only shows or hides the bar. See the gesture layer below.
  const phone = useMediaQuery(PHONE_QUERY);
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
    // Touch has no mousemove, so on a phone the bar hid after 3s and never came
    // back: every tap fell through the hidden (pointer-events: none) overlay to
    // the video's own handler and toggled playback instead of revealing it.
    // Discord Activities run on phones, so this was the only way to control
    // playback there — by accident, and destructively.
    // Records whether the bar was hidden *before* this tap revealed it, which
    // is the thing the video's click handler needs and can no longer observe by
    // the time it runs.
    const onReveal = () => {
      if (!visibleRef.current) revealTapRef.current = true;
      resetHideTimer();
    };
    parent.addEventListener("pointerdown", onReveal);
    parent.addEventListener("touchstart", onReveal, { passive: true });
    resetHideTimer();
    return () => {
      parent.removeEventListener("mousemove", onMove);
      parent.removeEventListener("mouseleave", onLeave);
      parent.removeEventListener("pointerdown", onReveal);
      parent.removeEventListener("touchstart", onReveal);
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
    // Keep the last real duration through a restart.
    //
    // Tearing down hls.js detaches the media, and the element then reports a
    // NaN duration until the replacement manifest loads. Writing that through
    // collapsed `duration` to 0, which is what made the scrub bar and the time
    // readout vanish for the several seconds a seek-restart takes — the bar
    // disappeared, playback reloaded, and it came back at the target. The
    // duration of the item hasn't changed across a restart, so there is nothing
    // to relearn; the title effect below clears it when the item really does.
    const onDur = () => {
      const d = video.duration;
      if (Number.isFinite(d) && d > 0) setDuration(d);
    };
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
    tapIdRef.current += 1;
    setSkipPreview({ delta: skipDeltaRef.current, target, tapId: tapIdRef.current });

    if (skipTimerRef.current !== null) clearTimeout(skipTimerRef.current);
    skipTimerRef.current = setTimeout(() => {
      skipTimerRef.current = null;
      skipTo(target);
      // Held a beat past the seek so the total doesn't vanish the instant it
      // is applied, which reads as the click having been dropped, and only then
      // faded out.
      skipClearTimerRef.current = setTimeout(() => {
        setSkipFading(true);
        skipFadeTimerRef.current = setTimeout(() => {
          setSkipPreview(null);
          setSkipFading(false);
        }, SKIP_INDICATOR_FADE_MS);
      }, SKIP_INDICATOR_LINGER_MS);
    }, SKIP_STACK_MS);

    // A new click during the linger or the fade cancels it — the burst is
    // continuing, and the total it is showing is about to change.
    if (skipClearTimerRef.current !== null) {
      clearTimeout(skipClearTimerRef.current);
      skipClearTimerRef.current = null;
    }
    if (skipFadeTimerRef.current !== null) {
      clearTimeout(skipFadeTimerRef.current);
      skipFadeTimerRef.current = null;
    }
    setSkipFading(false);
    resetHideTimer();
  }, [videoRef, canControl, duration, skipTo, resetHideTimer]);

  const skipBack = useCallback(() => queueSkip(-10), [queueSkip]);
  const skipForward = useCallback(() => queueSkip(10), [queueSkip]);

  const consumeRevealTap = useCallback(() => {
    const was = revealTapRef.current;
    revealTapRef.current = false;
    return was;
  }, []);

  useImperativeHandle(handleRef, () => ({ queueSkip, consumeRevealTap }),
    [queueSkip, consumeRevealTap]);

  /**
   * A tap on the picture, on a phone. Never plays or pauses.
   *
   * That is the point of it. A tap used to mean "pause" when the bar was up and
   * "show the bar" when it wasn't, so the same gesture in the same place did two
   * different things depending on a state you can't see until after you've
   * tapped — which is why pausing took two taps and looked like the first one
   * had been ignored. Playback is now a button you can see, in the middle of the
   * screen, and this handles only the two things that have nowhere else to live:
   *
   *   single tap  — show the bar, or dismiss it if it was already up
   *   double tap  — ±10s, on whichever side of the picture it landed
   *
   * The first tap of a double still shows the bar, and is left to. Suppressing
   * it would mean delaying every single tap by the double-tap window to find out
   * whether a second one is coming, and a bar that appears a third of a second
   * after you touch the screen feels broken in a way a brief flash does not.
   */
  const handlePictureTap = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
      const zone: "back" | "forward" | null =
        x < TAP_SIDE_ZONE ? "back" : x > 1 - TAP_SIDE_ZONE ? "forward" : null;
      const now = Date.now();
      const prev = lastTapRef.current;
      lastTapRef.current = { at: now, zone };
      // Consumed either way: the reveal flag is set on every pointerdown that
      // brings the bar back, and leaving it set would make the player's own
      // click handler swallow an unrelated tap later.
      const revealedTheBar = consumeRevealTap();

      // Second (or third, or fourth) tap of a burst on one side — skip, and
      // leave the bar alone. queueSkip stacks them into a single seek.
      if (canControl && zone !== null && zone === prev.zone && now - prev.at < DOUBLE_TAP_MS) {
        queueSkip(zone === "back" ? -TAP_SKIP_SECONDS : TAP_SKIP_SECONDS);
        return;
      }

      // An ordinary tap. It has already been revealed by the pointerdown
      // listener if it was hidden, so the only thing left to do is the other
      // half of the toggle.
      if (!revealedTheBar) {
        if (hideTimer.current) clearTimeout(hideTimer.current);
        setVisible(false);
      }
    },
    [canControl, consumeRevealTap, queueSkip],
  );

  // Drop pending timers on unmount so a queued seek can't fire into a torn-down
  // player (or a transcode the next item has already replaced).
  useEffect(() => () => {
    if (skipTimerRef.current !== null) clearTimeout(skipTimerRef.current);
    if (skipClearTimerRef.current !== null) clearTimeout(skipClearTimerRef.current);
    if (skipFadeTimerRef.current !== null) clearTimeout(skipFadeTimerRef.current);
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
        : restartingTo;
  const fillPct = pendingTime != null && duration > 0 ? (pendingTime / duration) * 100 : progress;
  const buffered = duration > 0 ? (bufferedEnd / duration) * 100 : 0;
  const barHeight = hoveringProgress || scrubPct != null ? 8 : 5;

  // Hoisted out of the tree below because a phone wraps it in a row with the
  // elapsed and remaining times either side, and a desktop doesn't.
  const progressBar = (
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
        // In the phone row it is the flexible middle between the two times.
        ...(phone ? styles.progressHitPhone : {}),
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
  );

  return (
    <>
      {/* Accumulated skip, on the side it's heading. Deliberately outside the
          overlay below: that fades out on idle, and spamming the buttons is
          exactly when you most need to see the running total. */}
      {skipPreview != null && skipPreview.delta !== 0 && (
        <SeekIndicator
          delta={skipPreview.delta}
          gesture={phone}
          fading={skipFading}
          tapId={skipPreview.tapId}
        />
      )}

      <div
        style={{
          ...styles.overlay,
          opacity: visible ? 1 : 0,
          pointerEvents: visible ? "auto" : "none",
        }}
        // This overlay spans the whole picture, so while the controls are up it
        // swallows every click aimed at the video beneath — including the
        // click-to-pause one. Forward only clicks that landed on the overlay
        // itself (its empty middle); anything on a button or bar is that
        // control's own click and stops here.
        onClick={(e) => { if (e.target === e.currentTarget) onSurfaceClick?.(); }}
      >
      {/* Phone gesture layer.
          Covers the whole picture and keeps its own pointer events while the
          overlay above has them switched off, so a tap lands here whether the
          bar is up or not. It sits at z-index 0 and the bars at 1, so it never
          steals a press aimed at a control. On a desktop it isn't rendered at
          all and the click-to-pause path below is untouched. */}
      {phone && (
        <div style={styles.gestureLayer} onClick={handlePictureTap} aria-hidden="true" />
      )}

      {/* Transport, in the middle of the picture where it can be seen and
          aimed at. Phone only: a desktop has a pointer, a keyboard and a bar
          that doesn't hide itself after three seconds.

          Episode navigation belongs here rather than in the bar on a phone.
          Down there it was two 32px targets in a crowded row an inch from the
          bottom edge, next to the scrub bar and the settings; up here it is
          where a thumb already is, beside the control it is a sibling of.

          A missing neighbour leaves its space rather than closing it up — at
          either end of a series one of these is absent, and letting the row
          re-centre would slide play out from under the thumb aiming at it. */}
      {phone && canControl && (
        <div style={styles.centerTransport}>
          {onPrevEpisode ? (
            <button
              onClick={onPrevEpisode}
              className="btn"
              style={styles.centerNavBtn}
              aria-label="Previous episode"
            >
              <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" style={styles.centerNavIcon}>
                  <rect x="2" y="2.5" width="2" height="11" rx="0.75"/>
                  <path d="M13.5 3.2v9.6a.6.6 0 0 1-.93.5L5.6 8.5a.6.6 0 0 1 0-1l6.97-4.8a.6.6 0 0 1 .93.5Z"/>
                </svg>
            </button>
          ) : (
            <div style={styles.centerNavSpacer} aria-hidden="true" />
          )}

          <button
            onClick={togglePlay}
            className="btn"
            style={styles.centerPlayBtn}
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? (
              <svg width="30" height="30" viewBox="0 0 22 22" fill="currentColor">
                <rect x="5" y="3.5" width="4.5" height="15" rx="1.2" />
                <rect x="12.5" y="3.5" width="4.5" height="15" rx="1.2" />
              </svg>
            ) : (
              <svg width="30" height="30" viewBox="0 0 22 22" fill="currentColor">
                <path d="M6 3.5L18.5 11L6 18.5V3.5Z" />
              </svg>
            )}
          </button>

          {onNextEpisode ? (
            <button
              onClick={onNextEpisode}
              className="btn"
              style={styles.centerNavBtn}
              aria-label="Next episode"
            >
              <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" style={styles.centerNavIcon}>
                  <path d="M2.5 3.2v9.6a.6.6 0 0 0 .93.5L10.4 8.5a.6.6 0 0 0 0-1L3.43 2.7a.6.6 0 0 0-.93.5Z"/>
                  <rect x="12" y="2.5" width="2" height="11" rx="0.75"/>
                </svg>
            </button>
          ) : (
            <div style={styles.centerNavSpacer} aria-hidden="true" />
          )}
        </div>
      )}

      {/* Top bar: back + title */}
      <div style={styles.topBar}>
        <button onClick={onBack} className="btn" style={styles.backBtn}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ marginRight: 4 }}>
            <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Back
        </button>
        <span style={styles.title}>{title}</span>
      </div>

      {/* Bottom bar */}
      <div style={{
        ...styles.bottomBar,
        ...(compact ? styles.bottomBarCompact : {}),
        ...(phone ? styles.bottomBarPhone : {}),
      }}>
        {/* The scrub bar. On a phone it is the bottom row, with elapsed and
            remaining either side of it — see progressRowPhone. */}
        {phone ? (
          <div style={styles.progressRowPhone}>
            <span style={styles.phoneTime}>{fmt(pendingTime ?? currentTime)}</span>
            {progressBar}
            <span style={styles.phoneTime}>
              {duration > 0 && isFinite(duration)
                ? `-${fmt(Math.max(0, duration - (pendingTime ?? currentTime)))}`
                : fmt(duration)}
            </span>
          </div>
        ) : (
          progressBar
        )}

        <div style={{ ...styles.controls, ...(phone ? styles.controlsPhone : {}) }}>
          {/* Left column: the time, alone.
              The phone bar carries it either side of the scrub row instead,
              where there is room for it. */}
          {!phone && (
            <div style={{ ...styles.side, ...(compact ? styles.groupCompact : {}) }}>
              <span style={{ ...styles.time, ...(compact ? styles.timeCompact : {}) }}>
                {/* Reads out the pending destination — a drag in progress, or a
                    stack of ±10s presses — so the number agrees with where the
                    handle is rather than with playback behind it. */}
                {fmt(pendingTime ?? currentTime)} / {fmt(duration)}
              </span>
            </div>
          )}
          {/* Middle column: the transport.
              In the middle because that is where the largest empty space on the
              bar was, and because it then sits in the same place whatever the
              window is doing — left-aligned, play drifts further from the
              settings you were last using with every inch of extra width. */}
          <div style={{ ...styles.center, ...(compact ? styles.centerCompact : {}) }}>
            {/* Reading order is the order they sit in: back through the
                series, back ten, play, forward ten, forward through the series.
                Play is the middle of five so that it is the middle of the bar,
                which is the whole point of the column.

                Play, ±10s and episode navigation are all absent on a phone:
                playback and episode navigation are the three buttons in the
                middle of the picture, and skipping is a double-tap to one
                side. */}
            {canControl && !phone && (
              <>
                {/* An absent neighbour leaves its width behind. At the first or
                    last episode of a series one of these is not rendered, and a
                    row that closed up around the gap would take play off centre
                    at exactly the moments it is least expected to move. */}
                {onPrevEpisode ? (
                  <button onClick={onPrevEpisode} className="btn" style={styles.skipBtn} title="Previous episode">
                    <svg width={BAR_EPISODE_ICON} height={BAR_EPISODE_ICON} viewBox="0 0 16 16" fill="currentColor">
                      <rect x="2" y="2.5" width="2" height="11" rx="0.75"/>
                      <path d="M13.5 3.2v9.6a.6.6 0 0 1-.93.5L5.6 8.5a.6.6 0 0 1 0-1l6.97-4.8a.6.6 0 0 1 .93.5Z"/>
                    </svg>
                  </button>
                ) : (
                  <div style={styles.skipSpacer} aria-hidden="true" />
                )}
                <button onClick={skipBack} className="btn" style={styles.skipBtn} title="Back 10s">
                  <SeekTen back />
                </button>
                <button onClick={togglePlay} className="btn" style={{ ...styles.playBtn, ...(compact ? styles.playBtnCompact : {}) }}>
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
                <button onClick={skipForward} className="btn" style={styles.skipBtn} title="Forward 10s">
                  <SeekTen back={false} />
                </button>
                {onNextEpisode ? (
                  <button onClick={onNextEpisode} className="btn" style={styles.skipBtn} title="Next episode">
                    <svg width={BAR_EPISODE_ICON} height={BAR_EPISODE_ICON} viewBox="0 0 16 16" fill="currentColor">
                      <path d="M2.5 3.2v9.6a.6.6 0 0 0 .93.5L10.4 8.5a.6.6 0 0 0 0-1L3.43 2.7a.6.6 0 0 0-.93.5Z"/>
                      <rect x="12" y="2.5" width="2" height="11" rx="0.75"/>
                    </svg>
                  </button>
                ) : (
                  <div style={styles.skipSpacer} aria-hidden="true" />
                )}
              </>
            )}
          </div>
          {/* Right column: everything that is not playback. */}
          <div style={{ ...styles.right, ...styles.side, ...(compact ? styles.rightCompact : {}) }}>
            {/* Not host-gated: the roster is read-only, and PeoplePanel decides
                for itself whether to offer role controls. Gating it here meant a
                viewer had to back out of the video to see who else was watching. */}
            {onOpenPeople && (
              <button
                onClick={onOpenPeople}
                className="btn"
                style={styles.peopleBtn}
                title={isHost ? "People & roles" : "Who's here"}
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                  <circle cx="6" cy="5" r="2.4" stroke="currentColor" strokeWidth="1.5"/>
                  <path d="M1.5 13.5c0-2.2 2-3.6 4.5-3.6s4.5 1.4 4.5 3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  <path d="M11 4.2a2.2 2.2 0 0 1 0 4.2M12.5 13.5c0-1.7-.7-2.9-2-3.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
                {peopleCount != null && peopleCount > 0 && (
                  <span style={styles.peopleBadge}>{peopleCount}</span>
                )}
              </button>
            )}
            {onToggleStats && (
              <button
                onClick={onToggleStats}
                className="btn"
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
            {/* Not gated on transport rights any more: choosing tracks moves you
                onto a stream that has them rather than changing what the room
                hears, so it is no more a control than the volume slider. */}
            {onOpenTrackSwitcher && (
              <button onClick={onOpenTrackSwitcher} className="btn" style={{ ...styles.gearBtn, ...(compact ? styles.gearBtnCompact : {}) }} title="Audio & Subtitles">
                {"\u2699"}
              </button>
            )}
            {/* Next to the gear, because it belongs to the same family of
                "how this is playing" controls — and because a subtitle that
                needs nudging needs nudging while you watch it, which is two
                menus deep from anywhere else. */}
            {onOpenSubtitleTiming && (
              <button
                onClick={onOpenSubtitleTiming}
                className="btn"
                style={{
                  ...styles.gearBtn,
                  ...(compact ? styles.gearBtnCompact : {}),
                  ...(subtitleTimingOpen ? styles.gearBtnActive : {}),
                }}
                title="Subtitle timing"
                aria-label="Subtitle timing"
                aria-pressed={subtitleTimingOpen}
              >
                <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  {/* A subtitle frame with its lines, over the arrows that say
                      it can be moved. Reads as "subtitles, sideways". */}
                  <rect x="1.5" y="3" width="17" height="10.5" rx="2"
                    stroke="currentColor" strokeWidth="1.4" />
                  <path d="M4.5 7.5h5M11.5 7.5h4M4.5 10.5h3M9 10.5h6.5"
                    stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  <path d="M4 17.5h12M4 17.5l2-1.6M4 17.5l2 1.6M16 17.5l-2-1.6M16 17.5l-2 1.6"
                    stroke="currentColor" strokeWidth="1.4"
                    strokeLinecap="round" strokeLinejoin="round" />
                </svg>
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
                      className="btn"
                      style={styles.muteBtn}
                      title={muted ? "Unmute" : "Mute"}
                    >
                      {muted ? "\u{1F507}" : "\u{1F50A}"}
                    </button>
                  </div>
                )}
                <button
                  onClick={() => setVolumeOpen((o) => !o)}
                  className="btn"
                  style={styles.muteBtn}
                  title="Volume"
                  aria-expanded={volumeOpen}
                >
                  {muted ? "\u{1F507}" : "\u{1F50A}"}
                </button>
              </div>
            ) : (
              <>
                <button onClick={toggleMute} className="btn" style={styles.muteBtn} title={muted ? "Unmute" : "Mute"}>
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
  /**
   * The side of the picture a skip applies to.
   *
   * Full height and a share of the width, with the content centred in it, so
   * the amount sits well inside the picture instead of against its edge. The
   * zone is only the positioning; the shape that appears inside it is the
   * pulse, which only the gesture gets.
   */
  seekZone: {
    position: "absolute",
    top: 0,
    bottom: 0,
    // Width is set by the component, from TAP_SIDE_ZONE.
    // Deliberately not clipped. The swell grows a few per cent past the zone at
    // its widest, and cutting it there would put a straight vertical edge back
    // in the middle of the curve, which is the shape this is meant to be free
    // of. The player container clips what leaves the screen.
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    pointerEvents: "none",
    // Above the control overlay, which the indicator deliberately outlives.
    zIndex: 11,
  },
  /**
   * The readout, exactly as it has always looked: the chevron above the count
   * on a rounded plate.
   *
   * The only thing that changed is where it sits. It used to be pinned 6% from
   * the edge of the picture with its contents flush-aligned, which put it half
   * underneath Discord's chrome on a phone and left the chevron over the end of
   * the number rather than above it. Centred in the zone, it lands ~15% in and
   * the two lines sit over one another.
   */
  skipIndicator: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "4px",
    color: "#f0f0f0",
  },
  /** Desktop: no D behind the readout, so it brings its own ground. */
  skipPlate: {
    /**
     * Uneven on purpose, and it is what makes the two lines look centred.
     *
     * The chevron is 10px of ink in a 26px line box, so it carries 8px of dead
     * space above it; the count is 11px of ink in a 17px box and carries 3px
     * below. Equal padding therefore reads as 26px of air over the chevron
     * against 21px under the count - the contents sitting low in the plate by
     * half of that. Splitting the same 36px as 15.5 and 20.5 puts 23.5px of
     * visible space on each side. The plate's size does not change.
     */
    padding: "15.5px 26px 20.5px",
    borderRadius: "999px",
    background: "rgba(0,0,0,0.55)",
    backdropFilter: "blur(6px)",
  },
  /** A gesture: the D is the ground. An outline keeps the text legible where
   *  the arc runs thin without putting a second surface on top of the first. */
  skipIndicatorOnD: {
    textShadow: "0 1px 3px rgba(0,0,0,0.75), 0 0 10px rgba(0,0,0,0.5)",
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
  /**
   * The swell: the whole D, played once per tap and gone between them.
   *
   * Deliberately not a circle at the point touched. A double-tap means "this
   * side of the picture" and nothing more precise than that — answering the
   * exact pixel implies the gesture cared where it landed, and it makes the
   * shape read as two unrelated things, a blob inside a panel.
   */
  seekPulse: {
    position: "absolute",
    // Taller than the picture, so the visible band is the middle of the arc
    // rather than the whole of it. Left and right are set per direction.
    top: SEEK_D_BLEED,
    bottom: SEEK_D_BLEED,
    // Dark, because it is now the only thing darkening the picture: there is no
    // standing wash beneath it to lighten over.
    background: "rgba(0,0,0,0.34)",
    opacity: 0,
    pointerEvents: "none",
    animation: "seek-pulse 520ms cubic-bezier(0.22, 0.7, 0.3, 1) forwards",
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
  // Phone only. `pointerEvents` is set explicitly because the overlay above
  // turns its own off while hidden, and this layer has to keep receiving the
  // tap that brings it back. z-index 0 puts it under the two bars, which claim
  // 1, so it only ever sees a press that missed every control.
  gestureLayer: {
    position: "absolute",
    inset: 0,
    zIndex: 0,
    pointerEvents: "auto",
  },
  /**
   * The three transport buttons, centred on the picture.
   *
   * The centring lives here rather than on the play button, which leaves the
   * standalone `translate` free on each button for the press dip they all share
   * (see .btn in index.html) — `transform` and `translate` compose in a fixed
   * order, and a button doing its own centring in `transform` would fight it.
   *
   * The row itself takes no pointer events: it spans the width of three buttons
   * and two gaps, and the picture between them still belongs to the gesture
   * layer underneath. Each button turns them back on for itself.
   */
  centerTransport: {
    position: "absolute",
    left: "50%",
    top: "50%",
    transform: "translate(-50%, -50%)",
    zIndex: 1,
    display: "flex",
    alignItems: "center",
    /**
     * Closed up from 26px, because the eye now measures to the icon rather
     * than to the edge of a plate. A 52px box holding 13px of icon carries
     * ~20px of empty space on the side facing play; left at 26px the gap read
     * as 46px, nearly twice what it was when both were circles. At 8px the
     * visible distance is back to ~28px, and the two targets still do not touch.
     */
    gap: "8px",
    pointerEvents: "none",
  },
  centerPlayBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "68px",
    height: "68px",
    borderRadius: "50%",
    border: "none",
    background: "rgba(0,0,0,0.45)",
    backdropFilter: "blur(4px)",
    color: "#fff",
    cursor: "pointer",
    fontFamily: "inherit",
    padding: 0,
    pointerEvents: "auto",
  },
  /**
   * Quieter than play: these move you through the series, which is a rarer
   * thing to want than stopping the picture. Bare, with no plate behind them.
   *
   * The 52px box stays even though nothing is drawn on it — it is the touch
   * target, and shrinking it to the 18px of icon would make a control you have
   * to aim at. The icon carries a shadow instead of a plate; see the svg, where
   * that filter has to live so `.btn`'s hover and press brightness still has
   * the button's own `filter` to itself.
   */
  centerNavBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "52px",
    height: "52px",
    // Round, so the focus ring is round. Nothing else is painted.
    borderRadius: "50%",
    border: "none",
    background: "transparent",
    color: "#fff",
    cursor: "pointer",
    fontFamily: "inherit",
    padding: 0,
    pointerEvents: "auto",
  },
  /** Stands in for the plate: enough edge to read on a bright frame. */
  centerNavIcon: {
    filter: "drop-shadow(0 1px 3px rgba(0,0,0,0.7)) drop-shadow(0 0 6px rgba(0,0,0,0.45))",
  },
  /** Holds the place of an absent neighbour so play stays under the thumb. */
  centerNavSpacer: { width: "52px", height: "52px" },
  topBar: {
    // Above the gesture layer, so the Back button is still a button.
    position: "relative",
    zIndex: 1,
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
    // Above the gesture layer — see topBar.
    position: "relative",
    zIndex: 1,
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
  // ─── Phone bar ─────────────────────────────────────────────────
  // Buttons on top, the scrub bar across the bottom with the times either side
  // of it — the shape every phone video player has, and the one worth matching
  // because it is the one people already know.
  bottomBarPhone: {
    display: "flex",
    flexDirection: "column",
  },
  // Visual order only; the DOM keeps the bar first. Reordering the markup would
  // mean maintaining two copies of it.
  controlsPhone: {
    order: 1,
    marginBottom: "8px",
  },
  progressRowPhone: {
    order: 2,
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
  progressHitPhone: {
    // Without a flex basis the hit area collapses: nothing inside it has an
    // intrinsic width, so it would shrink to nothing between the two times.
    flex: 1,
    minWidth: 0,
    marginBottom: 0,
  },
  phoneTime: {
    fontSize: "12px",
    fontWeight: 600,
    color: "#e0e0e0",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
    flexShrink: 0,
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
  /**
   * The two outer columns.
   *
   * Both take the same share of what is left over, which is what actually
   * centres the middle one: `space-between` alone would only centre it if the
   * time and the settings cluster happened to be the same width, and they are
   * not.
   */
  side: {
    flex: "1 1 0",
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: "12px",
  },
  /** The transport, which takes only the room it needs. */
  center: {
    flex: "0 0 auto",
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
  /** Tighter on a tablet, but never truncated: every item here is a target,
   *  and the time in the left column is the thing that gives instead. */
  centerCompact: { gap: "6px" },
  /** Holds the place of an episode button that is not there — the same icon
   *  inside the same padding, so it cannot come out a different width. */
  skipSpacer: {
    width: `${BAR_EPISODE_ICON + SKIP_BTN_PAD_X * 2}px`,
    height: `${BAR_EPISODE_ICON + SKIP_BTN_PAD_Y * 2}px`,
  },
  right: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
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
    padding: `${SKIP_BTN_PAD_Y}px ${SKIP_BTN_PAD_X}px`,
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
  /** Same treatment the stats toggle uses, so "this panel is open" reads the
   *  same way wherever it appears in the bar. */
  gearBtnActive: { color: "#e5a00d", background: "rgba(229,160,13,0.18)" },
  peopleBtn: {
    display: "flex", alignItems: "center", gap: "4px",
    background: "rgba(255,255,255,0.1)", border: "none",
    borderRadius: "16px", padding: "4px 10px",
    color: "#fff", cursor: "pointer", fontSize: "12px", fontFamily: "inherit",
  },
  peopleBadge: {
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
