import { useEffect, useState } from "react";
import {
  fetchPlexAccountStatus,
  fetchPlexItemWatchedState,
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
  watched?: boolean;
  onWatchedChange?: (watched: boolean) => void;
  /** Sit alongside the page's primary Play/Resume/Request action. */
  inline?: boolean;
}

/** Personal Plex actions. These never participate in room playback. */
export function PlexMediaActions({
  item, progress, onProgressChange, watched, onWatchedChange, inline = false,
}: PlexMediaActionsProps) {
  const [linked, setLinked] = useState(false);
  const [watchlisted, setWatchlisted] = useState(false);
  const [watchlistBusy, setWatchlistBusy] = useState(false);
  const [watchedBusy, setWatchedBusy] = useState(false);
  const [watchedState, setWatchedState] = useState(watched ?? progress?.watched ?? false);
  const [error, setError] = useState<string | null>(null);
  const supportsWatchlist = item.type === "movie" || item.type === "show";
  const supportsWatched = item.inLibrary !== false
    && (item.type === "movie" || item.type === "episode" || item.type === "season" || item.type === "show");

  useEffect(() => {
    if (watched != null) setWatchedState(watched);
    else if (progress?.watched != null) setWatchedState(progress.watched);
  }, [progress?.watched, watched]);

  useEffect(() => {
    let cancelled = false;
    fetchPlexAccountStatus()
      .then(async (status) => {
        if (cancelled) return;
        setLinked(status.linked);
        if (status.linked && supportsWatched) {
          try {
            const state = await fetchPlexItemWatchedState(item.ratingKey);
            if (!cancelled) setWatchedState(state.watched);
          } catch {
            // Keep the local state already supplied by the page.
          }
        }
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
  }, [item.guid, item.inLibrary, item.ratingKey, supportsWatchlist, supportsWatched]);

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
    const next = !watchedState;
    setWatchedBusy(true);
    setError(null);
    try {
      const result = await setPlexItemWatched(item.ratingKey, next);
      setWatchedState(next);
      onProgressChange?.(result.progress);
      onWatchedChange?.(next);
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
          <button
            type="button"
            onClick={() => void toggleWatchlist()}
            disabled={watchlistBusy}
            aria-label={watchlisted ? "Remove from Watchlist" : "Add to Watchlist"}
            aria-pressed={watchlisted}
            title={watchlistBusy ? "Updating Watchlist..." : watchlisted ? "In Watchlist" : "Add to Watchlist"}
            style={{
              ...styles.iconButton,
              ...(watchlisted ? styles.watchlistActive : {}),
              ...(watchlistBusy ? styles.busy : {}),
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.08)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            <Bookmark filled={watchlisted} />
          </button>
        )}
        {supportsWatched && (
          <button
            type="button"
            onClick={() => void toggleWatched()}
            disabled={watchedBusy}
            aria-label={watchedState ? "Mark Unwatched" : "Mark as Watched"}
            aria-pressed={watchedState}
            title={watchedBusy ? "Updating watched state..." : watchedState ? "Watched — mark unwatched" : "Mark as Watched"}
            style={{
              ...styles.iconButton,
              ...(watchedState ? styles.watchedActive : {}),
              ...(watchedBusy ? styles.busy : {}),
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.08)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            <WatchedCheckIcon />
          </button>
        )}
      </div>
      {error && <div style={styles.error}>{error}</div>}
    </div>
  );
}

function Bookmark({ filled }: { filled: boolean }) {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} aria-hidden="true">
      <path d="M6.5 3.5h11v17l-5.5-3.3-5.5 3.3v-17Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}

/** The watched-state glyph shared by media actions and episode rows. */
export function WatchedCheckIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="m8.1 12.1 2.5 2.5 5.3-5.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "8px", marginTop: "14px" },
  wrapInline: { marginTop: 0 },
  buttons: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px" },
  iconButton: {
    width: "46px", height: "46px", display: "inline-flex", alignItems: "center",
    justifyContent: "center", padding: 0, borderRadius: "50%", border: "none",
    background: "transparent", color: "#d6d6d6", cursor: "pointer",
    fontFamily: "inherit", transition: "background 0.15s ease, color 0.15s ease, opacity 0.15s ease",
  },
  watchlistActive: { color: "#e5a00d" },
  watchedActive: { color: "#6a9955" },
  busy: { opacity: 0.5, cursor: "wait" },
  error: { color: "#d47777", fontSize: "12px", lineHeight: 1.4 },
};
