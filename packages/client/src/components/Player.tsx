import { useEffect, useRef, useState, useCallback } from "react";
import Hls from "hls.js";
import { HlsJsP2PEngine } from "p2p-media-loader-hlsjs";
import { Controls } from "./Controls";
import { StatsOverlay } from "./StatsOverlay";
import type { P2PStats } from "./StatsOverlay";
import { TrackSwitcher } from "./TrackSwitcher";
import { QueuePanel } from "./QueuePanel";
import { NextUpButton } from "./NextUpButton";
import { PeoplePanel } from "./PeoplePanel";
import { SkipMarkerButton } from "./SkipMarkerButton";
import { hlsMasterUrl, pingSession, stopSession, getSessionToken, fetchConfig, setStreams, saveProgress, fetchMeta, fetchSiblingEpisodes } from "../lib/api";
import { formatMediaTitle } from "../lib/format";
import { loadVolume, saveVolume } from "../lib/volume";
import type { PlexItem, SkipMarker } from "../lib/api";
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

/**
 * Convert a server-resolved episode into a QueueItem for playback.
 *
 * Copies `showTitle` rather than folding it into `parentTitle`: server items put
 * the season in parentTitle and the show in showTitle, so collapsing them would
 * render "Season 2 — S2E1 · Title". See lib/format.ts.
 */
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

/** End of the furthest buffered range — approximates how far Plex has delivered. */
function bufferedEnd(video: HTMLVideoElement): number {
  const { buffered } = video;
  return buffered.length > 0 ? buffered.end(buffered.length - 1) : video.currentTime;
}

interface PlayerProps {
  item: PlexItem;
  isHost: boolean;
  /** Our own Discord user id — lets the people panel label and skip ourselves. */
  selfUserId?: string | null;
  subtitles: boolean;
  onBack: () => void;
  syncState?: SyncState;
  syncActions?: SyncActions;
  onPlayNext?: (item: QueueItem) => void;
}

export function Player({ item, isHost, selfUserId = null, subtitles, onBack, syncState, syncActions, onPlayNext }: PlayerProps) {
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
  const [showPeoplePanel, setShowPeoplePanel] = useState(false);
  const [showStats, setShowStats] = useState(false);
  // Next item to offer, auto-resolved from the series. Queue takes precedence
  // over this at render time — a queued item is a deliberate choice, this is a guess.
  const [nextEpisode, setNextEpisode] = useState<PlexItem | null>(null);
  // Previous episode, for the control-bar back button. Not used by the card.
  const [prevEpisode, setPrevEpisode] = useState<PlexItem | null>(null);
  const [nearEnd, setNearEnd] = useState(false);
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
  // Plex intro/credits markers for the current item, and whichever one the
  // playhead currently sits inside (null when outside every window).
  const [markers, setMarkers] = useState<SkipMarker[]>([]);
  const [activeMarker, setActiveMarker] = useState<SkipMarker | null>(null);
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
  if (subtitlesItemRef.current !== item.ratingKey) {
    subtitlesItemRef.current = item.ratingKey;
    subtitlesOnRef.current = subtitles;
  }

  // Transport rights: the host, plus anyone the host has granted co-host.
  // Note this is UX only — the server independently enforces the same rule.
  // Session ownership stays strictly host-only (ownsSessionRef above): a co-host
  // never pings or stops the Plex transcode.
  const canControl = isHost || (syncState?.isCoHost ?? false);
  const canControlRef = useRef(canControl);
  canControlRef.current = canControl;

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

  // Fetch intro/credits markers for the current item. Host only — the button is
  // host-gated, so viewers skip the request entirely.
  //
  // Deliberately its own effect rather than part of the main HLS effect: that one
  // depends on retryKey, which handleSeekRestart bumps, so markers would be
  // refetched and blanked on every restart-seek. Keying on item.ratingKey also
  // covers queue auto-advance, which reuses this same mounted Player.
  useEffect(() => {
    setMarkers([]);
    setActiveMarker(null);
    if (!canControl) return;
    let cancelled = false;
    fetchMeta(item.ratingKey)
      .then((meta) => { if (!cancelled) setMarkers(meta.markers ?? []); })
      .catch(() => { /* markers are optional — never surface an error over a working stream */ });
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
    setNearEnd(false);
    if (!canControl) return;
    let cancelled = false;
    fetchSiblingEpisodes(item.ratingKey)
      .then((r) => {
        if (cancelled) return;
        setNextEpisode(r.next);
        setPrevEpisode(r.prev);
      })
      .catch(() => { /* optional polish — never surface an error over a working stream */ });
    return () => { cancelled = true; };
  }, [item.ratingKey, canControl]);

  // Single HLS session — no mid-stream switching
  useEffect(() => {
    let mounted = true;

    destroyLocal();

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
    const url = hlsMasterUrl(item.ratingKey, sessionId, {
      subtitles: subtitlesOnRef.current,
      offset: offset > 0 ? offset : undefined,
    });

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
                // Reset counters for the new stream/session.
                const stats = p2pStatsRef.current;
                stats.p2pBytes = 0;
                stats.httpBytes = 0;
                stats.uploadBytes = 0;
                stats.peers = new Set();

                hls.p2pEngine.addEventListener("onSegmentLoaded", ({ bytesLength, downloadSource }) => {
                  if (downloadSource === "p2p") stats.p2pBytes += bytesLength;
                  else stats.httpBytes += bytesLength;
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
            // Send the formatted title, not the bare episode name — viewers
            // reconstruct their item from sync state alone (no show/season
            // fields), so this string is all they have to display.
            syncActionsRef.current?.sendPlay(item.ratingKey, formatMediaTitle(item), subtitlesOnRef.current, sessionId!);
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
            // Send the formatted title, not the bare episode name — viewers
            // reconstruct their item from sync state alone (no show/season
            // fields), so this string is all they have to display.
            syncActionsRef.current?.sendPlay(item.ratingKey, formatMediaTitle(item), subtitlesOnRef.current, sessionId!);
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
        if (amHost) {
          // The host owns the transcode, so a co-host's seek has to go through
          // the smart path — a far jump needs a restart at the new offset, not a
          // bare currentTime write. broadcast=false stops it echoing back out.
          handleHostSeekRef.current(syncState.position, false);
        } else {
          video.currentTime = syncState.position;
        }
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
  // `broadcast` is false when we're applying a seek that came *from* someone else
  // (a co-host) — re-sending it would echo the command back around the room.
  const handleSeekRestart = useCallback((positionSeconds: number, broadcast = true) => {
    if (seekStallTimerRef.current !== null) {
      clearTimeout(seekStallTimerRef.current);
      seekStallTimerRef.current = null;
    }
    seekOffsetRef.current = positionSeconds;
    setBuffering(true);
    if (broadcast) syncActionsRef.current?.sendSeek(positionSeconds);
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
  const handleHostSeek = useCallback((positionSeconds: number, broadcast = true) => {
    const video = videoRef.current;
    if (!video) {
      handleSeekRestart(positionSeconds, broadcast);
      return;
    }
    if (seekStallTimerRef.current !== null) {
      clearTimeout(seekStallTimerRef.current);
      seekStallTimerRef.current = null;
    }

    if (positionSeconds < sessionStartOffsetRef.current) {
      handleSeekRestart(positionSeconds, broadcast);
      return;
    }

    const wasBuffered = isPositionBuffered(video, positionSeconds);
    // Large forward jump past the transcode head — segments can't exist yet, so
    // an in-place seek would only stall for SEEK_STALL_TIMEOUT_MS before falling
    // back to a restart anyway. Restart at the target directly and skip the stall.
    if (!wasBuffered && positionSeconds - bufferedEnd(video) > FAR_SEEK_THRESHOLD_S) {
      handleSeekRestart(positionSeconds, broadcast);
      return;
    }

    video.currentTime = positionSeconds;
    if (broadcast) syncActionsRef.current?.sendSeek(positionSeconds);
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
    if (video) video.currentTime = positionSeconds;
    syncActionsRef.current?.sendSeek(positionSeconds);
  }, [handleHostSeek]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const video = videoRef.current;
      if (!video) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

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
          if (!canControlRef.current) return;
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
          if (!canControlRef.current) return;
          handleSeekCommand(Math.max(0, video.currentTime - 10));
          break;
        case "ArrowRight":
          e.preventDefault();
          if (!canControlRef.current) return;
          handleSeekCommand(Math.min(video.duration || 0, video.currentTime + 10));
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
  }, []);

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
      }
    },
    [handleTrackChange],
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
    const video = videoRef.current;
    if (!video || !canControl) return;
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
    const onEnded = () => setNearEnd(true);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("ended", onEnded);
    return () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("ended", onEnded);
    };
  }, [canControl]);

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
        queueCount={syncState?.queue?.length}
        onOpenQueue={isHost ? () => setShowQueuePanel(true) : undefined}
        peopleCount={syncState?.participants?.length}
        onOpenPeople={isHost ? () => setShowPeoplePanel(true) : undefined}
        // Undefined at the series edges (and for movies), so Controls renders
        // no button rather than a dead one.
        onPrevEpisode={canControl && prevEpisode ? playPrevEpisode : undefined}
        onNextEpisode={canControl && nextEpisode ? playNextEpisode : undefined}
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
            syncActions?.sendPromoteHost(uid);
            setShowPeoplePanel(false);
          }}
          onSetCoHost={(uid, value) => syncActions?.sendSetCoHost(uid, value)}
          onClose={() => setShowPeoplePanel(false)}
        />
      )}
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
