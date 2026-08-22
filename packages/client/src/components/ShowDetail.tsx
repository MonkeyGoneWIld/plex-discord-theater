import { useState, useEffect } from "react";
import { useMediaQuery, NARROW_QUERY } from "../lib/useMediaQuery";
import {
  fetchMeta, fetchChildren, fetchSeerrTv, fetchShowNextUp, historyEntryToItem, posterThumbUrl,
  getSessionToken, type Credit, type HistoryEntry, type PlexItem, type PlexMeta, type SeerrSeason,
} from "../lib/api";
import { formatTimecode } from "../lib/format";
import { useRevealTimeout } from "../lib/useRevealTimeout";
import { MovieCard } from "./MovieCard";
import { RatingsRow } from "./RatingsRow";
import { RelatedRows } from "./RelatedRows";
import { CastRow } from "./CastRow";
import { shelfStyles } from "./PosterShelf";
import { SeasonRequestGrid } from "./SeasonRequestGrid";
import { DetailLoading } from "./DetailLoading";
import { PlexMediaActions } from "./PlexMediaActions";

interface ShowDetailProps {
  item: PlexItem;
  onSelectSeason: (season: PlexItem, show: PlexItem) => void;
  /** Open an episode's detail view — used by the resume button. Omit to hide it. */
  onSelectEpisode?: (episode: PlexItem) => void;
  /** Open another show's detail page — used by the "also in this collection"
   *  rows. Omit to hide those rows. */
  onSelect?: (item: PlexItem) => void;
  /** Open a cast/crew member's page. Omit to render the row unclickable. */
  onSelectPerson?: (person: Credit) => void;
  onBack: () => void;
}

/**
 * Hard cap on the wait.
 *
 * The gate below reveals as soon as the page's header is in — poster, metadata
 * and ratings — and gives up waiting after a second regardless. A cached page
 * satisfies it within a frame or two and never shows the spinner at all.
 */
const REVEAL_TIMEOUT_MS = 1000;

function authUrl(url: string): string {
  const token = getSessionToken();
  if (!token || !url) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

export function ShowDetail({ item, onSelectSeason, onSelectEpisode, onSelect, onSelectPerson, onBack }: ShowDetailProps) {
  const [meta, setMeta] = useState<PlexMeta | null>(null);
  const [seasons, setSeasons] = useState<PlexItem[]>([]);
  const [loading, setLoading] = useState(true);
  // Seasons the library is missing, per Seerr (posters from TMDB).
  const [missingSeasons, setMissingSeasons] = useState<SeerrSeason[]>([]);
  const [reloadNonce, setReloadNonce] = useState(0);
  // The backdrop is the one part that can't come from the clicked card, so it
  // fades in on load rather than appearing hard.
  const [backdropLoaded, setBackdropLoaded] = useState(false);
  // Reveal gate — see `pageReady`.
  const [posterLoaded, setPosterLoaded] = useState(false);
  const [ratingsReady, setRatingsReady] = useState(false);
  // Where this viewer left the show: the episode in progress, or the one after
  // the last they finished. Null when never started or watched to the end.
  const [nextUp, setNextUp] = useState<HistoryEntry | null>(null);
  // Phone portrait: the poster and the detail column can't sit side by side.
  // The poster is a fixed 240px, so on a 390px screen the text beside it got
  // roughly 90px — the title broke a word per line, the genre pills stacked one
  // to a row, and "3 Seasons" wrapped. Same treatment as MovieDetail: the
  // poster goes above the text and the text gets the whole width.
  const narrow = useMediaQuery(NARROW_QUERY);

  useEffect(() => {
    setNextUp(null);
    let cancelled = false;
    fetchShowNextUp(item.ratingKey)
      .then((res) => { if (!cancelled) setNextUp(res.nextUp); })
      .catch(() => { /* the seasons grid is the real content — never block on this */ });
    return () => { cancelled = true; };
  }, [item.ratingKey]);

  // Metadata and seasons are fetched independently rather than through a single
  // Promise.all. They're separate requests to Plex and the header only needs the
  // first, so waiting for both meant the title, artwork and synopsis were held
  // back by the season list — the slower of the two on a long-running show.
  useEffect(() => {
    let cancelled = false;
    fetchMeta(item.ratingKey)
      .then((m) => { if (!cancelled) setMeta(m); })
      .catch(console.error);
    return () => { cancelled = true; };
  }, [item.ratingKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchChildren(item.ratingKey)
      .then((c) => { if (!cancelled) setSeasons(c.items); })
      .catch(console.error)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [item.ratingKey]);

  // Once meta is in, ask Seerr which seasons exist that we don't have.
  useEffect(() => {
    if (loading || !meta || meta.tmdbId == null) return;
    let cancelled = false;
    const owned = new Set(seasons.map((s) => s.index).filter((n) => n != null));
    fetchSeerrTv(meta.tmdbId)
      .then((tv) => {
        if (cancelled) return;
        if (tv.configured) {
          setMissingSeasons(tv.seasons.filter((s) => !owned.has(s.seasonNumber) && s.status !== 5));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [loading, meta, seasons, reloadNonce]);

  const backdropUrl = meta?.art ? authUrl(meta.art) : null;
  // Same sized URL the card used — see posterThumbUrl.
  const posterSrc = meta?.thumb ?? item.thumb;
  const posterUrl = posterSrc ? posterThumbUrl(posterSrc) : null;

  // Every show lands here, single-season included — a one-season show used to
  // auto-navigate straight to its episode list, which skipped the synopsis,
  // ratings, cast and related rows this page carries.
  //
  // Optimistic render, as in MovieDetail: the card that was clicked already has
  // the title, year, poster and synopsis, so the page is drawn immediately and
  // the metadata fills in the parts it alone knows.
  const dTitle = meta?.title ?? item.title;
  const dYear = meta?.year ?? item.year;
  const dSummary = meta?.summary ?? item.summary ?? null;

  // Header and season list only — see MovieDetail for why the cast and the
  // collection rows are left to fill in on their own.
  const revealTimedOut = useRevealTimeout(item.ratingKey, REVEAL_TIMEOUT_MS);
  const pageReady =
    (meta != null && !loading && (posterLoaded || !posterUrl) && ratingsReady) ||
    revealTimedOut;

  return (
    <div style={styles.page}>
      {!pageReady && <DetailLoading />}
      {/* Kept mounted behind the placeholder — see MovieDetail. */}
      <div style={pageReady ? styles.revealed : styles.prerender} aria-hidden={!pageReady}>
      {/* Backdrop — the one part not available from the clicked card. */}
      {backdropUrl && (
        <div style={styles.backdropWrap}>
          <img
            src={backdropUrl}
            alt=""
            style={{ ...styles.backdropImg, opacity: backdropLoaded ? 1 : 0 }}
            onLoad={() => setBackdropLoaded(true)}
          />
          <div style={styles.backdropOverlay} />
        </div>
      )}

      {/* Back button */}
      <button className="btn" onClick={onBack} style={styles.backBtn}>
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Back
      </button>

      <>
        <div style={{ ...styles.content, ...(narrow ? styles.contentNarrow : {}) }}>
          {/* Poster + Info layout — stacks on phone portrait */}
          <div style={{ ...styles.layout, ...(narrow ? styles.layoutNarrow : {}) }}>
            {posterUrl && (
              <div style={{ ...styles.posterWrap, ...(narrow ? styles.posterWrapNarrow : {}) }}>
                <img
                  src={posterUrl}
                  alt={dTitle}
                  style={styles.poster}
                  onLoad={() => setPosterLoaded(true)}
                  onError={() => setPosterLoaded(true)}
                  // A poster served from the browser cache can finish decoding
                  // before onLoad is attached, in which case the event never
                  // arrives and the gate would wait for nothing.
                  ref={(el) => { if (el?.complete) setPosterLoaded(true); }}
                />
              </div>
            )}

            <div style={styles.info}>
              <h1 style={{ ...styles.title, ...(narrow ? styles.titleNarrow : {}) }}>{dTitle}</h1>

              <div style={styles.metaRow}>
                {dYear && <span style={styles.metaItem}>{dYear}</span>}
                {item.childCount != null && (
                  <>
                    {dYear && <span style={styles.metaDot}>&middot;</span>}
                    <span style={styles.metaItem}>
                      {item.childCount} {item.childCount === 1 ? "Season" : "Seasons"}
                    </span>
                  </>
                )}
              </div>

              {/* Genres and ratings need the metadata, so both reserve their
                  height to keep the synopsis from jumping when they land. */}
              <div style={styles.genresSlot}>
                {meta && meta.genres.length > 0 && (
                  <div style={styles.genres}>
                    {meta.genres.map((g) => (
                      <span key={g} style={styles.genrePill}>{g}</span>
                    ))}
                  </div>
                )}
              </div>

              {/* External ratings for the show as a whole (not per-season). */}
              <div style={styles.ratingsSlot}>
                {meta && (
                  <RatingsRow
                    imdbId={meta.imdbId}
                    tmdbId={meta.tmdbId}
                    mediaType="show"
                    style={styles.ratings}
                    onReady={() => setRatingsReady(true)}
                  />
                )}
              </div>

              {dSummary && (
                <p style={styles.summary}>{dSummary}</p>
              )}

              {/* Pick up where this viewer left off. Opens the episode's detail
                  view rather than playing outright, so the audio/subtitle choice
                  and the Resume/Start Over decision still happen there — the same
                  route every other play in the app takes. */}
              <div style={styles.titleActions}>
                {nextUp && onSelectEpisode && (
                  <button className="btn"
                    onClick={() => onSelectEpisode(historyEntryToItem(nextUp))}
                    style={styles.resumeBtn}
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
                {/* Named whenever nothing ends up beside it: any show nobody
                    has started, and any phone, where a Resume button is wide
                    enough to take the whole row and wrap the glyph onto its
                    own line underneath. */}
                <PlexMediaActions item={item} inline labelled={!nextUp || narrow} />
              </div>
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
                tmdbId={meta?.tmdbId ?? null}
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
          <CastRow
            cast={meta?.cast}
            directors={meta?.directors}
            onSelectPerson={onSelectPerson}
            loading={!meta}
          />
        </div>

        {/* Collections then "More Like This" — same rows as the Home tab,
            rendered outside the narrow detail column so they span the page. */}
        {onSelect && (
          <RelatedRows
            ratingKey={item.ratingKey}
            recommendationsTitle="More Like This"
            onSelect={onSelect}
          />
        )}
        </>
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
  // Reveal gate — see MovieDetail for both halves.
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
    transition: "opacity 0.28s ease",
  },
  // Height reservations for the parts that need the metadata — see MovieDetail.
  genresSlot: {
    minHeight: "34px",
  },
  ratingsSlot: {
    minHeight: "26px",
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
    transition: "opacity 0.4s ease",
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
  content: {
    position: "relative",
    // Above the shelves below it (shelfStyles.wrap is z-index 10). At equal
    // z-index the later element wins, so the Cast & Crew row painted over the
    // open audio/subtitle dropdown and clipped the list.
    zIndex: 20,
    maxWidth: "1100px",
    margin: "0 auto",
    padding: "0 24px 48px",
  },
  layout: {
    display: "flex",
    gap: "36px",
    alignItems: "flex-start",
  },
  // ─── Phone portrait overrides ──────────────────────────────────
  // The same panel with the poster stacked above the text instead of beside it,
  // matching MovieDetail so a show and a film read identically on a phone.
  contentNarrow: {
    padding: "0 16px 40px",
  },
  layoutNarrow: {
    flexDirection: "column",
    gap: "20px",
    alignItems: "stretch",
  },
  posterWrapNarrow: {
    // Centred and capped rather than full-bleed: a 2:3 poster at full phone
    // width is taller than the screen and buries the seasons below it.
    width: "min(180px, 45%)",
    alignSelf: "center",
  },
  titleNarrow: {
    fontSize: "24px",
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
  titleActions: {
    display: "flex", alignItems: "center", flexWrap: "wrap", gap: "10px",
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
