import { useEffect, useState } from "react";
import { ScrollShelf } from "./ScrollShelf";
import { MovieCard } from "./MovieCard";
import { POSTER_ROW_CARD_WIDTH } from "../lib/grid";
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
 * shelf identical to the Home tab's collection rows: same card size
 * (POSTER_ROW_CARD_WIDTH), same ScrollShelf (mouse-wheel-free drag scrolling,
 * hover chevrons and side arrows on desktop, native swipe on touch). The server
 * keeps only small collections (see fetchItemCollections) — sprawling ones like
 * Trending are filtered out — and removes the current item from each row.
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
    <div style={styles.wrap}>
      {collections.map((collection) => (
        <div key={collection.ratingKey} style={styles.section}>
          <h3 style={styles.label}>{collection.title}</h3>
          <ScrollShelf rowStyle={styles.row}>
            {collection.items.map((member) => (
              <div key={member.ratingKey} style={styles.card}>
                <MovieCard item={member} onClick={onSelect} />
              </div>
            ))}
          </ScrollShelf>
        </div>
      ))}
    </div>
  );
}

// Mirrors Library.tsx's hub row styles (and its wide wrapper) so a detail-page
// collection is pixel-for-pixel the Home tab's collection row — same 2000px max
// width and 24px gutters, so the shelf stretches the full page and tops out at
// ten cards, instead of being penned into the narrow detail column.
const styles: Record<string, React.CSSProperties> = {
  wrap: {
    // Matches Library's wideWrap — wider than the detail column on purpose, so
    // the row reaches ten full-size cards at max stretch like the Home tab.
    maxWidth: "2000px",
    margin: "40px auto 0",
    padding: "0 24px",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  section: {
    paddingBottom: "8px",
  },
  label: {
    color: "#e0e0e0",
    fontSize: "20px",
    fontWeight: 700,
    marginBottom: "12px",
    letterSpacing: "-0.01em",
  },
  row: {
    display: "flex",
    gap: "14px",
    overflowX: "auto" as const,
    paddingBottom: "8px",
  },
  card: {
    flexShrink: 0,
    flexGrow: 0,
    width: POSTER_ROW_CARD_WIDTH,
  },
};
