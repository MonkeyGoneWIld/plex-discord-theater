import { useEffect, useRef, useState } from "react";
import type Hls from "hls.js";
import HlsPkg from "hls.js";
import { qualityLabel } from "../lib/quality";
import { codecFamily, codecName } from "../lib/codecName";
import { audioDetails, audioSummary, playbackMode, type StreamNotes } from "../lib/streamNotes";
import type { StreamTrack } from "../lib/api";
import { previewDetails, previewSummary, type PreviewStatus } from "../lib/previewStatus";
import { subtitleDetails, subtitleSummary, type SubtitleLoadStatus, type SubtitleShown } from "../lib/subtitleStatus";
import {
  HEALTH_COLORS, bufferFalling, bufferHealth, framesHealth, modeHealth, playbackWhy, previewHealth, pushSample, sparkLines,
  speedHealth, stallsHealth, subtitleHealth, syncSummary, type Health, type SyncInfo,
} from "../lib/statsHealth";

/**
 * Cumulative P2P delivery counters, accumulated in the Player from the
 * p2p-media-loader engine events and read here each poll. Lives outside this
 * component so counts survive the overlay being closed/reopened and reflect
 * the whole session, not just since the panel was opened.
 */
export interface P2PStats {
  p2pBytes: number;
  httpBytes: number;
  uploadBytes: number;
  peers: Set<string>;
}

/** The last segment in, as the P2P engine timed it — see Player. */
export interface LastSegment {
  bytes: number;
  /** From the engine first asking for it to its last byte. */
  ms: number;
  fromPeer: boolean;
}

interface StatsOverlayProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  hlsRef: React.RefObject<Hls | null>;
  vpsRelay: boolean;
  sessionId: string | null;
  p2pStatsRef: React.RefObject<P2PStats>;
  /** The server's own account of the stream — see StreamNotes. */
  notes: StreamNotes | null;
  /** This viewer's quality ceiling, kbps, 0 for none. */
  quality: number;
  /** Seconds downloaded past the playhead, the browser's buffer and the P2P
   *  engine's together — see lib/bufferAhead. */
  downloadedAheadS?: () => number;
  /** The subtitle on screen, how it is shown, and whether drawing it failed. */
  subtitle?: { track: StreamTrack | null; shown: SubtitleShown; failed: boolean };
  /** How far a subtitle the player draws has loaded — see SubtitleLayer. */
  subtitleStatusRef?: React.RefObject<SubtitleLoadStatus | null>;
  /** The part whose preview frames the seek bar fetches; null when Plex has none. */
  previewPartId?: number | null;
  /** How far they have come — see Controls. */
  previewStatusRef?: React.RefObject<PreviewStatus | null>;
  /** The last segment in, timed by the engine. hls.js's own timing for it is
   *  made up from the engine's bandwidth estimate, so it is only the fallback. */
  lastSegmentRef?: React.RefObject<LastSegment | null>;
  /** Bytes in, and milliseconds with a download in flight — see Player. */
  downloadMeter?: () => { bytes: number; activeMs: number };
  /** Where this player is against the room — see Player's statsSync. */
  syncInfo?: () => SyncInfo | null;
  /** The title's runtime, for where a subtitle's lines have come. */
  runtimeS?: number | null;
  onClose: () => void;
}

interface Snapshot {
  viewport: string;
  streamResolution: string;
  /** Frames a second, null while paused or before a second sample. */
  fps: number | null;
  paused: boolean;
  droppedFrames: number;
  totalFrames: number;
  /** The level's bitrate, bits a second; 0 unknown. */
  levelBps: number;
  /** The connection's speed while in use, bits a second, and whether it is
   *  only hls.js's estimate (no P2P engine to measure with). */
  speedBps: number | null;
  speedEstimated: boolean;
  /** Seconds downloaded past the playhead, of which in the browser's own buffer. */
  aheadS: number | null;
  inPlayerS: number;
  /** Downloaded to the end of the film: nothing more to wait for. */
  toEnd: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  /** Whether the video is Plex's original, copied, or a re-encode of it. */
  videoPath: string | null;
  lastFrag: string | null;
  /** Where the picture is, seconds. */
  at: number;
}

const POLL_INTERVAL_MS = 1000;
/** Samples the graphs hold: a minute. */
const GRAPH_SLOTS = 60;
/** The fewest slots a graph is drawn across, so two samples aren't a wall. */
const GRAPH_MIN_SLOTS = 10;
/** Seconds a frame verdict looks back over. */
const FRAMES_WINDOW = 10;
/** How far back the connection's speed is measured over. */
const SPEED_WINDOW_MS = 8_000;

/** The rows that open to more. */
type Section = "playback" | "video" | "audio" | "subtitles" | "sync" | "connection" | "peers" | "thumbnails";
/** Which are open — the viewer's own, kept across streams. */
const OPEN_KEY = "pdt:statsOpen";
function loadOpen(): Set<Section> {
  try {
    const raw = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}
function saveOpen(open: Set<Section>): void {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...open]));
  } catch {
    // Storage unavailable: they start closed next time.
  }
}

function mbps(bitsPerSec: number | null, digits = 1): string {
  if (!bitsPerSec || !isFinite(bitsPerSec)) return "—";
  return `${(bitsPerSec / 1_000_000).toFixed(digits)} Mbps`;
}

function lastSegmentText(seg: LastSegment | null): string | null {
  if (!seg || !(seg.ms > 0)) return null;
  return `${formatBytes(seg.bytes)} · ${Math.round(seg.ms)} ms · ${mbps((seg.bytes * 8 * 1000) / seg.ms)}${seg.fromPeer ? " · peer" : ""}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const GRAPH_W = 300;

/**
 * A minute of one measure, coloured by how it is doing now: an area under a
 * line, with gaps where there was nothing to measure, a dashed line for a
 * level to compare against, and red ticks for moments to mark.
 */
function Graph({ values, max, health, height, level, marks }: {
  values: Array<number | null>;
  max: number;
  health: Health;
  height: number;
  level?: number | null;
  marks?: boolean[];
}) {
  if (values.filter((v) => v !== null).length < 2) return null;
  const color = HEALTH_COLORS[health === "none" ? "info" : health];
  // Stretched across the width while the first minute builds up, rather than
  // a sliver at the right of an empty box.
  const slots = Math.max(GRAPH_MIN_SLOTS, Math.min(GRAPH_SLOTS, values.length));
  const lines = sparkLines(values, max, GRAPH_W, height, slots);
  const step = GRAPH_W / (slots - 1);
  const offset = slots - values.length;
  const levelY = level ? height - 1 - Math.min(1, level / max) * (height - 3) : null;
  return (
    <svg viewBox={`0 0 ${GRAPH_W} ${height}`} preserveAspectRatio="none" style={{ ...styles.graph, height }} aria-hidden>
      <rect width={GRAPH_W} height={height} fill="#1b1b1b" />
      {lines.map((points, i) => {
        const xs = points.split(" ");
        const first = xs[0].split(",")[0];
        const last = xs[xs.length - 1].split(",")[0];
        return (
          <g key={i}>
            <polygon points={`${first},${height} ${points} ${last},${height}`} fill={color.fill} />
            <polyline points={points} fill="none" stroke={color.line} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          </g>
        );
      })}
      {levelY !== null && (
        <line x1={0} y1={levelY} x2={GRAPH_W} y2={levelY} stroke="#bbb" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      )}
      {marks?.map((m, i) => (m ? <rect key={i} x={(offset + i) * step - 1} y={0} width={2} height={height} fill={HEALTH_COLORS.bad.line} /> : null))}
    </svg>
  );
}

/** A bar of parts side by side, each [share of 100, colour]. */
function Bar({ parts, children }: { parts: Array<[number, string]>; children?: React.ReactNode }) {
  return (
    <div style={styles.bar}>
      {parts.map(([w, c], i) => <div key={i} style={{ width: `${Math.max(0, Math.min(100, w))}%`, background: c }} />)}
      {children}
    </div>
  );
}

export function StatsOverlay({
  videoRef, hlsRef, vpsRelay, sessionId, p2pStatsRef, notes, quality, downloadedAheadS, subtitle, subtitleStatusRef,
  previewPartId = null, previewStatusRef, lastSegmentRef, downloadMeter, syncInfo, runtimeS = null, onClose,
}: StatsOverlayProps) {
  // Read by the poll, which is set up once.
  const downloadedAheadRef = useRef(downloadedAheadS);
  downloadedAheadRef.current = downloadedAheadS;
  const downloadMeterRef = useRef(downloadMeter);
  downloadMeterRef.current = downloadMeter;
  const lastSegmentPropRef = useRef(lastSegmentRef);
  lastSegmentPropRef.current = lastSegmentRef;
  const [snap, setSnap] = useState<Snapshot | null>(null);
  // Force a re-render each tick so P2P counters (read from a ref) stay live.
  const [, setTick] = useState(0);

  // FPS is derived from the delta in decoded frames between polls.
  const prevFramesRef = useRef<{ frames: number; dropped: number; t: number } | null>(null);
  // The download meter's readings over the last few seconds, and the last
  // speed they gave.
  const meterReadingsRef = useRef<Array<{ bytes: number; activeMs: number; at: number }>>([]);
  const lastSpeedRef = useRef<number | null>(null);
  // A minute of each graphed measure, a sample a poll.
  const historyRef = useRef({
    fps: [] as Array<number | null>,
    drops: [] as boolean[],
    frames: [] as Array<{ shown: number; dropped: number }>,
    buffer: [] as Array<number | null>,
    speed: [] as Array<number | null>,
  });
  // Latest fragment download, captured from FRAG_BUFFERED.
  const lastFragRef = useRef<string | null>(null);
  // Codecs captured from BUFFER_CODECS. The level's videoCodec/audioCodec come
  // from the master playlist's CODECS attribute, which Plex's manifests don't
  // include — so those are almost always undefined.
  // BUFFER_CODECS instead reports what hls.js parsed out of the actual stream.
  const codecsRef = useRef<{ video: string | null; audio: string | null }>({ video: null, audio: null });
  // The hls instance we attached the FRAG_BUFFERED listener to (may change on
  // recovery, which tears down and rebuilds the Hls instance).
  const attachedHlsRef = useRef<Hls | null>(null);

  useEffect(() => {
    const onFragBuffered = (_e: unknown, data: { frag?: { stats?: { loaded: number; loading: { start: number; end: number } } } }) => {
      const stats = data.frag?.stats;
      if (!stats) return;
      const bytes = stats.loaded;
      const ms = stats.loading.end - stats.loading.start;
      if (bytes > 0 && ms > 0) {
        lastFragRef.current = `${formatBytes(bytes)} · ${Math.round(ms)} ms · ${mbps((bytes * 8) / (ms / 1000))}`;
      }
    };

    const onBufferCodecs = (
      _e: unknown,
      data: { video?: { codec?: string }; audio?: { codec?: string }; audiovideo?: { codec?: string } },
    ) => {
      // audiovideo is the muxed case — one track carrying both, which is what
      // MPEG-TS from Plex produces.
      const video = data.video?.codec ?? data.audiovideo?.codec ?? null;
      const audio = data.audio?.codec ?? null;
      if (video) codecsRef.current.video = video;
      if (audio) codecsRef.current.audio = audio;
    };

    const attachFragListener = () => {
      const hls = hlsRef.current;
      if (hls === attachedHlsRef.current) return;
      if (attachedHlsRef.current) {
        attachedHlsRef.current.off(HlsPkg.Events.FRAG_BUFFERED, onFragBuffered);
        attachedHlsRef.current.off(HlsPkg.Events.BUFFER_CODECS, onBufferCodecs);
      }
      if (hls) {
        hls.on(HlsPkg.Events.FRAG_BUFFERED, onFragBuffered);
        hls.on(HlsPkg.Events.BUFFER_CODECS, onBufferCodecs);
      }
      // A rebuilt Hls instance re-parses the stream, so drop stale codecs and
      // let the new BUFFER_CODECS repopulate them. Its frame count starts
      // again from nothing too.
      codecsRef.current = { video: null, audio: null };
      prevFramesRef.current = null;
      attachedHlsRef.current = hls;
    };

    const poll = () => {
      attachFragListener();
      const video = videoRef.current;
      const hls = hlsRef.current;
      if (!video) return;
      const history = historyRef.current;
      const now = performance.now();

      // Frames: shown and dropped since the last poll. Paused, nothing is
      // shown, and nothing is wrong: a gap in the graph.
      const q = video.getVideoPlaybackQuality?.();
      const totalFrames = q?.totalVideoFrames ?? 0;
      const droppedFrames = q?.droppedVideoFrames ?? 0;
      const prev = prevFramesRef.current;
      let fps: number | null = null;
      let dropped = 0;
      const playing = !video.paused && !video.seeking && video.readyState >= 3;
      if (q && prev && now > prev.t && totalFrames >= prev.frames) {
        const shown = totalFrames - prev.frames;
        dropped = Math.max(0, droppedFrames - prev.dropped);
        if (playing) {
          fps = shown / ((now - prev.t) / 1000);
          pushSample(history.frames, { shown, dropped }, FRAMES_WINDOW);
        }
      }
      prevFramesRef.current = q ? { frames: totalFrames, dropped: droppedFrames, t: now } : null;
      pushSample(history.fps, fps, GRAPH_SLOTS);
      pushSample(history.drops, dropped > 0, GRAPH_SLOTS);

      // Buffer: seconds ahead of the playhead — downloaded in all, and of that
      // how much the browser itself holds, which for a heavy stream is capped
      // well short of the rest by its own size limit.
      let inPlayer = 0;
      let rangeEnd = 0;
      const { buffered, currentTime } = video;
      for (let i = 0; i < buffered.length; i++) {
        if (currentTime >= buffered.start(i) - 0.1 && currentTime <= buffered.end(i) + 0.1) {
          inPlayer = buffered.end(i) - currentTime;
          rangeEnd = buffered.end(i);
          break;
        }
      }
      const aheadS = video.readyState === 0 ? null : Math.max(inPlayer, downloadedAheadRef.current?.() ?? 0);
      const toEnd = Number.isFinite(video.duration) && video.duration > 0 && rangeEnd >= video.duration - 0.5;
      pushSample(history.buffer, aheadS, GRAPH_SLOTS);

      // Speed: what came in over the time anything was coming in, across the
      // last SPEED_WINDOW_MS — a segment fetched in parts arrives in bursts,
      // and a second at a time read 2 Mbps and 19 by turns on a 6.5 Mbps
      // line. Idle — a full buffer — says nothing new: the last speed stands.
      let speedBps: number | null = lastSpeedRef.current;
      let speedEstimated = false;
      const meter = downloadMeterRef.current?.();
      if (meter) {
        const readings = meterReadingsRef.current;
        readings.push({ ...meter, at: now });
        while (readings.length > 1 && now - readings[0].at > SPEED_WINDOW_MS) readings.shift();
        const from = readings[0];
        if (meter.activeMs - from.activeMs >= 1000 && meter.bytes >= from.bytes) {
          speedBps = ((meter.bytes - from.bytes) * 8) / ((meter.activeMs - from.activeMs) / 1000);
          lastSpeedRef.current = speedBps;
        }
        // Nothing coming in since the panel opened — the buffer full, say:
        // the last segment's own speed is the best word there is.
        const seg = lastSegmentPropRef.current?.current;
        if (speedBps === null && seg && seg.ms > 0) speedBps = (seg.bytes * 8 * 1000) / seg.ms;
      } else if (hls?.bandwidthEstimate) {
        speedBps = hls.bandwidthEstimate;
        speedEstimated = true;
      }
      pushSample(history.speed, speedBps, GRAPH_SLOTS);

      // Current level: resolution, bitrate, codecs
      let streamResolution = "—";
      let levelBps = 0;
      let videoPath: string | null = null;
      const level = hls ? hls.levels[hls.currentLevel] ?? hls.levels[hls.loadLevel] ?? hls.levels[0] : undefined;
      if (level) {
        streamResolution = level.width && level.height ? `${level.width}×${level.height}` : "—";
        levelBps = level.bitrate || 0;
        // The server marks the playlists it builds for copied streams as EVENT
        // playlists (services/direct-stream.ts); Plex's own have no type.
        if (level.details) videoPath = level.details.type === "EVENT" ? "Original" : "Transcoded";
      }

      setSnap({
        viewport: video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : "—",
        streamResolution,
        fps,
        paused: video.paused,
        droppedFrames,
        totalFrames,
        levelBps,
        speedBps,
        speedEstimated,
        aheadS,
        inPlayerS: inPlayer,
        toEnd,
        // Prefer what was parsed from the stream; fall back to the manifest's
        // CODECS attribute on the off-chance a playlist does declare it.
        videoCodec: codecsRef.current.video ?? level?.videoCodec ?? null,
        audioCodec: codecsRef.current.audio ?? level?.audioCodec ?? null,
        videoPath,
        lastFrag: lastFragRef.current,
        at: video.currentTime,
      });
      setTick((n) => n + 1);
    };

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      clearInterval(id);
      if (attachedHlsRef.current) {
        attachedHlsRef.current.off(HlsPkg.Events.FRAG_BUFFERED, onFragBuffered);
        attachedHlsRef.current.off(HlsPkg.Events.BUFFER_CODECS, onBufferCodecs);
        attachedHlsRef.current = null;
      }
    };
  }, [videoRef, hlsRef]);

  // What is behind a row stays out of the way until the row is opened.
  const [open, setOpen] = useState<Set<Section>>(loadOpen);
  const toggle = (section: Section) => setOpen((was) => {
    const next = new Set(was);
    if (next.has(section)) next.delete(section);
    else next.add(section);
    saveOpen(next);
    return next;
  });

  const history = historyRef.current;
  const p2p = p2pStatsRef.current;
  const totalDelivered = p2p.p2pBytes + p2p.httpBytes;
  const p2pRatio = totalDelivered > 0 ? Math.round((p2p.p2pBytes / totalDelivered) * 100) : 0;

  // The server's word on the stream beats the playlist-type guess, which can't
  // say why or at what rate.
  const streamBps = notes?.kbps ? notes.kbps * 1000 : snap?.levelBps || null;
  const copied = notes?.video ? notes.video === "copy" : snap?.videoPath ? snap.videoPath === "Original" : null;
  const source = copied === null ? "—" : `${copied ? "Original" : "Transcoded"}${streamBps ? ` · ${mbps(streamBps)}` : ""}`;
  // Plex's words for the stream — see playbackMode. Without the server's
  // notes, the playlist says only whether the video is the original.
  const mode = playbackMode(notes) ?? (copied === null ? null : copied ? "Direct Stream" : "Transcode");
  const videoSummary = [
    snap && snap.streamResolution !== "—" ? snap.streamResolution : null,
    codecFamily(snap?.videoCodec),
    streamBps ? mbps(streamBps) : null,
  ].filter(Boolean).join(" · ") || "—";

  // Frames: the last few seconds playing, against the stream's usual rate —
  // the median of the last half minute, which one jittery sample can't move.
  const recentFrames = history.frames.reduce((a, f) => ({ shown: a.shown + f.shown, dropped: a.dropped + f.dropped }), { shown: 0, dropped: 0 });
  const playedFps = history.fps.filter((f): f is number => f !== null).slice(-30).sort((a, b) => a - b);
  const nominalFps = playedFps.length >= 5 ? playedFps[Math.floor(playedFps.length / 2)] : null;
  const framesState: Health = snap?.paused || snap?.fps == null ? "none" : framesHealth(recentFrames, snap.fps, nominalFps);
  const framesText = !snap || snap.totalFrames === 0 && snap.fps === null
    ? "—"
    : `${snap.paused ? "paused" : snap.fps === null ? "—" : `${snap.fps.toFixed(1)} fps`} · ${snap.droppedFrames}/${snap.totalFrames} dropped`;

  const subtitleStatus = subtitleStatusRef?.current ?? null;
  const subtitleState = subtitle ? subtitleHealth(subtitle.shown, subtitle.track, subtitleStatus, subtitle.failed) : "none";
  const subtitleLoading = subtitle?.shown === "drawn" && subtitle.track && !subtitle.failed &&
    (!subtitleStatus || subtitleStatus.streamId !== subtitle.track.id || subtitleStatus.state === "loading" || subtitleStatus.state === "reading");

  const sync = syncInfo?.() ?? null;
  const syncLine = syncSummary(sync);

  const bufferState = bufferHealth(snap?.aheadS ?? null, snap?.toEnd);
  // One number: everything downloaded ahead, in the browser's buffer or the
  // P2P engine's. Where it is held makes no difference to anyone watching —
  // a skip into either plays at once.
  const bufferText = snap?.aheadS == null
    ? "—"
    : snap.toEnd
      ? "to the end"
      : `${snap.aheadS < 10 ? snap.aheadS.toFixed(1) : snap.aheadS.toFixed(0)} s`;

  const speedState = speedHealth(snap?.speedBps ?? null, streamBps, { health: bufferState, falling: bufferFalling(history.buffer) });
  const speedText = snap?.speedBps
    ? `${mbps(snap.speedBps)}${snap.speedEstimated ? " est." : ""}${streamBps ? ` · needs ${mbps(streamBps)}` : ""}`
    : "—";

  const preview = previewStatusRef?.current ?? null;
  const thumbs = preview && preview.partId === previewPartId ? preview : null;
  const thumbsState = previewHealth(thumbs, previewPartId !== null);
  const thumbsLoading = thumbs && (thumbs.state === "waiting" || thumbs.state === "downloading");

  const lastSegment = lastSegmentText(lastSegmentRef?.current ?? null) ?? snap?.lastFrag ?? null;
  const delivery = vpsRelay ? "VPS relay (nginx cache)" : "P2P mesh (WebRTC)";
  const graphMax = (values: Array<number | null>, floor: number, also = 0) =>
    Math.max(floor, also, ...values.filter((v): v is number => v !== null)) * 1.15;

  // What is playing, then where it is against the room and how it arrives,
  // then the seek bar's frames.
  type Row = { label: string; value: string; health?: Health; section?: Section; details?: Array<[string, string, Health?]>; visual?: React.ReactNode; keep?: string };
  const rows: Row[] = [
    {
      label: "Playback", value: mode ?? "—", health: modeHealth(mode), section: "playback",
      details: [
        ...playbackWhy(notes, mode).map(([l, v]) => [l, v, "warn"] as [string, string, Health]),
        ["Quality", quality ? `Up to ${qualityLabel(quality)}` : qualityLabel(0)],
        ...(sessionId ? [["Session", sessionId.slice(0, 8)] as [string, string]] : []),
      ],
    },
    {
      label: "Video", value: videoSummary, health: copied === null ? "none" : copied ? "ok" : "warn", section: "video",
      details: [
        ["Source", source, copied === null ? "none" : copied ? "ok" : "warn"],
        ...(notes?.video === "transcode" && notes.reason ? [["Reason", notes.reason, "warn"] as [string, string, Health]] : []),
        ["Codec", codecName(snap?.videoCodec) ?? "—"],
        ["Viewport", snap?.viewport ?? "—"],
      ],
    },
    {
      label: "Frames", value: framesText, health: framesState,
      visual: <Graph values={history.fps} max={graphMax(history.fps, 30)} health={framesState} height={22} marks={history.drops} />,
    },
    {
      label: "Audio", value: audioSummary(notes), section: "audio",
      health: notes?.audio === "copy" ? "ok" : notes?.audio === "transcode" ? "warn" : "none",
      details: [
        ...(snap?.audioCodec ? [["Codec", codecName(snap.audioCodec)!] as [string, string]] : []),
        ...audioDetails(notes).map(([l, v]) => [l, v, l === "Source" ? "none" : "warn"] as [string, string, Health]),
      ],
    },
    {
      label: "Subtitles", section: "subtitles", health: subtitleState,
      ...splitState(subtitle ? subtitleSummary(subtitle.track, subtitle.shown, subtitleStatus, subtitle.failed) : "—"),
      details: subtitle ? subtitleDetails(subtitle.track, subtitle.shown, subtitleStatus, subtitle.failed) : [],
      visual: subtitleLoading ? subtitleBar(subtitleStatus, subtitle?.track?.id ?? null, runtimeS, snap?.at ?? 0) : null,
    },
    {
      label: "Sync", value: syncLine.text, health: syncLine.health, section: "sync",
      details: sync ? [
        ["Role", sync.role],
        ["Playback rate", `${sync.rate.toFixed(2)}×`, Math.abs(sync.rate - 1) >= 0.005 ? "info" : "none"],
        ["Stalls", sync.stalls.count ? `${sync.stalls.count} · ${(sync.stalls.totalMs / 1000).toFixed(1)} s in all` : "none", stallsHealth(sync.stalls)],
      ] : [],
    },
    {
      label: "Buffer", value: bufferText, health: bufferState,
      visual: <Graph values={history.buffer} max={graphMax(history.buffer, BUFFER_GRAPH_FLOOR_S)} health={bufferState} height={24} />,
    },
    {
      label: "Connection", value: speedText, health: speedState, section: "connection",
      details: [
        ...(lastSegment ? [["Last segment", lastSegment] as [string, string]] : []),
        ["Delivery", delivery],
      ],
      visual: <Graph values={history.speed} max={graphMax(history.speed, 1_000_000, streamBps ?? 0)} health={speedState} height={26} level={streamBps} />,
    },
    ...(vpsRelay ? [] : [{
      label: "Peers", value: `${p2p.peers.size} peer${p2p.peers.size === 1 ? "" : "s"} · ${p2pRatio}% from peers`, section: "peers" as Section,
      details: [["Uploaded", formatBytes(p2p.uploadBytes)] as [string, string]],
      visual: totalDelivered > 0 ? (
        <>
          <Bar parts={[[p2pRatio, PEERS], [100 - p2pRatio, SERVER]]} />
          <div style={styles.legend}>
            <span style={{ color: PEERS }}>peers {formatBytes(p2p.p2pBytes)}</span>
            <span style={{ color: SERVER_TEXT }}>server {formatBytes(p2p.httpBytes)}</span>
          </div>
        </>
      ) : null,
    }]),
    {
      label: "Thumbnails", section: "thumbnails", health: thumbsState,
      value: previewSummary(thumbs, previewPartId !== null),
      details: previewDetails(thumbs),
      visual: thumbsLoading && thumbs ? thumbnailBar(thumbs) : null,
    },
  ];

  return (
    <div style={styles.panel}>
      <style>{`@keyframes pdtStatsSweep{0%{left:-30%}100%{left:100%}}`}</style>
      <div style={styles.header}>
        <span style={styles.headerTitle}>Stats for nerds</span>
        <button onClick={onClose} className="btn" style={styles.closeBtn} title="Close (i)">
          {"✕"}
        </button>
      </div>
      <div style={styles.body}>
        {BANDS.map((band) => (
          <div key={band.label} style={{ ...styles.band, background: band.background, border: `1px solid ${band.border}` }}>
            <div style={{ ...styles.bandLabel, color: band.color }}>{band.label}</div>
            {rows.filter((row) => band.rows.includes(row.label)).map(renderRow)}
          </div>
        ))}
      </div>
    </div>
  );

  function renderRow(row: Row) {
          const expandable = !!row.section && !!row.details?.length;
          const isOpen = expandable && open.has(row.section!);
          const line = (
            <>
              <span style={styles.label}>
                <span style={styles.chevron}>{expandable ? (isOpen ? "▾" : "▸") : ""}</span>
                {row.label}
              </span>
              <span style={{ ...styles.valueLine, color: HEALTH_COLORS[row.health ?? "none"].line }} title={`${row.value}${row.keep ?? ""}`}>
                <span style={styles.valueText}>{row.value}</span>
                {row.keep ? <span style={styles.valueKeep}>{row.keep}</span> : null}
              </span>
            </>
          );
          return (
            <div key={row.label}>
              {expandable ? (
                <button type="button" style={styles.toggleRow} onClick={() => toggle(row.section!)} aria-expanded={isOpen}>
                  {line}
                </button>
              ) : (
                <div style={styles.row}>{line}</div>
              )}
              {row.visual ? <div style={styles.visual}>{row.visual}</div> : null}
              {isOpen && (
                <div style={styles.details}>
                  {row.details!.map(([label, value, health], i) => (
                    <div key={i} style={styles.row}>
                      <span style={styles.detailLabel}>{label}</span>
                      <span
                        style={{
                          ...(label === "Reason" || label === "Why" || label === "" ? styles.wrappedValue : styles.value),
                          color: HEALTH_COLORS[health ?? "none"].line,
                        }}
                        title={value}
                      >
                        {value}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
  }
}

/**
 * The panel's sections: the media playing; where this player is against the
 * room and how the stream reaches it; the seek bar's previews — each outlined
 * on a faint background of its own, so the eye finds a group before reading
 * a line.
 */
const BANDS: Array<{ label: string; rows: string[]; background: string; border: string; color: string }> = [
  {
    label: "Media", rows: ["Playback", "Video", "Frames", "Audio", "Subtitles"],
    background: "rgba(255,255,255,0.035)", border: "rgba(255,255,255,0.16)", color: "rgba(255,255,255,0.55)",
  },
  {
    label: "Sync and network", rows: ["Sync", "Buffer", "Connection", "Peers"],
    background: "rgba(106,162,232,0.07)", border: "rgba(106,162,232,0.42)", color: "#6aa2e8",
  },
  {
    label: "Previews", rows: ["Thumbnails"],
    background: "rgba(217,164,65,0.07)", border: "rgba(217,164,65,0.42)", color: "#d9a441",
  },
];

/** "English (SRT) · reading (412)" as the part that may shorten and the state that stays. */
function splitState(summary: string): { value: string; keep?: string } {
  const at = summary.lastIndexOf(" · ");
  return at > 0 ? { value: summary.slice(0, at), keep: summary.slice(at) } : { value: summary };
}

/** Where the buffer graph's scale starts, so a few seconds don't fill it. */
const BUFFER_GRAPH_FLOOR_S = 40;
const PEERS = HEALTH_COLORS.info.line;
const SERVER = "#3c5a80";
const SERVER_TEXT = "#8aa3c2";
const SUBTITLE_COLOR = "#9b8fe0";
const THUMBS_COLOR = "#d9a441";

/**
 * A subtitle still coming: where along the film its lines have all come, and
 * where the picture is, while Plex reads it out of the file; a sweep while a
 * file beside it, or the first answer, is on its way.
 */
function subtitleBar(status: SubtitleLoadStatus | null, trackId: number | null, runtimeS: number | null, atS: number) {
  const reading = status && status.streamId === trackId && status.state === "reading" && runtimeS;
  if (!reading) {
    return (
      <div style={styles.bar}>
        <div style={{ position: "absolute", top: 0, bottom: 0, width: "30%", background: SUBTITLE_COLOR, opacity: 0.8, animation: "pdtStatsSweep 1.4s linear infinite" }} />
      </div>
    );
  }
  return (
    <div style={styles.bar}>
      {(status.covered ?? []).map(([from, to], i) => {
        const end = to === null ? runtimeS : Math.min(to, runtimeS);
        return (
          <div key={i} style={{ position: "absolute", top: 0, bottom: 0, left: `${(from / runtimeS) * 100}%`, width: `${Math.max(0.5, ((end - from) / runtimeS) * 100)}%`, background: SUBTITLE_COLOR }} />
        );
      })}
      <div style={{ position: "absolute", top: 0, bottom: 0, left: `${Math.min(100, (atS / runtimeS) * 100)}%`, width: 2, background: "#fff" }} />
    </div>
  );
}

/** The preview frames still coming: how many are in, with a tick where each pass ends. */
function thumbnailBar(status: PreviewStatus) {
  const share = status.frames ? (status.ready / status.frames) * 100 : 0;
  return (
    <div style={styles.bar}>
      <div style={{ width: `${share}%`, background: THUMBS_COLOR }} />
      {status.transport === "progressive-v2" && [5, 15, 40].map((at) => (
        <div key={at} style={{ position: "absolute", top: 0, bottom: 0, left: `${at}%`, width: 1, background: "#141414" }} />
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: "absolute",
    top: "64px",
    left: "20px",
    width: "340px",
    maxWidth: "calc(100% - 40px)",
    background: "rgba(15,15,15,0.82)",
    backdropFilter: "blur(12px)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: "10px",
    color: "#f0f0f0",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "12px",
    zIndex: 16,
    boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 12px",
    borderBottom: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(255,255,255,0.04)",
  },
  headerTitle: {
    fontSize: "12px",
    fontWeight: 600,
    letterSpacing: "0.3px",
    color: "#e5a00d",
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "rgba(255,255,255,0.6)",
    cursor: "pointer",
    fontSize: "13px",
    lineHeight: 1,
    padding: "2px 4px",
    fontFamily: "inherit",
  },
  band: {
    borderRadius: "6px",
    padding: "2px 6px 4px 4px",
    marginBottom: "4px",
  },
  bandLabel: {
    fontSize: "10px",
    fontWeight: 600,
    letterSpacing: "0.8px",
    textTransform: "uppercase",
    padding: "2px 0 1px 12px",
  },
  body: {
    padding: "6px 8px 4px 6px",
    // Open rows can run past a small window: scroll rather than overflow.
    maxHeight: "calc(100vh - 160px)",
    overflowY: "auto",
  },
  row: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: "12px",
    padding: "2px 0",
  },
  toggleRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: "12px",
    width: "100%",
    padding: "2px 0",
    background: "none",
    border: "none",
    color: "inherit",
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
  },
  chevron: {
    display: "inline-block",
    width: "12px",
    color: "#e5a00d",
  },
  label: {
    color: "rgba(255,255,255,0.5)",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  visual: {
    margin: "1px 0 4px 12px",
  },
  graph: {
    display: "block",
    width: "100%",
  },
  bar: {
    position: "relative",
    display: "flex",
    height: "5px",
    borderRadius: "3px",
    background: "#2a2a2a",
    overflow: "hidden",
    marginTop: "3px",
  },
  legend: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: "11px",
    marginTop: "2px",
  },
  details: {
    margin: "0 0 4px 16px",
    padding: "0 0 2px 8px",
    borderLeft: "1px solid rgba(255,255,255,0.12)",
  },
  detailLabel: {
    color: "rgba(255,255,255,0.4)",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  value: {
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
  valueLine: {
    display: "flex",
    justifyContent: "flex-end",
    minWidth: 0,
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
  },
  valueText: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
  valueKeep: {
    flexShrink: 0,
  },
  // A reason can run to a few words more than fit; it is the one thing
  // allowed a second line, and only once its row is opened.
  wrappedValue: {
    textAlign: "right",
    minWidth: 0,
  },
};
