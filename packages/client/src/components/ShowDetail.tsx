import { useState, useEffect } from "react";
import { fetchMeta, fetchChildren, getSessionToken, type PlexItem, type PlexMeta } from "../lib/api";
import { SeasonRequestPanel } from "./SeasonRequestPanel";
import { MovieCard } from "./MovieCard";
import { SkeletonBlock } from "./SkeletonBlock";

interface ShowDetailProps {
  item: PlexItem;
  onSelectSeason: (season: PlexItem, show: PlexItem) => void;
  onReplaceWithSeason?: (season: PlexItem, show: PlexItem) => void;
  onBack: () => void;
}

function authUrl(url: string): string {
  const token = getSessionToken();
  if (!token || !url) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

export function ShowDetail({ item, onSelectSeason, onReplaceWithSeason, onBack }: ShowDetailProps) {
  const [meta, setMeta] = useState<PlexMeta | null>(null);
  const [seasons, setSeasons] = useState<PlexItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoNavigated, setAutoNavigated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    Promise.all([fetchMeta(item.ratingKey), fetchChildren(item.ratingKey)])
      .then(([m, c]) => {
        if (cancelled) return;
        setMeta(m);
        setSeasons(c.items);

        // Single-season show: replace this view with the season view
        // so back goes to library instead of looping through auto-nav
        if (c.items.length === 1 && !autoNavigated) {
          setAutoNavigated(true);
          const nav = onReplaceWithSeason ?? onSelectSeason;
          nav(c.items[0], item);
        }
      })
      .catch(console.error)
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [item.ratingKey]);

  const backdropUrl = meta?.art ? authUrl(meta.art) : null;
  const posterUrl = meta?.thumb ? authUrl(meta.thumb) : (item.thumb ? authUrl(item.thumb) : null);

  // If auto-navigated, render nothing (the parent will mount SeasonDetail)
  if (autoNavigated) return null;

  if (loading) {
    return (
      <div style={styles.page}>
        <button onClick={onBack} style={styles.backBtn}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Back
        </button>
        <SkeletonBlock width="100%" height={300} borderRadius={0} />
        <div style={{ display: "flex", gap: "24px", padding: "24px", maxWidth: 1100 }}>
          <SkeletonBlock width={180} height={270} borderRadius={8} />
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "12px" }}>
            <SkeletonBlock width="60%" height={24} />
            <SkeletonBlock width="40%" height={16} />
            <SkeletonBlock width="100%" height={14} />
            <SkeletonBlock width="90%" height={14} />
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "16px", padding: "0 24px 24px" }}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i}>
              <SkeletonBlock height={240} borderRadius={8} />
              <SkeletonBlock width="70%" height={14} style={{ marginTop: 8 }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      {/* Backdrop */}
      {backdropUrl && (
        <div style={styles.backdropWrap}>
          <img src={backdropUrl} alt="" style={styles.backdropImg} />
          <div style={styles.backdropOverlay} />
        </div>
      )}

      {/* Back button */}
      <button onClick={onBack} style={styles.backBtn}>
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Back
      </button>

      {meta ? (
        <div style={styles.content}>
          {/* Poster + Info layout */}
          <div style={styles.layout}>
            {posterUrl && (
              <div style={styles.posterWrap}>
                <img src={posterUrl} alt={meta.title} style={styles.poster} />
              </div>
            )}

            <div style={styles.info}>
              <h1 style={styles.title}>{meta.title}</h1>

              <div style={styles.metaRow}>
                {meta.year && <span style={styles.metaItem}>{meta.year}</span>}
                {item.childCount != null && (
                  <>
                    {meta.year && <span style={styles.metaDot}>&middot;</span>}
                    <span style={styles.metaItem}>
                      {item.childCount} {item.childCount === 1 ? "Season" : "Seasons"}
                    </span>
                  </>
                )}
              </div>

              {meta.genres.length > 0 && (
                <div style={styles.genres}>
                  {meta.genres.map((g) => (
                    <span key={g} style={styles.genrePill}>{g}</span>
                  ))}
                </div>
              )}

              {meta.summary && (
                <p style={styles.summary}>{meta.summary}</p>
              )}
            </div>
          </div>

          {/* Seasons grid */}
          {seasons.length === 0 && !loading ? (
            <div style={{
              display: "flex", flexDirection: "column" as const, alignItems: "center",
              padding: "48px 24px", gap: "12px",
            }}>
              <p style={{ color: "#666", fontSize: "14px" }}>No seasons available</p>
            </div>
          ) : (
            <div style={styles.seasonsSection}>
              <h2 style={styles.seasonsTitle}>Seasons</h2>
              <div style={styles.seasonsGrid}>
                {seasons.map((season) => (
                  <MovieCard
                    key={season.ratingKey}
                    item={season}
                    onClick={(s) => onSelectSeason(s, item)}
                  />
                ))}
              </div>
            </div>
          )}
          {/* Request any seasons you don't have yet (owned ones show above). */}
          {meta.tmdbId != null && (
            <div style={{ padding: "0 24px 24px" }}>
              <SeasonRequestPanel
                tmdbId={meta.tmdbId}
                heading="Request seasons"
                hideAvailable
                ownedSeasons={seasons.map((s) => s.index).filter((n): n is number => n != null)}
              />
            </div>
          )}
        </div>
      ) : (
        <div style={styles.loadingWrap}>
          <p style={styles.loadingText}>Failed to load show details</p>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    position: "relative",
    minHeight: "100vh",
    background: "#0d0d0d",
    overflow: "hidden",
  },
  backdropWrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: "60vh",
    overflow: "hidden",
  },
  backdropImg: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    filter: "blur(20px) brightness(0.3)",
    transform: "scale(1.1)",
  },
  backdropOverlay: {
    position: "absolute",
    inset: 0,
    background: "linear-gradient(to bottom, rgba(13,13,13,0.3) 0%, #0d0d0d 100%)",
  },
  backBtn: {
    position: "relative",
    zIndex: 10,
    display: "flex",
    alignItems: "center",
    gap: "6px",
    margin: "16px 24px",
    padding: "8px 16px",
    borderRadius: "8px",
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(255,255,255,0.05)",
    color: "#f0f0f0",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: 500,
    fontFamily: "inherit",
    backdropFilter: "blur(12px)",
  },
  loadingWrap: {
    position: "relative",
    zIndex: 10,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "50vh",
    gap: "16px",
  },
  spinner: {
    width: "32px",
    height: "32px",
    border: "3px solid rgba(255,255,255,0.1)",
    borderTopColor: "#e5a00d",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  },
  loadingText: {
    color: "#888",
    fontSize: "15px",
  },
  content: {
    position: "relative",
    zIndex: 10,
    maxWidth: "1100px",
    margin: "0 auto",
    padding: "0 24px 48px",
  },
  layout: {
    display: "flex",
    gap: "36px",
    alignItems: "flex-start",
  },
  posterWrap: {
    flexShrink: 0,
    width: "240px",
    borderRadius: "12px",
    overflow: "hidden",
    boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
  },
  poster: {
    width: "100%",
    display: "block",
    aspectRatio: "2/3",
    objectFit: "cover",
  },
  info: {
    flex: 1,
    minWidth: 0,
    paddingTop: "8px",
  },
  title: {
    fontSize: "32px",
    fontWeight: 700,
    lineHeight: 1.15,
    letterSpacing: "-0.02em",
    color: "#f0f0f0",
    marginBottom: "12px",
  },
  metaRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "16px",
  },
  metaItem: {
    fontSize: "15px",
    color: "#888",
    fontWeight: 500,
  },
  metaDot: {
    color: "#555",
    fontSize: "15px",
  },
  genres: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
    marginBottom: "20px",
  },
  genrePill: {
    padding: "4px 12px",
    borderRadius: "20px",
    background: "rgba(255,255,255,0.07)",
    border: "1px solid rgba(255,255,255,0.08)",
    color: "#aaa",
    fontSize: "13px",
    fontWeight: 500,
  },
  summary: {
    fontSize: "15px",
    lineHeight: 1.6,
    color: "#999",
    marginBottom: "28px",
    display: "-webkit-box",
    WebkitLineClamp: 4,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  },
  seasonsSection: {
    marginTop: "40px",
  },
  seasonsTitle: {
    fontSize: "20px",
    fontWeight: 600,
    color: "#e0e0e0",
    marginBottom: "16px",
  },
  seasonsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
    gap: "14px",
  },
};
