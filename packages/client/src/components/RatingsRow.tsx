import { useEffect, useRef } from "react";
import type { Ratings } from "../lib/api";
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
  ratings?: Ratings | null;
  /** Extra style for the row container (e.g. margins) set by the caller. */
  style?: React.CSSProperties;
  /** Fired once the lookup settles, so a detail page can include the scores in
   *  what it waits for before revealing itself. */
  onReady?: () => void;
}

// Reserve the row's height from first paint so filling in the (async) ratings
// never pushes the rest of the page down. Matches the tallest element (RT icons).
const ROW_MIN_HEIGHT = 26;

/**
 * External ratings — Rotten Tomatoes (Tomatometer + Audience), IMDb and TMDB —
 * shown on a movie/show detail page. Scores are already included in Plex metadata.
 *
 * The row's height is reserved up front, so it holds its place while the scores
 * are being prepared without shifting the layout. If Plex has no scores, it
 * collapses.
 */
export function RatingsRow({ ratings, style, onReady }: RatingsRowProps) {
  // Ref, not a dependency: callers pass an inline arrow, and depending on it
  // would refetch on every parent render.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => { onReadyRef.current?.(); }, []);

  const hasAny = !!ratings && (
    ratings.imdb != null || ratings.tmdb != null ||
    ratings.rtCritic != null || ratings.rtAudience != null
  );

  // Nothing to show and nothing pending — take up no space at all.
  if (!hasAny) return null;

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
