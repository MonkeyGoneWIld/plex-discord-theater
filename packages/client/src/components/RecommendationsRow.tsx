import { useEffect, useState } from "react";
import { PosterShelf, shelfStyles } from "./PosterShelf";
import { fetchRecommendations, type PlexItem } from "../lib/api";

interface RecommendationsRowProps {
  /** The movie/show to base recommendations on. */
  ratingKey: string;
  /** Row heading (chosen by the user, e.g. "More Like This"). */
  title: string;
  /** Open a suggestion's detail page — same navigation as the library grid. */
  onSelect: (item: PlexItem) => void;
}

/**
 * TMDB "you might also like" row for a movie/show detail page — shown after the
 * collection rows. Suggestions already in the library come first (playable),
 * then the rest as requestable "Not in library" cards; the server does that
 * ordering. Needs a TMDB key server-side; without one (or with no suggestions)
 * the response is empty and this renders nothing.
 */
export function RecommendationsRow({ ratingKey, title, onSelect }: RecommendationsRowProps) {
  const [items, setItems] = useState<PlexItem[]>([]);

  useEffect(() => {
    setItems([]);
    let cancelled = false;
    fetchRecommendations(ratingKey)
      .then((res) => { if (!cancelled) setItems(res.items); })
      // Recommendations are a nicety — a failure just hides the row.
      .catch(() => { if (!cancelled) setItems([]); });
    return () => { cancelled = true; };
  }, [ratingKey]);

  if (items.length === 0) return null;

  return (
    <div style={shelfStyles.wrap}>
      <PosterShelf title={title} items={items} onSelect={onSelect} />
    </div>
  );
}
