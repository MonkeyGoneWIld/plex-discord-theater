import { ScrollShelf } from "./ScrollShelf";
import { MovieCard } from "./MovieCard";
import { COLLECTION_ROW_CARD_WIDTH, COLLECTION_ROW_MAX_WIDTH_PX } from "../lib/grid";
import type { PlexItem } from "../lib/api";

interface PosterShelfProps {
  /** Row heading, e.g. a collection name or "More Like This". */
  title: string;
  items: PlexItem[];
  onSelect: (item: PlexItem) => void;
}

/**
 * One labelled, horizontally-scrolling poster shelf — the shared building block
 * for the detail-page collection and "More Like This" rows. Same card size as
 * the Home tab (via COLLECTION_ROW_CARD_WIDTH) and the same ScrollShelf
 * behaviour (drag scroll, hover chevrons/side arrows on desktop, native swipe on
 * touch). Purely presentational; the caller supplies the items.
 */
export function PosterShelf({ title, items, onSelect }: PosterShelfProps) {
  return (
    <div style={shelfStyles.section}>
      <h3 style={shelfStyles.label}>{title}</h3>
      <ScrollShelf rowStyle={shelfStyles.row}>
        {items.map((item) => (
          <div key={item.ratingKey} style={shelfStyles.card}>
            <MovieCard item={item} onClick={onSelect} />
          </div>
        ))}
      </ScrollShelf>
    </div>
  );
}

// Shared with RelatedRows so every detail-page shelf is laid out identically.
// `wrap` mirrors Library.tsx's hub styling but in a
// narrower centred column that tops out at eight cards (see grid.ts), and lifts
// the row above the detail page's absolutely-positioned backdrop so its heading
// isn't hidden on tall/fullscreen viewports.
export const shelfStyles: Record<string, React.CSSProperties> = {
  wrap: {
    maxWidth: `${COLLECTION_ROW_MAX_WIDTH_PX}px`,
    margin: "40px auto 0",
    padding: "0 24px",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    position: "relative",
    zIndex: 10,
  },
  section: {
    paddingBottom: "8px",
  },
  label: {
    color: "#e0e0e0",
    fontSize: "20px",
    fontWeight: 700,
    marginBottom: 0,
    letterSpacing: "-0.01em",
  },
  row: {
    display: "flex",
    gap: "14px",
    overflowX: "auto" as const,
    // See Library.tsx hubRow for why the horizontal padding is paired with an
    // equal negative margin.
    padding: "20px 24px 22px",
    margin: "0 -24px",
  },
  card: {
    flexShrink: 0,
    flexGrow: 0,
    width: COLLECTION_ROW_CARD_WIDTH,
  },
};
