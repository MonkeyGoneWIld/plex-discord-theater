import { useState, useEffect, useCallback, useRef } from "react";
import { Search } from "./Search";
import { FilterBar } from "./FilterBar";
import { MovieCard } from "./MovieCard";
import { SkeletonGrid } from "./SkeletonGrid";
import { POSTER_GRID_COLUMNS, POSTER_ROW_CARD_WIDTH } from "../lib/grid";
import {
  fetchHome,
  fetchSections,
  fetchSectionItems,
  fetchGenres,
  searchPlex,
  fetchContinueWatching,
  fetchHistory,
  deleteHistoryEntry,
  dismissFromContinueWatching,
  clearHistory,
  historyEntryToItem,
  type HistoryEntry,
  type PlexItem,
  type PlexSection,
  type Genre,
  type PlexHub,
} from "../lib/api";
import { formatWhen } from "../lib/format";

const PAGE_SIZE = 200;
const HISTORY_PAGE_SIZE = 100;

/** Watched fraction for a history entry, or null when the runtime is unknown. */
function progressOf(entry: HistoryEntry): number | null {
  return entry.durationMs > 0 ? Math.min(1, entry.positionMs / entry.durationMs) : null;
}

function describeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("429")
    ? "You're sending requests too quickly and have been temporarily rate limited. Wait a few minutes, then retry."
    : "Couldn't load the library. Check your connection, then retry.";
}

interface LibraryProps {
  isHost: boolean;
  onSelect: (item: PlexItem) => void;
  activeSection: string | null;
  onActiveSectionChange: (id: string) => void;
  onBrowseContext?: (context: string) => void;
  /** Bumped when a watch ends, so Continue Watching and History reload. Catches
   *  playback ending while the library is already on screen, which no
   *  navigation signal would. */
  historyNonce?: number;
  /** Whether the library is the view on screen. It stays mounted (hidden) behind
   *  detail and player views, so this is what tells the history rows to reload
   *  on the way back — otherwise they'd still show pre-playback positions. */
  visible?: boolean;
}

export function Library({ isHost, onSelect, activeSection, onActiveSectionChange, onBrowseContext, historyNonce = 0, visible = true }: LibraryProps) {
  const [sections, setSections] = useState<PlexSection[]>([]);
  // "home" and "history" are virtual tab ids — one for the real Plex homepage
  // (hubs), one for this app's own watch history. Both are kept in the same
  // activeSection state so tab switching logic is shared with real sections.
  const isHomeTab = activeSection === "home";
  const isHistoryTab = activeSection === "history";
  const [continueItems, setContinueItems] = useState<HistoryEntry[]>([]);
  const [historyItems, setHistoryItems] = useState<HistoryEntry[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [homeHubs, setHomeHubs] = useState<PlexHub[]>([]);
  const [homeLoading, setHomeLoading] = useState(true);
  const [items, setItems] = useState<PlexItem[]>([]);
  const [totalSize, setTotalSize] = useState(0);
  const [searchResults, setSearchResults] = useState<PlexItem[] | null>(null);
  // Bumped to tell the Search box to clear itself when Back exits search.
  const [searchResetSignal, setSearchResetSignal] = useState(0);
  const rawSearchResults = useRef<PlexItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [genres, setGenres] = useState<Genre[]>([]);
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const [sort, setSort] = useState("titleSort:asc");
  const loadMoreAbort = useRef<AbortController | null>(null);
  const searchQueryRef = useRef("");
  // Monotonically increasing id — lets an in-flight search's response detect
  // it's been superseded (by a newer search or a clear) and discard itself,
  // instead of overwriting the UI with stale results after the box was cleared.
  const searchReqId = useRef(0);
  const [homeError, setHomeError] = useState<string | null>(null);
  const [itemsError, setItemsError] = useState<string | null>(null);
  // Bumped by the Retry button to re-run the fetch effects after a failure
  const [retryNonce, setRetryNonce] = useState(0);

  // Load sections on mount
  useEffect(() => {
    fetchSections()
      .then(({ sections: s }) => {
        setSections(s);
        // Default to the Home tab (real Plex homepage) if nothing is persisted
        // from a previous visit, instead of jumping straight into a library.
        if (!activeSection) onActiveSectionChange("home");
      })
      .catch((err) => {
        console.error(err);
        // Still land on the Home tab so the error state (not a blank screen)
        // renders when every request is failing, e.g. while rate limited.
        if (!activeSection) onActiveSectionChange("home");
      })
      .finally(() => setLoading(false));
  }, [retryNonce]);

  // Load Plex homepage hubs (Recently Added, Collections, etc.). Plex's own
  // Continue Watching hub is filtered out server-side — it tracks the shared
  // Plex account, not the Discord host, so this app keeps its own (below).
  useEffect(() => {
    setHomeLoading(true);
    setHomeError(null);
    fetchHome()
      .then(({ hubs }) => setHomeHubs(hubs))
      .catch((err) => {
        console.error(err);
        setHomeError(describeError(err));
      })
      .finally(() => setHomeLoading(false));
  }, [retryNonce]);

  // Continue Watching — the caller's own in-progress items. Refetched every time
  // the row comes back on screen (returning from a detail or player view,
  // switching to the Home tab) as well as when a watch ends, since positions
  // change while this component sits mounted and hidden.
  useEffect(() => {
    if (!visible || !isHomeTab) return;
    fetchContinueWatching()
      .then(({ items: entries }) => setContinueItems(entries))
      // A missing row is invisible, not an error state — never let history
      // trouble take the whole Home tab down with it.
      .catch(() => setContinueItems([]));
  }, [visible, isHomeTab, retryNonce, historyNonce]);

  // Full history — same refresh discipline, only while its own tab is open.
  useEffect(() => {
    if (!visible || !isHistoryTab) return;
    setHistoryLoading(true);
    setHistoryError(null);
    fetchHistory({ limit: HISTORY_PAGE_SIZE })
      .then((res) => {
        setHistoryItems(res.items);
        setHistoryTotal(res.total);
      })
      .catch((err) => {
        console.error(err);
        const msg = err instanceof Error ? err.message : String(err);
        setHistoryError(
          msg.includes("429")
            ? "You're sending requests too quickly and have been temporarily rate limited. Wait a few minutes, then retry."
            : "Couldn't load your watch history. Check your connection, then retry.",
        );
      })
      .finally(() => setHistoryLoading(false));
  }, [isHistoryTab, retryNonce, historyNonce]);

  // Leave Continue Watching but stay in history. Only the row is affected, so
  // the History tab's copy of the item is deliberately left alone.
  // All of these are optimistic: the card goes immediately, and a failed
  // request just means it reappears on the next load rather than the click
  // appearing to do nothing.
  const handleDismissFromContinue = useCallback((item: PlexItem) => {
    setContinueItems((prev) => prev.filter((e) => e.ratingKey !== item.ratingKey));
    dismissFromContinueWatching(item.ratingKey).catch(console.error);
  }, []);

  // Forget the item outright. Continue Watching is a subset of history, so this
  // has to clear it from both.
  const handleForgetFromHistory = useCallback((item: PlexItem) => {
    setContinueItems((prev) => prev.filter((e) => e.ratingKey !== item.ratingKey));
    setHistoryItems((prev) => prev.filter((e) => e.ratingKey !== item.ratingKey));
    setHistoryTotal((n) => Math.max(0, n - 1));
    deleteHistoryEntry(item.ratingKey).catch(console.error);
  }, []);

  const handleClearHistory = useCallback(() => {
    setContinueItems([]);
    setHistoryItems([]);
    setHistoryTotal(0);
    clearHistory().catch(console.error);
  }, []);

  // Fetch genres when section changes
  useEffect(() => {
    if (!activeSection || isHomeTab || isHistoryTab) return;
    setGenres([]);
    // Keep the existing values when they're already at their defaults. A fresh
    // [] or an identical string still counts as a change and would re-trigger
    // the item load below, so switching tabs used to fire two requests and
    // abort the first.
    setSelectedGenres((prev) => (prev.length === 0 ? prev : []));
    setSort((prev) => (prev === "titleSort:asc" ? prev : "titleSort:asc"));
    fetchGenres(activeSection)
      .then((res) => setGenres(res.genres))
      .catch(console.error);
  }, [activeSection]);

  // Load items when section, genres, or sort changes
  useEffect(() => {
    if (!activeSection || isHomeTab || isHistoryTab) return;
    // Cancel any in-flight load-more request
    loadMoreAbort.current?.abort();
    loadMoreAbort.current = null;
    setLoadingMore(false);
    const controller = new AbortController();
    setLoading(true);
    setItems([]);
    setTotalSize(0);
    setItemsError(null);
    fetchSectionItems(activeSection, {
      signal: controller.signal,
      start: 0,
      size: PAGE_SIZE,
      genre: selectedGenres.length > 0 ? selectedGenres : undefined,
      sort,
    })
      .then((res) => {
        setItems(res.items);
        setTotalSize(res.totalSize);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error(err);
        setItemsError(describeError(err));
      })
      .finally(() => {
        // Only the request that's still current may clear the loading flag.
        // finally runs for aborted requests too, so a superseded load used to
        // set loading=false while its replacement was still in flight — with
        // items already emptied, that rendered "This library is empty" for a
        // moment before the real results arrived.
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [activeSection, selectedGenres, sort, retryNonce]);

  const handleLoadMore = useCallback(() => {
    if (!activeSection || loadingMore) return;
    const controller = new AbortController();
    loadMoreAbort.current = controller;
    setLoadingMore(true);
    fetchSectionItems(activeSection, {
      signal: controller.signal,
      start: items.length,
      size: PAGE_SIZE,
      genre: selectedGenres.length > 0 ? selectedGenres : undefined,
      sort,
    })
      .then((res) => {
        setItems((prev) => [...prev, ...res.items]);
        setTotalSize(res.totalSize);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error(err);
      })
      .finally(() => setLoadingMore(false));
  }, [activeSection, items.length, loadingMore, selectedGenres, sort]);

  // Find the active section's type ("movie" or "show") to filter search results
  const activeSectionType = sections.find((s) => s.id === activeSection)?.type;

  const handleSearch = useCallback(async (query: string) => {
    searchQueryRef.current = query;
    const reqId = ++searchReqId.current;

    // History tab: scope the search to the user's own watch history. As long as
    // there's any history, matches come only from those entries — nothing from
    // the wider library, and no "Not in your library" online results. Only when
    // the history is empty do we fall through to the global search below
    // ("if there is no history, then search everything").
    if (isHistoryTab && historyItems.length > 0) {
      const q = query.toLowerCase();
      const matches = historyItems
        .filter(
          (e) =>
            e.title.toLowerCase().includes(q) ||
            (e.showTitle?.toLowerCase().includes(q) ?? false),
        )
        .map(historyEntryToItem);
      // Not a Plex search — clear the raw buffer so the tab-switch re-filter
      // effect below leaves these results alone.
      rawSearchResults.current = null;
      setSearchResults(matches);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const { items: results } = await searchPlex(query);
      // A newer search started or the box was cleared while this was in
      // flight — this response is stale, discard it.
      if (reqId !== searchReqId.current) return;
      rawSearchResults.current = results;
      // Filter by active tab: Movies tab → only movies, TV Shows tab → only shows (no episodes/seasons)
      const filtered = activeSectionType
        ? results.filter((item) => item.type === activeSectionType)
        : results;
      setSearchResults(filtered);
    } catch (err) {
      if (reqId !== searchReqId.current) return;
      console.error("Search failed:", err);
    }
    if (reqId === searchReqId.current) setLoading(false);
  }, [activeSectionType, isHistoryTab, historyItems]);

  // Re-filter search results when switching tabs during an active search
  useEffect(() => {
    if (!rawSearchResults.current) return;
    const filtered = activeSectionType
      ? rawSearchResults.current.filter((item) => item.type === activeSectionType)
      : rawSearchResults.current;
    setSearchResults(filtered);
  }, [activeSectionType]);

  const handleClearSearch = useCallback(() => {
    // Invalidate any in-flight search so its response can't land after clear
    searchReqId.current++;
    rawSearchResults.current = null;
    setSearchResults(null);
    setLoading(false);
  }, []);

  // Back out of search entirely: drop results and clear the box, returning to
  // the browse grid (and its tabs).
  const handleBackFromSearch = useCallback(() => {
    handleClearSearch();
    setSearchResetSignal((n) => n + 1);
  }, [handleClearSearch]);

  const handleClick = useCallback(
    (item: PlexItem) => {
      onSelect(item);
    },
    [onSelect],
  );

  const searchQuery = searchQueryRef.current;
  const displayItems = searchResults ?? items;
  const hasMore = !searchResults && items.length < totalSize;
  // While searching, online (Discover) results are shown in a separate section
  // below the library matches. When browsing, everything is a library item.
  const isSearching = searchResults !== null;
  const libraryItems = isSearching ? displayItems.filter((i) => i.inLibrary !== false) : displayItems;
  const externalItems = isSearching ? displayItems.filter((i) => i.inLibrary === false) : [];
  const searchPlaceholder = isHomeTab
    ? "Search everything..."
    : isHistoryTab
      ? historyItems.length > 0
        ? "Search your history..."
        : "Search everything..."
      : activeSectionType === "movie"
        ? "Search movies..."
        : activeSectionType === "show"
          ? "Search TV shows..."
          : "Search your library...";

  return (
    <div style={styles.container}>
      {/* Back sits at the view's top-left, at the same 16/24 offset as the
          detail pages. Absolutely positioned so it never affects the centered
          search bar's position. */}
      {isSearching && (
        <button onClick={handleBackFromSearch} style={styles.backBtn}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Back
        </button>
      )}
      <div style={styles.narrowWrap}>
        <Search onSearch={handleSearch} onClear={handleClearSearch} placeholder={searchPlaceholder} clearSignal={searchResetSignal} />

        {/* Section tabs — visible during search so user can switch result type.
            These sit directly under the search bar and keep a fixed position: the
            Genre/Sort filter bar renders BELOW them (see next block) so switching
            to a Movies/TV Shows tab never shoves the tab row down. */}
        {!searchResults && (
          <div style={styles.tabs}>
            <button
              onClick={() => {
                onActiveSectionChange("home");
                if (onBrowseContext) onBrowseContext("Browsing Home");
              }}
              style={{
                ...styles.tab,
                ...(isHomeTab ? styles.tabActive : {}),
              }}
            >
              Home
            </button>
            {sections.map((s) => (
              <button
                key={s.id}
                onClick={() => {
                  onActiveSectionChange(s.id);
                  if (onBrowseContext) onBrowseContext(`Browsing ${s.title}`);
                }}
                style={{
                  ...styles.tab,
                  ...(s.id === activeSection ? styles.tabActive : {}),
                }}
              >
                {s.title}
              </button>
            ))}
            <button
              onClick={() => {
                onActiveSectionChange("history");
                if (onBrowseContext) onBrowseContext("Browsing their watch history");
              }}
              style={{
                ...styles.tab,
                ...(isHistoryTab ? styles.tabActive : {}),
              }}
            >
              History
            </button>
          </div>
        )}

        {/* Filter bar — below the tabs, and only on a real library section
            (never Home or History, and never during search). Keeping it here
            rather than above the tabs means the tab row stays put when it
            appears/disappears. */}
        {!searchResults && !isHomeTab && !isHistoryTab && genres.length > 0 && (
          <FilterBar
            genres={genres}
            selectedGenres={selectedGenres}
            onGenresChange={setSelectedGenres}
            sort={sort}
            onSortChange={setSort}
          />
        )}
      </div>

      <div style={styles.wideWrap}>

      {isHistoryTab && !searchResults ? (
        historyLoading ? (
          <SkeletonGrid />
        ) : historyError ? (
          <div style={styles.emptyState}>
            <div style={styles.emptyIcon}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" />
              </svg>
            </div>
            <p style={styles.emptyText}>{historyError}</p>
            <button onClick={() => setRetryNonce((n) => n + 1)} style={styles.retryBtn}>
              Retry
            </button>
          </div>
        ) : historyItems.length === 0 ? (
          <div style={styles.emptyState}>
            <div style={styles.emptyIcon}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
              </svg>
            </div>
            <p style={styles.emptyText}>
              Nothing watched yet. Anything you play while hosting shows up here.
            </p>
          </div>
        ) : (
          <>
            <div style={styles.historyHeader}>
              <span style={styles.historyCount}>
                {historyTotal} {historyTotal === 1 ? "title" : "titles"}
              </span>
              <button onClick={handleClearHistory} style={styles.clearBtn}>
                Clear history
              </button>
            </div>
            <div style={styles.grid}>
              {historyItems.map((entry) => (
                <div key={entry.ratingKey}>
                  <MovieCard
                    item={historyEntryToItem(entry)}
                    onClick={handleClick}
                    progress={progressOf(entry)}
                    watched={entry.watched}
                    onRemove={handleForgetFromHistory}
                    removeLabel="Remove from watch history"
                  />
                  <div style={styles.historyWhen}>{formatWhen(entry.updatedAt)}</div>
                </div>
              ))}
            </div>
          </>
        )
      ) : isHomeTab && !searchResults ? (
        homeLoading ? (
          <SkeletonGrid />
        ) : homeError ? (
          <div style={styles.emptyState}>
            <div style={styles.emptyIcon}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" />
              </svg>
            </div>
            <p style={styles.emptyText}>{homeError}</p>
            <button onClick={() => setRetryNonce((n) => n + 1)} style={styles.retryBtn}>
              Retry
            </button>
          </div>
        ) : homeHubs.length === 0 && continueItems.length === 0 ? (
          <div style={styles.emptyState}>
            <div style={styles.emptyIcon}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
              </svg>
            </div>
            <p style={styles.emptyText}>
              Nothing to show on Home yet. Make sure your Plex collections are set to
              be visible on Home in their collection settings.
            </p>
          </div>
        ) : (
          <div style={styles.hubsWrap}>
            {/* Ours, not Plex's — the server drops Plex's own Continue Watching
                hub, since this app tracks progress per Discord host instead. */}
            {continueItems.length > 0 && (
              <div style={styles.hubSection}>
                <h3 style={styles.hubLabel}>Continue Watching</h3>
                <div style={styles.hubRow} className="scroll-row">
                  {continueItems.map((entry) => (
                    <div key={entry.ratingKey} style={styles.hubCard}>
                      <MovieCard
                        item={historyEntryToItem(entry)}
                        onClick={handleClick}
                        progress={progressOf(entry)}
                        onRemove={handleDismissFromContinue}
                        removeLabel="Remove from Continue Watching"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
            {homeHubs.map((hub) => (
              <div key={hub.hubIdentifier} style={styles.hubSection}>
                <h3 style={styles.hubLabel}>{hub.title}</h3>
                <div style={styles.hubRow} className="scroll-row">
                  {hub.items.map((hubItem) => (
                    <div key={hubItem.ratingKey} style={styles.hubCard}>
                      <MovieCard item={hubItem} onClick={handleClick} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )
      ) : loading ? (
        <SkeletonGrid />
      ) : itemsError && !searchResults ? (
        <div style={styles.emptyState}>
          <div style={styles.emptyIcon}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" />
            </svg>
          </div>
          <p style={styles.emptyText}>{itemsError}</p>
          <button onClick={() => setRetryNonce((n) => n + 1)} style={styles.retryBtn}>
            Retry
          </button>
        </div>
      ) : displayItems.length === 0 ? (
        <div style={styles.emptyState}>
          <div style={styles.emptyIcon}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
            </svg>
          </div>
          <p style={styles.emptyText}>
            {searchResults !== null
              ? `No results for \u201c${searchQuery}\u201d`
              : selectedGenres.length > 0
                ? `No ${activeSectionType === "show" ? "shows" : "movies"} match these filters`
                : "This library is empty"}
          </p>
        </div>
      ) : (
        <>
          {libraryItems.length > 0 && (
            <div style={styles.grid}>
              {libraryItems.map((item) => (
                <MovieCard key={item.ratingKey} item={item} onClick={handleClick} />
              ))}
            </div>
          )}
          {externalItems.length > 0 && (
            <>
              <div style={styles.sectionHeader}>Not in your library</div>
              <div style={styles.grid}>
                {externalItems.map((item) => (
                  <MovieCard key={item.ratingKey} item={item} onClick={handleClick} />
                ))}
              </div>
            </>
          )}
          {hasMore && (
            <div style={styles.loadMoreWrap}>
              <button
                onClick={handleLoadMore}
                disabled={loadingMore}
                style={styles.loadMoreBtn}
                onMouseEnter={(e) => {
                  if (!loadingMore) e.currentTarget.style.borderColor = "rgba(229,160,13,0.4)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "rgba(255,255,255,0.1)";
                }}
              >
                {loadingMore ? "Loading..." : `Load More (${items.length} of ${totalSize})`}
              </button>
            </div>
          )}
        </>
      )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: "100%",
    position: "relative",
  },
  // Identical to MovieDetail.backBtn (same 16/24 offset, same look), but pinned
  // absolutely to the view's top-left so it lands in the exact same spot as the
  // detail-page Back and never shifts the centered search bar.
  backBtn: {
    position: "absolute",
    top: "16px",
    left: "24px",
    zIndex: 10,
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "8px 16px",
    borderRadius: "8px",
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(255,255,255,0.05)",
    color: "#f0f0f0",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: 500,
    fontFamily: "inherit",
    backdropFilter: "blur(12px)",
  },
  narrowWrap: {
    maxWidth: "1200px",
    margin: "0 auto",
  },
  wideWrap: {
    // Wider than the search/tabs column on purpose — this is what actually
    // lets 10 panels render at a real size instead of squeezing into the
    // same 1200px box the search bar uses (which just made them tiny).
    maxWidth: "2000px",
    margin: "0 auto",
  },
  tabs: {
    display: "flex",
    gap: "8px",
    padding: "0 24px 16px",
  },
  tab: {
    padding: "8px 20px",
    borderRadius: "20px",
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.04)",
    color: "#888",
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: 500,
    fontFamily: "inherit",
    transition: "all 0.2s ease",
  },
  tabActive: {
    background: "rgba(229,160,13,0.15)",
    color: "#e5a00d",
    // Full shorthand so it overrides `tab`'s `border` rather than half of it —
    // a borderColor-only override can't be undone, leaving the tab you just
    // switched away from with a solid white outline.
    border: "1px solid rgba(229,160,13,0.3)",
    fontWeight: 600,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: POSTER_GRID_COLUMNS,
    gap: "14px",
    padding: "16px 24px",
  },
  sectionHeader: {
    padding: "8px 24px 0",
    fontSize: "13px",
    fontWeight: 600,
    letterSpacing: "0.3px",
    color: "rgba(255,255,255,0.45)",
    textTransform: "uppercase" as const,
  },
  historyHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 24px 0",
  },
  historyCount: {
    fontSize: "13px",
    fontWeight: 600,
    letterSpacing: "0.3px",
    color: "rgba(255,255,255,0.45)",
    textTransform: "uppercase" as const,
  },
  clearBtn: {
    padding: "6px 14px",
    borderRadius: "8px",
    border: "1px solid rgba(255,255,255,0.12)",
    background: "transparent",
    color: "#888",
    cursor: "pointer",
    fontSize: "12px",
    fontWeight: 600,
    fontFamily: "inherit",
  },
  historyWhen: {
    padding: "6px 2px 0",
    fontSize: "11px",
    color: "#666",
    fontWeight: 500,
  },
  emptyState: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    padding: "48px 24px",
    gap: "12px",
  },
  emptyIcon: {
    color: "#555",
  },
  emptyText: {
    color: "#666",
    fontSize: "14px",
    textAlign: "center" as const,
  },
  loadMoreWrap: {
    display: "flex",
    justifyContent: "center",
    padding: "8px 24px 32px",
  },
  retryBtn: {
    padding: "8px 24px",
    borderRadius: "8px",
    border: "1px solid rgba(229,160,13,0.3)",
    background: "rgba(229,160,13,0.15)",
    color: "#e5a00d",
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: 600,
    fontFamily: "inherit",
    transition: "all 0.2s ease",
  },
  loadMoreBtn: {
    padding: "10px 28px",
    borderRadius: "8px",
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(255,255,255,0.04)",
    color: "#aaa",
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: 500,
    fontFamily: "inherit",
    transition: "all 0.2s ease",
  },
  hubsWrap: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "8px",
    padding: "8px 0 32px",
  },
  hubSection: {
    padding: "0 24px 8px",
  },
  hubLabel: {
    color: "#e0e0e0",
    fontSize: "20px",
    fontWeight: 700,
    marginBottom: "12px",
    letterSpacing: "-0.01em",
  },
  hubRow: {
    display: "flex",
    gap: "14px",
    overflowX: "auto" as const,
    paddingBottom: "8px",
  },
  hubCard: {
    flexShrink: 0,
    flexGrow: 0,
    // Shares its width formula with the poster grid (see lib/grid.ts), so a Home
    // card is never a different size from a Movies/TV Shows card.
    width: POSTER_ROW_CARD_WIDTH,
  },
};
