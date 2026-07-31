import { SkeletonBlock } from "./SkeletonBlock";
import { COLLECTION_ROW_CARD_WIDTH } from "../lib/grid";

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
  return (
    <div style={{ paddingBottom: "8px" }} aria-hidden="true">
      <SkeletonBlock width={labelWidth} height={20} />
      <div
        style={{
          display: "flex",
          gap: cast ? "18px" : "14px",
          padding: cast ? "18px 0 2px" : "20px 0 22px",
          overflow: "hidden",
        }}
      >
        {Array.from({ length: count }, (_, i) => (
          <div
            key={i}
            style={{ flexShrink: 0, width: cast ? "150px" : COLLECTION_ROW_CARD_WIDTH }}
          >
            <SkeletonBlock
              width={cast ? 150 : "100%"}
              height={cast ? 150 : undefined}
              // Posters are a fixed 2:3; a headshot is a circle.
              style={cast ? undefined : { aspectRatio: "2 / 3", height: "auto" }}
              borderRadius={cast ? "50%" : 10}
            />
            <SkeletonBlock
              width={cast ? "70%" : "80%"}
              height={13}
              style={{ marginTop: cast ? 10 : 8 }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
