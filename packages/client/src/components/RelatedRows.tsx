import { useEffect, useRef, useState } from "react";
import { PosterShelf, shelfStyles } from "./PosterShelf";
import { fetchRelated, type PlexCollection, type PlexItem } from "../lib/api";

interface RelatedRowsProps {
  /** The movie/show whose collections and recommendations to show. */
  ratingKey: string;
  /** Heading for the recommendations row (user-chosen, e.g. "More Like This"). */
  recommendationsTitle: string;
  /** Open a title's detail page — the same navigation the library grid uses. */
  onSelect: (item: PlexItem) => void;
  /** Fired once the fetch settles, success or not, so the detail page can hold
   *  its reveal until these rows are ready to appear with everything else. */
  onReady?: () => void;
}

/**
 * The detail-page "related" rows: first the collections the item belongs to
 * (Plex-style "also in this collection"), then a TMDB recommendations row. Both
 * come from one request so recommendations can exclude anything already shown in
 * a collection (see the server's /collections endpoint).
 *
 * Each row is a PosterShelf — same card size and scroll behaviour as the Home
 * tab. Renders nothing until there's at least one row to show, so an item with
 * neither leaves no empty headers behind.
 */
export function RelatedRows({ ratingKey, recommendationsTitle, onSelect, onReady }: RelatedRowsProps) {
  const [collections, setCollections] = useState<PlexCollection[]>([]);
  const [recommendations, setRecommendations] = useState<PlexItem[]>([]);
  // Ref, not a dependency: parents pass an inline arrow, and depending on it
  // would refetch on every parent render.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    setCollections([]);
    setRecommendations([]);
    let cancelled = false;
    fetchRelated(ratingKey)
      .then((res) => {
        if (cancelled) return;
        setCollections(res.collections);
        setRecommendations(res.recommendations);
      })
      // These rows are a nicety — the play/seasons actions are the real content
      // and must never wait on or break because of them.
      .catch(() => {
        if (cancelled) return;
        setCollections([]);
        setRecommendations([]);
      })
      .finally(() => { if (!cancelled) onReadyRef.current?.(); });
    return () => { cancelled = true; };
  }, [ratingKey]);

  if (collections.length === 0 && recommendations.length === 0) return null;

  return (
    <div style={shelfStyles.wrap}>
      {collections.map((collection) => (
        <PosterShelf
          key={collection.ratingKey}
          title={collection.title}
          items={collection.items}
          onSelect={onSelect}
        />
      ))}
      {recommendations.length > 0 && (
        <PosterShelf title={recommendationsTitle} items={recommendations} onSelect={onSelect} />
      )}
    </div>
  );
}
