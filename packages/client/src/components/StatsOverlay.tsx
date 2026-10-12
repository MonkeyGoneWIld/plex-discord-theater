import { useEffect, useRef, useState } from "react";
import type Hls from "hls.js";
import HlsPkg from "hls.js";
import { qualityLabel } from "../lib/quality";
import { audioDetails, audioSummary, playbackMode, type StreamNotes } from "../lib/streamNotes";
import type { StreamTrack } from "../lib/api";
import { previewDetails, previewSummary, type PreviewStatus } from "../lib/previewStatus";
import { subtitleDetails, subtitleSummary, type SubtitleLoadStatus, type SubtitleShown } from "../lib/subtitleStatus";

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
  onClose: () => void;
}

interface Snapshot {
  resolution: string;
  streamResolution: string;
  fps: string;
  droppedFrames: number;
  totalFrames: number;
  videoBitrate: string;
  bandwidth: string;
  bufferHealth: string;
  videoCodec: string;
  audioCodec: string;
  /** Whether the video is Plex's original, copied, or a re-encode of it. */
  videoPath: string;
  lastFrag: string;
}

const POLL_INTERVAL_MS = 1000;

/** The rows that open to more, each one line until opened. */
type Section = "video" | "audio" | "subtitles" | "thumbnails";
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

function mbps(bitsPerSec: number): string {
  if (!bitsPerSec || !isFinite(bitsPerSec)) return "—";
  return `${(bitsPerSec / 1_000_000).toFixed(2)} Mbps`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function StatsOverlay({
  videoRef, hlsRef, vpsRelay, sessionId, p2pStatsRef, notes, quality, downloadedAheadS, subtitle, subtitleStatusRef,
  previewPartId = null, previewStatusRef, onClose,
}: StatsOverlayProps) {
  // Read by the poll, which is set up once.
  const downloadedAheadRef = useRef(downloadedAheadS);
  downloadedAheadRef.current = downloadedAheadS;
  const [snap, setSnap] = useState<Snapshot | null>(null);
  // Force a re-render each tick so P2P counters (read from a ref) stay live.
  const [, setTick] = useState(0);

  // FPS is derived from the delta in decoded frames between polls.
  const prevFramesRef = useRef<{ frames: number; t: number } | null>(null);
  // Latest fragment download, captured from FRAG_BUFFERED.
  const lastFragRef = useRef<string>("—");
  // Codecs captured from BUFFER_CODECS. The level's videoCodec/audioCodec come
  // from the master playlist's CODECS attribute, which Plex's manifests don't
  // include — so those are almost always undefined and the row read "— / —".
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
        const rate = (bytes * 8) / (ms / 1000);
        lastFragRef.current = `${formatBytes(bytes)} · ${Math.round(ms)} ms · ${mbps(rate)}`;
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
      // let the new BUFFER_CODECS repopulate them.
      codecsRef.current = { video: null, audio: null };
      attachedHlsRef.current = hls;
    };

    const poll = () => {
      attachFragListener();
      const video = videoRef.current;
      const hls = hlsRef.current;
      if (!video) return;

      // Decoded frames + fps
      const q = video.getVideoPlaybackQuality?.();
      const totalFrames = q?.totalVideoFrames ?? 0;
      const droppedFrames = q?.droppedVideoFrames ?? 0;
      const now = performance.now();
      let fps = "—";
      const prev = prevFramesRef.current;
      if (prev && now > prev.t) {
        const df = totalFrames - prev.frames;
        const dt = (now - prev.t) / 1000;
        if (df >= 0 && dt > 0) fps = `${(df / dt).toFixed(1)} fps`;
      }
      prevFramesRef.current = { frames: totalFrames, t: now };

      // Buffer health: seconds ahead of the playhead — downloaded in all, and
      // of that how much the browser itself holds, which for a heavy stream is
      // capped well short of the rest by its own size limit.
      let inPlayer = 0;
      const { buffered, currentTime } = video;
      for (let i = 0; i < buffered.length; i++) {
        if (currentTime >= buffered.start(i) - 0.1 && currentTime <= buffered.end(i) + 0.1) {
          inPlayer = buffered.end(i) - currentTime;
          break;
        }
      }
      const downloaded = Math.max(inPlayer, downloadedAheadRef.current?.() ?? 0);
      const bufferHealth = video.readyState === 0
        ? "—"
        : downloaded - inPlayer >= 1
          ? `${downloaded.toFixed(0)} s · ${inPlayer.toFixed(0)} s in player`
          : `${inPlayer.toFixed(1)} s`;

      // Current level: resolution, bitrate, codecs
      let streamResolution = "—";
      let videoBitrate = "—";
      let videoCodec = "—";
      let audioCodec = "—";
      let videoPath = "—";
      if (hls) {
        const level = hls.levels[hls.currentLevel] ?? hls.levels[hls.loadLevel] ?? hls.levels[0];
        if (level) {
          streamResolution = level.width && level.height ? `${level.width}×${level.height}` : "—";
          videoBitrate = mbps(level.bitrate);
        }
        // Prefer what was parsed from the stream; fall back to the manifest's
        // CODECS attribute on the off-chance a playlist does declare it.
        videoCodec = codecsRef.current.video ?? level?.videoCodec ?? "—";
        audioCodec = codecsRef.current.audio ?? level?.audioCodec ?? "—";
        // The server marks the playlists it builds for copied streams as EVENT
        // playlists (services/direct-stream.ts); Plex's own have no type.
        if (level?.details) {
          videoPath = level.details.type === "EVENT" ? "Original" : "Transcoded";
        }
      }

      setSnap({
        resolution: video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : "—",
        streamResolution,
        fps,
        droppedFrames,
        totalFrames,
        videoBitrate,
        bandwidth: hls ? mbps(hls.bandwidthEstimate) : "—",
        bufferHealth,
        videoCodec,
        audioCodec,
        videoPath,
        lastFrag: lastFragRef.current,
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

  // The few rows with more behind them stay one line until opened.
  const [open, setOpen] = useState<Set<Section>>(loadOpen);
  const toggle = (section: Section) => setOpen((was) => {
    const next = new Set(was);
    if (next.has(section)) next.delete(section);
    else next.add(section);
    saveOpen(next);
    return next;
  });

  const p2p = p2pStatsRef.current;
  const totalDelivered = p2p.p2pBytes + p2p.httpBytes;
  const p2pRatio = totalDelivered > 0 ? Math.round((p2p.p2pBytes / totalDelivered) * 100) : 0;

  // The server's word on the stream beats the playlist-type guess, which can't
  // say why or at what rate.
  const mbpsOf = (kbps: number | null) => (kbps ? ` · ${(kbps / 1000).toFixed(kbps % 1000 ? 1 : 0)} Mbps` : "");
  const source = notes?.video === "copy"
    ? `Original${mbpsOf(notes.kbps)}`
    : notes?.video === "transcode"
      ? `Transcoded${mbpsOf(notes.kbps)}`
      : snap?.videoPath ?? "—";
  // Plex's words for the stream — see playbackMode. Without the server's
  // notes, the playlist says only whether the video is the original.
  const mode = playbackMode(notes)
    ?? (snap?.videoPath === "Original" ? "Direct Stream" : snap?.videoPath === "Transcoded" ? "Transcode" : null);
  const subtitleStatus = subtitleStatusRef?.current ?? null;
  const previewStatus = previewStatusRef?.current ?? null;
  const preview = previewStatus && previewStatus.partId === previewPartId ? previewStatus : null;

  const rows: Array<{ label: string; value: string; section?: Section; details?: Array<[string, string]> }> = [
    { label: "Playback", value: mode ?? "—" },
    { label: "Viewport / Frames", value: `${snap?.resolution ?? "—"} · ${snap?.droppedFrames ?? 0}/${snap?.totalFrames ?? 0} dropped` },
    { label: "Stream resolution", value: snap?.streamResolution ?? "—" },
    { label: "Decode rate", value: snap?.fps ?? "—" },
    { label: "Video bitrate", value: snap?.videoBitrate ?? "—" },
    { label: "Connection speed", value: snap?.bandwidth ?? "—" },
    { label: "Buffer health", value: snap?.bufferHealth ?? "—" },
    {
      label: "Video", value: source, section: "video",
      details: notes?.video === "transcode" && notes.reason ? [["Reason", notes.reason]] : [],
    },
    { label: "Audio", value: audioSummary(notes), section: "audio", details: audioDetails(notes) },
    {
      label: "Subtitles", section: "subtitles",
      value: subtitle ? subtitleSummary(subtitle.track, subtitle.shown, subtitleStatus, subtitle.failed) : "—",
      details: subtitle ? subtitleDetails(subtitle.track, subtitle.shown, subtitleStatus, subtitle.failed) : [],
    },
    {
      label: "Thumbnails", section: "thumbnails",
      value: previewSummary(preview, previewPartId !== null),
      details: previewDetails(preview),
    },
    { label: "Your quality", value: quality ? `Up to ${qualityLabel(quality)}` : qualityLabel(0) },
    { label: "Codecs", value: `${snap?.videoCodec ?? "—"} / ${snap?.audioCodec ?? "—"}` },
    { label: "Last segment", value: snap?.lastFrag ?? "—" },
    { label: "Delivery", value: vpsRelay ? "VPS relay (nginx cache)" : "P2P mesh (WebRTC)" },
    ...(vpsRelay ? [] : [
      { label: "Peers connected", value: String(p2p.peers.size) },
      { label: "From peers / server", value: `${formatBytes(p2p.p2pBytes)} / ${formatBytes(p2p.httpBytes)} (${p2pRatio}%)` },
      { label: "Uploaded to peers", value: formatBytes(p2p.uploadBytes) },
    ]),
    ...(sessionId ? [{ label: "Session", value: sessionId.slice(0, 8) }] : []),
  ];

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.headerTitle}>Stats for nerds</span>
        <button onClick={onClose} className="btn" style={styles.closeBtn} title="Close (i)">
          {"✕"}
        </button>
      </div>
      <div style={styles.body}>
        {rows.map((row) => {
          const expandable = !!row.section && !!row.details?.length;
          const isOpen = expandable && open.has(row.section!);
          const line = (
            <>
              <span style={styles.label}>
                <span style={styles.chevron}>{expandable ? (isOpen ? "▾" : "▸") : ""}</span>
                {row.label}
              </span>
              <span style={styles.value} title={row.value}>{row.value}</span>
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
              {isOpen && (
                <div style={styles.details}>
                  {row.details!.map(([label, value]) => (
                    <div key={label} style={styles.row}>
                      <span style={styles.detailLabel}>{label}</span>
                      <span style={label === "Reason" ? styles.wrappedValue : styles.value} title={value}>{value}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: "absolute",
    top: "64px",
    left: "20px",
    width: "370px",
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
  body: {
    padding: "4px 12px 8px 8px",
    // An open row or two can run past a small window: scroll rather than
    // overflow.
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
    color: "#f0f0f0",
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
  // A reason can run to a few words more than fit; it is the one thing
  // allowed a second line, and only once its row is opened.
  wrappedValue: {
    color: "#f0f0f0",
    textAlign: "right",
    minWidth: 0,
  },
};
