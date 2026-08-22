import { useState, useEffect } from "react";
import {
  authUrl, fetchDiscoverMeta, fetchTmdbMeta, fetchSeerrStatus, fetchSeerrTv, seerrRequest,
  type Credit, type PlexItem, type DiscoverMeta, type SeerrMediaType, type SeerrTv,
} from "../lib/api";
import { SeasonRequestGrid } from "./SeasonRequestGrid";
import { RatingsRow } from "./RatingsRow";
import { SkeletonBlock } from "./SkeletonBlock";
import { CastRow } from "./CastRow";
import { shelfStyles } from "./PosterShelf";
import { DetailLoading } from "./DetailLoading";
import { PlexMediaActions } from "./PlexMediaActions";
import { useRevealTimeout } from "../lib/useRevealTimeout";
import { useMediaQuery, NARROW_QUERY } from "../lib/useMediaQuery";

interface ExternalDetailProps {
  item: PlexItem;
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

function formatRuntime(ms: number | null): string {
  if (!ms) return "";
  const min = Math.round(ms / 60000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Seerr MediaStatus → label for an already-tracked title.
const STATUS_LABEL: Record<number, string> = {
  2: "Requested",
  3: "Processing",
  4: "Partially available",
  5: "Available",
};

/**
 * Detail view for an online (Discover) title the user doesn't own. Shows the
 * richer provider metadata (summary, genres, runtime) when available, falling
 * back to what search already gave us, plus a placeholder Request button.
 */
export function ExternalDetail({ item, onBack, onSelectPerson }: ExternalDetailProps) {
  const [meta, setMeta] = useState<DiscoverMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const mediaType: SeerrMediaType = item.type === "show" ? "tv" : "movie";

  // Seerr request state. configured: null=unknown, then true/false. status is the
  // MediaStatus (null = not requested).
  const [seerrConfigured, setSeerrConfigured] = useState<boolean | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  // Whether the Seerr lookup has come back. The button stays a skeleton until it
  // has: rendering "Request" first and swapping it for "Available"/"Processing" a
  // moment later offers an action that was never really there, and a mis-aimed
  // click in that window fires a request for something already owned.
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  // Reveal gate — see `pageReady`.
  const [posterLoaded, setPosterLoaded] = useState(false);
  const [ratingsReady, setRatingsReady] = useState(false);
  // Phone portrait. This page wraps rather than stacks without it: the poster is
  // a fixed 220px and the text column asks for 260px, so on a phone the text
  // dropped below the poster and the poster stayed pinned to the left edge —
  // near enough to the library pages to look like a bug, since a title you *do*
  // own centres its poster on the same screen. Same treatment as MovieDetail.
  const narrow = useMediaQuery(NARROW_QUERY);


  useEffect(() => {
    // Discover search results resolve full detail from their plex:// guid;
    // out-of-library collection/recommendation members have no guid but carry a
    // tmdbId, so fetch their detail from TMDB instead. Without either, fall back
    // to whatever fields the card already provided.
    const load = item.guid
      ? fetchDiscoverMeta(item.guid)
      : item.tmdbId != null
        ? fetchTmdbMeta(item.tmdbId, item.type === "show" ? "show" : "movie")
        : null;
    if (!load) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    load
      .then((m) => { if (!cancelled) setMeta(m); })
      .catch(() => { /* degrade to the fields search already provided */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [item.guid, item.tmdbId, item.type]);

  // Once we know the TMDB id, pull the current request/availability status.
  // TV shows use the per-season grid instead, fetched below. Out-of-library
  // collection members carry their tmdbId directly (no plex:// guid to resolve),
  // so fall back to that when the provider metadata didn't supply one.
  const tmdbId = meta?.tmdbId ?? item.tmdbId ?? null;
  useEffect(() => {
    if (tmdbId == null || mediaType !== "movie") return;
    let cancelled = false;
    setStatusLoaded(false);
    fetchSeerrStatus(tmdbId, mediaType)
      .then((s) => { if (!cancelled) { setSeerrConfigured(s.configured); setStatus(s.status); } })
      .catch(() => { if (!cancelled) setSeerrConfigured(false); })
      .finally(() => { if (!cancelled) setStatusLoaded(true); });
    return () => { cancelled = true; };
  }, [tmdbId, mediaType]);

  // TV: the full season list with per-season status, for the request grid.
  const [seerrTv, setSeerrTv] = useState<SeerrTv | null>(null);
  const [tvNonce, setTvNonce] = useState(0);
  useEffect(() => {
    if (tmdbId == null || mediaType !== "tv") return;
    let cancelled = false;
    fetchSeerrTv(tmdbId)
      .then((tv) => { if (!cancelled) setSeerrTv(tv); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [tmdbId, mediaType, tvNonce]);

  const handleRequest = () => {
    if (tmdbId == null || requesting) return;
    setRequesting(true);
    setRequestError(null);
    seerrRequest(tmdbId, mediaType)
      .then((r) => setStatus(r.status ?? 2))
      .catch((err) => setRequestError(err instanceof Error ? err.message : "Request failed"))
      .finally(() => setRequesting(false));
  };

  // Prefer detail metadata; fall back to what the search result carried.
  const title = meta?.title ?? item.title;
  const year = meta?.year ?? item.year ?? null;
  const poster = meta?.thumb ?? item.thumb;
  const summary = meta?.summary ?? item.summary ?? null;
  const genres = meta?.genres ?? [];
  const runtime = formatRuntime(meta?.duration ?? null);
  const rating = meta?.contentRating ?? null;
  const facts = [year, runtime, rating].filter(Boolean).join("  ·  ");
  const statusLabel = status != null ? STATUS_LABEL[status] ?? null : null;

  // Appear once, complete — the same gate the library detail pages use. The
  // Seerr answer is part of it here, because the request button is what this
  // page exists for and showing it in the wrong state is worse than waiting.
  const wantsStatus = tmdbId != null && mediaType === "movie";
  const wantsSeasons = tmdbId != null && mediaType === "tv";
  const revealTimedOut = useRevealTimeout(item.ratingKey, REVEAL_TIMEOUT_MS);
  const pageReady =
    (!loading &&
      (posterLoaded || !poster) &&
      ratingsReady &&
      (!wantsStatus || statusLoaded) &&
      (!wantsSeasons || seerrTv != null)) ||
    revealTimedOut;

  return (
    <div style={styles.container}>
      {!pageReady && <DetailLoading />}
      <div style={pageReady ? styles.revealed : styles.prerender} aria-hidden={!pageReady}>
      <button className="btn" onClick={onBack} style={styles.backBtn}>
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Back
      </button>
      <div style={{ ...styles.body, ...(narrow ? styles.bodyNarrow : {}) }}>
        {poster ? (
          <img
            src={authUrl(poster)}
            alt={title}
            style={{ ...styles.poster, ...(narrow ? styles.posterNarrow : {}) }}
            onLoad={() => setPosterLoaded(true)}
            onError={() => setPosterLoaded(true)}
          />
        ) : (
          <div style={{
            ...styles.poster,
            ...styles.posterPlaceholder,
            ...(narrow ? styles.posterNarrow : {}),
          }}>No Poster</div>
        )}
        <div style={{ ...styles.info, ...(narrow ? styles.infoNarrow : {}) }}>
          <div style={styles.badge}>Not in your library</div>
          <h1 style={{ ...styles.title, ...(narrow ? styles.titleNarrow : {}) }}>{title}</h1>
          {facts && <div style={styles.facts}>{facts}</div>}
          {genres.length > 0 && (
            <div style={styles.genres}>
              {genres.map((g) => (
                <span key={g} style={styles.genre}>{g}</span>
              ))}
            </div>
          )}
          {/* External ratings — keyed off the TMDB id the provider metadata gives
              us (Discover results carry no imdb id). */}
          <RatingsRow
            tmdbId={tmdbId}
            mediaType={item.type === "show" ? "show" : "movie"}
            style={styles.ratings}
            onReady={() => setRatingsReady(true)}
          />
          {loading && !summary ? (
            <div style={styles.summaryMuted}>Loading details…</div>
          ) : summary ? (
            <p style={styles.summary}>{summary}</p>
          ) : (
            <div style={styles.summaryMuted}>No description available.</div>
          )}
          {/* Requesting — movies get a single button here; TV shows the season
              grid below. Both hidden when Seerr isn't set up or there's no
              TMDB id. */}
          <div style={styles.titleActions}>
            {tmdbId != null && mediaType === "movie" && seerrConfigured !== false && (
              !statusLoaded ? (
                // Same footprint as the real button, so nothing shifts when it lands.
                <SkeletonBlock width={140} height={40} borderRadius={8} />
              ) : statusLabel ? (
                <button className="btn" disabled style={{ ...styles.requestBtn, ...styles.requestBtnDone }}>
                  {statusLabel}
                </button>
              ) : (
                <button className="btn"
                  onClick={handleRequest}
                  disabled={requesting}
                  style={styles.requestBtn}
                >
                  {requesting ? "Requesting…" : "Request"}
                </button>
              )
            )}
            <PlexMediaActions item={item} inline labelled />
          </div>
          {requestError && <div style={styles.requestError}>{requestError}</div>}
        </div>
      </div>
      {/* TV: same season request grid as the library show page. It comes before
          the credits — requesting the show is what this page is for, and the
          cast is context for that decision rather than the point of it. */}
      {tmdbId != null && mediaType === "tv" && seerrTv?.configured !== false && (
        <div style={{ ...styles.seasonsWrap, ...(narrow ? styles.seasonsWrapNarrow : {}) }}>
          {seerrTv == null ? (
            <div style={styles.summaryMuted}>Loading seasons…</div>
          ) : seerrTv.seasons.length > 0 ? (
            <SeasonRequestGrid
              tmdbId={tmdbId}
              seasons={seerrTv.seasons}
              onRequested={() => setTvNonce((n) => n + 1)}
            />
          ) : null}
        </div>
      )}

      {/* Cast & Crew — from TMDB here rather than Plex, but the same row. */}
      <div style={shelfStyles.wrap}>
        <CastRow
          cast={meta?.cast}
          directors={meta?.directors}
          onSelectPerson={onSelectPerson}
          loading={loading}
        />
      </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: "100%",
    position: "relative",
  },
  // Reveal gate — see MovieDetail.
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
  // Matches MovieDetail's back button so navigation is consistent across pages.
  backBtn: {
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
  },
  body: {
    display: "flex",
    gap: "24px",
    alignItems: "flex-start",
    flexWrap: "wrap",
    maxWidth: "900px",
    margin: "0 auto",
    padding: "8px 24px 40px",
  },
  poster: {
    width: "220px",
    aspectRatio: "2/3",
    objectFit: "cover",
    borderRadius: "12px",
    flexShrink: 0,
    background: "rgba(255,255,255,0.04)",
  },
  posterPlaceholder: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#555",
    fontSize: "13px",
    fontWeight: 500,
  },
  info: {
    flex: 1,
    minWidth: "260px",
  },
  // ─── Phone portrait overrides ──────────────────────────────────
  // Poster centred above the text, text across the full width. Deliberately the
  // same numbers as MovieDetail's, so an owned title and one you'd have to
  // request are laid out identically.
  bodyNarrow: {
    flexDirection: "column",
    flexWrap: "nowrap",
    alignItems: "stretch",
    gap: "20px",
    padding: "8px 16px 40px",
  },
  posterNarrow: {
    width: "min(180px, 45%)",
    alignSelf: "center",
  },
  infoNarrow: {
    // Releases the 260px floor, which is what forced the wrap in the first place.
    minWidth: 0,
  },
  titleNarrow: {
    fontSize: "24px",
  },
  seasonsWrapNarrow: {
    padding: "0 16px 40px",
  },
  badge: {
    display: "inline-block",
    padding: "3px 8px",
    borderRadius: "5px",
    background: "rgba(255,255,255,0.08)",
    color: "rgba(255,255,255,0.7)",
    fontSize: "11px",
    fontWeight: 600,
    letterSpacing: "0.3px",
    textTransform: "uppercase",
    marginBottom: "12px",
  },
  title: {
    fontSize: "26px",
    fontWeight: 700,
    color: "#f0f0f0",
    margin: "0 0 8px",
    lineHeight: 1.2,
  },
  facts: {
    color: "#888",
    fontSize: "14px",
    marginBottom: "20px",
  },
  genres: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    marginBottom: "20px",
  },
  ratings: {
    marginBottom: "20px",
  },
  genre: {
    padding: "3px 10px",
    borderRadius: "12px",
    background: "rgba(255,255,255,0.05)",
    color: "#bbb",
    fontSize: "12px",
    fontWeight: 500,
  },
  summary: {
    color: "#ccc",
    fontSize: "15px",
    lineHeight: 1.6,
    margin: "0 0 28px",
  },
  summaryMuted: {
    color: "#666",
    fontSize: "14px",
    margin: "0 0 28px",
  },
  requestBtn: {
    padding: "11px 24px",
    borderRadius: "10px",
    border: "none",
    background: "#e5a00d",
    color: "#000",
    fontSize: "15px",
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  /**
   * The action block's own spacing, matched to the gap above it.
   *
   * The row gap only shows when the row wraps — on a narrow screen, where the
   * watchlist control drops below the Request button. It was the one gap on
   * the page that did not match its neighbours: 28px of air above the row and
   * 10px inside it, so the control read as stuck to the button's underside
   * rather than as the next thing down. The column gap is untouched — side by
   * side these are one row of buttons, not two blocks.
   */
  titleActions: {
    display: "flex", alignItems: "center", flexWrap: "wrap", gap: "28px 10px",
  },
  requestBtnDone: {
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(229,160,13,0.6)",
    color: "#e5a00d",
    cursor: "default",
  },
  requestError: {
    marginTop: "10px",
    color: "#e5834a",
    fontSize: "13px",
  },
  seasonsWrap: {
    maxWidth: "900px",
    margin: "0 auto",
    padding: "0 24px 40px",
  },
};
