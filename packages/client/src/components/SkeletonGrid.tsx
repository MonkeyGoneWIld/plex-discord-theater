import { usePosterLayout } from "../lib/grid";

const SKELETON_COUNT = 10;

export function SkeletonGrid() {
  // Same source as the real grid, so the placeholder reserves the columns the
  // posters will actually land in — three across on a phone, not two that then
  // reflow into three the moment they arrive.
  const { gridColumns } = usePosterLayout();
  return (
    <div style={{ ...styles.grid, gridTemplateColumns: gridColumns }}>
      {Array.from({ length: SKELETON_COUNT }, (_, i) => (
        <div key={i} style={styles.card}>
          <div style={{ ...styles.poster, animationDelay: `${i * 0.05}s` }} />
          <div style={{ ...styles.title, animationDelay: `${i * 0.05 + 0.1}s` }} />
          <div style={{ ...styles.subtitle, animationDelay: `${i * 0.05 + 0.2}s` }} />
        </div>
      ))}
    </div>
  );
}

const shimmer = "shimmer 1.5s ease-in-out infinite";

const styles: Record<string, React.CSSProperties> = {
  grid: {
    display: "grid",
    // gridTemplateColumns comes from usePosterLayout above — see the note there.
    gap: "14px",
    padding: "16px 24px",
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  poster: {
    aspectRatio: "2/3",
    borderRadius: "6px",
    background: "linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.04) 75%)",
    backgroundSize: "200% 100%",
    animation: shimmer,
  },
  title: {
    height: "12px",
    width: "75%",
    borderRadius: "4px",
    background: "linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.04) 75%)",
    backgroundSize: "200% 100%",
    animation: shimmer,
  },
  subtitle: {
    height: "10px",
    width: "40%",
    borderRadius: "4px",
    background: "linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.04) 75%)",
    backgroundSize: "200% 100%",
    animation: shimmer,
  },
};
