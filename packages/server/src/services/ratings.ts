export interface PlexRatingEntry {
  image?: string;
  type?: string;
  value?: number | string | null;
}

export interface PlexRatingsSource {
  Rating?: PlexRatingEntry[];
  rating?: number | string | null;
  ratingImage?: string | null;
  audienceRating?: number | string | null;
  audienceRatingImage?: string | null;
}

export interface Ratings {
  imdb: number | null;
  tmdb: number | null;
  rtCritic: number | null;
  rtAudience: number | null;
}

function numeric(value: number | string | null | undefined): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function percentage(value: number | string | null | undefined): number | null {
  const parsed = numeric(value);
  return parsed == null ? null : Math.max(0, Math.min(100, Math.round(parsed * 10)));
}

function imdbScore(value: number | string | null | undefined): number | null {
  const parsed = numeric(value);
  return parsed == null ? null : Math.round(Math.max(0, Math.min(10, parsed)) * 10) / 10;
}

/** Convert Plex's Rating entries into the scores the client displays. */
export function mapPlexRatings(source: PlexRatingsSource): Ratings {
  const ratings: Ratings = { imdb: null, tmdb: null, rtCritic: null, rtAudience: null };
  for (const entry of source.Rating ?? []) {
    const image = String(entry.image ?? "").toLowerCase();
    const kind = String(entry.type ?? "").toLowerCase();
    if (image.startsWith("imdb://")) ratings.imdb = imdbScore(entry.value);
    else if (image.startsWith("themoviedb://") || image.startsWith("tmdb://")) ratings.tmdb = percentage(entry.value);
    else if (image.startsWith("rottentomatoes://")) {
      const mapped = percentage(entry.value);
      if (kind === "critic") ratings.rtCritic = mapped;
      else if (kind === "audience") ratings.rtAudience = mapped;
    }
  }
  if (ratings.rtCritic == null && String(source.ratingImage ?? "").toLowerCase().startsWith("rottentomatoes://")) ratings.rtCritic = percentage(source.rating);
  if (ratings.rtAudience == null && String(source.audienceRatingImage ?? "").toLowerCase().startsWith("rottentomatoes://")) ratings.rtAudience = percentage(source.audienceRating);
  if (ratings.imdb == null && String(source.ratingImage ?? "").toLowerCase().startsWith("imdb://")) ratings.imdb = imdbScore(source.rating);
  if (ratings.tmdb == null && String(source.ratingImage ?? "").toLowerCase().startsWith("themoviedb://")) ratings.tmdb = percentage(source.rating);
  return ratings;
}
