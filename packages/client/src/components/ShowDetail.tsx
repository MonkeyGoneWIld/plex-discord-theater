import { useState, useEffect } from "react";
import {
  fetchMeta, fetchChildren, fetchSeerrTv, fetchShowNextUp, historyEntryToItem,
  getSessionToken, type HistoryEntry, type PlexItem, type PlexMeta, type SeerrSeason,
} from "../lib/api";
import { formatTimecode } from "../lib/format";
import { useImageReady } from "../lib/useImageReady";
import { MovieCard } from "./MovieCard";
import { RatingsRow } from "./RatingsRow";
import { RelatedRows } from "./RelatedRows";
import { CastRow } from "./CastRow";
import { shelfStyles } from "./PosterShelf";
import { SeasonRequestGrid } from "./SeasonRequestGrid";
import { SkeletonBlock } from "./SkeletonBlock";

interface ShowDetailProps {
  item: PlexItem;
  onSelectSeason: (season: PlexItem, show: PlexItem) => void;
  /** Open an episode's detail view — used by the resume button. Omit to hide it. */
  onSelectEpisode?: (episode: PlexItem) => void;
  /** Open another show's detail page — used by the "also in this collection"
   *  rows. Omit to hide those rows. */
  onSelect?: (item: PlexItem) => void;
  onBack: () => void;
}

function authUrl(url: string): string {
  const token = getSessionToken();
  if (!token || !url) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

export function ShowDetail({ item, onSelectSeason, onSelectEpisode, onSelect, onBack }: ShowDetailProps) {
  const [meta, setMeta] = useState<PlexMeta | null>(null);
  const [seasons, setSeasons] = useState<PlexItem[]>([]);
  const [loading, setLoading] = useState(true);
  // Seasons the library is missing, per Seerr (posters from TMDB).
  const [missingSeasons, setMissingSeasons] = useState<SeerrSeason[]>([]);
  const [seerrDone, setSeerrDone] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  // Readiness of the page's independently-fetched parts (see `pageReady`).
  const [ratingsReady, setRatingsReady] = useState(false);
  const [relatedReady, setRelatedReady] = useState(false);
  // Backstop: one slow side request must not hold the whole page.
  const [revealTimedOut, setRevealTimedOut] = useState(false);

  useEffect(() => {
    setRatingsReady(false);
    setRelatedReady(false);
    setRevealTimedOut(false);
    const timer = window.setTimeout(() => setRevealTimedOut(true), 5000);
    return () => clearTimeout(timer);
  }, [item.ratingKey]);
  // Where this viewer left the show: the episode in progress, or the one after
  // the last they finished. Null when never started or watched to the end.
  const [nextUp, setNextUp] = useState<HistoryEntry | null>(null);

  useEffect(() => {
    setNextUp(null);
    let cancelled = false;
    fetchShowNextUp(item.ratingKey)
      .then((res) => { if (!cancelled) setNextUp(res.nextUp); })
      .catch(() => { /* the seasons grid is the real content — never block on this */ });
    return () => { cancelled = true; };
  }, [item.ratingKey]);

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

  const backdropUrl = meta?.art ? authUrl(meta.art) : null;
  const posterUrl = meta?.thumb ? authUrl(meta.thumb) : (item.thumb ? authUrl(item.thumb) : null);

  // Every show lands here, single-season included — a one-season show used to
  // auto-navigate straight to its episode list, which skipped the synopsis,
  // ratings, cast and related rows this page carries.
  //
  // Hold the skeleton until Seerr has answered too, so the request UI and the
  // season grid appear together rather than the latter popping in afterwards.
  const deciding = !loading && !seerrDone;

  // The rest of the page's parts fetch independently, so — as in MovieDetail —
  // hold the skeleton until they've all landed and reveal in one go.
  // A metadata failure renders neither row, so nothing would ever report ready.
  const wantsRatings = meta != null;
  const wantsRelated = meta != null && !!onSelect;
  const backdropReady = useImageReady(backdropUrl);
  const pageReady =
    (!loading && !deciding && backdropReady &&
      (!wantsRatings || ratingsReady) && (!wantsRelated || relatedReady)) ||
    revealTimedOut;

  const skeleton = (
      <div>
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

  return (
    <div style={styles.page}>
      {!pageReady && skeleton}
      {/* Kept mounted behind the skeleton so its children fetch — see MovieDetail. */}
      <div style={pageReady ? styles.revealed : styles.prerender} aria-hidden={!pageReady}>
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
        <>
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

              {/* External ratings for the show as a whole (not per-season). */}
              <RatingsRow
                imdbId={meta.imdbId}
                tmdbId={meta.tmdbId}
                mediaType="show"
                style={styles.ratings}
                onReady={() => setRatingsReady(true)}
              />

              {meta.summary && (
                <p style={styles.summary}>{meta.summary}</p>
              )}

              {/* Pick up where this viewer left off. Opens the episode's detail
                  view rather than playing outright, so the audio/subtitle choice
                  and the Resume/Start Over decision still happen there — the same
                  route every other play in the app takes. */}
              {nextUp && onSelectEpisode && (
                <button
                  onClick={() => onSelectEpisode(historyEntryToItem(nextUp))}
                  style={styles.resumeBtn}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "#f0ad1a"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "#e5a00d"; }}
                >
                  <svg width="20" height="20" viewBox="0 0 22 22" fill="none" style={{ flexShrink: 0 }}>
                    <path d="M5 3.5L18 11L5 18.5V3.5Z" fill="currentColor"/>
                  </svg>
                  <span style={styles.resumeText}>
                    <span style={styles.resumeLabel}>
                      {/* Mid-episode reads as resuming; a fresh episode as
                          continuing the show. */}
                      {nextUp.positionMs > 0 ? "Resume Watching" : "Continue Watching"}
                    </span>
                    <span style={styles.resumeEpisode}>
                      {nextUp.parentIndex != null && nextUp.index != null
                        ? `Season ${nextUp.parentIndex} · Episode ${nextUp.index}`
                        : nextUp.title}
                      {nextUp.parentIndex != null && nextUp.index != null && ` — ${nextUp.title}`}
                      {nextUp.positionMs > 0 && nextUp.durationMs > 0 &&
                        ` · ${formatTimecode(nextUp.durationMs - nextUp.positionMs)} left`}
                    </span>
                  </span>
                </button>
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
              <SeasonRequestGrid
                tmdbId={meta.tmdbId ?? null}
                seasons={missingSeasons}
                onRequested={() => setReloadNonce((n) => n + 1)}
              >
                {seasons.map((season) => (
                  <MovieCard
                    key={season.ratingKey}
                    item={season}
                    onClick={(s) => onSelectSeason(s, item)}
                  />
                ))}
              </SeasonRequestGrid>
            </div>
          )}
        </div>

        {/* Cast & Crew before the collection rows — see MovieDetail. */}
        <div style={shelfStyles.wrap}>
          <CastRow cast={meta.cast} directors={meta.directors} writers={meta.writers} />
        </div>

        {/* Collections then "More Like This" — same rows as the Home tab,
            rendered outside the narrow detail column so they span the page. */}
        {onSelect && (
          <RelatedRows
            ratingKey={item.ratingKey}
            recommendationsTitle="More Like This"
            onSelect={onSelect}
            onReady={() => setRelatedReady(true)}
          />
        )}
        </>
      ) : (
        <div style={styles.loadingWrap}>
          <p style={styles.loadingText}>Failed to load show details</p>
        </div>
      )}
      </div>
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
  // Atomic reveal — see MovieDetail for the reasoning.
  prerender: {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    opacity: 0,
    pointerEvents: "none" as const,
  },
  revealed: {
    opacity: 1,
    transition: "opacity 0.25s ease",
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
  ratings: {
    marginBottom: "20px",
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
  resumeBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: "12px",
    alignSelf: "flex-start",
    padding: "12px 24px",
    borderRadius: "12px",
    border: "none",
    background: "#e5a00d",
    color: "#000",
    cursor: "pointer",
    fontFamily: "inherit",
    textAlign: "left" as const,
    transition: "background 0.15s ease",
    boxShadow: "0 4px 20px rgba(229,160,13,0.3)",
    maxWidth: "100%",
  },
  resumeText: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "2px",
    minWidth: 0,
  },
  resumeLabel: { fontSize: "15px", fontWeight: 700, lineHeight: 1.2 },
  resumeEpisode: {
    fontSize: "12px",
    fontWeight: 600,
    opacity: 0.75,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
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
};
