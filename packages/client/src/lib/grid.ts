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
 * Poster grid columns.
 *
 * `max()` is what makes this reflow properly: while there's room, the
 * ten-column width is the larger value and auto-fill lands on exactly ten
 * columns, preserving the intended layout. Once the window narrows enough that
 * ten columns would push a poster below MIN_CARD_PX, the floor wins and
 * auto-fill drops to fewer columns instead — so posters keep their size and the
 * count changes, rather than ten posters shrinking indefinitely.
 */
export const POSTER_GRID_COLUMNS =
  `repeat(auto-fill, minmax(max(${MIN_CARD_PX}px, ${FULL_ROW_COLUMN}), 1fr))`;

/**
 * Width for cards in the horizontally-scrolling Home rows, which are flex items
 * rather than grid cells. Uses the same two values so a Home poster is never a
 * different size from a Movies/TV Shows poster at the same window width.
 */
export const POSTER_ROW_CARD_WIDTH = `max(${MIN_CARD_PX}px, ${FULL_ROW_COLUMN})`;
