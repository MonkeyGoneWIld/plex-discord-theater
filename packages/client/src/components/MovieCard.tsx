import { useState } from "react";
import type { PlexItem } from "../lib/api";
import { getSessionToken } from "../lib/api";

interface MovieCardProps {
  item: PlexItem;
  onClick: (item: PlexItem) => void;
  /** Watched fraction (0-1) — draws a progress bar across the bottom of the poster. */
  progress?: number | null;
  /** Marks the poster with a "watched" tick. Used by the history view. */
  watched?: boolean;
  /** Adds a dismiss control that forgets this item. Omit for a plain card. */
  onRemove?: (item: PlexItem) => void;
}

function authThumbUrl(thumb: string, w?: number, h?: number): string {
  const token = getSessionToken();
  if (!token) return thumb;
  const sep = thumb.includes("?") ? "&" : "?";
  let url = `${thumb}${sep}token=${encodeURIComponent(token)}`;
  if (w && h) url += `&w=${w}&h=${h}`;
  return url;
}

export function MovieCard({ item, onClick, progress, watched, onRemove }: MovieCardProps) {
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
      // Native tooltip on the whole card, so the full title shows on hover
      // anywhere over it (poster included), not only over the ellipsized text.
      title={item.title}
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
        {watched && (
          <div style={styles.watchedBadge} title="Watched">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M3 8.5L6.5 12L13 4.5" stroke="currentColor" strokeWidth="2.2"
                strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
        )}
        {/* A nested <button> would be invalid inside the card button, so the
            dismiss control is a span with an explicit role and key handling. */}
        {onRemove && (
          <span
            role="button"
            tabIndex={0}
            aria-label={`Remove ${item.title} from history`}
            title="Remove from history"
            style={styles.removeBtn}
            onClick={(e) => { e.stopPropagation(); onRemove(item); }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              e.stopPropagation();
              onRemove(item);
            }}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
              <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </span>
        )}
        {progress != null && progress > 0 && (
          <div style={styles.progressTrack}>
            <div style={{ ...styles.progressFill, width: `${Math.min(100, progress * 100)}%` }} />
          </div>
        )}
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
  watchedBadge: {
    position: "absolute",
    top: "8px",
    right: "8px",
    width: "22px",
    height: "22px",
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(0,0,0,0.72)",
    color: "#6a9955",
  },
  removeBtn: {
    position: "absolute",
    top: "8px",
    left: "8px",
    width: "22px",
    height: "22px",
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(0,0,0,0.72)",
    color: "rgba(255,255,255,0.75)",
    cursor: "pointer",
  },
  progressTrack: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: "4px",
    background: "rgba(0,0,0,0.55)",
  },
  progressFill: {
    height: "100%",
    background: "#e5a00d",
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
