import { useState } from "react";
import type { PlexItem } from "../lib/api";
import { getSessionToken } from "../lib/api";

interface MovieCardProps {
  item: PlexItem;
  onClick: (item: PlexItem) => void;
  /** Show is in the library but missing seasons — flags a "Partial" badge. */
  partial?: boolean;
}

function authThumbUrl(thumb: string, w?: number, h?: number): string {
  const token = getSessionToken();
  if (!token) return thumb;
  const sep = thumb.includes("?") ? "&" : "?";
  let url = `${thumb}${sep}token=${encodeURIComponent(token)}`;
  if (w && h) url += `&w=${w}&h=${h}`;
  return url;
}

export function MovieCard({ item, onClick, partial }: MovieCardProps) {
  // Online (Discover) result: in search but not in the library. Clickable — it
  // opens a detail view (with a request button) rather than playback.
  const external = item.inLibrary === false;
  const [imgError, setImgError] = useState(false);
  // Episodes: use the show's poster (portrait, matches other cards) instead of
  // the episode still (landscape — looks cropped in a portrait card). Fall back
  // to the still if no show poster is available.
  const posterSrc = item.type === "episode" ? (item.showThumb ?? item.thumb) : item.thumb;
  const showImg = !!posterSrc && !imgError;
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
      <div style={styles.posterWrap}>
        {showImg ? (
          <img
            src={authThumbUrl(posterSrc!, 320, 480)}
            alt={item.title}
            style={styles.poster}
            loading="lazy"
            onError={() => setImgError(true)}
          />
        ) : (
          <div style={styles.placeholder}>No Poster</div>
        )}
        {external && <div style={styles.badge}>Not in library</div>}
        {!external && partial && <div style={styles.partialBadge}>Partial</div>}
      </div>
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
  posterWrap: {
    position: "relative",
  },
  badge: {
    position: "absolute",
    top: "8px",
    left: "8px",
    padding: "3px 7px",
    borderRadius: "5px",
    background: "rgba(0,0,0,0.72)",
    color: "rgba(255,255,255,0.85)",
    fontSize: "10px",
    fontWeight: 600,
    letterSpacing: "0.3px",
    textTransform: "uppercase" as const,
  },
  partialBadge: {
    position: "absolute",
    top: "8px",
    left: "8px",
    padding: "3px 7px",
    borderRadius: "5px",
    background: "rgba(229,160,13,0.9)",
    color: "#000",
    fontSize: "10px",
    fontWeight: 700,
    letterSpacing: "0.3px",
    textTransform: "uppercase" as const,
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
