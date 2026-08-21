import { useState, useEffect, useCallback, useRef } from "react";
import { Search } from "./Search";
import { FilterBar } from "./FilterBar";
import { ScrollShelf } from "./ScrollShelf";
import { MovieCard } from "./MovieCard";
import { SkeletonGrid } from "./SkeletonGrid";
import { usePosterLayout } from "../lib/grid";
import { useMediaQuery, ROOM_BESIDE_SEARCH_QUERY } from "../lib/useMediaQuery";
import {
  authUrl,
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
  fetchPlexAccountStatus,
  fetchPlexWatchlist,
  setPlexWatchlistState,
  historyEntryToItem,
  type HistoryEntry,
  type PersonResult,
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

/** In-place History filter predicate. `q` must already be lowercased/trimmed.
 *  Matches the title or, for episodes, the show title. Shared by the render and
 *  the "Clear history" handler so both agree on exactly what's "visible". */
function historyMatches(entry: HistoryEntry, q: string): boolean {
  return (
    entry.title.toLowerCase().includes(q) ||
    (entry.showTitle?.toLowerCase().includes(q) ?? false)
  );
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
  /** Open a cast/crew member's page from a search result. */
  onSelectPerson?: (person: PersonResult) => void;
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

export function Library({ isHost, onSelect, onSelectPerson, activeSection, onActiveSectionChange, onBrowseContext, historyNonce = 0, visible = true }: LibraryProps) {
  // How many posters fit across, and how wide each is — three on a phone,
  // as many as the window allows anywhere else. See lib/grid.
  const poster = usePosterLayout();
  // Whether there is margin beside the centred search column for Back to sit in.
  const roomForBack = useMediaQuery(ROOM_BESIDE_SEARCH_QUERY);
  const [sections, setSections] = useState<PlexSection[]>([]);
  // "home" and "history" are virtual tab ids — one for the real Plex homepage
  // (hubs), one for this app's own watch history. Both are kept in the same
  // activeSection state so tab switching logic is shared with real sections.
  const isHomeTab = activeSection === "home";
  const isHistoryTab = activeSection === "history";
  const isWatchlistTab = activeSection === "watchlist";
  const [continueItems, setContinueItems] = useState<HistoryEntry[]>([]);
  const [historyItems, setHistoryItems] = useState<HistoryEntry[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  // In-place filter query for the History tab. Unlike a regular search (which
  // sets searchResults and swaps to the dedicated search view), this only
  // narrows the History grid — the tabs, "Clear history" and layout all stay.
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  // null while the account check is unresolved. Destructive history controls
  // stay hidden in that state so a linked account never sees Clear History
  // flash briefly before its status request finishes.
  const [plexLinked, setPlexLinked] = useState<boolean | null>(null);
  const [watchlistItems, setWatchlistItems] = useState<PlexItem[]>([]);
  const [watchlistLoading, setWatchlistLoading] = useState(false);
  const [watchlistError, setWatchlistError] = useState<string | null>(null);
  const [homeHubs, setHomeHubs] = useState<PlexHub[]>([]);
  const [homeLoading, setHomeLoading] = useState(true);
  const [items, setItems] = useState<PlexItem[]>([]);
  const [totalSize, setTotalSize] = useState(0);
  const [searchResults, setSearchResults] = useState<PlexItem[] | null>(null);
  // A search request is in flight. Separate from `loading`, which also covers
  // library page loads and — on the Home tab — never reaches the screen during
  // a search, because the hubs branch renders ahead of it.
  const [searchBusy, setSearchBusy] = useState(false);
  // Cast and crew matching the search. Only surfaced on Home (and on History
  // when there's no history to filter) — the Movies and TV Shows tabs are
  // filtered views of one library section, where a person isn't a valid result.
  const [people, setPeople] = useState<PersonResult[]>([]);
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
  // server account, not this Discord user's local/linked history.
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
    setHistoryLoadingMore(false);
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
    // `visible` matters here exactly as it does for Continue Watching above:
    // this component stays mounted behind detail and player views, so without
    // it the tab still shows pre-playback positions on the way back.
  }, [visible, isHistoryTab, retryNonce, historyNonce]);

  // Watchlist is an opt-in account surface, so the tab itself only exists for
  // a linked user. Re-check after an account sync/link and when the Library
  // returns to screen so connecting in the header is reflected immediately.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    fetchPlexAccountStatus()
      .then((status) => {
        if (cancelled) return;
        setPlexLinked(status.linked);
        if (!status.linked && isWatchlistTab) onActiveSectionChange("home");
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [visible, historyNonce, isWatchlistTab, onActiveSectionChange]);

  useEffect(() => {
    if (!visible || !isWatchlistTab || !plexLinked) return;
    setWatchlistLoading(true);
    setWatchlistError(null);
    fetchPlexWatchlist()
      .then((res) => setWatchlistItems(res.items))
      .catch((err) => {
        console.error(err);
        setWatchlistError(err instanceof Error ? err.message : "Could not load your Plex Watchlist");
      })
      .finally(() => setWatchlistLoading(false));
  }, [visible, isWatchlistTab, plexLinked, retryNonce, historyNonce]);

  /**
   * Next page of history.
   *
   * The tab fetched exactly one page and never offered another, while the
   * header above it counted the *full* total — so someone with 400 watched
   * titles read "400 titles" over a grid that silently stopped at 100.
   */
  const handleLoadMoreHistory = useCallback(() => {
    if (historyLoadingMore) return;
    setHistoryLoadingMore(true);
    fetchHistory({ limit: HISTORY_PAGE_SIZE, offset: historyItems.length })
      .then((res) => {
        // Concatenating pages can duplicate a row if something was watched
        // between requests and reordered by updated_at, so dedupe on the way in.
        setHistoryItems((prev) => {
          const seen = new Set(prev.map((e) => e.ratingKey));
          return [...prev, ...res.items.filter((e) => !seen.has(e.ratingKey))];
        });
        setHistoryTotal(res.total);
      })
      .catch(console.error)
      .finally(() => setHistoryLoadingMore(false));
  }, [historyItems.length, historyLoadingMore]);

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
    deleteHistoryEntry(item.ratingKey).catch((err) => {
      console.error(err);
      // The server keeps the local row until Plex confirms the matching delete.
      // Restore the authoritative list if that remote operation fails instead
      // of leaving an optimistic removal on screen that never really happened.
      setRetryNonce((n) => n + 1);
    });
  }, []);

  const handleClearHistory = useCallback(() => {
    const q = historyQuery.trim().toLowerCase();
    // Filter active: clear only the items currently visible under the filter,
    // leaving the rest of the history intact. Same optimistic pattern as the
    // per-card remove — a single entry delete covers Continue Watching too.
    if (q) {
      const keys = new Set(
        historyItems.filter((e) => historyMatches(e, q)).map((e) => e.ratingKey),
      );
      if (keys.size === 0) return;
      setContinueItems((prev) => prev.filter((e) => !keys.has(e.ratingKey)));
      setHistoryItems((prev) => prev.filter((e) => !keys.has(e.ratingKey)));
      setHistoryTotal((n) => Math.max(0, n - keys.size));
      Promise.all([...keys].map((key) => deleteHistoryEntry(key))).catch((err) => {
        console.error(err);
        setRetryNonce((n) => n + 1);
      });
      // Drop the filter and empty the search box, returning to the full history
      // (now minus what was just cleared).
      setHistoryQuery("");
      setSearchResetSignal((n) => n + 1);
      return;
    }
    // Only reachable for a confirmed unlinked account (see the render gate).
    setContinueItems([]);
    setHistoryItems([]);
    setHistoryTotal(0);
    clearHistory().catch((err) => {
      console.error(err);
      setRetryNonce((n) => n + 1);
    });
  }, [historyItems, historyQuery]);

  // Fetch genres when section changes
  useEffect(() => {
    if (!activeSection || isHomeTab || isHistoryTab || isWatchlistTab) return;
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
  }, [activeSection, isHomeTab, isHistoryTab, isWatchlistTab]);

  // Load items when section, genres, or sort changes
  useEffect(() => {
    if (!activeSection || isHomeTab || isHistoryTab || isWatchlistTab) return;
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
  }, [activeSection, isHomeTab, isHistoryTab, isWatchlistTab, selectedGenres, sort, retryNonce]);

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

    // History tab with history present: filter the History grid in place. No
    // separate search view — the tabs, the "Clear history" button and the
    // history layout all stay exactly as they are; only the visible cards
    // narrow down (see filteredHistoryItems below). When there's no history we
    // fall through to the global search, which behaves just like Home
    // ("if there is no history, then search everything").
    if (isHistoryTab && historyItems.length > 0) {
      setHistoryQuery(query);
      return;
    }

    setLoading(true);
    setSearchBusy(true);
    try {
      const { items: results, people: peopleResults } = await searchPlex(query);
      // A newer search started or the box was cleared while this was in
      // flight — this response is stale, discard it.
      if (reqId !== searchReqId.current) return;
      rawSearchResults.current = results;
      setPeople(peopleResults ?? []);
      // Filter by active tab: Movies tab → only movies, TV Shows tab → only shows (no episodes/seasons)
      const filtered = activeSectionType
        ? results.filter((item) => item.type === activeSectionType)
        : results;
      setSearchResults(filtered);
    } catch (err) {
      if (reqId !== searchReqId.current) return;
      console.error("Search failed:", err);
    }
    if (reqId === searchReqId.current) {
      setLoading(false);
      setSearchBusy(false);
    }
  }, [activeSectionType, isHistoryTab, historyItems.length]);

  // Re-filter search results when switching tabs during an active search
  useEffect(() => {
    if (!rawSearchResults.current) return;
    const filtered = activeSectionType
      ? rawSearchResults.current.filter((item) => item.type === activeSectionType)
      : rawSearchResults.current;
    setSearchResults(filtered);
  }, [activeSectionType]);

  // Switching tabs drops the in-place History filter and empties the search
  // box, so a query typed on History doesn't linger when you leave and return.
  // (The Search box ignores the initial signal, so mount is unaffected.)
  // Set when the tab change is us widening a search on the user's behalf, so
  // the reset below doesn't throw away the query they are mid-way through.
  const preserveQueryRef = useRef(false);
  useEffect(() => {
    setHistoryQuery("");
    if (preserveQueryRef.current) {
      preserveQueryRef.current = false;
      return;
    }
    setSearchResetSignal((n) => n + 1);
  }, [activeSection]);

  /**
   * Drop the kind filter and show everything the search found.
   *
   * No refetch: the search itself was never scoped — the request goes to the
   * whole library and to Discover, and the active tab only filters the answer
   * by kind afterwards. Moving to Home re-runs that filter with nothing to
   * filter on, which is why the results appear instantly.
   */
  const handleWidenSearch = useCallback(() => {
    preserveQueryRef.current = true;
    onActiveSectionChange("home");
    onBrowseContext?.("Browsing Home");
  }, [onActiveSectionChange, onBrowseContext]);

  const handleClearSearch = useCallback(() => {
    // Invalidate any in-flight search so its response can't land after clear
    searchReqId.current++;
    rawSearchResults.current = null;
    setSearchResults(null);
    setPeople([]);
    setLoading(false);
    // Emptying the box (via its "X" or by deleting the text) also drops the
    // in-place History filter, restoring the full history grid.
    setHistoryQuery("");
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

  const handleRemoveFromWatchlist = useCallback((item: PlexItem) => {
    setWatchlistItems((old) => old.filter((entry) => entry.ratingKey !== item.ratingKey));
    setPlexWatchlistState(item, false).catch((err) => {
      console.error(err);
      // Re-read on failure so an optimistic removal cannot lie about Plex.
      fetchPlexWatchlist().then((res) => setWatchlistItems(res.items)).catch(() => {});
    });
  }, []);

  /**
   * Open the show behind an episode card.
   *
   * Built from the fields the episode already carries rather than fetched — the
   * detail view resolves the rest by ratingKey, which is the same stub the
   * in-page breadcrumbs hand it.
   */
  const handleShowClick = useCallback(
    (item: PlexItem) => {
      if (!item.grandparentRatingKey) return;
      onSelect({
        ratingKey: item.grandparentRatingKey,
        title: item.showTitle ?? "Show",
        type: "show",
        thumb: item.showThumb ?? null,
      });
    },
    [onSelect],
  );

  const searchQuery = searchQueryRef.current;
  // History tab in-place filter (see handleSearch). Matches title or, for
  // episodes, the show title. Empty query => the full history grid.
  const historyQ = historyQuery.trim().toLowerCase();
  const filteredHistoryItems = historyQ
    ? historyItems.filter((e) => historyMatches(e, historyQ))
    : historyItems;
  const displayItems = searchResults ?? items;
  const hasMore = !searchResults && items.length < totalSize;
  // While searching, online (Discover) results are shown in a separate section
  // below the library matches. When browsing, everything is a library item.
  const isSearching = searchResults !== null;
  // People show only while searching, and only where a person is a sensible
  // result: Home, or History once it has fallen through to a global search.
  const showPeople = isSearching && !activeSectionType && people.length > 0;
  const libraryItems = isSearching ? displayItems.filter((i) => i.inLibrary !== false) : displayItems;
  const externalItems = isSearching ? displayItems.filter((i) => i.inLibrary === false) : [];

  /**
   * Split a set of results into films and television.
   *
   * A search returns both mixed together, and nothing on a poster said which
   * was which — you had to open a title to find out whether it was a film or a
   * series, which is the one thing you already know you want. Order within each
   * group is untouched, so the best match is still the first card under its
   * heading.
   *
   * Seasons and episodes count as television. Anything else — a collection,
   * say — keeps its place at the end under no heading rather than being
   * mislabelled as one or the other.
   */
  const splitByKind = (list: PlexItem[]) => ({
    movies: list.filter((i) => i.type === "movie"),
    tv: list.filter((i) => i.type === "show" || i.type === "season" || i.type === "episode"),
    other: list.filter(
      (i) => i.type !== "movie" && i.type !== "show" && i.type !== "season" && i.type !== "episode",
    ),
  });
  const libraryGroups = splitByKind(libraryItems);
  const externalGroups = splitByKind(externalItems);
  // The search ran and found nothing. The empty state below takes over the job
  // of describing the scope in that case, so the bar under the box stands down
  // — otherwise the same sentence and the same button appear twice on one
  // screen, a few centimetres apart.
  const searchFoundNothing = isSearching && !loading && displayItems.length === 0;
  // The kind the active tab narrows results to, in the words the UI uses for
  // it. Null on Home and History, where nothing is filtered out.
  const scopeLabel =
    activeSectionType === "movie" ? "movies" : activeSectionType === "show" ? "TV shows" : null;
  const searchPlaceholder = isHomeTab
    ? "Search everything..."
    : isHistoryTab
      ? historyItems.length > 0
        ? "Search your history..."
        : "Search everything..."
      : isWatchlistTab
        ? "Search everything..."
      : activeSectionType === "movie"
        ? "Search movies..."
        : activeSectionType === "show"
          ? "Search TV shows..."
          : "Search your library...";

  // Poster surfaces, resized for the screen. Every one of these has to use the
  // same card width: the grid, the Home shelves and the people row sit directly
  // above and below each other, and a row on its own scale reads as a mistake.
  const gridStyle = { ...styles.grid, gridTemplateColumns: poster.gridColumns };
  const peopleRowStyle = { ...styles.peopleRow, gridTemplateColumns: poster.gridColumns };
  const hubCardStyle = { ...styles.hubCard, width: poster.rowCardWidth };

  return (
    <div style={styles.container}>
      {/* Back sits at the view's top-left, at the same 16/24 offset as every
          other page's. Absolutely positioned, so it neither shifts the centred
          search bar nor moves itself — landing in the same place everywhere is
          the whole point of it.

          Which means it needs the margin beside the column to be there, and
          below ROOM_BESIDE_SEARCH_QUERY it isn't: the column reaches the edges
          and the box slides under the button. So the button goes, rather than
          moving somewhere else or sitting on the text. The box's own X clears
          the query, which is what actually ends a search — the button was never
          the only way out, just the widest.

          Never on a phone, at any width, for the same reason it was removed
          there before: over the field it covered the text, above the field it
          pushed the whole page down the moment you typed. */}
      {isSearching && !poster.phone && roomForBack && (
        <button onClick={handleBackFromSearch} style={styles.backBtn}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Back
        </button>
      )}
      <div style={{ ...styles.narrowWrap, ...(poster.phone ? styles.narrowWrapPhone : {}) }}>
        <Search
          onSearch={handleSearch}
          onClear={handleClearSearch}
          placeholder={searchPlaceholder}
          clearSignal={searchResetSignal}
          busy={searchBusy}
        />

        {/* What this search is actually showing.
            The request is never scoped — it always covers the whole library and
            Discover — but an active tab filters the answer down to one kind,
            and nothing said so once the placeholder had been typed over. People
            read a short result list as "it isn't there" rather than "you are
            looking at half of what was found". */}
        {isSearching && scopeLabel && !searchFoundNothing && (
          <div style={styles.scopeBar}>
            <span style={styles.scopeText}>Showing {scopeLabel} only</span>
            <button type="button" onClick={handleWidenSearch} style={styles.scopeBtn}>
              Search everything
            </button>
          </div>
        )}

        {/* Section tabs — visible during search so user can switch result type.
            These sit directly under the search bar and keep a fixed position: the
            Genre/Sort filter bar renders BELOW them (see next block) so switching
            to a Movies/TV Shows tab never shoves the tab row down. */}
        {!searchResults && (
          <div style={{ ...styles.tabs, ...(poster.phone ? styles.tabsPhone : {}) }}>
            <button
              onClick={() => {
                onActiveSectionChange("home");
                if (onBrowseContext) onBrowseContext("Browsing Home");
              }}
              style={{
                ...styles.tab,
                ...(poster.phone ? styles.tabPhone : {}),
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
                  ...(poster.phone ? styles.tabPhone : {}),
                  ...(s.id === activeSection ? styles.tabActive : {}),
                }}
              >
                {s.title}
              </button>
            ))}
            {plexLinked && (
              <button
                onClick={() => {
                  onActiveSectionChange("watchlist");
                  if (onBrowseContext) onBrowseContext("Browsing Watchlist");
                }}
                style={{
                  ...styles.tab,
                  ...(poster.phone ? styles.tabPhone : {}),
                  ...(isWatchlistTab ? styles.tabActive : {}),
                }}
              >
                Watchlist
              </button>
            )}
            <button
              onClick={() => {
                onActiveSectionChange("history");
                if (onBrowseContext) onBrowseContext("Browsing History");
              }}
              style={{
                ...styles.tab,
                ...(poster.phone ? styles.tabPhone : {}),
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
        {!searchResults && !isHomeTab && !isHistoryTab && !isWatchlistTab && genres.length > 0 && (
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

      {isWatchlistTab && !searchResults ? (
        watchlistLoading ? (
          <SkeletonGrid />
        ) : watchlistError ? (
          <div style={styles.emptyState}>
            <div style={styles.emptyIcon}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" />
              </svg>
            </div>
            <p style={styles.emptyText}>{watchlistError}</p>
            <button onClick={() => setRetryNonce((n) => n + 1)} style={styles.retryBtn}>Retry</button>
          </div>
        ) : watchlistItems.length === 0 ? (
          <div style={styles.emptyState}>
            <div style={styles.emptyIcon}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M6 3.5h12v17l-6-3.5-6 3.5v-17Z" />
              </svg>
            </div>
            <p style={styles.emptyText}>Your Plex Watchlist is empty.</p>
          </div>
        ) : (
          <>
            <div style={styles.historyHeader}>
              <span style={styles.historyCount}>
                {watchlistItems.length} {watchlistItems.length === 1 ? "title" : "titles"}
              </span>
            </div>
            <div style={gridStyle}>
              {watchlistItems.map((item) => (
                <MovieCard
                  key={`${item.inLibrary === false ? "online" : "local"}-${item.ratingKey}`}
                  item={item}
                  onClick={handleClick}
                  onRemove={handleRemoveFromWatchlist}
                  removeLabel="Remove from Plex Watchlist"
                />
              ))}
            </div>
          </>
        )
      ) : isHistoryTab && !searchResults ? (
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
              Nothing watched yet. Anything you watch in the player shows up here.
            </p>
          </div>
        ) : (
          <>
            <div style={styles.historyHeader}>
              <span style={styles.historyCount}>
                {/* Reflects the filtered set while searching, the full total
                    otherwise — the header itself never leaves. */}
                {historyQ
                  ? `${filteredHistoryItems.length} ${filteredHistoryItems.length === 1 ? "title" : "titles"}`
                  : `${historyTotal} ${historyTotal === 1 ? "title" : "titles"}`}
              </span>
              {/* Hidden while a filter matches nothing — there's nothing to
                  clear. When a filter matches, it only clears those visible
                  matches, so the label says so rather than implying a full wipe. */}
              {plexLinked === false && (!historyQ || filteredHistoryItems.length > 0) && (
                <button onClick={handleClearHistory} style={styles.clearBtn}>
                  {historyQ ? "Forget Filtered History" : "Clear History"}
                </button>
              )}
            </div>
            {filteredHistoryItems.length === 0 ? (
              <div style={styles.emptyState}>
                <div style={styles.emptyIcon}>
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
                  </svg>
                </div>
                <p style={styles.emptyText}>
                  No history matches &ldquo;{historyQuery.trim()}&rdquo;
                </p>
              </div>
            ) : (
              <div style={gridStyle}>
                {filteredHistoryItems.map((entry) => (
                  <div key={entry.ratingKey}>
                    <MovieCard
                      item={historyEntryToItem(entry)}
                      onClick={handleClick}
                      progress={progressOf(entry)}
                      watched={entry.watched}
                      onRemove={handleForgetFromHistory}
                      onSelectShow={handleShowClick}
                      removeLabel="Remove from watch history"
                    />
                    <div style={styles.historyWhen}>{formatWhen(entry.updatedAt)}</div>
                  </div>
                ))}
              </div>
            )}
            {/* Only without a filter: the filter narrows what has been loaded,
                so paging under it would be answering a different question. */}
            {!historyQ && historyItems.length < historyTotal && (
              <div style={styles.loadMoreWrap}>
                <button
                  onClick={handleLoadMoreHistory}
                  disabled={historyLoadingMore}
                  style={styles.loadMoreBtn}
                  onMouseEnter={(e) => {
                    if (!historyLoadingMore) e.currentTarget.style.borderColor = "rgba(229,160,13,0.4)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "rgba(255,255,255,0.1)";
                  }}
                >
                  {historyLoadingMore
                    ? "Loading..."
                    : `Load More (${historyItems.length} of ${historyTotal})`}
                </button>
              </div>
            )}
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
            {/* Ours, not the shared server account's — history is per verified
                Discord user and can optionally sync with that user's Plex account. */}
            {continueItems.length > 0 && (
              <div style={styles.hubSection}>
                <h3 style={styles.hubLabel}>Continue Watching</h3>
                <ScrollShelf rowStyle={styles.hubRow}>
                  {continueItems.map((entry) => (
                    <div key={entry.ratingKey} style={hubCardStyle}>
                      <MovieCard
                        item={historyEntryToItem(entry)}
                        onClick={handleClick}
                        progress={progressOf(entry)}
                        onRemove={handleDismissFromContinue}
                        onSelectShow={handleShowClick}
                        removeLabel="Remove from Continue Watching"
                      />
                    </div>
                  ))}
                </ScrollShelf>
              </div>
            )}
            {homeHubs.map((hub) => (
              <div key={hub.hubIdentifier} style={styles.hubSection}>
                <h3 style={styles.hubLabel}>{hub.title}</h3>
                <ScrollShelf rowStyle={styles.hubRow}>
                  {hub.items.map((hubItem) => (
                    <div key={hubItem.ratingKey} style={hubCardStyle}>
                      <MovieCard
                        item={hubItem}
                        onClick={handleClick}
                        onSelectShow={handleShowClick}
                      />
                    </div>
                  ))}
                </ScrollShelf>
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
              ? scopeLabel
                ? `No ${scopeLabel} match \u201c${searchQuery}\u201d`
                : `Nothing matches \u201c${searchQuery}\u201d`
              : selectedGenres.length > 0
                ? `No ${activeSectionType === "show" ? "shows" : "movies"} match these filters`
                : "This library is empty"}
          </p>
          {/* "No results" is only half the story when a tab is filtering the
              answer: there may well be results, of the other kind. Say what was
              covered, and make widening one click rather than a guess. */}
          {searchResults !== null && (
            scopeLabel ? (
              <>
                <p style={styles.emptyHint}>
                  Results on this tab are limited to {scopeLabel}.
                </p>
                <button onClick={handleWidenSearch} style={styles.retryBtn}>
                  Search everything
                </button>
              </>
            ) : (
              <p style={styles.emptyHint}>Searched your full library and online.</p>
            )
          )}
        </div>
      ) : (
        <>
          {libraryItems.length > 0 && (
            // Grouped only while searching. Browsing a section is already one
            // kind of thing, so headings there would label the obvious.
            isSearching ? (
              <>
                {([
                  ["Movies", libraryGroups.movies],
                  ["TV shows", libraryGroups.tv],
                  [null, libraryGroups.other],
                ] as Array<[string | null, PlexItem[]]>).map(([label, group]) =>
                  group.length === 0 ? null : (
                    <div key={label ?? "other"}>
                      {label && <div style={styles.sectionHeader}>{label}</div>}
                      <div style={gridStyle}>
                        {group.map((item) => (
                          <MovieCard
                            key={item.ratingKey}
                            item={item}
                            onClick={handleClick}
                            onSelectShow={handleShowClick}
                          />
                        ))}
                      </div>
                    </div>
                  ),
                )}
              </>
            ) : (
              <div style={gridStyle}>
                {libraryItems.map((item) => (
                  <MovieCard
                    key={item.ratingKey}
                    item={item}
                    onClick={handleClick}
                    onSelectShow={handleShowClick}
                  />
                ))}
              </div>
            )
          )}
          {/* Cast and crew sit between what the library has and what it
              doesn't: a person you own films by is a better answer than a film
              you'd have to request, and a worse one than a film already here. */}
          {showPeople && (
            <>
              <div style={styles.sectionHeader}>People</div>
              <div style={peopleRowStyle}>
                {people.map((p) => (
                  <button
                    key={p.name}
                    type="button"
                    style={styles.personCard}
                    onClick={() => onSelectPerson?.(p)}
                    title={p.name}
                    // Same hover language as the cast row and the poster cards:
                    // the edge lights amber. Without it these were the only
                    // clickable things in the results that gave no response.
                    onMouseEnter={(e) => {
                      const disc = e.currentTarget.firstElementChild as HTMLElement | null;
                      if (disc) disc.style.borderColor = "rgba(229,160,13,0.85)";
                    }}
                    onMouseLeave={(e) => {
                      const disc = e.currentTarget.firstElementChild as HTMLElement | null;
                      if (disc) disc.style.borderColor = "rgba(255,255,255,0.08)";
                    }}
                  >
                    {p.thumb ? (
                      <img src={authUrl(p.thumb)} alt="" style={styles.personPhoto} />
                    ) : (
                      <div style={{ ...styles.personPhoto, ...styles.personPhotoEmpty }}>
                        {p.name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("")}
                      </div>
                    )}
                    <div style={styles.personName}>{p.name}</div>
                  </button>
                ))}
              </div>
            </>
          )}
          {externalItems.length > 0 && (
            <>
              <div style={styles.sectionHeader}>Not in your library</div>
              {([
                ["Movies", externalGroups.movies],
                ["TV shows", externalGroups.tv],
                [null, externalGroups.other],
              ] as Array<[string | null, PlexItem[]]>).map(([label, group]) =>
                group.length === 0 ? null : (
                  <div key={label ?? "other"}>
                    {label && <div style={styles.subSectionHeader}>{label}</div>}
                    <div style={gridStyle}>
                      {group.map((item) => (
                        <MovieCard key={item.ratingKey} item={item} onClick={handleClick} />
                      ))}
                    </div>
                  </div>
                ),
              )}
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
  narrowWrapPhone: {
    width: "100%",
    minWidth: 0,
    maxWidth: "100%",
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
  tabsPhone: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(64px, 1fr))",
    gap: "6px",
    width: "100%",
    minWidth: 0,
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
  tabPhone: {
    width: "100%",
    minWidth: 0,
    padding: "8px 6px",
    fontSize: "12px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
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
    // gridTemplateColumns is set per-render from usePosterLayout.
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
  scopeBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "10px",
    padding: "10px 24px 0",
    flexWrap: "wrap",
  },
  scopeText: {
    fontSize: "13px",
    color: "rgba(255,255,255,0.45)",
  },
  scopeBtn: {
    background: "none",
    border: "none",
    padding: 0,
    color: "#e5a00d",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
    textDecoration: "underline",
  },
  emptyHint: {
    fontSize: "13px",
    fontWeight: 400,
    lineHeight: 1.5,
    color: "#6b6b6b",
    marginTop: "-4px",
    textAlign: "center",
    maxWidth: "420px",
  },
  // Sits under "Not in your library", so it is quieter than the heading above
  // it — two headings at the same weight read as two unrelated sections.
  subSectionHeader: {
    padding: "10px 24px 0",
    fontSize: "12px",
    fontWeight: 600,
    letterSpacing: "0.3px",
    color: "rgba(255,255,255,0.3)",
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
  // The headline of an empty state, with emptyHint below it. The two were
  // 14px/#666 and 13px/rgba(255,255,255,0.35) — one pixel and two greys apart,
  // where the translucent one composites to roughly rgb(97,97,97) against the
  // page. Near-identical size at near-identical weight doesn't read as a
  // hierarchy; it reads as two fonts. Both are opaque now, and the step between
  // them is deliberate.
  emptyText: {
    color: "#9a9a9a",
    fontSize: "15px",
    fontWeight: 500,
    lineHeight: 1.4,
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
  // The same grid the poster results use, so a person lines up in the same
  // columns as the titles above and below rather than sitting in its own row.
  peopleRow: {
    display: "grid",
    // gridTemplateColumns is set per-render from usePosterLayout.
    gap: "14px",
    padding: "16px 24px",
  },
  personCard: {
    width: "100%",
    background: "none",
    border: "none",
    padding: 0,
    color: "inherit",
    font: "inherit",
    cursor: "pointer",
    textAlign: "center" as const,
  },
  personPhoto: {
    // Square box at the column width, cropped to a circle — as large as the
    // posters beside it, which is what puts them on the same visual footing.
    width: "100%",
    aspectRatio: "1 / 1",
    borderRadius: "50%",
    objectFit: "cover" as const,
    display: "block",
    background: "#1c1c1c",
    border: "1px solid rgba(255,255,255,0.08)",
    transition: "border-color 0.18s ease",
  },
  personPhotoEmpty: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#777",
    fontSize: "34px",
    fontWeight: 600,
  },
  personName: {
    marginTop: "11px",
    fontSize: "14px",
    fontWeight: 600,
    color: "#e8e8e8",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
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
    // `width` is set per-render from usePosterLayout, which shares its formula
    // with the poster grid — so a Home card is never a different size from a
    // Movies/TV Shows card.
  },
};
