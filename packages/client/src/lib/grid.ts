/** Most columns the poster grid will ever show. */
const MAX_COLUMNS = 10;
/** Gap between cards, matching the grid's `gap`. */
const GAP_PX = 14;
/**
 * Narrowest a poster may get before the grid drops to fewer columns.
 *
 * This is the one number to tune. Ten columns survive while the container is at
 * least `MAX_COLUMNS * MIN_CARD_PX + TOTAL_GAP_PX` wide — 1526px at these
 * values. Narrower than that and the count steps down instead of the posters
 * continuing to shrink. Lower it to keep ten columns at narrower widths; raise
 * it for bigger posters and fewer per row.
 */
const MIN_CARD_PX = 140;

/** Total gap width across a full row: one fewer gap than columns. */
const TOTAL_GAP_PX = (MAX_COLUMNS - 1) * GAP_PX;

/** Width one column would have at exactly MAX_COLUMNS across. */
const FULL_ROW_COLUMN = `(100% - ${TOTAL_GAP_PX}px) / ${MAX_COLUMNS}`;

/**
 * The single poster-card width, shared by the Movies/TV Shows/History grid and
 * the horizontally-scrolling Home rows so a card is exactly the same size on
 * every tab.
 *
 * `max()` is what makes this reflow properly: while there's room, the
 * ten-column width is the larger value and the grid lands on exactly ten
 * columns filling the row. Once the window narrows enough that ten columns
 * would push a poster below MIN_CARD_PX, the floor wins — the card holds at
 * MIN_CARD_PX and the column count steps down, rather than ten posters
 * shrinking indefinitely.
 */
const POSTER_CARD_WIDTH = `max(${MIN_CARD_PX}px, ${FULL_ROW_COLUMN})`;

/**
 * Poster grid columns — fixed-width tracks, not `minmax(…, 1fr)`.
 *
 * The width is exactly POSTER_CARD_WIDTH, the same value the Home rows use. A
 * `1fr` max would let the grid stretch its columns to fill the row once the
 * count steps down at the MIN_CARD_PX floor, making grid posters wider than the
 * fixed-width Home-row posters at the same window size. Keeping the track fixed
 * means every tab renders an identical card; the grid simply leaves trailing
 * space on the right when the columns don't divide the row evenly, exactly like
 * a Home row.
 */
export const POSTER_GRID_COLUMNS = `repeat(auto-fill, ${POSTER_CARD_WIDTH})`;

/**
 * Width for cards in the horizontally-scrolling Home rows, which are flex items
 * rather than grid cells. Identical to the grid track above.
 */
export const POSTER_ROW_CARD_WIDTH = POSTER_CARD_WIDTH;

// ─── Detail-page collection rows ────────────────────────────────
//
// The "also in this collection" rows use the same card size as the Home rows
// but top out at eight cards instead of ten, in a narrower centred wrapper. The
// card size is held constant by pairing an eight-column width formula with a
// wrapper whose max width is scaled to match: at full stretch a card is the same
// ~182px it is in a ten-column Home row at 2000px, and exactly eight fit.

/** Cards a collection row shows at maximum stretch. */
const COLLECTION_MAX_COLUMNS = 8;
const COLLECTION_TOTAL_GAP_PX = (COLLECTION_MAX_COLUMNS - 1) * GAP_PX;
const COLLECTION_FULL_ROW_COLUMN = `(100% - ${COLLECTION_TOTAL_GAP_PX}px) / ${COLLECTION_MAX_COLUMNS}`;

/** Collection-row card width — same floor and full-stretch size as a Home card,
 *  but divided across eight columns rather than ten. */
export const COLLECTION_ROW_CARD_WIDTH = `max(${MIN_CARD_PX}px, ${COLLECTION_FULL_ROW_COLUMN})`;

// Home wideWrap width and its 24px-per-side gutters — the reference the card
// full-stretch size is derived from (see Library.tsx wideWrap / hubSection).
const HOME_WRAP_MAX_PX = 2000;
const ROW_GUTTERS_PX = 48;
/** A Home card's width at full ten-column stretch inside the 2000px wideWrap. */
const HOME_FULL_STRETCH_CARD_PX =
  (HOME_WRAP_MAX_PX - ROW_GUTTERS_PX - (MAX_COLUMNS - 1) * GAP_PX) / MAX_COLUMNS;

/**
 * Max width of the collection-row wrapper (content + its 24px gutters). Sized so
 * eight cards at the Home full-stretch width exactly fill it — 8 cards + 7 gaps
 * + 2 gutters — so the shelf stays centred and caps at eight without shrinking
 * the thumbnails.
 */
export const COLLECTION_ROW_MAX_WIDTH_PX = Math.round(
  COLLECTION_MAX_COLUMNS * HOME_FULL_STRETCH_CARD_PX + COLLECTION_TOTAL_GAP_PX + ROW_GUTTERS_PX,
);
