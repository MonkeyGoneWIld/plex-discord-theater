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
  fetchProgress,
  fetchSeerrPartial,
  getSessionToken,
  type PlexItem,
  type PlexSection,
  type Genre,
  type WatchProgressItem,
  type PlexHub,
} from "../lib/api";

const PAGE_SIZE = 200;

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
}

export function Library({ isHost, onSelect, activeSection, onActiveSectionChange, onBrowseContext }: LibraryProps) {
  const [sections, setSections] = useState<PlexSection[]>([]);
  // "home" is a virtual tab id representing the real Plex homepage (hubs).
  // It's kept in the same activeSection state so tab switching logic is shared.
  const isHomeTab = activeSection === "home";
  const [homeHubs, setHomeHubs] = useState<PlexHub[]>([]);
  const [homeLoading, setHomeLoading] = useState(true);
  const [items, setItems] = useState<PlexItem[]>([]);
  const [totalSize, setTotalSize] = useState(0);
  const [searchResults, setSearchResults] = useState<PlexItem[] | null>(null);
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
  const [continueWatching, setContinueWatching] = useState<WatchProgressItem[]>([]);
  const [homeError, setHomeError] = useState<string | null>(null);
  const [itemsError, setItemsError] = useState<string | null>(null);
  // Bumped by the Retry button to re-run the fetch effects after a failure
  const [retryNonce, setRetryNonce] = useState(0);

  // Plex rating keys of partially-available shows (missing seasons), for a badge.
  const [partialKeys, setPartialKeys] = useState<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    fetchSeerrPartial()
      .then((r) => { if (!cancelled) setPartialKeys(new Set(r.ratingKeys)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const isPartial = (item: PlexItem) => item.type === "show" && partialKeys.has(item.ratingKey);

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

  // Load Plex homepage hubs (Continue Watching, Recently Added, Collections, etc.)
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

  // Fetch continue watching on mount when host
  useEffect(() => {
    if (!isHost) return;
    fetchProgress()
      .then(({ items }) => setContinueWatching(items))
      .catch(() => {});
  }, [isHost]);

  // Fetch genres when section changes
  useEffect(() => {
    if (!activeSection || isHomeTab) return;
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
    if (!activeSection || isHomeTab) return;
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
  }, [activeSectionType]);

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

  const handleClick = useCallback(
    (item: PlexItem) => {
      onSelect(item);
    },
    [onSelect],
  );

  function authThumbUrl(thumb: string | null): string {
    if (!thumb) return "";
    const token = getSessionToken();
    if (!token) return thumb;
    const sep = thumb.includes("?") ? "&" : "?";
    return `${thumb}${sep}token=${encodeURIComponent(token)}`;
  }

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
    : activeSectionType === "movie"
      ? "Search movies..."
      : activeSectionType === "show"
        ? "Search TV shows..."
        : "Search your library...";

  return (
    <div style={styles.container}>
      <div style={styles.narrowWrap}>
        {isHost && continueWatching.length > 0 && (
          <div style={styles.continueSection}>
            <h3 style={styles.continueLabel}>Continue Watching</h3>
            <div style={styles.continueRow} className="scroll-row">
              {continueWatching.map((cwItem) => {
                const pct = cwItem.duration > 0 ? (cwItem.position / cwItem.duration) * 100 : 0;
                const minLeft = Math.round((cwItem.duration - cwItem.position) / 60);
                return (
                  <div
                    key={cwItem.ratingKey}
                    style={styles.continueCard}
                    onClick={() => onSelect({
                      ratingKey: cwItem.ratingKey,
                      title: cwItem.title,
                      type: cwItem.type,
                      thumb: cwItem.thumb,
                      parentTitle: cwItem.parentTitle,
                      parentIndex: cwItem.parentIndex,
                      index: cwItem.index,
                    })}
                  >
                    <div style={styles.continuePoster}>
                      {cwItem.thumb && <img src={authThumbUrl(cwItem.thumb)} alt="" style={styles.continuePosterImg} loading="lazy" />}
                    </div>
                    <div style={styles.continueInfo}>
                      <div style={styles.continueTitle}>{cwItem.title}</div>
                      <div style={styles.continueTime}>{minLeft}m left</div>
                    </div>
                    <div style={styles.continueProgress}>
                      <div style={{ ...styles.continueProgressFill, width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <Search onSearch={handleSearch} onClear={handleClearSearch} placeholder={searchPlaceholder} />

        {/* Filter bar (hidden during search and on Home) */}
        {!searchResults && !isHomeTab && genres.length > 0 && (
          <FilterBar
            genres={genres}
            selectedGenres={selectedGenres}
            onGenresChange={setSelectedGenres}
            sort={sort}
            onSortChange={setSort}
          />
        )}

        {/* Section tabs — visible during search so user can switch result type */}
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
          </div>
        )}
      </div>

      <div style={styles.wideWrap}>

      {isHomeTab && !searchResults ? (
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
        ) : homeHubs.length === 0 ? (
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
            {homeHubs.map((hub) => (
              <div key={hub.hubIdentifier} style={styles.hubSection}>
                <h3 style={styles.hubLabel}>{hub.title}</h3>
                <div style={styles.hubRow} className="scroll-row">
                  {hub.items.map((hubItem) => (
                    <div key={hubItem.ratingKey} style={styles.hubCard}>
                      <MovieCard item={hubItem} onClick={handleClick} partial={isPartial(hubItem)} />
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
                <MovieCard key={item.ratingKey} item={item} onClick={handleClick} partial={isPartial(item)} />
              ))}
            </div>
          )}
          {externalItems.length > 0 && (
            <>
              <div style={styles.sectionHeader}>Not in your library</div>
              <div style={styles.grid}>
                {externalItems.map((item) => (
                  <MovieCard key={item.ratingKey} item={item} onClick={handleClick} partial={isPartial(item)} />
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
    borderColor: "rgba(229,160,13,0.3)",
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
  continueSection: {
    padding: "0 24px 16px",
  },
  continueLabel: {
    color: "#e5a00d",
    fontSize: "14px",
    fontWeight: 600,
    marginBottom: "12px",
    letterSpacing: "-0.01em",
  },
  continueRow: {
    display: "flex",
    gap: "12px",
    overflowX: "auto" as const,
    paddingBottom: "8px",
  },
  continueCard: {
    flexShrink: 0,
    width: "140px",
    cursor: "pointer",
    borderRadius: "8px",
    overflow: "hidden",
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.06)",
    transition: "transform 0.15s ease",
  },
  continuePoster: {
    width: "100%",
    aspectRatio: "2/3",
    background: "rgba(255,255,255,0.04)",
    overflow: "hidden",
  },
  continuePosterImg: {
    width: "100%",
    height: "100%",
    objectFit: "cover" as const,
  },
  continueInfo: {
    padding: "8px",
  },
  continueTitle: {
    color: "#f0f0f0",
    fontSize: "12px",
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  continueTime: {
    color: "#888",
    fontSize: "11px",
    marginTop: "2px",
  },
  continueProgress: {
    height: "3px",
    background: "rgba(255,255,255,0.1)",
  },
  continueProgressFill: {
    height: "100%",
    background: "#e5a00d",
    borderRadius: "2px",
  },
};
