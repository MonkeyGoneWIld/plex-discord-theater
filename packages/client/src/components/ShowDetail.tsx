import { useState, useEffect } from "react";
import {
  fetchMeta, fetchChildren, fetchSeerrTv, seerrRequest, seerrPosterUrl,
  getSessionToken, type PlexItem, type PlexMeta, type SeerrSeason,
} from "../lib/api";
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

// Seerr MediaStatus → badge for a season we don't have yet.
const MISSING_STATUS: Record<number, { label: string; color: string }> = {
  2: { label: "Requested", color: "#e5a00d" },
  3: { label: "Processing", color: "#5aa9e6" },
  4: { label: "Partial", color: "#e5a00d" },
};

export function ShowDetail({ item, onSelectSeason, onReplaceWithSeason, onBack }: ShowDetailProps) {
  const [meta, setMeta] = useState<PlexMeta | null>(null);
  const [seasons, setSeasons] = useState<PlexItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoNavigated, setAutoNavigated] = useState(false);
  // Seasons the library is missing, per Seerr (posters from TMDB). seerrDone
  // gates the single-season auto-nav: a partial show must land here, on the
  // request UI, instead of skipping straight to the episode list.
  const [missingSeasons, setMissingSeasons] = useState<SeerrSeason[]>([]);
  const [seerrDone, setSeerrDone] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    Promise.all([fetchMeta(item.ratingKey), fetchChildren(item.ratingKey)])
      .then(([m, c]) => {
        if (cancelled) return;
        setMeta(m);
        setSeasons(c.items);
      })
      .catch(console.error)
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [item.ratingKey]);

  // Once meta is in, ask Seerr which seasons exist that we don't have.
  useEffect(() => {
    if (loading || !meta) return;
    if (meta.tmdbId == null) {
      setSeerrDone(true);
      return;
    }
    let cancelled = false;
    const owned = new Set(seasons.map((s) => s.index).filter((n) => n != null));
    fetchSeerrTv(meta.tmdbId)
      .then((tv) => {
        if (cancelled) return;
        if (tv.configured) {
          setMissingSeasons(tv.seasons.filter((s) => !owned.has(s.seasonNumber) && s.status !== 5));
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setSeerrDone(true); });
    return () => { cancelled = true; };
  }, [loading, meta, seasons, reloadNonce]);

  // Single-season show with nothing missing: replace this view with the season
  // view so back goes to library instead of looping through auto-nav. Waits for
  // the Seerr answer so partially-available shows keep this landing page.
  useEffect(() => {
    if (loading || autoNavigated || !seerrDone) return;
    if (seasons.length === 1 && missingSeasons.length === 0) {
      setAutoNavigated(true);
      const nav = onReplaceWithSeason ?? onSelectSeason;
      nav(seasons[0], item);
    }
  }, [loading, seerrDone, seasons, missingSeasons, autoNavigated]);

  const toggleSeason = (n: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n); else next.add(n);
      return next;
    });

  const requestable = missingSeasons.filter((s) => s.status == null);

  const submitRequest = () => {
    if (meta?.tmdbId == null || selected.size === 0 || requesting) return;
    setRequesting(true);
    setRequestError(null);
    seerrRequest(meta.tmdbId, "tv", [...selected])
      .then(() => { setSelected(new Set()); setReloadNonce((n) => n + 1); })
      .catch((err) => setRequestError(err instanceof Error ? err.message : "Request failed"))
      .finally(() => setRequesting(false));
  };

  const backdropUrl = meta?.art ? authUrl(meta.art) : null;
  const posterUrl = meta?.thumb ? authUrl(meta.thumb) : (item.thumb ? authUrl(item.thumb) : null);

  // If auto-navigated, render nothing (the parent will mount SeasonDetail)
  if (autoNavigated) return null;

  // Hold the skeleton while deciding whether a single-season show auto-navigates
  // (Seerr answer pending) — avoids flashing this page before the redirect.
  const deciding = !loading && !seerrDone && seasons.length === 1;

  if (loading || deciding) {
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

          {/* Seasons grid — owned (playable) cards plus the seasons we don't
              have yet, rendered as selectable request cards with TMDB posters. */}
          {seasons.length === 0 && missingSeasons.length === 0 && !loading ? (
            <div style={{
              display: "flex", flexDirection: "column" as const, alignItems: "center",
              padding: "48px 24px", gap: "12px",
            }}>
              <p style={{ color: "#666", fontSize: "14px" }}>No seasons available</p>
            </div>
          ) : (
            <div style={styles.seasonsSection}>
              <div style={styles.seasonsHeader}>
                <h2 style={styles.seasonsTitle}>Seasons</h2>
                {requestable.length > 0 && (
                  <div style={styles.requestControls}>
                    <button
                      onClick={() =>
                        setSelected(
                          selected.size === requestable.length
                            ? new Set()
                            : new Set(requestable.map((s) => s.seasonNumber)),
                        )
                      }
                      style={styles.selectAllBtn}
                    >
                      {selected.size === requestable.length ? "Clear" : "Select all missing"}
                    </button>
                    <button
                      onClick={submitRequest}
                      disabled={selected.size === 0 || requesting}
                      style={{
                        ...styles.requestBtn,
                        ...(selected.size === 0 || requesting ? styles.requestBtnDisabled : {}),
                      }}
                    >
                      {requesting
                        ? "Requesting…"
                        : selected.size > 0
                          ? `Request ${selected.size} season${selected.size > 1 ? "s" : ""}`
                          : "Request seasons"}
                    </button>
                  </div>
                )}
              </div>
              {requestError && <div style={styles.requestError}>{requestError}</div>}
              <div style={styles.seasonsGrid}>
                {seasons.map((season) => (
                  <MovieCard
                    key={season.ratingKey}
                    item={season}
                    onClick={(s) => onSelectSeason(s, item)}
                  />
                ))}
                {missingSeasons.map((s) => {
                  const badge = s.status != null ? MISSING_STATUS[s.status] : null;
                  const selectable = s.status == null;
                  const isSel = selected.has(s.seasonNumber);
                  const poster = seerrPosterUrl(s.posterPath);
                  return (
                    <button
                      key={`missing-${s.seasonNumber}`}
                      onClick={selectable ? () => toggleSeason(s.seasonNumber) : undefined}
                      disabled={!selectable}
                      style={{
                        ...styles.missingCard,
                        ...(selectable ? { cursor: "pointer" } : {}),
                        ...(isSel ? styles.missingCardSelected : {}),
                      }}
                    >
                      <div style={styles.missingPosterWrap}>
                        {poster ? (
                          <img src={authUrl(poster)} alt={s.name} style={styles.missingPoster} loading="lazy" />
                        ) : (
                          <div style={styles.missingPlaceholder}>No Poster</div>
                        )}
                        {selectable && (
                          <span style={{ ...styles.check, ...(isSel ? styles.checkOn : {}) }}>
                            {isSel ? "✓" : ""}
                          </span>
                        )}
                        {badge && (
                          <div style={{ ...styles.missingBadge, color: badge.color, borderColor: badge.color }}>
                            {badge.label}
                          </div>
                        )}
                        {!badge && !isSel && <div style={styles.missingLabel}>Not in library</div>}
                      </div>
                      <div style={styles.missingInfo}>
                        <div style={styles.missingTitle}>{s.name}</div>
                        {s.episodeCount > 0 && (
                          <div style={styles.missingEpisodes}>
                            {s.episodeCount} {s.episodeCount === 1 ? "episode" : "episodes"}
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
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
  seasonsHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    flexWrap: "wrap",
    marginBottom: "16px",
  },
  seasonsTitle: {
    fontSize: "20px",
    fontWeight: 600,
    color: "#e0e0e0",
    margin: 0,
  },
  requestControls: {
    display: "flex",
    alignItems: "center",
    gap: "14px",
  },
  selectAllBtn: {
    background: "none",
    border: "none",
    color: "#e5a00d",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  requestBtn: {
    padding: "9px 20px",
    borderRadius: "8px",
    border: "none",
    background: "#e5a00d",
    color: "#000",
    fontSize: "14px",
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  requestBtnDisabled: {
    background: "rgba(229,160,13,0.25)",
    color: "rgba(0,0,0,0.6)",
    cursor: "default",
  },
  requestError: {
    color: "#e5834a",
    fontSize: "13px",
    marginBottom: "12px",
  },
  seasonsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
    gap: "14px",
  },
  // Missing-season request card — matches MovieCard's shape, dimmed poster.
  missingCard: {
    background: "#141414",
    borderRadius: "10px",
    overflow: "hidden",
    border: "1px solid rgba(255,255,255,0.06)",
    color: "inherit",
    textAlign: "left",
    width: "100%",
    padding: 0,
    fontFamily: "inherit",
    cursor: "default",
    transition: "border-color 0.15s ease, box-shadow 0.15s ease",
  },
  missingCardSelected: {
    borderColor: "rgba(229,160,13,0.7)",
    boxShadow: "0 0 0 1px rgba(229,160,13,0.4)",
  },
  missingPosterWrap: {
    position: "relative",
  },
  missingPoster: {
    width: "100%",
    aspectRatio: "2/3",
    objectFit: "cover",
    display: "block",
    opacity: 0.55,
  },
  missingPlaceholder: {
    width: "100%",
    aspectRatio: "2/3",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(255,255,255,0.03)",
    color: "#555",
    fontSize: "13px",
    fontWeight: 500,
  },
  check: {
    position: "absolute",
    top: "8px",
    right: "8px",
    width: "22px",
    height: "22px",
    borderRadius: "6px",
    border: "1px solid rgba(255,255,255,0.35)",
    background: "rgba(0,0,0,0.55)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "13px",
    color: "#000",
  },
  checkOn: {
    background: "#e5a00d",
    borderColor: "#e5a00d",
  },
  missingBadge: {
    position: "absolute",
    top: "8px",
    left: "8px",
    padding: "3px 8px",
    borderRadius: "5px",
    border: "1px solid",
    background: "rgba(0,0,0,0.7)",
    fontSize: "10px",
    fontWeight: 700,
    letterSpacing: "0.3px",
    textTransform: "uppercase" as const,
  },
  missingLabel: {
    position: "absolute",
    top: "8px",
    left: "8px",
    padding: "3px 7px",
    borderRadius: "5px",
    background: "rgba(0,0,0,0.72)",
    color: "rgba(255,255,255,0.85)",
    fontSize: "10px",
    fontWeight: 600,
    letterSpacing: "0.3px",
    textTransform: "uppercase" as const,
  },
  missingInfo: {
    padding: "10px 10px 12px",
  },
  missingTitle: {
    fontSize: "13px",
    fontWeight: 600,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    color: "#e0e0e0",
  },
  missingEpisodes: {
    fontSize: "12px",
    color: "#666",
    marginTop: "3px",
    fontWeight: 500,
  },
};
