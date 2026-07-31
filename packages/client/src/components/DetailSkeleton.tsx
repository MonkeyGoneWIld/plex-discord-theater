import { SkeletonBlock } from "./SkeletonBlock";
import { ShelfSkeleton } from "./ShelfSkeleton";
import { shelfStyles } from "./PosterShelf";

/**
 * The placeholder a detail page shows until it is ready to appear in full.
 *
 * It mirrors the real page block for block — poster, title, facts, genre pills,
 * ratings, synopsis, action button, cast row, one shelf — using the same
 * measurements the live layout uses. That fidelity is the whole point: a
 * placeholder in the wrong geometry is worse than none, because every shape the
 * eye settles on then moves.
 */
export function DetailSkeleton({
  /** Episode stills are landscape; everything else is a 2:3 poster. */
  wide = false,
  /** Shows list seasons rather than a single play button. */
  seasons = false,
}: {
  wide?: boolean;
  seasons?: boolean;
}) {
  return (
    <div aria-hidden="true">
      {/* Matches MovieDetail's content + layout. */}
      <div style={{ position: "relative", zIndex: 10, maxWidth: 1100, margin: "0 auto", padding: "0 24px 48px" }}>
        <div style={{ display: "flex", gap: "36px", alignItems: "flex-start" }}>
          <SkeletonBlock
            width={wide ? 360 : 240}
            height={wide ? 202 : 360}
            borderRadius={12}
            style={{ flexShrink: 0 }}
          />
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            {/* Title */}
            <SkeletonBlock width="46%" height={38} />
            {/* Year · runtime */}
            <SkeletonBlock width={170} height={15} style={{ marginTop: 14 }} />
            {/* Genre pills */}
            <div style={{ display: "flex", gap: "8px", marginTop: 16 }}>
              <SkeletonBlock width={78} height={26} borderRadius={13} />
              <SkeletonBlock width={64} height={26} borderRadius={13} />
              <SkeletonBlock width={88} height={26} borderRadius={13} />
            </div>
            {/* Ratings */}
            <div style={{ display: "flex", gap: "16px", marginTop: 18 }}>
              <SkeletonBlock width={58} height={22} borderRadius={4} />
              <SkeletonBlock width={58} height={22} borderRadius={4} />
              <SkeletonBlock width={58} height={22} borderRadius={4} />
            </div>
            {/* Synopsis */}
            <div style={{ display: "flex", flexDirection: "column", gap: "9px", marginTop: 20, maxWidth: 640 }}>
              <SkeletonBlock width="100%" height={14} />
              <SkeletonBlock width="97%" height={14} />
              <SkeletonBlock width="88%" height={14} />
              <SkeletonBlock width="54%" height={14} />
            </div>
            {/* Subtitle picker + Play */}
            <SkeletonBlock width={92} height={11} style={{ marginTop: 26 }} />
            <SkeletonBlock width={340} height={40} borderRadius={8} style={{ marginTop: 8 }} />
            <SkeletonBlock width={128} height={46} borderRadius={8} style={{ marginTop: 22 }} />
          </div>
        </div>
      </div>

      {seasons && (
        <div style={{ maxWidth: 1100, margin: "0 auto", padding: "0 24px 32px" }}>
          <SkeletonBlock width={110} height={20} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "16px", marginTop: 16 }}>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i}>
                <SkeletonBlock height={240} borderRadius={8} />
                <SkeletonBlock width="70%" height={13} style={{ marginTop: 8 }} />
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={shelfStyles.wrap}>
        <ShelfSkeleton variant="cast" labelWidth={140} />
        <ShelfSkeleton variant="poster" labelWidth={190} />
      </div>
    </div>
  );
}
