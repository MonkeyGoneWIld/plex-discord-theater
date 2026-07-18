import type { PlexItem } from "../lib/api";
import { getSessionToken } from "../lib/api";

interface MovieCardProps {
  item: PlexItem;
  onClick: (item: PlexItem) => void;
}

function authThumbUrl(thumb: string, w?: number, h?: number): string {
  const token = getSessionToken();
  if (!token) return thumb;
  const sep = thumb.includes("?") ? "&" : "?";
  let url = `${thumb}${sep}token=${encodeURIComponent(token)}`;
  if (w && h) url += `&w=${w}&h=${h}`;
  return url;
}

export function MovieCard({ item, onClick }: MovieCardProps) {
  return (
    <button
      onClick={() => onClick(item)}
      style={styles.card}
      onMouseEnter={(e) => {
        const el = e.currentTarget;
        el.style.transform = "scale(1.03)";
        el.style.boxShadow = "0 4px 24px rgba(229,160,13,0.12)";
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget;
        el.style.transform = "scale(1)";
        el.style.boxShadow = "none";
      }}
    >
      {(() => {
        // Episodes: use the show's poster (portrait, matches other cards)
        // instead of the episode still (landscape — looks cropped/ugly when
        // forced into a portrait card). Fall back to the still if no show
        // poster is available.
        const posterSrc = item.type === "episode" ? (item.showThumb ?? item.thumb) : item.thumb;
        return posterSrc ? (
          <img src={authThumbUrl(posterSrc, 320, 480)} alt={item.title} style={styles.poster} loading="lazy" />
        ) : (
          <div style={styles.placeholder}>No Poster</div>
        );
      })()}
      <div style={styles.info}>
        <div style={styles.title}>{item.title}</div>
        {item.type === "episode" ? (
          <div style={styles.year}>
            {item.showTitle}
            {item.parentIndex != null && item.index != null
              ? `${item.showTitle ? " \u00b7 " : ""}S${item.parentIndex}E${item.index}`
              : ""}
          </div>
        ) : item.type === "season" && item.leafCount != null ? (
          <div style={styles.year}>{item.leafCount} {item.leafCount === 1 ? "episode" : "episodes"}</div>
        ) : item.year ? (
          <div style={styles.year}>{item.year}</div>
        ) : null}
      </div>
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    background: "#141414",
    borderRadius: "10px",
    overflow: "hidden",
    cursor: "pointer",
    border: "1px solid rgba(255,255,255,0.06)",
    color: "inherit",
    textAlign: "left",
    transition: "transform 0.2s ease, box-shadow 0.2s ease",
    width: "100%",
    fontFamily: "inherit",
  },
  poster: {
    width: "100%",
    aspectRatio: "2/3",
    objectFit: "cover",
    display: "block",
  },
  placeholder: {
    width: "100%",
    aspectRatio: "2/3",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(255,255,255,0.03)",
    color: "#555",
    fontSize: "13px",
    fontWeight: 500,
  },
  info: {
    padding: "10px 10px 12px",
  },
  title: {
    fontSize: "13px",
    fontWeight: 600,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    color: "#e0e0e0",
  },
  year: {
    fontSize: "12px",
    color: "#666",
    marginTop: "3px",
    fontWeight: 500,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
};
