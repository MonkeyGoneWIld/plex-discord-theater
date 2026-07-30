import { useEffect, useState } from "react";
import { fetchRatings, type Ratings, type RatingsMediaType } from "../lib/api";
// Official Rotten Tomatoes icons (Wikimedia Commons) — the same marks RT uses on
// its own site: Fresh tomato / Rotten green splat, and the upright / spilled
// audience popcorn tubs.
import tomatoFresh from "../assets/rt/tomato-fresh.svg";
import tomatoRotten from "../assets/rt/tomato-rotten.svg";
import popcornFresh from "../assets/rt/popcorn-fresh.svg";
import popcornSpilled from "../assets/rt/popcorn-spilled.svg";

interface RatingsRowProps {
  imdbId?: string | null;
  tmdbId?: number | null;
  mediaType: RatingsMediaType;
  /** Extra style for the row container (e.g. margins) set by the caller. */
  style?: React.CSSProperties;
}

/**
 * External ratings badges — IMDb, Rotten Tomatoes (Tomatometer + Audience) and
 * TMDB — shown on a movie/show detail page. Self-contained: it fetches its own
 * data and renders nothing until (and unless) there's at least one score, so the
 * caller just drops it in without worrying about loading or empty states.
 *
 * Data comes from MDBList; when the server has no key configured the fetch
 * reports `configured: false` and this stays hidden.
 */
export function RatingsRow({ imdbId, tmdbId, mediaType, style }: RatingsRowProps) {
  const [ratings, setRatings] = useState<Ratings | null>(null);

  useEffect(() => {
    setRatings(null);
    if (!imdbId && tmdbId == null) return;
    let cancelled = false;
    fetchRatings({ imdbId, tmdbId, mediaType })
      .then((res) => { if (!cancelled && res.configured) setRatings(res.ratings); })
      .catch(() => { /* ratings are a nicety — never surface an error for them */ });
    return () => { cancelled = true; };
  }, [imdbId, tmdbId, mediaType]);

  if (!ratings) return null;
  const { imdb, tmdb, rtCritic, rtAudience } = ratings;
  if (imdb == null && tmdb == null && rtCritic == null && rtAudience == null) return null;

  return (
    <div style={{ ...styles.row, ...style }}>
      {rtCritic != null && (
        <Badge title={`Rotten Tomatoes — Tomatometer (${rtCritic}%)`}>
          <img
            src={rtCritic >= 60 ? tomatoFresh : tomatoRotten}
            alt=""
            aria-hidden="true"
            style={styles.rtIcon}
          />
          <span style={styles.score}>{rtCritic}%</span>
        </Badge>
      )}
      {rtAudience != null && (
        <Badge title={`Rotten Tomatoes — Audience Score (${rtAudience}%)`}>
          <img
            src={rtAudience >= 60 ? popcornFresh : popcornSpilled}
            alt=""
            aria-hidden="true"
            style={styles.rtIcon}
          />
          <span style={styles.score}>{rtAudience}%</span>
        </Badge>
      )}
      {imdb != null && (
        <Badge title="IMDb rating">
          <span style={styles.imdbLogo}>IMDb</span>
          <span style={styles.score}>{imdb.toFixed(1)}</span>
        </Badge>
      )}
      {tmdb != null && (
        <Badge title="TMDB user score">
          <span style={styles.tmdbLogo}>TMDB</span>
          <span style={styles.score}>{tmdb}%</span>
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
  score: {
    fontSize: "16px",
    fontWeight: 700,
    color: "#f0f0f0",
    letterSpacing: "-0.01em",
    lineHeight: 1,
  },
  // The IMDb wordmark logo — its own golden badge is the brand mark, not a box
  // we've added around it. Kept smaller than the RT icons, per the design.
  imdbLogo: {
    display: "inline-flex",
    alignItems: "center",
    height: "17px",
    padding: "0 4px",
    borderRadius: "3px",
    background: "#f5c518",
    color: "#000",
    fontSize: "10px",
    fontWeight: 800,
    letterSpacing: "0.01em",
    lineHeight: 1,
  },
  tmdbLogo: {
    display: "inline-flex",
    alignItems: "center",
    height: "17px",
    padding: "0 5px",
    borderRadius: "3px",
    background: "linear-gradient(90deg, #90cea1 0%, #01b4e4 100%)",
    color: "#0d253f",
    fontSize: "10px",
    fontWeight: 800,
    letterSpacing: "0.01em",
    lineHeight: 1,
  },
};
