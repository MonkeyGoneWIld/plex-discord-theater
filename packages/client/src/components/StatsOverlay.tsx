import { useEffect, useRef, useState } from "react";
import type Hls from "hls.js";
import HlsPkg from "hls.js";

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
  lastFrag: string;
}

const POLL_INTERVAL_MS = 1000;

function mbps(bitsPerSec: number): string {
  if (!bitsPerSec || !isFinite(bitsPerSec)) return "—";
  return `${(bitsPerSec / 1_000_000).toFixed(2)} Mbps`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function StatsOverlay({ videoRef, hlsRef, vpsRelay, sessionId, p2pStatsRef, onClose }: StatsOverlayProps) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  // Force a re-render each tick so P2P counters (read from a ref) stay live.
  const [, setTick] = useState(0);

  // FPS is derived from the delta in decoded frames between polls.
  const prevFramesRef = useRef<{ frames: number; t: number } | null>(null);
  // Latest fragment download, captured from FRAG_BUFFERED.
  const lastFragRef = useRef<string>("—");
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
        lastFragRef.current = `${formatBytes(bytes)} in ${Math.round(ms)} ms (${mbps(rate)})`;
      }
    };

    const attachFragListener = () => {
      const hls = hlsRef.current;
      if (hls === attachedHlsRef.current) return;
      if (attachedHlsRef.current) {
        attachedHlsRef.current.off(HlsPkg.Events.FRAG_BUFFERED, onFragBuffered);
      }
      if (hls) hls.on(HlsPkg.Events.FRAG_BUFFERED, onFragBuffered);
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

      // Buffer health (seconds ahead of the playhead)
      let bufferHealth = "—";
      const { buffered, currentTime } = video;
      for (let i = 0; i < buffered.length; i++) {
        if (currentTime >= buffered.start(i) - 0.1 && currentTime <= buffered.end(i) + 0.1) {
          bufferHealth = `${(buffered.end(i) - currentTime).toFixed(1)} s`;
          break;
        }
      }

      // Current level: resolution, bitrate, codecs
      let streamResolution = "—";
      let videoBitrate = "—";
      let videoCodec = "—";
      let audioCodec = "—";
      if (hls) {
        const level = hls.levels[hls.currentLevel] ?? hls.levels[hls.loadLevel] ?? hls.levels[0];
        if (level) {
          streamResolution = level.width && level.height ? `${level.width}×${level.height}` : "—";
          videoBitrate = mbps(level.bitrate);
          videoCodec = level.videoCodec ?? "—";
          audioCodec = level.audioCodec ?? "—";
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
        attachedHlsRef.current = null;
      }
    };
  }, [videoRef, hlsRef]);

  const p2p = p2pStatsRef.current;
  const totalDelivered = p2p.p2pBytes + p2p.httpBytes;
  const p2pRatio = totalDelivered > 0 ? Math.round((p2p.p2pBytes / totalDelivered) * 100) : 0;

  const rows: Array<[string, string]> = [
    ["Viewport / Frames", `${snap?.resolution ?? "—"} · dropped ${snap?.droppedFrames ?? 0} / ${snap?.totalFrames ?? 0}`],
    ["Stream resolution", snap?.streamResolution ?? "—"],
    ["Decode rate", snap?.fps ?? "—"],
    ["Video bitrate", snap?.videoBitrate ?? "—"],
    ["Connection speed", snap?.bandwidth ?? "—"],
    ["Buffer health", snap?.bufferHealth ?? "—"],
    ["Codecs", `${snap?.videoCodec ?? "—"} / ${snap?.audioCodec ?? "—"}`],
    ["Last segment", snap?.lastFrag ?? "—"],
    ["Delivery", vpsRelay ? "VPS relay (nginx cache)" : "P2P mesh (WebRTC)"],
  ];

  if (!vpsRelay) {
    rows.push(
      ["Peers connected", String(p2p.peers.size)],
      ["From peers / server", `${formatBytes(p2p.p2pBytes)} / ${formatBytes(p2p.httpBytes)} (${p2pRatio}% P2P)`],
      ["Uploaded to peers", formatBytes(p2p.uploadBytes)],
    );
  }

  if (sessionId) rows.push(["Session", sessionId.slice(0, 8)]);

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.headerTitle}>Stats for nerds</span>
        <button onClick={onClose} style={styles.closeBtn} title="Close (i)">
          {"✕"}
        </button>
      </div>
      <div style={styles.body}>
        {rows.map(([label, value]) => (
          <div key={label} style={styles.row}>
            <span style={styles.label}>{label}</span>
            <span style={styles.value}>{value}</span>
          </div>
        ))}
      </div>
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
    padding: "8px 12px",
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
    padding: "6px 12px 10px",
  },
  row: {
    display: "flex",
    justifyContent: "space-between",
    gap: "12px",
    padding: "3px 0",
  },
  label: {
    color: "rgba(255,255,255,0.5)",
    whiteSpace: "nowrap",
  },
  value: {
    color: "#f0f0f0",
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
  },
};
