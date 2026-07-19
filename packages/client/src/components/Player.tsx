import { useEffect, useRef, useState, useCallback } from "react";
import Hls from "hls.js";
import { HlsJsP2PEngine } from "p2p-media-loader-hlsjs";
import { Controls } from "./Controls";
import { TrackSwitcher } from "./TrackSwitcher";
import { QueuePanel } from "./QueuePanel";
import { UpNext } from "./UpNext";
import { hlsMasterUrl, pingSession, stopSession, getSessionToken, fetchConfig, setStreams, saveProgress } from "../lib/api";
import type { PlexItem } from "../lib/api";
import type { SyncState, SyncActions, QueueItem } from "../hooks/useSync";

const PING_INTERVAL_MS = 10_000; // 10s — matches Plex API recommendation for LAN timeline updates
const HEARTBEAT_INTERVAL_MS = 5_000;
const DRIFT_THRESHOLD_S = 2;
const HEARTBEAT_DRIFT_THRESHOLD_S = 3;
const MAX_VIEWER_RETRIES = 3;
const MAX_NETWORK_RETRIES = 5;
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

/** Whether the video has enough buffered data at `t` to play from there. */
function isPositionBuffered(video: HTMLVideoElement, t: number): boolean {
  const { buffered } = video;
  for (let i = 0; i < buffered.length; i++) {
    if (t >= buffered.start(i) - 0.1 && t < buffered.end(i) - 0.3) return true;
  }
  return false;
}

/** End of the furthest buffered range — approximates how far Plex has delivered. */
function bufferedEnd(video: HTMLVideoElement): number {
  const { buffered } = video;
  return buffered.length > 0 ? buffered.end(buffered.length - 1) : video.currentTime;
}

interface PlayerProps {
  item: PlexItem;
  isHost: boolean;
  subtitles: boolean;
  onBack: () => void;
  syncState?: SyncState;
  syncActions?: SyncActions;
  onPlayNext?: (item: QueueItem) => void;
}

export function Player({ item, isHost, subtitles, onBack, syncState, syncActions, onPlayNext }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [vpsRelay, setVpsRelay] = useState<boolean | null>(null); // null = not yet loaded
  const [buffering, setBuffering] = useState(true);
  const [showTrackSwitcher, setShowTrackSwitcher] = useState(false);
  const [trackSwitching, setTrackSwitching] = useState<"audio" | "subtitle" | null>(null);
  const [showQueuePanel, setShowQueuePanel] = useState(false);
  const [showUpNext, setShowUpNext] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const recoveryAttemptRef = useRef(0);
  const recoveryPositionRef = useRef(0);
  const MAX_RECOVERY_ATTEMPTS = 2;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const retryCountRef = useRef(0);
  const hlsDeadRef = useRef(false);
  const networkRetryRef = useRef(0);
  const pendingStopRef = useRef<Promise<void> | null>(null);
  const bufferCleanupRef = useRef<(() => void) | null>(null);
  const seekOffsetRef = useRef(0);
  // Offset the current transcode session started at — Plex has no segments
  // before this position, so seeks behind it always need a restart.
  // Note: a promoted host inherits the stream without knowing the original
  // offset (stays 0); the stall-timeout fallback still recovers in that case.
  const sessionStartOffsetRef = useRef(0);
  const seekStallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastProgressSaveRef = useRef(0);
  const PROGRESS_SAVE_INTERVAL_MS = 30_000;

  // Stable refs so the HLS effect doesn't re-run when these change
  const syncActionsRef = useRef(syncActions);
  syncActionsRef.current = syncActions;
  const syncStateRef = useRef(syncState);
  syncStateRef.current = syncState;

  // Refs for isHost/ownsSession so the main HLS effect doesn't re-run on promotion.
  // The promoted host should keep the existing HLS stream, not tear it down.
  const isHostRef = useRef(isHost);
  isHostRef.current = isHost;
  const ownsSessionRef = useRef(isHost);

  // Whether this Player mounted as host — controls viewerHlsSessionId computation.
  // Using a mount-time ref prevents promotion from flipping the value to null
  // (which would trigger a full HLS teardown/rebuild and reset to 0:00).
  const mountedAsHostRef = useRef(isHost);

  // For the viewer, tracks the host's HLS session ID from sync state.
  // For the host, always null — prevents spurious effect re-runs that would
  // generate a new UUID and orphan the running Plex transcode.
  const viewerHlsSessionId = mountedAsHostRef.current ? null : (syncState?.hlsSessionId ?? null);

  // Handle promotion: start ping + heartbeat when viewer becomes host mid-playback
  useEffect(() => {
    if (!isHost || ownsSessionRef.current) return;

    // Promoted to host — take over session ownership
    ownsSessionRef.current = true;

    // Start pinging to keep transcode alive (the old host was doing this)
    if (pingIntervalRef.current === null) {
      pingIntervalRef.current = setInterval(() => {
        if (sessionIdRef.current) {
          const timeMs = videoRef.current ? videoRef.current.currentTime * 1000 : undefined;
          pingSession(sessionIdRef.current, timeMs).catch(console.error);
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

  const destroyLocal = useCallback(() => {
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
    if (bufferCleanupRef.current) {
      bufferCleanupRef.current();
      bufferCleanupRef.current = null;
    }
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
  }, []);

  // Fetch VPS relay config once on mount — HLS init waits for this
  useEffect(() => {
    fetchConfig()
      .then((config) => setVpsRelay(config.vpsRelay))
      .catch(() => setVpsRelay(false)); // default to non-VPS (P2P mode) if config fails
  }, []);

  // Single HLS session — no mid-stream switching
  useEffect(() => {
    let mounted = true;

    destroyLocal();
    setShowUpNext(false);

    // Host creates a new session; viewer reuses the host's session
    const sessionOwner = ownsSessionRef.current;
    const sessionId = sessionOwner
      ? crypto.randomUUID()
      : viewerHlsSessionId;

    if (!sessionId) {
      // Viewer doesn't have a session ID yet — wait for sync
      return;
    }

    sessionIdRef.current = sessionId;

    const offset = seekOffsetRef.current;
    seekOffsetRef.current = 0;
    if (sessionOwner) sessionStartOffsetRef.current = offset;
    const url = hlsMasterUrl(item.ratingKey, sessionId, { subtitles, offset: offset > 0 ? offset : undefined });

    async function start() {
      if (pendingStopRef.current) {
        try { await pendingStopRef.current; } catch {}
        pendingStopRef.current = null;
        // Give Plex time to fully release transcode resources
        await new Promise(r => setTimeout(r, 500));
      }

      // Wait for VPS config before initializing HLS — prevents double-start
      // (P2P init on false default, then teardown+re-init when config arrives)
      if (vpsRelay === null) return;

      const video = videoRef.current;
      if (!mounted || !video) return;

      if (Hls.isSupported()) {
        const token = getSessionToken();

        const hlsConfig: Partial<import("hls.js").HlsConfig> = {
          maxBufferLength: 60,
          maxMaxBufferLength: 120,
          // hls.js also caps the forward buffer by bytes (default 60 MB, which at
          // 12-20 Mbps is only ~25-40s — silently undercutting maxBufferLength).
          // Raise it so the 60s time target is the real limit.
          maxBufferSize: 150 * 1000 * 1000,
          // Keep 90s behind the playhead so short backward seeks replay from the
          // buffer instead of refetching, while bounding total memory use.
          backBufferLength: 90,
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
                highDemandTimeWindow: 15,
                // Match maxBufferLength (60s) so the whole forward buffer can be
                // filled from peers — beyond this window segments aren't fetched
                // at all, so 30s was halving the effective buffer and giving
                // peers less lead time to supply segments before the HTTP
                // fallback kicks in.
                p2pDownloadTimeWindow: 60,
                httpDownloadTimeWindow: 6,
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

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (!mounted) return;

          // Clear track switching overlay
          setTrackSwitching(null);
          canvasRef.current = null;

          // Clear recovery overlay
          setRecovering(false);

          // Viewer joining mid-playback: seek to host's position immediately
          // instead of waiting for the 5s heartbeat drift threshold
          if (!isHostRef.current && syncActionsRef.current) {
            const syncPos = syncStateRef.current?.position;
            if (syncPos && syncPos > DRIFT_THRESHOLD_S) {
              video.currentTime = syncPos;
            }
          }

          // Pre-fetch cache ensures segments arrive instantly — play as soon as manifest is parsed
          video.play().catch((err) => console.warn("Autoplay prevented:", err));

          // Host: broadcast play with sessionId when manifest is ready
          if (isHostRef.current) {
            syncActionsRef.current?.sendPlay(item.ratingKey, item.title, subtitles, sessionId!);
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
            hlsDeadRef.current = false;
          }
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          console.error("HLS fatal error:", data);

          // MEDIA_ERROR: try HLS.js built-in recovery first
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            console.warn("[HLS] Fatal media error, attempting recoverMediaError");
            hls.recoverMediaError();
            return;
          }

          // NETWORK_ERROR: try hls.startLoad() first (transient failures)
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetryRef.current < MAX_NETWORK_RETRIES) {
            networkRetryRef.current++;
            hls.startLoad();
            return;
          }

          // Viewer: retry by bumping retryKey
          if (!ownsSessionRef.current) {
            if (retryCountRef.current < MAX_VIEWER_RETRIES) {
              retryCountRef.current++;
              console.warn(`[Viewer] HLS fatal error, retry ${retryCountRef.current}/${MAX_VIEWER_RETRIES} in 2s`);
              setTimeout(() => {
                if (mounted) setRetryKey((k) => k + 1);
              }, 2000);
            } else {
              if (mounted) setError(`Playback error: ${data.type}`);
              hlsDeadRef.current = true;
            }
            return;
          }

          // Host: auto-recovery
          if (recoveryAttemptRef.current < MAX_RECOVERY_ATTEMPTS) {
            recoveryAttemptRef.current++;
            const video = videoRef.current;
            recoveryPositionRef.current = video?.currentTime ?? 0;

            // Capture freeze frame (reuse canvasRef from track switching)
            if (video && video.videoWidth > 0) {
              const canvas = document.createElement("canvas");
              canvas.width = video.videoWidth;
              canvas.height = video.videoHeight;
              canvas.getContext("2d")!.drawImage(video, 0, 0);
              canvasRef.current = canvas;
            }

            if (mounted) {
              setRecovering(true);
              setError(null);
            }

            console.warn(`[Host] Stream interrupted, auto-recovery attempt ${recoveryAttemptRef.current}/${MAX_RECOVERY_ATTEMPTS}`);

            // Wait 2s then restart transcode at saved position
            setTimeout(() => {
              if (!mounted) return;
              destroyLocal();
              if (sessionIdRef.current) {
                pendingStopRef.current = stopSession(sessionIdRef.current).catch(() => {});
                sessionIdRef.current = null;
              }
              seekOffsetRef.current = recoveryPositionRef.current;
              setRetryKey((k) => k + 1);
            }, 2000);
          } else {
            // Recovery exhausted — show manual retry
            if (mounted) {
              setError(null);
              setRecovering(false);
            }
            destroyLocal();
            if (sessionIdRef.current) {
              pendingStopRef.current = stopSession(sessionIdRef.current).catch(() => {});
              sessionIdRef.current = null;
            }
          }
        });

        hls.loadSource(url);
        hls.attachMedia(video);

        // Buffering indicator events
        const onWaiting = () => { if (!video.paused) setBuffering(true); };
        const onPlaying = () => setBuffering(false);
        const onSeeked = () => { if (!video.paused) setBuffering(false); };
        video.addEventListener("waiting", onWaiting);
        video.addEventListener("playing", onPlaying);
        video.addEventListener("seeked", onSeeked);
        bufferCleanupRef.current = () => {
          video.removeEventListener("waiting", onWaiting);
          video.removeEventListener("playing", onPlaying);
          video.removeEventListener("seeked", onSeeked);
        };
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        const token = getSessionToken();
        const sep = url.includes("?") ? "&" : "?";
        const nativeUrl = token ? `${url}${sep}token=${encodeURIComponent(token)}` : url;
        video.src = nativeUrl;
        const onLoaded = () => {
          if (!mounted) return;
          video.play().catch((err) => console.warn("Autoplay prevented:", err));
          if (isHostRef.current) {
            syncActionsRef.current?.sendPlay(item.ratingKey, item.title, subtitles, sessionId!);
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
        if (sessionIdRef.current) {
          pingSession(sessionIdRef.current, 0).catch(console.error);
        }
        pingIntervalRef.current = setInterval(() => {
          if (sessionIdRef.current) {
            const timeMs = videoRef.current ? videoRef.current.currentTime * 1000 : undefined;
            pingSession(sessionIdRef.current, timeMs).catch(console.error);
          }
        }, PING_INTERVAL_MS);
      }

      // Host: heartbeat every 5s (guard against double-start if promotion effect already set one)
      if (isHostRef.current && heartbeatIntervalRef.current === null) {
        heartbeatIntervalRef.current = setInterval(() => {
          const v = videoRef.current;
          if (v && v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            syncActionsRef.current?.sendHeartbeat(v.currentTime, !v.paused);

            // Save progress every 30s
            const now = Date.now();
            if (now - lastProgressSaveRef.current >= PROGRESS_SAVE_INTERVAL_MS) {
              lastProgressSaveRef.current = now;
              saveProgress({
                ratingKey: item.ratingKey,
                title: item.title,
                thumb: item.thumb,
                type: item.type,
                parentTitle: item.parentTitle,
                parentIndex: item.parentIndex,
                index: item.index,
                position: v.currentTime,
                duration: v.duration || 0,
              }).catch(() => {});
            }
          }
        }, HEARTBEAT_INTERVAL_MS);
      }
    }

    start();

    return () => {
      mounted = false;
      destroyLocal();
      // Only the session owner stops the Plex transcode
      if (ownsSessionRef.current && sessionIdRef.current) {
        pendingStopRef.current = stopSession(sessionIdRef.current).catch(() => {});
        sessionIdRef.current = null;
      }
    };
  }, [item.ratingKey, subtitles, destroyLocal, viewerHlsSessionId, retryKey, vpsRelay]);

  // Viewer: respond to explicit host commands (play/pause/resume/seek)
  // Does NOT fire on heartbeats — both clients share the same HLS stream
  // so they naturally stay in sync without constant seeking.
  useEffect(() => {
    if (isHostRef.current || !syncState || syncState.commandSeq === 0) return;

    // Viewer recovery: if HLS died after exhausting retries, a new host command
    // means the stream may be alive again — reset and retry
    if (hlsDeadRef.current) {
      hlsDeadRef.current = false;
      retryCountRef.current = 0;
      setRetryKey((k) => k + 1);
      return;
    }

    const video = videoRef.current;
    if (!video) return;

    // Sync play/pause state
    if (syncState.playing && video.paused) {
      video.play().catch(() => {});
    } else if (!syncState.playing && !video.paused) {
      video.pause();
    }

    // Seek correction — only on explicit commands, with generous threshold
    if (syncState.position > 0) {
      const drift = Math.abs(video.currentTime - syncState.position);
      if (drift > DRIFT_THRESHOLD_S) {
        video.currentTime = syncState.position;
      }
    }
  }, [syncState?.commandSeq]);

  // Viewer: periodic drift correction on heartbeats (larger threshold than explicit commands).
  // Also fires on explicit command position updates, but the command-based effect above
  // already corrects at a tighter 2s threshold, making this a no-op in that case.
  useEffect(() => {
    if (isHostRef.current || !syncState) return;
    const video = videoRef.current;
    if (!video || !syncState.playing || video.paused) return;
    if (syncState.position <= 0) return;

    const drift = Math.abs(video.currentTime - syncState.position);
    if (drift > HEARTBEAT_DRIFT_THRESHOLD_S) {
      console.warn(`[Viewer] Heartbeat drift correction: ${drift.toFixed(1)}s`);
      video.currentTime = syncState.position;
    }
  }, [syncState?.position]);

  // Full seek recovery: restart the Plex transcode with an offset so segments
  // exist at the target position. Used when the target can't be reached in-place.
  const handleSeekRestart = useCallback((positionSeconds: number) => {
    if (seekStallTimerRef.current !== null) {
      clearTimeout(seekStallTimerRef.current);
      seekStallTimerRef.current = null;
    }
    seekOffsetRef.current = positionSeconds;
    setBuffering(true);
    syncActionsRef.current?.sendSeek(positionSeconds);
    setRetryKey((k) => k + 1);
  }, []);

  // Host seek entry point. Prefers a cheap in-place seek — the restart path
  // tears down the HLS session and waits for a fresh Plex transcode (5-15s of
  // buffering), which is only necessary when the target segments don't exist.
  //  - Target buffered: instant in-place seek.
  //  - Target unbuffered but at/after the session's start offset: in-place seek
  //    (Plex has usually already transcoded well past what hls.js buffers, and
  //    back-seeks hit segments already on disk). If segments don't arrive
  //    within SEEK_STALL_TIMEOUT_MS, fall back to a transcode restart.
  //  - Target before the session's start offset: segments can't exist — restart.
  const handleHostSeek = useCallback((positionSeconds: number) => {
    const video = videoRef.current;
    if (!video) {
      handleSeekRestart(positionSeconds);
      return;
    }
    if (seekStallTimerRef.current !== null) {
      clearTimeout(seekStallTimerRef.current);
      seekStallTimerRef.current = null;
    }

    if (positionSeconds < sessionStartOffsetRef.current) {
      handleSeekRestart(positionSeconds);
      return;
    }

    const wasBuffered = isPositionBuffered(video, positionSeconds);
    // Large forward jump past the transcode head — segments can't exist yet, so
    // an in-place seek would only stall for SEEK_STALL_TIMEOUT_MS before falling
    // back to a restart anyway. Restart at the target directly and skip the stall.
    if (!wasBuffered && positionSeconds - bufferedEnd(video) > FAR_SEEK_THRESHOLD_S) {
      handleSeekRestart(positionSeconds);
      return;
    }

    video.currentTime = positionSeconds;
    syncActionsRef.current?.sendSeek(positionSeconds);
    if (wasBuffered) return;

    setBuffering(true);
    seekStallTimerRef.current = setTimeout(() => {
      seekStallTimerRef.current = null;
      const v = videoRef.current;
      if (!v) return;
      if (!isPositionBuffered(v, v.currentTime)) {
        console.warn(`[Seek] No data after ${SEEK_STALL_TIMEOUT_MS}ms — restarting transcode at ${v.currentTime.toFixed(1)}s`);
        handleSeekRestart(v.currentTime);
      }
    }, SEEK_STALL_TIMEOUT_MS);
  }, [handleSeekRestart]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const video = videoRef.current;
      if (!video) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      switch (e.key) {
        case " ":
          e.preventDefault();
          if (!isHostRef.current) return;
          if (video.paused) {
            video.play();
            syncActionsRef.current?.sendResume(video.currentTime);
          } else {
            video.pause();
            syncActionsRef.current?.sendPause(video.currentTime);
          }
          break;
        case "ArrowLeft":
          e.preventDefault();
          if (!isHostRef.current) return;
          handleHostSeek(Math.max(0, video.currentTime - 10));
          break;
        case "ArrowRight":
          e.preventDefault();
          if (!isHostRef.current) return;
          handleHostSeek(Math.min(video.duration || 0, video.currentTime + 10));
          break;
        case "m":
        case "M":
          e.preventDefault();
          if (video.volume > 0) {
            (video as any).__prevVolume = video.volume;
            video.volume = 0;
          } else {
            video.volume = (video as any).__prevVolume ?? 1;
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
  }, [handleHostSeek]);

  const handleBack = useCallback(() => {
    destroyLocal();
    // Only the session owner stops the Plex transcode
    if (ownsSessionRef.current && sessionIdRef.current) {
      pendingStopRef.current = stopSession(sessionIdRef.current).catch(() => {});
      sessionIdRef.current = null;
    }
    if (isHostRef.current) {
      syncActionsRef.current?.sendStop();
    }
    onBack();
  }, [destroyLocal, onBack]);

  const handleTrackChange = useCallback(async (partId: number, audioStreamID?: number, subtitleStreamID?: number) => {
    if (!sessionIdRef.current) return;

    // Capture last video frame to canvas for seamless transition
    const video = videoRef.current;
    if (video && video.videoWidth > 0) {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")!.drawImage(video, 0, 0);
      canvasRef.current = canvas;
    }

    // Show overlay
    setTrackSwitching(audioStreamID !== undefined ? "audio" : "subtitle");

    try {
      await setStreams(partId, { audioStreamID, subtitleStreamID });
    } catch (err) {
      console.error("Failed to set streams:", err);
      setTrackSwitching(null);
      canvasRef.current = null;
      return;
    }
    // Restart HLS session to apply new tracks, preserving current position
    if (video && video.currentTime > 0) {
      seekOffsetRef.current = video.currentTime;
    }
    setShowTrackSwitcher(false);
    setRetryKey((k) => k + 1);
  }, []);

  const advanceQueue = useCallback(() => {
    const queue = syncStateRef.current?.queue;
    if (!queue || queue.length === 0) return;
    const next = queue[0];
    syncActionsRef.current?.sendQueueRemove(next.ratingKey);
    onPlayNext?.(next);
  }, [onPlayNext]);

  // Auto-advance on video ended
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !isHost) return;
    const onEnded = () => {
      const queue = syncStateRef.current?.queue;
      if (queue && queue.length > 0) {
        advanceQueue();
      }
    };
    video.addEventListener("ended", onEnded);
    return () => video.removeEventListener("ended", onEnded);
  }, [isHost, advanceQueue]);

  // Show "Up Next" banner when within 30s of the end (host only)
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !isHost) return;
    const onTime = () => {
      const queue = syncStateRef.current?.queue;
      const remaining = (video.duration || 0) - video.currentTime;
      if (queue && queue.length > 0 && remaining <= 30 && remaining > 0 && video.duration > 60) {
        setShowUpNext(true);
      }
    };
    video.addEventListener("timeupdate", onTime);
    return () => video.removeEventListener("timeupdate", onTime);
  }, [isHost]);

  // Build rich display title for Controls top bar
  const displayTitle = item.parentTitle
    ? `${item.parentTitle} \u2014 S${item.parentIndex ?? "?"}E${item.index ?? "?"} \u00b7 ${item.title}`
    : item.year
      ? `${item.title} (${item.year})`
      : item.title;

  return (
    <div style={styles.container}>
      {syncState?.authFailed ? (
        <div style={styles.error}>Session expired — please close and restart the activity</div>
      ) : syncState?.reconnectFailed ? (
        <div style={styles.error}>Connection lost — please close and restart the activity</div>
      ) : error ? (
        <div style={styles.error}>{error}</div>
      ) : syncState?.hostDisconnected ? (
        <div style={styles.hostDisconnected}>Host disconnected — waiting for reconnection...</div>
      ) : null}

      {/* Buffering indicator */}
      {buffering && !error && (
        <div style={styles.bufferingOverlay}>
          <div style={styles.bufferingSpinner} />
          <span style={styles.bufferingText}>Loading...</span>
        </div>
      )}

      <video
        ref={videoRef}
        style={styles.video}
        playsInline
      />

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
      {!recovering && !error && recoveryAttemptRef.current >= MAX_RECOVERY_ATTEMPTS && !sessionIdRef.current && (
        <div style={styles.trackSwitchOverlay}>
          <div style={styles.trackSwitchMessage}>
            <span style={{ color: "#e74c3c", fontSize: "16px", fontWeight: 600 }}>Stream lost</span>
            <button
              onClick={() => {
                recoveryAttemptRef.current = 0;
                recoveryPositionRef.current = recoveryPositionRef.current || 0;
                seekOffsetRef.current = recoveryPositionRef.current;
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

      <Controls
        videoRef={videoRef}
        isHost={isHost}
        title={displayTitle}
        onBack={handleBack}
        onSyncPause={isHost ? syncActions?.sendPause : undefined}
        onSyncResume={isHost ? syncActions?.sendResume : undefined}
        onSyncSeek={isHost ? syncActions?.sendSeek : undefined}
        onSeekRestart={isHost ? handleHostSeek : undefined}
        onOpenTrackSwitcher={isHost ? () => setShowTrackSwitcher(true) : undefined}
        queueCount={syncState?.queue?.length}
        onOpenQueue={isHost ? () => setShowQueuePanel(true) : undefined}
      />
      {showTrackSwitcher && (
        <TrackSwitcher
          ratingKey={item.ratingKey}
          onClose={() => setShowTrackSwitcher(false)}
          onTrackChange={handleTrackChange}
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
      {showUpNext && isHost && syncState?.queue?.[0] && (
        <UpNext
          item={syncState.queue[0]}
          onPlayNow={() => { setShowUpNext(false); advanceQueue(); }}
          onCancel={() => { setShowUpNext(false); syncActions?.sendQueueRemove(syncState.queue[0].ratingKey); }}
        />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
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
