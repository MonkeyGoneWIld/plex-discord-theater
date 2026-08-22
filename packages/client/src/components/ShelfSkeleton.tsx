import { SkeletonBlock } from "./SkeletonBlock";
import { COLLECTION_ROW_CARD_WIDTH, usePosterLayout } from "../lib/grid";

/**
 * Placeholder for a shelf that hasn't loaded yet, in the shape of the shelf it
 * stands in for.
 *
 * The detail pages draw their header instantly from the clicked card, but the
 * rows underneath — cast, collections, recommendations — each need their own
 * request. Rendering nothing until those land left the lower half of the page
 * blank and then jolted it into existence, which read as the page still
 * loading long after it was usable. These hold the space at the right size, so
 * what arrives fills a slot that was already there.
 *
 * Sized from the same constants as the real rows, so it can't drift out of step
 * with them.
 */

/**
 * The text under a card, as the real rows set it.
 *
 * A cast card carries a name and a character, a poster card a title and a
 * year, and both were being stood in for by a single 13px bar. The card was
 * then a line and a half short of what replaced it — 22px for a cast row, 37px
 * for a row of posters — and every row below jumped by that much as each one
 * landed. Reserving both lines is the whole job of this file, so it is worth
 * spelling them out.
 */
const LINE_HEIGHT = 1.3;
/** MovieCard's title/year, and CastRow's name/role. */
const PRIMARY_FONT_PX = 13;
const SECONDARY_FONT_PX = 12;
/** CastRow: the gap over the name, and between the name and the character. */
const CAST_NAME_GAP_PX = 10;
const CAST_ROLE_GAP_PX = 3;
/** MovieCard's `info` padding, and the gap between its two lines. */
const CARD_INFO_PADDING = "10px 10px 12px";
const CARD_YEAR_GAP_PX = 3;

/**
 * One line of text, not yet arrived.
 *
 * The bar is shorter than the line it stands in — a solid block at the full
 * line height reads as a filled field rather than a placeholder — so the line
 * box is held by the wrapper and the bar is centred inside it. That way the
 * reservation is the real line height whatever the bar looks like.
 */
function SkeletonLine({
  width, fontPx, marginTop = 0,
}: { width: string; fontPx: number; marginTop?: number }) {
  return (
    <div
      style={{
        marginTop,
        height: `${fontPx * LINE_HEIGHT}px`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <SkeletonBlock width={width} height={Math.round(fontPx * 0.8)} />
    </div>
  );
}

export function ShelfSkeleton({
  variant,
  labelWidth = 170,
  count = 8,
}: {
  /** `poster` for a collection/related row, `cast` for the circular credits row. */
  variant: "poster" | "cast";
  labelWidth?: number;
  count?: number;
}) {
  const cast = variant === "cast";
  // Headshots are three-across on a phone, so the placeholder has to be too —
  // see CastRow.
  const { castAvatarWidth } = usePosterLayout();
  return (
    <div style={{ paddingBottom: "8px" }} aria-hidden="true">
      <SkeletonBlock width={labelWidth} height={20} />
      <div
        style={{
          display: "flex",
          gap: cast ? "18px" : "14px",
          // Matches the real rows, which carry the page gutter themselves.
          padding: cast ? "18px 24px 2px" : "20px 24px 22px",
          overflow: "hidden",
        }}
      >
        {Array.from({ length: count }, (_, i) => (
          <div
            key={i}
            style={{ flexShrink: 0, width: cast ? castAvatarWidth : COLLECTION_ROW_CARD_WIDTH }}
          >
            <SkeletonBlock
              width="100%"
              // Posters are a fixed 2:3; a headshot is a circle.
              style={{ aspectRatio: cast ? "1 / 1" : "2 / 3", height: "auto" }}
              borderRadius={cast ? "50%" : 10}
            />
            {cast ? (
              <>
                <SkeletonLine width="70%" fontPx={PRIMARY_FONT_PX} marginTop={CAST_NAME_GAP_PX} />
                <SkeletonLine width="45%" fontPx={SECONDARY_FONT_PX} marginTop={CAST_ROLE_GAP_PX} />
              </>
            ) : (
              <div style={{ padding: CARD_INFO_PADDING }}>
                <SkeletonLine width="80%" fontPx={PRIMARY_FONT_PX} />
                <SkeletonLine width="50%" fontPx={SECONDARY_FONT_PX} marginTop={CARD_YEAR_GAP_PX} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
