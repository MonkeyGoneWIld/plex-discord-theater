import { useEffect, useRef, useState } from "react";
import type { PlexItem } from "../lib/api";
import { posterThumbUrl, prefetchDetail } from "../lib/api";

interface MovieCardProps {
  item: PlexItem;
  onClick: (item: PlexItem) => void;
  /** Watched fraction (0-1) — draws a progress bar across the bottom of the poster. */
  progress?: number | null;
  /** Marks the poster with a "watched" tick. Used by the history view. */
  watched?: boolean;
  /** Adds a dismiss control to the poster. Omit for a plain card. */
  onRemove?: (item: PlexItem) => void;
  /** Tooltip and accessible name for that control — the two surfaces that use
   *  it do different things (leave Continue Watching vs. forget entirely), so
   *  the wording has to come from the caller. */
  removeLabel?: string;
}


// Not-in-library posters are desaturated and dimmed so the tile reads as "not
// owned" at a glance — the small badge alone is easy to miss. Lifted on hover to
// signal the card is still clickable (it opens the request page).
const EXTERNAL_POSTER_FILTER = "grayscale(65%) brightness(0.55)";

/** How long the pointer must rest on a card before it counts as intent to open
 *  it. Long enough to skip cards being swept past, short enough that the fetch
 *  is usually done by the time a deliberate click lands. */
const HOVER_INTENT_MS = 120;

// Card edge colours. Hover swaps between them, so they have to match what the
// `card` / `cardExternal` styles below set, or leaving a card would repaint it
// with the wrong resting edge.
const IDLE_BORDER = "rgba(255,255,255,0.06)";
const EXTERNAL_BORDER = "rgba(255,255,255,0.14)";
const ACCENT_BORDER = "rgba(229,160,13,0.85)";

/** Hover lift for an owned poster. A filter repaints in place — unlike a scale,
 *  which would push the card past the row's clip edge and shear the border. */
const HOVER_POSTER_FILTER = "brightness(1.12)";

export function MovieCard({ item, onClick, progress, watched, onRemove, removeLabel = "Remove" }: MovieCardProps) {
  const prefetchTimer = useRef<number | undefined>(undefined);
  // A card can unmount while its timer is pending (filtering, tab switch).
  useEffect(() => () => { if (prefetchTimer.current) window.clearTimeout(prefetchTimer.current); }, []);
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
      style={external ? { ...styles.card, ...styles.cardExternal } : styles.card}
      onMouseEnter={(e) => {
        // Prefetch what the detail page needs, but only once the pointer has
        // settled — sweeping across a row would otherwise fire a request per
        // card. Cancelled on leave, and cheap to repeat (the API cache holds the
        // in-flight promise, so a re-entry joins the existing request).
        prefetchTimer.current = window.setTimeout(() => prefetchDetail(item), HOVER_INTENT_MS);
        const el = e.currentTarget;
        // Everything here stays inside the card's own box.
        //
        // These cards sit in a scroller, and `overflow-x: auto` clips both axes
        // hard at its content edge. Anything drawn outside the box is cut: an
        // outer glow lost its top and bottom on every card and its outer side on
        // the end ones, and `scale()` did the same to the border, since growing
        // 3% puts ~2.5px of card above the row's top edge. Making room by
        // padding the row only shrinks the cards until an extra one fits.
        //
        // So hover is an amber edge plus a brighter poster — a colour change and
        // a filter, neither of which moves or grows anything.
        el.style.borderColor = ACCENT_BORDER;
        const img = el.querySelector("img");
        // A dimmed not-in-library poster comes up to full colour; an owned one
        // just lifts slightly.
        if (img) img.style.filter = external ? "none" : HOVER_POSTER_FILTER;
      }}
      onMouseLeave={(e) => {
        if (prefetchTimer.current) window.clearTimeout(prefetchTimer.current);
        const el = e.currentTarget;
        el.style.borderColor = external ? EXTERNAL_BORDER : IDLE_BORDER;
        const img = el.querySelector("img");
        if (img) img.style.filter = external ? EXTERNAL_POSTER_FILTER : "";
      }}
    >
      <div style={styles.posterWrap}>
        {showImg ? (
          <img
            src={posterThumbUrl(posterSrc!)}
            alt={item.title}
            style={external ? { ...styles.poster, filter: EXTERNAL_POSTER_FILTER } : styles.poster}
            // Eager, not lazy: load every poster up front so nothing pops in as
            // the user scrolls the (non-virtualized) rows and grids.
            loading="eager"
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
            aria-label={`${removeLabel}: ${item.title}`}
            title={removeLabel}
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
    transition: "border-color 0.18s ease",
    width: "100%",
    fontFamily: "inherit",
  },
  // Muted tile for a not-in-library card — a darker body and dashed border set it
  // apart from owned cards even beyond the dimmed poster and badge.
  cardExternal: {
    background: "#101010",
    border: "1px dashed rgba(255,255,255,0.14)",
  },
  posterWrap: {
    position: "relative",
  },
  badge: {
    position: "absolute",
    top: "8px",
    left: "8px",
    padding: "3px 8px",
    borderRadius: "5px",
    // Amber-tinted rather than plain black, so the "Not in library" label reads
    // as a status flag instead of blending into the dimmed poster behind it.
    background: "rgba(229,160,13,0.92)",
    color: "#1a1205",
    fontSize: "10px",
    fontWeight: 700,
    letterSpacing: "0.3px",
    textTransform: "uppercase" as const,
    boxShadow: "0 1px 6px rgba(0,0,0,0.5)",
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
    // Smoothes the not-in-library dim lifting/settling on hover.
    transition: "filter 0.2s ease",
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
