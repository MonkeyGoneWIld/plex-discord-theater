import { useState, useCallback, useRef, useEffect } from "react";

interface ControlsProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
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
}

function fmt(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
    : `${m}:${s.toString().padStart(2, "0")}`;
}

const HIDE_DELAY_MS = 3000;

export function Controls({
  videoRef,
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
}: ControlsProps) {
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [visible, setVisible] = useState(true);
  const [hoveringProgress, setHoveringProgress] = useState(false);
  // Fraction (0-1) of the bar under the cursor, null when not hovering —
  // drives the seek-preview timestamp tooltip and hover marker.
  const [hoverPct, setHoverPct] = useState<number | null>(null);
  const [hintsVisible, setHintsVisible] = useState(showKeyboardHints);
  const progressRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hintsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousVolumeRef = useRef(1);
  const [bufferedEnd, setBufferedEnd] = useState(0);

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

  const seek = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!canControl || !progressRef.current || !videoRef.current) return;
      if (!duration || !isFinite(duration)) return;
      const rect = progressRef.current.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
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

  const skipBack = useCallback(() => {
    const video = videoRef.current;
    if (!video || !canControl) return;
    skipTo(Math.max(0, video.currentTime - 10));
  }, [videoRef, canControl, skipTo]);

  const skipForward = useCallback(() => {
    const video = videoRef.current;
    if (!video || !canControl) return;
    skipTo(Math.min(video.duration || 0, video.currentTime + 10));
  }, [videoRef, canControl, skipTo]);

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

  const handleProgressMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!progressRef.current) return;
    const rect = progressRef.current.getBoundingClientRect();
    setHoverPct(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
  }, []);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const buffered = duration > 0 ? (bufferedEnd / duration) * 100 : 0;
  const barHeight = hoveringProgress ? 8 : 5;

  return (
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
      <div style={styles.bottomBar}>
        {/* Chunky progress bar */}
        <div
          ref={progressRef}
          onClick={seek}
          onMouseEnter={() => setHoveringProgress(true)}
          onMouseMove={handleProgressMove}
          onMouseLeave={() => { setHoveringProgress(false); setHoverPct(null); }}
          style={{ ...styles.progressHit, cursor: canControl ? "pointer" : "default" }}
        >
          {/* Seek preview: timestamp under the cursor. clamp() keeps the
              bubble from overflowing the bar edges. */}
          {hoverPct != null && duration > 0 && isFinite(duration) && (
            <div
              style={{
                ...styles.seekTooltip,
                left: `clamp(30px, ${hoverPct * 100}%, calc(100% - 30px))`,
              }}
            >
              {fmt(hoverPct * duration)}
            </div>
          )}
          <div style={{ ...styles.progressTrack, height: barHeight, transition: "height 0.15s ease" }}>
            <div style={{ ...styles.progressBuffer, width: `${buffered}%` }} />
            <div style={{ ...styles.progressFill, width: `${progress}%` }} />
            {hoverPct != null && (
              <div style={{ ...styles.hoverMarker, left: `${hoverPct * 100}%` }} />
            )}
            <div
              style={{
                position: "absolute",
                left: `${progress}%`,
                top: "50%",
                transform: "translate(-50%, -50%)",
                width: 14,
                height: 14,
                borderRadius: "50%",
                background: "#e5a00d",
                boxShadow: "0 0 8px rgba(229,160,13,0.5)",
                opacity: canControl && hoveringProgress ? 1 : 0,
                transition: "opacity 0.15s ease",
                pointerEvents: "none",
              }}
            />
          </div>
        </div>

        <div style={styles.controls}>
          <div style={styles.left}>
            {canControl && (
              <>
                {/* Rendered only when a sibling exists, so there's never a dead
                    control — the player omits the handler at the series edges. */}
                {onPrevEpisode && (
                  <button onClick={onPrevEpisode} style={styles.skipBtn} title="Previous episode">
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
                      <rect x="2" y="2.5" width="2" height="11" rx="0.75"/>
                      <path d="M13.5 3.2v9.6a.6.6 0 0 1-.93.5L5.6 8.5a.6.6 0 0 1 0-1l6.97-4.8a.6.6 0 0 1 .93.5Z"/>
                    </svg>
                  </button>
                )}
                <button onClick={togglePlay} style={styles.playBtn}>
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
            <span style={styles.time}>
              {fmt(currentTime)} / {fmt(duration)}
            </span>
          </div>
          <div style={styles.right}>
            {isHost && onOpenPeople && (
              <button onClick={onOpenPeople} style={styles.queueBtn} title="People & roles">
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
                style={{ ...styles.gearBtn, color: statsActive ? "#e5a00d" : "#fff" }}
                title="Stats for nerds (i)"
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                  <path d="M2 14V2M2 14H14M5 11V8M8 11V5M11 11V9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            )}
            {canControl && onOpenTrackSwitcher && (
              <button onClick={onOpenTrackSwitcher} style={styles.gearBtn} title={isHost ? "Audio & Subtitles" : "Subtitles"}>
                {"\u2699"}
              </button>
            )}
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
              style={styles.volume}
            />
            {hintsVisible && (
              <div style={styles.hints}>
                <span style={styles.hintBadge}>Space</span>
                <span style={styles.hintBadge}>{"\u2190\u2192"}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
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
    padding: "16px 20px",
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
    padding: "0 20px 16px",
    background: "linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.4) 60%, transparent 100%)",
    paddingTop: "48px",
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
