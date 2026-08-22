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
  /**
   * Show these controls as named buttons rather than bare glyphs.
   *
   * For when nothing else is in the row with them. Beside a Play or Resume
   * button a lone circle-check reads as its companion; on its own under the
   * synopsis it reads as a stray mark, and its 46px target puts the glyph 9px
   * in from where every line above it starts. A label fixes both — it lines up
   * with the text and it says what it does.
   *
   * Both controls take the label together. A bookmark outline is the less
   * self-evident of the two glyphs, so leaving it bare beside a named
   * "Mark as watched" made the pair read as one button and one loose mark.
   */
  labelled?: boolean;
}

/** Personal media actions. These never participate in room playback. */
export function PlexMediaActions({
  item, progress, onProgressChange, watched, onWatchedChange, inline = false,
  labelled = false,
}: PlexMediaActionsProps) {
  const [linked, setLinked] = useState<boolean | null>(null);
  const [watchlisted, setWatchlisted] = useState(false);
  const [watchlistBusy, setWatchlistBusy] = useState(false);
  const [watchedBusy, setWatchedBusy] = useState(false);
  const [watchedState, setWatchedState] = useState(watched ?? progress?.watched ?? false);
  const [error, setError] = useState<string | null>(null);
  const supportsWatchlist = item.type === "movie" || item.type === "show";
  const supportsWatched = item.inLibrary !== false
    && (item.type === "movie" || item.type === "episode" || item.type === "season" || item.type === "show");
  /**
   * What the control does, named by what it applies to.
   *
   * One pattern across all three scopes rather than three phrasings: the older
   * strings spelled out "all episodes in this show", which repeats the page you
   * are already on, and dropped the "as" from the unwatched half so the two
   * directions did not read as a pair. This is the tooltip and the accessible
   * name; see watchedLabel for the shorter text the button itself carries.
   */
  const watchedScope = item.type === "season" ? "season "
    : item.type === "show" ? "show " : "";
  const watchedAction = watchedState
    ? `Mark ${watchedScope}as unwatched`
    : `Mark ${watchedScope}as watched`;
  const watchlistAction = watchlisted ? "Remove from Watchlist" : "Add to Watchlist";
  /**
   * Shorter text for the buttons themselves — the tooltip and the accessible
   * name above keep the full phrasing.
   *
   * The two have to share one line. Spelled out, "Add to Watchlist" beside
   * "Mark show as watched" measures 469px against the 358px a 390px phone
   * gives them, so they wrapped onto separate rows. These fit on one down to
   * a 360px screen in every state (322px of 328px), at the same pill size.
   *
   * The watchlist button drops its verb rather than its noun: it is the one
   * whose glyph already carries the state, filling in and turning amber once
   * the title is on the list.
   */
  const watchlistLabel = "Watchlist";
  const watchedLabel = watchedState ? "Mark unwatched" : "Mark watched";

  useEffect(() => {
    if (watched != null) setWatchedState(watched);
    else if (progress?.watched != null) setWatchedState(progress.watched);
  }, [progress?.watched, watched]);

  useEffect(() => {
    let cancelled = false;
    if (!supportsWatched) return;
    fetchPlexItemWatchedState(item.ratingKey)
      .then((state) => { if (!cancelled) setWatchedState(state.watched); })
      .catch(() => {
        // Keep the local state already supplied by the page.
      });
    return () => { cancelled = true; };
  }, [item.ratingKey, supportsWatched]);

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

  if (!supportsWatched && !(linked && supportsWatchlist)) return null;

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
      <div style={{ ...styles.buttons, ...(labelled ? styles.buttonsLabelled : {}) }}>
        {linked && supportsWatchlist && (
          <button className="btn"
            type="button"
            onClick={() => void toggleWatchlist()}
            disabled={watchlistBusy}
            aria-label={watchlistAction}
            aria-pressed={watchlisted}
            title={watchlistBusy ? "Updating Watchlist..." : watchlisted ? "In Watchlist" : "Add to Watchlist"}
            style={{
              ...(labelled ? styles.labelledButton : styles.iconButton),
              ...(watchlisted ? styles.watchlistActive : {}),
              ...(watchlistBusy ? styles.busy : {}),
            }}
          >
            <Bookmark filled={watchlisted} />
            {labelled && <span>{watchlistLabel}</span>}
          </button>
        )}
        {supportsWatched && (
          <button className="btn"
            type="button"
            onClick={() => void toggleWatched()}
            disabled={watchedBusy}
            aria-label={watchedAction}
            aria-pressed={watchedState}
            title={watchedBusy ? "Updating watched state..." : watchedAction}
            style={{
              ...(labelled ? styles.labelledButton : styles.iconButton),
              ...(watchedState ? styles.watchedActive : {}),
              ...(watchedBusy ? styles.busy : {}),
            }}
          >
            <WatchedCheckIcon />
            {labelled && <span>{watchedLabel}</span>}
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
  /** 6px is the spacing between two touching circles; between two bordered
   *  pills sharing a row it reads as a seam. */
  buttonsLabelled: { gap: "10px" },
  iconButton: {
    width: "46px", height: "46px", display: "inline-flex", alignItems: "center",
    justifyContent: "center", padding: 0, borderRadius: "50%", border: "none",
    background: "transparent", color: "#d6d6d6", cursor: "pointer",
    fontFamily: "inherit", transition: "background 0.15s ease, color 0.15s ease, opacity 0.15s ease",
  },
  /** The same control, named. Sized to sit under a synopsis rather than beside
   *  a play button, so it starts where the text does. */
  labelledButton: {
    display: "inline-flex", alignItems: "center", gap: "9px",
    // 44px, the same floor the episode list's control is held to. It is a
    // primary way to change state on a phone, and it was 4px short of it.
    height: "44px", padding: "0 18px 0 13px", borderRadius: "999px",
    border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.06)",
    color: "#d6d6d6", cursor: "pointer", fontFamily: "inherit",
    fontSize: "14px", fontWeight: 500, whiteSpace: "nowrap",
    transition: "background 0.15s ease, color 0.15s ease, opacity 0.15s ease",
  },
  watchlistActive: { color: "#e5a00d" },
  watchedActive: { color: "#6a9955" },
  busy: { opacity: 0.5, cursor: "wait" },
  error: { color: "#d47777", fontSize: "12px", lineHeight: 1.4 },
};
