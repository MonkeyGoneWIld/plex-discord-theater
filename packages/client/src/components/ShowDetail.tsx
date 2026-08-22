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

/**
 * The second line of the play button: "Season 1 · Episode 3 — Title", plus the
 * time left when the episode is part-watched. Episodes Plex hasn't numbered
 * (extras, some specials) fall back to their title alone.
 */
function episodeLine(
  parentIndex: number | null | undefined,
  index: number | null | undefined,
  title: string,
  remainingMs?: number,
): string {
  const head = parentIndex != null && index != null
    ? `Season ${parentIndex} · Episode ${index} — ${title}`
    : title;
  return remainingMs != null && remainingMs > 0
    ? `${head} · ${formatTimecode(remainingMs)} left`
    : head;
}

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
  // Null means both "still asking" and "nothing to resume", so the first
  // episode is only looked up once the lookup has actually answered.
  const [nextUpLoaded, setNextUpLoaded] = useState(false);
  // The show's opening episode, for when there's nothing to resume.
  const [firstEpisode, setFirstEpisode] = useState<PlexItem | null>(null);
  // Whether that lookup has been attempted. Separate from its result for the
  // same reason as nextUpLoaded: an empty answer and an unasked question look
  // identical from here, and the button below has to tell them apart.
  const [firstEpisodeTried, setFirstEpisodeTried] = useState(false);
  // Phone portrait: the poster and the detail column can't sit side by side.
  // The poster is a fixed 240px, so on a 390px screen the text beside it got
  // roughly 90px — the title broke a word per line, the genre pills stacked one
  // to a row, and "3 Seasons" wrapped. Same treatment as MovieDetail: the
  // poster goes above the text and the text gets the whole width.
  const narrow = useMediaQuery(NARROW_QUERY);

  useEffect(() => {
    setNextUp(null);
    setNextUpLoaded(false);
    setFirstEpisode(null);
    setFirstEpisodeTried(false);
    let cancelled = false;
    fetchShowNextUp(item.ratingKey)
      .then((res) => { if (!cancelled) setNextUp(res.nextUp); })
      // A failed lookup falls through to the same place a never-started show
      // does — offering episode one beats offering nothing.
      .catch(() => { /* the seasons grid is the real content — never block on this */ })
      .finally(() => { if (!cancelled) setNextUpLoaded(true); });
    return () => { cancelled = true; };
  }, [item.ratingKey]);

  /**
   * Nothing to resume, so start at the beginning.
   *
   * A show nobody here has played has no next-up episode, which left the page
   * with no play control at all — the only way in was to pick a season, then an
   * episode. Same for a show watched through to the end. Both get the show's
   * opening episode instead.
   *
   * Specials are skipped where there's a numbered season to prefer: Plex files
   * them as season 0 and returns them first, so "the first season" taken
   * literally would start a lot of shows on a recap or an OVA.
   */
  useEffect(() => {
    if (!nextUpLoaded || nextUp || seasons.length === 0) return;
    const byIndex = [...seasons].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const opening = byIndex.find((season) => (season.index ?? 0) >= 1) ?? byIndex[0];
    if (!opening) return;
    let cancelled = false;
    fetchChildren(opening.ratingKey)
      .then((res) => {
        if (cancelled) return;
        const episodes = [...res.items].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        setFirstEpisode(episodes[0] ?? null);
      })
      .catch(() => { /* the seasons grid is still a way in */ })
      .finally(() => { if (!cancelled) setFirstEpisodeTried(true); });
    return () => { cancelled = true; };
  }, [nextUp, nextUpLoaded, seasons]);

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

  // The play button, wherever it starts from. Resuming and starting fresh are
  // the same button with a different word on it, so they're built as one.
  const startFrom: PlexItem | null = nextUp ? historyEntryToItem(nextUp) : firstEpisode;
  const startLabel = !nextUp ? "Play"
    // Mid-episode reads as resuming; a fresh episode as continuing the show.
    : nextUp.positionMs > 0 ? "Resume Watching" : "Continue Watching";
  const startLine = nextUp
    ? episodeLine(nextUp.parentIndex, nextUp.index, nextUp.title,
        nextUp.positionMs > 0 && nextUp.durationMs > 0
          ? nextUp.durationMs - nextUp.positionMs
          : undefined)
    : firstEpisode
      ? episodeLine(firstEpisode.parentIndex, firstEpisode.index, firstEpisode.title)
      : null;
  /**
   * Still working out where the button starts from.
   *
   * Two requests can stand between opening the page and knowing: the next-up
   * lookup, and then — for a show nobody has started — the first season's
   * episode list. That reliably outlasts the reveal below, which waits on the
   * metadata and the season list only, so the button used to appear a moment
   * after the page did and shove the seasons grid down as it arrived.
   *
   * The reveal below waits on this, so normally the button is complete before
   * the page is on screen. When the wait times out instead, the button is
   * drawn at its full size and dimmed, and the text fills in underneath it
   * without moving the seasons grid. It goes false either when there is
   * something to play or when we know there is nothing.
   */
  const startPending = !startFrom
    && (!nextUpLoaded || loading || (seasons.length > 0 && !firstEpisodeTried));

  // Header, season list and the play button — see MovieDetail for why the cast
  // and the collection rows are left to fill in on their own.
  //
  // The button is in here because it changes width as well as height when it
  // lands: on a wide screen the watchlist and watched controls sit to its
  // right, and "Play" grew into "Play / Season 1 · Episode 1 — The Seinfeld
  // Chronicles" and pushed them a couple of hundred pixels across.
  const revealTimedOut = useRevealTimeout(item.ratingKey, REVEAL_TIMEOUT_MS);
  const pageReady =
    (meta != null && !loading && (posterLoaded || !posterUrl) && ratingsReady && !startPending) ||
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

              {/* Pick up where this viewer left off, or start the show from
                  episode one. Opens the episode's detail view rather than
                  playing outright, so the audio/subtitle choice and the
                  Resume/Start Over decision still happen there — the same route
                  every other play in the app takes. */}
              <div style={styles.titleActions}>
                {(startFrom || startPending) && onSelectEpisode && (
                  <button className="btn"
                    onClick={startFrom ? () => onSelectEpisode(startFrom) : undefined}
                    disabled={!startFrom}
                    style={{ ...styles.resumeBtn, ...(startFrom ? {} : styles.resumeBtnPending) }}
                  >
                    <svg width="20" height="20" viewBox="0 0 22 22" fill="none" style={{ flexShrink: 0 }}>
                      <path d="M5 3.5L18 11L5 18.5V3.5Z" fill="currentColor"/>
                    </svg>
                    <span style={styles.resumeText}>
                      <span style={styles.resumeLabel}>{startLabel}</span>
                      {/* A non-breaking space while the episode is unknown. An
                          empty span has no line box, so the button would be a
                          line shorter until the text landed and then grow. */}
                      <span style={styles.resumeEpisode}>{startLine ?? "\u00a0"}</span>
                    </span>
                  </button>
                )}
                <PlexMediaActions item={item} inline labelled />
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
  // Height reservations for the parts that need the metadata — see MovieDetail
  // for why the genres reserve their trailing gap and the ratings don't.
  genresSlot: {
    minHeight: "47px",
    display: "flow-root",
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
    // The same 20px that separates the genres, the ratings and the synopsis
    // below it. At 16px this one line sat measurably tighter than every other
    // gap in the column.
    marginBottom: "20px",
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
  /**
   * The action block's own spacing, matched to the gap above it.
   *
   * The row gap only shows on a narrow screen, where the primary button takes
   * the whole width and the watchlist and watched controls wrap underneath it.
   * It was the one gap on the page that did not match its neighbours: 28px of
   * air above the button and 10px below, so the controls read as stuck to its
   * underside rather than as the next thing down. The column gap is untouched
   * — side by side these are one row of buttons, not two blocks.
   */
  /** The button at its final size, before it knows what it plays. Dimmed the
   *  same way MovieDetail dims Play while it waits on the stream list. */
  resumeBtnPending: {
    opacity: 0.55,
    cursor: "default",
    boxShadow: "none",
  },
  titleActions: {
    display: "flex", alignItems: "center", flexWrap: "wrap", gap: "28px 10px",
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
