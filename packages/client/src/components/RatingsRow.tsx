import { useEffect, useRef, useState } from "react";
import { fetchRatings, type Ratings, type RatingsMediaType } from "../lib/api";
// Rating-source marks — the same icons Rotten Tomatoes and Seerr use.
// RT: Fresh tomato / Rotten green splat, and upright / spilled audience popcorn.
// IMDb + TMDB: the official brand logos. All from Wikimedia Commons.
import tomatoFresh from "../assets/rt/tomato-fresh.svg";
import tomatoRotten from "../assets/rt/tomato-rotten.svg";
import popcornFresh from "../assets/rt/popcorn-fresh.svg";
import popcornSpilled from "../assets/rt/popcorn-spilled.svg";
import imdbLogo from "../assets/rt/imdb.svg";
import tmdbLogo from "../assets/rt/tmdb.svg";

interface RatingsRowProps {
  imdbId?: string | null;
  tmdbId?: number | null;
  mediaType: RatingsMediaType;
  /** Extra style for the row container (e.g. margins) set by the caller. */
  style?: React.CSSProperties;
  /** Fired once the lookup settles, so a detail page can reveal the whole page
   *  at once rather than letting the scores fade in on their own. */
  onReady?: () => void;
}

// Reserve the row's height from first paint so filling in the (async) ratings
// never pushes the rest of the page down. Matches the tallest element (RT icons).
const ROW_MIN_HEIGHT = 26;

/**
 * External ratings — Rotten Tomatoes (Tomatometer + Audience), IMDb and TMDB —
 * shown on a movie/show detail page. Self-contained: it fetches its own data.
 *
 * The row's height is reserved up front, so it holds its place while the request
 * is in flight and the scores fade in without shifting the layout. If nothing is
 * available (no key configured, or the title is unknown to MDBList) it collapses.
 */
export function RatingsRow({ imdbId, tmdbId, mediaType, style, onReady }: RatingsRowProps) {
  const [ratings, setRatings] = useState<Ratings | null>(null);
  const [loading, setLoading] = useState(true);
  // Ref, not a dependency — see RelatedRows.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    setRatings(null);
    if (!imdbId && tmdbId == null) { setLoading(false); onReadyRef.current?.(); return; }
    setLoading(true);
    let cancelled = false;
    fetchRatings({ imdbId, tmdbId, mediaType })
      .then((res) => { if (!cancelled && res.configured) setRatings(res.ratings); })
      .catch(() => { /* ratings are a nicety — never surface an error for them */ })
      .finally(() => { if (!cancelled) { setLoading(false); onReadyRef.current?.(); } });
    return () => { cancelled = true; };
  }, [imdbId, tmdbId, mediaType]);

  const hasAny = !!ratings && (
    ratings.imdb != null || ratings.tmdb != null ||
    ratings.rtCritic != null || ratings.rtAudience != null
  );

  // Nothing to show and nothing pending — take up no space at all.
  if (!loading && !hasAny) return null;

  return (
    <div style={{ ...styles.row, ...style, minHeight: ROW_MIN_HEIGHT }}>
      {ratings?.rtCritic != null && (
        <Badge title={`Rotten Tomatoes — Tomatometer (${ratings.rtCritic}%)`}>
          <img src={ratings.rtCritic >= 60 ? tomatoFresh : tomatoRotten} alt="" aria-hidden="true" style={styles.rtIcon} />
          <span style={styles.score}>{ratings.rtCritic}%</span>
        </Badge>
      )}
      {ratings?.rtAudience != null && (
        <Badge title={`Rotten Tomatoes — Audience Score (${ratings.rtAudience}%)`}>
          <img src={ratings.rtAudience >= 60 ? popcornFresh : popcornSpilled} alt="" aria-hidden="true" style={styles.rtIcon} />
          <span style={styles.score}>{ratings.rtAudience}%</span>
        </Badge>
      )}
      {ratings?.imdb != null && (
        <Badge title="IMDb rating">
          <img src={imdbLogo} alt="IMDb" style={styles.logo} />
          <span style={styles.score}>{ratings.imdb.toFixed(1)}</span>
        </Badge>
      )}
      {ratings?.tmdb != null && (
        <Badge title="TMDB user score">
          <img src={tmdbLogo} alt="TMDB" style={styles.logo} />
          <span style={styles.score}>{ratings.tmdb}%</span>
        </Badge>
      )}
    </div>
  );
}

function Badge({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <span style={styles.item} title={title}>
      {children}
    </span>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // Inline ratings with no per-item chrome (Seerr-style): icon + number, spaced.
  row: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "22px",
  },
  item: {
    display: "inline-flex",
    alignItems: "center",
    gap: "7px",
  },
  // Fixed height, auto width — the RT icons have different aspect ratios (the
  // spilled tub is wide, the upright tub tall), so constraining height keeps them
  // visually consistent without distortion.
  rtIcon: {
    height: "26px",
    width: "auto",
    display: "block",
    flexShrink: 0,
  },
  // IMDb / TMDB brand logos — kept a touch smaller than the RT icons, per design.
  logo: {
    height: "18px",
    width: "auto",
    display: "block",
    flexShrink: 0,
  },
  score: {
    fontSize: "16px",
    fontWeight: 700,
    color: "#f0f0f0",
    letterSpacing: "-0.01em",
    lineHeight: 1,
  },
};
