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
