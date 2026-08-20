import { useEffect, useState } from "react";
import {
  fetchPlexAccountStatus,
  fetchPlexWatchlist,
  fetchPlexWatchlistState,
  setPlexItemWatched,
  setPlexWatchlistState,
  type HistoryEntry,
  type PlexItem,
} from "../lib/api";

interface PlexMediaActionsProps {
  item: PlexItem;
  progress?: HistoryEntry | null;
  onProgressChange?: (progress: HistoryEntry | null) => void;
  /** Sit alongside the page's primary Play/Resume/Request action. */
  inline?: boolean;
}

/** Personal Plex actions. These never participate in room playback. */
export function PlexMediaActions({ item, progress, onProgressChange, inline = false }: PlexMediaActionsProps) {
  const [linked, setLinked] = useState(false);
  const [watchlisted, setWatchlisted] = useState(false);
  const [watchlistBusy, setWatchlistBusy] = useState(false);
  const [watchedBusy, setWatchedBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supportsWatchlist = item.type === "movie" || item.type === "show";
  const supportsWatched = item.inLibrary !== false && (item.type === "movie" || item.type === "episode");

  useEffect(() => {
    let cancelled = false;
    fetchPlexAccountStatus()
      .then(async (status) => {
        if (cancelled) return;
        setLinked(status.linked);
        if (!status.linked || !supportsWatchlist) return;
        try {
          if (item.inLibrary === false) {
            const list = await fetchPlexWatchlist();
            if (!cancelled) {
              setWatchlisted(list.items.some((entry) => !!item.guid && entry.guid === item.guid));
            }
          } else {
            const state = await fetchPlexWatchlistState(item.ratingKey);
            if (!cancelled) setWatchlisted(state.watchlisted);
          }
        } catch {
          // The action can still be attempted; don't hide every other control
          // because Plex couldn't answer the initial watchlist lookup.
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [item.guid, item.inLibrary, item.ratingKey, supportsWatchlist]);

  if (!linked || (!supportsWatchlist && !supportsWatched)) return null;

  const toggleWatchlist = async () => {
    if (watchlistBusy) return;
    const next = !watchlisted;
    setWatchlistBusy(true);
    setError(null);
    try {
      await setPlexWatchlistState(item, next);
      setWatchlisted(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update Plex Watchlist");
    } finally {
      setWatchlistBusy(false);
    }
  };

  const toggleWatched = async () => {
    if (watchedBusy) return;
    const next = !progress?.watched;
    setWatchedBusy(true);
    setError(null);
    try {
      const result = await setPlexItemWatched(item.ratingKey, next);
      onProgressChange?.(result.progress);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update watched state");
    } finally {
      setWatchedBusy(false);
    }
  };

  return (
    <div style={{ ...styles.wrap, ...(inline ? styles.wrapInline : {}) }}>
      <div style={styles.buttons}>
        {supportsWatchlist && (
          <button type="button" onClick={() => void toggleWatchlist()} disabled={watchlistBusy} style={styles.button}>
            <Bookmark filled={watchlisted} />
            {watchlistBusy ? "Updating..." : watchlisted ? "In Watchlist" : "Add to Watchlist"}
          </button>
        )}
        {supportsWatched && (
          <button type="button" onClick={() => void toggleWatched()} disabled={watchedBusy} style={styles.button}>
            <Check filled={progress?.watched === true} />
            {watchedBusy ? "Updating..." : progress?.watched ? "Mark Unwatched" : "Mark as Watched"}
          </button>
        )}
      </div>
      {error && <div style={styles.error}>{error}</div>}
    </div>
  );
}

function Bookmark({ filled }: { filled: boolean }) {
  return (
    <svg width="17" height="17" viewBox="0 0 20 20" fill={filled ? "currentColor" : "none"} aria-hidden="true">
      <path d="M5 3.5C5 2.67 5.67 2 6.5 2h7c.83 0 1.5.67 1.5 1.5V18l-5-3-5 3V3.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function Check({ filled }: { filled: boolean }) {
  return (
    <svg width="17" height="17" viewBox="0 0 20 20" fill={filled ? "currentColor" : "none"} aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="m6.5 10 2.2 2.2 4.8-5" stroke={filled ? "#151515" : "currentColor"} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "8px", marginTop: "14px" },
  wrapInline: { marginTop: 0 },
  buttons: { display: "flex", flexWrap: "wrap", gap: "8px" },
  button: {
    display: "inline-flex", alignItems: "center", gap: "8px", padding: "9px 13px",
    borderRadius: "9px", border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.055)", color: "#d2d2d2", cursor: "pointer",
    fontFamily: "inherit", fontSize: "13px", fontWeight: 600,
  },
  error: { color: "#d47777", fontSize: "12px", lineHeight: 1.4 },
};
