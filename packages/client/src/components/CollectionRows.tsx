import { useEffect, useState } from "react";
import { PosterShelf, shelfStyles } from "./PosterShelf";
import { fetchItemCollections, type PlexCollection, type PlexItem } from "../lib/api";

interface CollectionRowsProps {
  /** The movie/show whose collections to show. */
  ratingKey: string;
  /** Open a member's detail page — the same navigation the library grid uses. */
  onSelect: (item: PlexItem) => void;
}

/**
 * "Also in this collection" rows for a movie/show detail page — the same idea as
 * Plex's own landing pages, which surface the collection an item belongs to.
 *
 * Each collection the item is part of renders as a horizontally-scrolling poster
 * shelf (PosterShelf). The server keeps only small collections (see
 * fetchItemCollections) — sprawling ones like Trending are filtered out — and,
 * for movies with a TMDB key, fills in franchise entries the library is missing
 * as requestable cards.
 *
 * Renders nothing until there's a collection to show, so an item in none (or one
 * whose only collections are large) leaves no empty header behind.
 */
export function CollectionRows({ ratingKey, onSelect }: CollectionRowsProps) {
  const [collections, setCollections] = useState<PlexCollection[]>([]);

  useEffect(() => {
    setCollections([]);
    let cancelled = false;
    fetchItemCollections(ratingKey)
      .then((res) => { if (!cancelled) setCollections(res.collections); })
      // A missing collections row is invisible, never an error state — the
      // seasons/play actions are the real content and must never wait on this.
      .catch(() => { if (!cancelled) setCollections([]); });
    return () => { cancelled = true; };
  }, [ratingKey]);

  if (collections.length === 0) return null;

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
    </div>
  );
}
