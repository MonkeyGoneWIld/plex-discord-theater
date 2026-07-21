import { useState, useEffect } from "react";
import { fetchChildren, getSessionToken, type PlexItem } from "../lib/api";
import { SkeletonBlock } from "./SkeletonBlock";
import type { QueueItem } from "../hooks/useSync";

interface SeasonDetailProps {
  season: PlexItem;
  show: PlexItem;
  onSelectEpisode: (episode: PlexItem) => void;
  onBack: () => void;
  isHost?: boolean;
  isPlaying?: boolean;
  onAddToQueue?: (item: QueueItem) => void;
}

function authUrl(url: string, w?: number, h?: number): string {
  const token = getSessionToken();
  if (!token || !url) return url;
  const sep = url.includes("?") ? "&" : "?";
  let out = `${url}${sep}token=${encodeURIComponent(token)}`;
  if (w && h) out += `&w=${w}&h=${h}`;
  return out;
}

function fmtDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0
    ? `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
    : `${m}:${s.toString().padStart(2, "0")}`;
}

export function SeasonDetail({ season, show, onSelectEpisode, onBack, isHost, isPlaying, onAddToQueue }: SeasonDetailProps) {
  const [episodes, setEpisodes] = useState<PlexItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchChildren(season.ratingKey)
      .then((res) => { if (!cancelled) setEpisodes(res.items); })
      .catch(console.error)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [season.ratingKey]);

  const seasonLabel = season.index != null ? `Season ${season.index}` : season.title;

  return (
    <div style={styles.page}>
      <button onClick={onBack} style={styles.backBtn}>
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Back
      </button>

      <div style={styles.breadcrumb}>
        <span style={styles.breadcrumbShow}>{show.title}</span>
        <span style={styles.breadcrumbSep}>&rsaquo;</span>
        <span style={styles.breadcrumbSeason}>{seasonLabel}</span>
      </div>

      {loading ? (
        <div style={{ padding: "0 24px", display: "flex", flexDirection: "column", gap: "16px" }}>
          <SkeletonBlock width="30%" height={18} />
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={{ display: "flex", gap: "16px", alignItems: "center" }}>
              <SkeletonBlock width={200} height={112} borderRadius={8} />
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "8px" }}>
                <SkeletonBlock width="50%" height={16} />
                <SkeletonBlock width="80%" height={12} />
                <SkeletonBlock width="60%" height={12} />
              </div>
            </div>
          ))}
        </div>
      ) : episodes.length === 0 ? (
        <div style={{
          display: "flex", flexDirection: "column" as const, alignItems: "center",
          padding: "48px 24px", gap: "12px",
        }}>
          <p style={{ color: "#666", fontSize: "14px" }}>No episodes available</p>
        </div>
      ) : (
        <div style={styles.list}>
          {episodes.map((ep) => {
            const isHovered = hoveredKey === ep.ratingKey;
            return (
              <button
                key={ep.ratingKey}
                onClick={() => onSelectEpisode(ep)}
                onMouseEnter={() => setHoveredKey(ep.ratingKey)}
                onMouseLeave={() => setHoveredKey(null)}
                style={{
                  ...styles.episodeCard,
                  ...(isHovered ? styles.episodeCardHover : {}),
                }}
              >
                <div style={styles.thumbWrap}>
                  {ep.thumb ? (
                    <img src={authUrl(ep.thumb, 400, 225)} alt="" style={styles.episodeThumb} loading="lazy" />
                  ) : (
                    <div style={styles.episodePlaceholder}>No Image</div>
                  )}
                  <div style={{ ...styles.playOverlay, opacity: isHovered ? 1 : 0 }}>
                    <div style={styles.playCircle}>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="#fff">
                        <path d="M4 2.5L13 8L4 13.5V2.5Z"/>
                      </svg>
                    </div>
                  </div>
                  {ep.duration && (
                    <div style={styles.durationBadge}>{fmtDuration(ep.duration)}</div>
                  )}
                  {isHost && isPlaying && onAddToQueue && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onAddToQueue({
                          ratingKey: ep.ratingKey,
                          title: ep.title,
                          type: ep.type,
                          thumb: ep.thumb,
                          subtitles: false,
                          parentTitle: show.title,
                          parentIndex: season.index,
                          index: ep.index,
                        });
                      }}
                      style={{
                        padding: "4px 10px", borderRadius: "6px",
                        border: "1px solid rgba(229,160,13,0.4)", background: "rgba(0,0,0,0.6)",
                        color: "#e5a00d", fontSize: "11px", fontWeight: 600,
                        cursor: "pointer", fontFamily: "inherit",
                        position: "absolute", bottom: "8px", right: "8px",
                      }}
                    >
                      + Queue
                    </button>
                  )}
                </div>
                <div style={styles.episodeInfo}>
                  <div style={styles.episodeMeta}>
                    <span style={styles.episodeNumber}>E{ep.index ?? "?"}</span>
                    <span style={styles.episodeTitle}>{ep.title}</span>
                  </div>
                  {ep.summary && (
                    <p style={styles.episodeSummary}>{ep.summary}</p>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: "100vh", background: "#0d0d0d" },
  backBtn: {
    display: "flex", alignItems: "center", gap: "6px",
    margin: "16px 24px", padding: "8px 16px", borderRadius: "8px",
    border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.05)",
    color: "#f0f0f0", cursor: "pointer", fontSize: "14px", fontWeight: 500, fontFamily: "inherit",
  },
  breadcrumb: {
    display: "flex", alignItems: "center", gap: "8px",
    padding: "0 24px 16px", maxWidth: "1100px", margin: "0 auto",
  },
  breadcrumbShow: { fontSize: "14px", color: "#888", fontWeight: 500 },
  breadcrumbSep: { fontSize: "16px", color: "#555" },
  breadcrumbSeason: { fontSize: "14px", color: "#e5a00d", fontWeight: 600 },
  loadingWrap: { display: "flex", justifyContent: "center", padding: "64px" },
  spinner: {
    width: "32px", height: "32px",
    border: "3px solid rgba(255,255,255,0.1)", borderTopColor: "#e5a00d",
    borderRadius: "50%", animation: "spin 0.8s linear infinite",
  },
  empty: { textAlign: "center", padding: "64px", color: "#666", fontSize: "15px" },
  list: {
    maxWidth: "1100px", margin: "0 auto", padding: "0 24px 48px",
    display: "flex", flexDirection: "column", gap: "10px",
  },
  episodeCard: {
    display: "flex", gap: "14px", padding: "10px", borderRadius: "8px",
    border: "1px solid rgba(255,255,255,0.06)", background: "rgba(255,255,255,0.03)",
    cursor: "pointer", color: "inherit", textAlign: "left", fontFamily: "inherit",
    transition: "all 0.2s ease", width: "100%",
  },
  episodeCardHover: {
    borderColor: "rgba(229,160,13,0.3)", background: "rgba(255,255,255,0.05)",
    transform: "scale(1.01)",
  },
  thumbWrap: {
    width: "200px", height: "112px", borderRadius: "6px", flexShrink: 0,
    position: "relative", overflow: "hidden", background: "rgba(255,255,255,0.03)",
  },
  episodeThumb: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  episodePlaceholder: {
    width: "100%", height: "100%", display: "flex", alignItems: "center",
    justifyContent: "center", color: "#555", fontSize: "12px", fontWeight: 500,
  },
  playOverlay: {
    position: "absolute", inset: 0, display: "flex", alignItems: "center",
    justifyContent: "center", transition: "opacity 0.2s ease", background: "rgba(0,0,0,0.3)",
  },
  playCircle: {
    width: "36px", height: "36px", borderRadius: "50%", background: "rgba(0,0,0,0.6)",
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  durationBadge: {
    position: "absolute", bottom: "4px", right: "6px",
    background: "rgba(0,0,0,0.7)", padding: "1px 6px", borderRadius: "3px",
    fontSize: "10px", color: "#ccc",
  },
  episodeInfo: {
    display: "flex", flexDirection: "column", justifyContent: "center",
    gap: "4px", flex: 1, minWidth: 0,
  },
  episodeMeta: { display: "flex", alignItems: "center", gap: "8px" },
  episodeNumber: { color: "#e5a00d", fontSize: "12px", fontWeight: 700 },
  episodeTitle: {
    color: "#f0f0f0", fontSize: "14px", fontWeight: 500,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  episodeSummary: {
    color: "#888", fontSize: "12px", lineHeight: "1.4", margin: 0,
    display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
  },
};
