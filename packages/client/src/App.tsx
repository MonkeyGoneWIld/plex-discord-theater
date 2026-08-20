import { useState, useCallback, useEffect, useLayoutEffect, useRef, lazy, Suspense } from "react";
import { useDiscord } from "./hooks/useDiscord";
import { useSync } from "./hooks/useSync";
import { Library } from "./components/Library";
import { MovieDetail } from "./components/MovieDetail";
import { ShowDetail } from "./components/ShowDetail";
import { SeasonDetail } from "./components/SeasonDetail";
import { ExternalDetail } from "./components/ExternalDetail";
import { PersonDetail } from "./components/PersonDetail";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PeoplePanel } from "./components/PeoplePanel";
import { InviteButton } from "./components/InviteButton";
import { formatMediaTitle } from "./lib/format";
import { authUrl, fetchMeta, invalidateMeta, setStreams } from "./lib/api";
import { loadSubtitlePref, matchSubtitleTrack } from "./lib/subtitlePref";
import { useMediaQuery, MOBILE_LANDSCAPE_QUERY, NARROW_QUERY, PHONE_QUERY } from "./lib/useMediaQuery";
import type { PlexItem } from "./lib/api";
import type { QueueItem } from "./hooks/useSync";

/**
 * The player, and everything only it needs, in a separate chunk.
 *
 * hls.js and the p2p-media-loader engine (with its bittorrent-tracker and Node
 * polyfills) are the bulk of this app's JavaScript, and none of it is used
 * until someone actually starts watching. Bundled together, the activity had to
 * download and parse the whole video stack before it could paint a library —
 * which is the first thing anyone sees and the moment their impression is
 * formed. Split out, the library ships on its own and the player chunk is
 * fetched in the background straight afterwards (see the preload below), so by
 * the time anything is played it is already there.
 */
const Player = lazy(() =>
  import("./components/Player").then((m) => ({ default: m.Player })),
);

type View =
  // `flat` marks a title opened from a collection / "More Like This" row. Such a
  // title is a sibling, not a child, of the page it was opened from, so its
  // breadcrumb collapses to just Home › <title> instead of nesting under an
  // unrelated ancestor. Back still walks the stack normally.
  | { kind: "library" }
  | { kind: "show"; item: PlexItem; flat?: boolean }
  | { kind: "season"; item: PlexItem; show: PlexItem }
  | { kind: "detail"; item: PlexItem; flat?: boolean }
  | { kind: "external-detail"; item: PlexItem; flat?: boolean }
  // A cast/crew member's page, keyed by name — which is what the person endpoint
  // looks up. The photo comes from the credit clicked, so the page has a subject
  // immediately.
  | { kind: "person"; name: string; thumb?: string | null }
  // resumePosition (seconds) is set only when the host chose "Resume" on the
  // detail view; every other route into the player starts from the beginning.
  //
  // mediaIndex names the file to play for a title Plex holds more than one of.
  // Only the detail view ever sets it — every other route in (a viewer following
  // the room, a rejoin, the queue) leaves it undefined and takes the server's
  // default, which is the same file the detail view would have started on.
  //
  // `synthesized` marks an item built from sync state alone — a ratingKey and a
  // title, which is everything a client following the room has to go on. Real
  // metadata replaces it as soon as the lookup lands (see the upgrade effect).
  | {
      kind: "player";
      item: PlexItem;
      subtitles: boolean;
      resumePosition?: number;
      mediaIndex?: number;
      /** Tracks chosen on the detail page. Only the client that starts the room
       *  has them; everyone else is told which stream to play by the server. */
      audioStreamId?: number;
      subtitleStreamId?: number;
      synthesized?: boolean;
    };

// Breadcrumb label for a stack entry.
function crumbLabel(v: View): string {
  switch (v.kind) {
    case "library": return "Home";
    case "season": return v.item.index != null ? `Season ${v.item.index}` : v.item.title;
    case "person": return v.name;
    default: return v.item.title;
  }
}

// A title opened from a related row — its breadcrumb collapses to Home › title.
function isFlatView(v: View): boolean {
  // A person page always collapses to Home › <name>. They're reached from a
  // title, but they aren't part of one — drawing the film as a parent would
  // misdescribe the trail. Back still pops the real stack, so the title that
  // led here is one press away.
  if (v.kind === "person") return true;
  return (v.kind === "show" || v.kind === "detail" || v.kind === "external-detail") && v.flat === true;
}

export function App() {
  const { isReady, isHost, userId, username, instanceId, error, canInvite, openInvite, setPresence } =
    useDiscord();
  const [viewStack, setViewStack] = useState<View[]>([{ kind: "library" }]);
  const view = viewStack[viewStack.length - 1];

  const { state: syncState, actions: syncActions } = useSync({
    instanceId,
    userId,
    username,
    enabled: isReady,
  });

  const effectiveIsHost = syncState.isHost ?? isHost;

  // Toast when promoted to host.
  //
  // Only on a genuine false → true handover. `null` is the third state and it
  // means "we don't know our role yet", which is where every client starts:
  // once the join reply began carrying isHost from the roster, null → true
  // became the *normal* opening move for whoever launched the activity, and
  // they were congratulated on becoming the host of a room they had just
  // opened. Starting something is not being handed it.
  const [promotedToast, setPromotedToast] = useState(false);
  const prevSyncIsHost = useRef(syncState.isHost);
  useEffect(() => {
    const prev = prevSyncIsHost.current;
    prevSyncIsHost.current = syncState.isHost;
    if (syncState.isHost === true && prev === false) {
      setPromotedToast(true);
      const timer = setTimeout(() => setPromotedToast(false), 2000);
      return () => clearTimeout(timer);
    }
  }, [syncState.isHost]);

  // Keep Discord's member list honest about what this person is doing.
  // Sourced from room state rather than the local view, so every participant
  // shows the same title — which is what makes it read as a shared session in
  // the member list rather than one person watching something.
  useEffect(() => {
    setPresence(syncState.ratingKey ? syncState.title : null);
  }, [syncState.ratingKey, syncState.title, setPresence]);

  // Warm the player chunk in the background as soon as the app is idle. Nobody
  // opens this activity without eventually playing something, so the only
  // question is whether the download happens now, off the critical path, or at
  // the moment they press play.
  useEffect(() => {
    if (!isReady) return;
    const preload = () => void import("./components/Player");
    // requestIdleCallback isn't in older Safari, which Discord's mobile webview
    // has shipped; a short timer is close enough and always available.
    const canIdle = typeof window.requestIdleCallback === "function";
    const handle = canIdle
      ? window.requestIdleCallback(preload, { timeout: 4000 })
      : window.setTimeout(preload, 1500);
    return () => {
      if (canIdle) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };
  }, [isReady]);

  // Whether the socket has been down long enough to say so. Delayed, so an
  // ordinary reconnect (well under a second) never shows a banner at all.
  const [showReconnecting, setShowReconnecting] = useState(false);
  useEffect(() => {
    if (syncState.connected || syncState.authFailed || syncState.reconnectFailed) {
      setShowReconnecting(false);
      return;
    }
    const timer = setTimeout(() => setShowReconnecting(true), 2500);
    return () => clearTimeout(timer);
  }, [syncState.connected, syncState.authFailed, syncState.reconnectFailed]);

  // Persist active library section across navigation
  const [librarySection, setLibrarySection] = useState<string | null>(null);

  // Remounts Library from scratch (cleared search/filters/scroll). Bumped only by
  // goHome — Back keeps the always-mounted Library exactly as it was left, which
  // is what distinguishes the two.
  const [libraryEpoch, setLibraryEpoch] = useState(0);

  // Roster/roles panel, reachable from the header while browsing. The player has
  // its own copy for use during playback (the header is hidden there).
  const [showPeoplePanel, setShowPeoplePanel] = useState(false);

  // Phone held sideways, where Discord overlays its own controls on the corners
  // of the Activity. See the header below.
  const mobileLandscape = useMediaQuery(MOBILE_LANDSCAPE_QUERY);
  // A phone either way up. Discord's mobile client draws its own bar across the
  // top of the Activity with "Invite To Activity" already in it, so anything
  // this header offers on that subject is the second copy on the screen.
  const phone = useMediaQuery(PHONE_QUERY);
  // Upright, where the header has one screen-width of room to fit a trail that
  // can run Home > Show > Season > Episode. Sideways there is width to spare.
  const phonePortrait = useMediaQuery(NARROW_QUERY) && !mobileLandscape;

  // Saved window scroll per stack depth: slot i holds where view i was when
  // something was pushed on top of it. Restored when the stack shrinks back.
  const scrollPosRef = useRef<number[]>([0]);

  const pushView = useCallback((v: View) => {
    setViewStack((s) => {
      scrollPosRef.current[s.length - 1] = window.scrollY;
      return [...s, v];
    });
  }, []);

  const popView = useCallback(() => {
    setViewStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }, []);

  // Breadcrumb jump: keep the stack up to (and including) index i.
  const truncateToView = useCallback((i: number) => {
    setViewStack((s) => (i >= 0 && i < s.length - 1 ? s.slice(0, i + 1) : s));
  }, []);

  // Breadcrumb jump to a synthesized ancestor (a show/season view that was never
  // on the stack — e.g. an episode opened straight from search): replace
  // everything from stackIndex onward with the given view.
  const jumpToView = useCallback((stackIndex: number, v: View) => {
    setViewStack((s) => [...s.slice(0, stackIndex), v]);
  }, []);

  // In-content breadcrumb navigation (the clickable show/season titles on the
  // detail pages). Both rebuild the view stack exactly the way the header
  // breadcrumb does, so the trail stays a clean Home › Show › Season › Episode
  // chain regardless of how the current view was reached. If a real ancestor
  // view is already on the stack we truncate back to it (restoring its scroll);
  // otherwise we synthesize it at its proper position. The stack root (index 0)
  // is always the library, so the show sits right above it. For a single-season
  // show there is no show view (it was replaced by the season) — synthesizing
  // one and landing on it just lets ShowDetail auto-navigate back to the season,
  // which is the same place the header's show crumb leads.
  const goToShow = useCallback((show: PlexItem) => {
    setViewStack((s) => {
      const si = s.findIndex((v) => v.kind === "show" && v.item.ratingKey === show.ratingKey);
      if (si >= 0) return s.slice(0, si + 1);
      return [s[0], { kind: "show", item: show }];
    });
  }, []);

  const goToSeason = useCallback((season: PlexItem, show: PlexItem) => {
    setViewStack((s) => {
      const sj = s.findIndex((v) => v.kind === "season" && v.item.ratingKey === season.ratingKey);
      if (sj >= 0) return s.slice(0, sj + 1);
      // No season view on the stack (e.g. an episode opened from search): place
      // the synthesized season after the show if it's present, else above the
      // library root. Never leaves a standalone show view behind a season for a
      // single-season show, which would re-trigger the auto-nav loop.
      const si = s.findIndex((v) => v.kind === "show" && v.item.ratingKey === show.ratingKey);
      const base = si >= 0 ? s.slice(0, si + 1) : [s[0]];
      return [...base, { kind: "season", item: season, show }];
    });
  }, []);

  // Scroll handling on navigation: new views start at the top; going back to a
  // view that's still on the stack restores its saved position. "Going back" is
  // detected by object identity (same View at the new top), so breadcrumb jumps
  // to synthesized views correctly land at the top instead. The restore retries
  // across a few frames because detail views may still be rendering their
  // (cached) data when the effect first fires.
  const prevStackRef = useRef<View[]>(viewStack);
  useLayoutEffect(() => {
    const prev = prevStackRef.current;
    if (viewStack === prev) return;
    prevStackRef.current = viewStack;
    const top = viewStack[viewStack.length - 1];
    const returning = viewStack.length < prev.length && prev[viewStack.length - 1] === top;
    if (returning) {
      const target = scrollPosRef.current[viewStack.length - 1] ?? 0;
      let tries = 0;
      const attempt = () => {
        window.scrollTo(0, target);
        if (window.scrollY < target - 2 && tries++ < 30) requestAnimationFrame(attempt);
      };
      attempt();
    } else if (top !== prev[prev.length - 1]) {
      window.scrollTo(0, 0);
    }
  }, [viewStack]);

  const emitBrowse = useCallback((context: string) => {
    if (effectiveIsHost && syncActions) {
      syncActions.sendBrowse(context);
    }
  }, [effectiveIsHost, syncActions]);

  const goHome = useCallback(() => {
    setViewStack([{ kind: "library" }]);
    // Fresh library — unlike Back, Home resets search, filters, and scroll.
    setLibraryEpoch((n) => n + 1);
    scrollPosRef.current = [0];
    emitBrowse("Browsing the library");
  }, [emitBrowse]);

  // Bumped whenever a watch ends, so the Library reloads Continue Watching and
  // History. The Library stays mounted behind detail views, so without a nudge
  // it would still show the progress from before the film was played.
  const [historyNonce, setHistoryNonce] = useState(0);
  const prevPlayingKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevPlayingKeyRef.current;
    prevPlayingKeyRef.current = syncState.ratingKey;
    // Fires both on stop (key → null) and on switching titles mid-session,
    // which is exactly when the previous item's saved position changed.
    if (prev && prev !== syncState.ratingKey) setHistoryNonce((n) => n + 1);
  }, [syncState.ratingKey]);

  // Track previous ratingKey to detect changes
  const prevRatingKeyRef = useRef<string | null>(null);

  // Viewer: auto-navigate when host starts or stops playback
  useEffect(() => {
    const prevKey = prevRatingKeyRef.current;
    const newKey = syncState.ratingKey;
    prevRatingKeyRef.current = newKey; // always update, even for host

    if (effectiveIsHost) return;

    // Host started playing — push player onto stack
    if (newKey && newKey !== prevKey) {
      const playerView: View = {
        kind: "player",
        item: {
          ratingKey: newKey,
          title: syncState.title || "Untitled",
          type: "movie",
          thumb: null,
        },
        subtitles: syncState.subtitles,
        synthesized: true,
      };
      setViewStack((s) => {
        const covering = s[s.length - 1]?.kind !== "player";
        if (covering) scrollPosRef.current[s.length - 1] = window.scrollY;
        const base = covering ? s : s.slice(0, -1);
        return [...base, playerView];
      });
    }

    // Host stopped — pop back from player if we're on one
    if (!newKey && prevKey) {
      setViewStack((s) => {
        const top = s[s.length - 1];
        if (top?.kind === "player") return s.slice(0, -1);
        return s;
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveIsHost, syncState.ratingKey]);

  // A host with a live stream but no player open (e.g. promoted while on the
  // library) gets pulled into it, the way viewers are — otherwise they're stuck
  // as host of a stream they can't see. The viewer auto-navigate effect above
  // bails for hosts, so this handles the host case. Fires only in that state:
  // a host starting playback is already on the player, and a host who stops has
  // a null ratingKey (sendStop clears it), so neither triggers a spurious push.
  useEffect(() => {
    if (!effectiveIsHost || !syncState.ratingKey || view.kind === "player") return;
    const playerView: View = {
      kind: "player",
      item: {
        ratingKey: syncState.ratingKey,
        title: syncState.title || "Untitled",
        type: "movie",
        thumb: null,
      },
      subtitles: syncState.subtitles,
      synthesized: true,
    };
    setViewStack((s) => {
      const covering = s[s.length - 1]?.kind !== "player";
      if (covering) scrollPosRef.current[s.length - 1] = window.scrollY;
      const base = covering ? s : s.slice(0, -1);
      return [...base, playerView];
    });
  }, [effectiveIsHost, syncState.ratingKey, syncState.title, syncState.subtitles, view.kind]);

  const handleRejoin = useCallback(() => {
    if (!syncState.ratingKey) return;
    const playerView: View = {
      kind: "player",
      item: {
        ratingKey: syncState.ratingKey,
        title: syncState.title || "Untitled",
        type: "movie",
        thumb: null,
      },
      subtitles: syncState.subtitles,
      synthesized: true,
    };
    // Replace a top player rather than appending: the rejoin banner has onClick
    // on both the wrapper and its inner button, so a button click fires this
    // twice (bubbling). Appending twice would stack two player views and force
    // a double back-press. Matches handlePlayNext / the auto-navigate effect.
    setViewStack((s) => {
      const covering = s[s.length - 1]?.kind !== "player";
      if (covering) scrollPosRef.current[s.length - 1] = window.scrollY;
      const base = covering ? s : s.slice(0, -1);
      return [...base, playerView];
    });
  }, [syncState.ratingKey, syncState.title, syncState.subtitles]);

  // Show "Now Playing" banner when viewer is not on the player but host is playing
  // Also shown to a host who is out of the player while a stream is live — e.g.
  // promoted back to host after leaving — so they aren't stranded with no way in.
  const showNowPlaying = !!syncState.ratingKey && view.kind !== "player";

  /**
   * Real metadata for whatever the room is playing.
   *
   * Sync state carries a ratingKey and a display title and nothing else, which
   * is all a viewer's player used to get: a stub typed "movie" with no artwork
   * and no ancestry. That stub is what the player then reasons from, so for
   * every viewer an episode wasn't an episode — reaching the end left them on
   * the episode instead of the show, and the poster on the rejoin banner was
   * the only thing anyone had bothered to look up separately.
   *
   * One fetch answers both. It is already cached client-side and served from the
   * server's metadata cache, so this costs nothing beyond the request the banner
   * was making anyway.
   */
  const [nowPlayingMeta, setNowPlayingMeta] = useState<PlexItem | null>(null);
  const nowPlayingThumb = nowPlayingMeta
    ? (nowPlayingMeta.type === "episode"
        ? (nowPlayingMeta.showThumb ?? nowPlayingMeta.thumb)
        : nowPlayingMeta.thumb)
    : null;
  useEffect(() => {
    const rk = syncState.ratingKey;
    if (!rk) {
      setNowPlayingMeta(null);
      return;
    }
    let cancelled = false;
    fetchMeta(rk)
      .then((meta) => {
        if (cancelled) return;
        setNowPlayingMeta({
          ratingKey: rk,
          title: meta.title,
          type: meta.type,
          thumb: meta.thumb,
          showThumb: meta.showThumb,
          showTitle: meta.showTitle,
          parentTitle: meta.parentTitle,
          parentIndex: meta.parentIndex,
          index: meta.index,
          year: meta.year,
          parentRatingKey: meta.parentRatingKey,
          grandparentRatingKey: meta.grandparentRatingKey,
        });
      })
      .catch(() => { if (!cancelled) setNowPlayingMeta(null); });
    return () => { cancelled = true; };
  }, [syncState.ratingKey]);

  /**
   * Swap the synthesized item for the real one once metadata arrives.
   *
   * Nothing waits on this: the player needs only a ratingKey to start, and the
   * upgrade lands a beat later without disturbing playback — `item.ratingKey` is
   * unchanged, so no effect keyed on it re-runs and the transcode is untouched.
   */
  useEffect(() => {
    if (!nowPlayingMeta) return;
    setViewStack((s) => {
      const top = s[s.length - 1];
      if (top?.kind !== "player" || !top.synthesized) return s;
      if (top.item.ratingKey !== nowPlayingMeta.ratingKey) return s;
      return [...s.slice(0, -1), { ...top, item: nowPlayingMeta, synthesized: false }];
    });
  }, [nowPlayingMeta]);

  const handleSelect = useCallback((item: PlexItem, flat = false) => {
    // Online (Discover) results aren't in the library — open a detail view with
    // metadata and a request button instead of the playable detail/player path.
    if (item.inLibrary === false) {
      pushView({ kind: "external-detail", item, flat });
      emitBrowse(`Looking at ${item.title}`);
      return;
    }
    if (item.type === "show") {
      pushView({ kind: "show", item, flat });
      emitBrowse(`Looking at ${item.title}`);
    } else {
      pushView({ kind: "detail", item, flat });
      emitBrowse(`Looking at ${formatMediaTitle(item)}`);
    }
  }, [pushView, emitBrowse]);

  // Navigation from a collection / "More Like This" row — flags the opened title
  // as `flat` so its breadcrumb collapses to Home › <title> (see isFlatView).
  const handleSelectRelated = useCallback(
    (item: PlexItem) => handleSelect(item, true),
    [handleSelect],
  );

  // Keyed by name, which is what the person endpoint looks up and all Plex
  // gives us on a credit. An earlier version gated this on a tag id that no
  // credit ever carried, so every cast member was silently unclickable.
  const handleSelectPerson = useCallback(
    (person: { name: string; thumb?: string | null }) => {
      pushView({ kind: "person", name: person.name, thumb: person.thumb });
      emitBrowse(`Looking at ${person.name}`);
    },
    [pushView, emitBrowse],
  );

  const handlePlay = useCallback((
    item: PlexItem,
    subtitles: boolean,
    resumePosition?: number,
    mediaIndex?: number,
    audioStreamId?: number,
    subtitleStreamId?: number,
  ) => {
    pushView({
      kind: "player", item, subtitles, resumePosition, mediaIndex,
      audioStreamId, subtitleStreamId,
    });
  }, [pushView]);

  const handleShowSeason = useCallback((season: PlexItem, show: PlexItem) => {
    pushView({ kind: "season", item: season, show });
    emitBrowse(`Looking at ${show.title} \u2014 Season ${season.index ?? "?"}`);
  }, [pushView, emitBrowse]);

  // For single-season shows: replace the show view with the season view
  // so back goes straight to library instead of looping
  const handleSeasonEpisode = useCallback((episode: PlexItem) => {
    pushView({ kind: "detail", item: episode });
    emitBrowse(`Looking at ${formatMediaTitle(episode)}`);
  }, [pushView, emitBrowse]);

  // Show/season stubs are built from the episode's grandparent/parent fields so
  // the detail views can fetch the rest by ratingKey. `?? "Show"`/"Season" are
  // just placeholder labels for the rare item missing those strings.
  const handleEpisodeShowClick = useCallback((ep: PlexItem) => {
    const showKey = ep.grandparentRatingKey;
    if (!showKey) return;
    goToShow({
      ratingKey: showKey,
      title: ep.showTitle ?? "Show",
      type: "show",
      thumb: ep.showThumb ?? null,
    });
  }, [goToShow]);

  const handleEpisodeSeasonClick = useCallback((ep: PlexItem) => {
    const seasonKey = ep.parentRatingKey;
    const showKey = ep.grandparentRatingKey;
    if (!seasonKey || !showKey) return;
    const show: PlexItem = {
      ratingKey: showKey,
      title: ep.showTitle ?? "Show",
      type: "show",
      thumb: ep.showThumb ?? null,
    };
    const season: PlexItem = {
      ratingKey: seasonKey,
      title: ep.parentTitle ?? (ep.parentIndex != null ? `Season ${ep.parentIndex}` : "Season"),
      type: "season",
      thumb: null,
      ...(ep.parentIndex != null ? { index: ep.parentIndex } : {}),
    };
    goToSeason(season, show);
  }, [goToSeason]);

  const handleSeasonShowClick = useCallback((show: PlexItem) => {
    goToShow(show);
  }, [goToShow]);

  const handlePlayNext = useCallback(async (queueItem: QueueItem) => {
    // Re-apply the viewer's remembered subtitle choice to the incoming item.
    //
    // Nothing else does this on the auto-advance path: MovieDetail is where
    // tracks normally get chosen, and moving to the next episode skips it
    // entirely, so Plex would fall back to the part's own default. The stream
    // has to be selected *before* the player mounts — once the transcode has
    // started, changing it costs a restart. A failure here is non-fatal: the
    // episode still plays, just with whatever Plex defaults to.
    let subtitles = queueItem.subtitles;
    try {
      const meta = await fetchMeta(queueItem.ratingKey);
      const pref = loadSubtitlePref();
      if (pref && meta.partId != null) {
        const match = matchSubtitleTrack(meta.subtitleTracks, pref);
        await setStreams(meta.partId, { subtitleStreamID: match?.id ?? 0 });
        invalidateMeta(queueItem.ratingKey);
        subtitles = match != null;
      }
    } catch (err) {
      console.error("Failed to carry subtitle preference to next item:", err);
    }

    const playerView: View = {
      kind: "player",
      item: {
        ratingKey: queueItem.ratingKey,
        title: queueItem.title,
        type: queueItem.type,
        thumb: queueItem.thumb,
        parentTitle: queueItem.parentTitle,
        showTitle: queueItem.showTitle,
        parentIndex: queueItem.parentIndex,
        index: queueItem.index,
      },
      subtitles,
    };
    setViewStack((s) => {
      const covering = s[s.length - 1]?.kind !== "player";
      if (covering) scrollPosRef.current[s.length - 1] = window.scrollY;
      const base = covering ? s : s.slice(0, -1);
      return [...base, playerView];
    });
  }, []);

  // Breadcrumb trail. Mostly mirrors the view stack, but synthesizes missing
  // ancestors so an episode always shows the full Home › Show › Season › Episode
  // path — even when reached without walking through those views (an episode
  // straight from search, or a single-season show whose show view was replaced
  // by auto-navigation). Synthetic crumbs navigate via jumpToView with a stub
  // item; the detail views fetch everything else by ratingKey.
  const crumbs: Array<{ label: string; home?: boolean; onClick?: () => void }> = [];
  // A title opened from a related row shows a flat Home › <title> trail rather
  // than nesting under whatever page it was reached from (which is a sibling,
  // not an ancestor). Back still pops the real stack, so the previous page is a
  // click away — it just isn't drawn as a parent here.
  if (isFlatView(view)) {
    crumbs.push({ label: "Home", home: true, onClick: goHome });
    crumbs.push({ label: crumbLabel(view) });
  } else {
  viewStack.forEach((v, i) => {
    const isLast = i === viewStack.length - 1;
    const prevKind = viewStack[i - 1]?.kind;

    if (v.kind === "season" && prevKind !== "show" && v.show.ratingKey) {
      const show = v.show;
      crumbs.push({
        label: show.title,
        onClick: () => jumpToView(i, { kind: "show", item: show }),
      });
    }
    if (v.kind === "detail" && v.item.type === "episode" && prevKind !== "season") {
      const ep = v.item;
      const showStub: PlexItem | null = ep.grandparentRatingKey
        ? {
            ratingKey: ep.grandparentRatingKey,
            title: ep.showTitle ?? "Show",
            type: "show",
            thumb: ep.showThumb ?? null,
          }
        : null;
      if (showStub) {
        crumbs.push({
          label: showStub.title,
          onClick: () => jumpToView(i, { kind: "show", item: showStub }),
        });
        if (ep.parentRatingKey) {
          const seasonStub: PlexItem = {
            ratingKey: ep.parentRatingKey,
            title: ep.parentTitle ?? (ep.parentIndex != null ? `Season ${ep.parentIndex}` : "Season"),
            type: "season",
            thumb: null,
            ...(ep.parentIndex != null ? { index: ep.parentIndex } : {}),
          };
          crumbs.push({
            label: crumbLabel({ kind: "season", item: seasonStub, show: showStub }),
            onClick: () => jumpToView(i, { kind: "season", item: seasonStub, show: showStub }),
          });
        }
      }
    }

    crumbs.push({
      label: crumbLabel(v),
      home: v.kind === "library",
      onClick: isLast ? undefined : i === 0 ? goHome : () => truncateToView(i),
    });
  });
  }

  /**
   * The trail as drawn.
   *
   * On an upright phone that is the Home crumb and nothing else. A full trail
   * needs room the header doesn't have there: Home > Silo > Season 3 > Episode 7
   * against roughly 200px, with the username and roster count taking the rest of
   * the row, ellipsised every crumb down to two or three characters — so it read
   * as a row of stubs and none of them told you where you were. Home is the one
   * that still does a job at that width. Turned sideways the width is back and
   * so is the trail.
   *
   * crumbs[0] is always the library, and always clickable here: the header shows
   * the logo instead of any trail when the library is the view on screen.
   */
  const shownCrumbs = phonePortrait ? crumbs.slice(0, 1) : crumbs;

  if (error) {
    return (
      <div style={styles.center}>
        <p style={styles.error}>Failed to connect: {error}</p>
        <p style={styles.hint}>Make sure you're running this inside a Discord Activity.</p>
      </div>
    );
  }

  if (!isReady) {
    return (
      <div style={styles.center}>
        <div style={styles.spinner} />
        <p style={styles.loading}>Connecting to Discord...</p>
      </div>
    );
  }

  return (
    <div style={styles.app}>
      {/* Header — visible on all non-player views */}
      {view.kind !== "player" && (
        <header style={styles.header}>
          {view.kind !== "library" ? (
            /* Breadcrumb trail — every ancestor is clickable. Home is a full
               reset (goHome); other crumbs jump back within the stack, keeping
               the library and any saved scroll positions intact. */
            <nav style={styles.breadcrumbs}>
              {shownCrumbs.map((c, i) => (
                <span key={i} style={styles.crumbWrap}>
                  {i > 0 && <span style={styles.crumbSep}>&rsaquo;</span>}
                  {c.onClick ? (
                    <button
                      onClick={c.onClick}
                      style={{ ...styles.crumb, ...styles.crumbLink }}
                      title={c.label}
                    >
                      {c.home && (
                        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" style={{ flexShrink: 0 }}>
                          <path d="M3 10L10 3L17 10M5 8.5V16A1 1 0 006 17H9V12H11V17H14A1 1 0 0015 16V8.5"
                            stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      )}
                      <span style={styles.crumbText}>{c.label}</span>
                    </button>
                  ) : (
                    <span style={{ ...styles.crumb, ...styles.crumbCurrent }} title={c.label}>
                      <span style={styles.crumbText}>{c.label}</span>
                    </span>
                  )}
                </span>
              ))}
            </nav>
          ) : (
            <h1 style={styles.logo}>Watch Together</h1>
          )}
          {/* On a phone in landscape Discord's own Leave pill overlaps the top
              right of the Activity, sitting right on top of this button. Moving
              it to the left of the name puts it back in reach \u2014 the label is
              what gets clipped there instead, which costs nothing. */}
          <span style={styles.user}>
            {/* Sits with the roster rather than inside it: inviting is about
                who isn't here yet, which is the same question the people
                button answers from the other side. Not on a phone, where
                Discord's own bar is already showing an invite button a
                centimetre above this one. */}
            {canInvite && !phone && <InviteButton onInvite={openInvite} />}
            <span style={styles.userName}>
              {username} {effectiveIsHost ? "(Host)" : "(Viewer)"}
              {!effectiveIsHost && syncState.connected && " • Synced"}
            </span>
            {syncState.connected && (
              <button
                onClick={() => setShowPeoplePanel(true)}
                // Visual order only — the DOM order stays name-then-button, so
                // reading order and focus order are unchanged either way.
                style={{ ...styles.peopleBtn, ...(mobileLandscape ? styles.peopleBtnLandscape : {}) }}
                title={effectiveIsHost ? "People & roles" : "Who's here"}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                  <circle cx="6" cy="5" r="2.4" stroke="currentColor" strokeWidth="1.5"/>
                  <path d="M1.5 13.5c0-2.2 2-3.6 4.5-3.6s4.5 1.4 4.5 3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  <path d="M11 4.2a2.2 2.2 0 0 1 0 4.2M12.5 13.5c0-1.7-.7-2.9-2-3.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
                {effectiveIsHost
                  ? syncState.participants.length || ""
                  : `Host: ${syncState.hostUsername ?? "\u2014"}`}
              </button>
            )}
          </span>
        </header>
      )}

      {/* Host promotion toast */}
      {promotedToast && (
        <div style={styles.promotedToast}>You are now the host</div>
      )}

      {/* Sync is down while browsing.
          The player has always said so; out here there was nothing at all, so a
          dropped socket looked exactly like a quiet room — you could browse,
          pick something, and only then discover nobody had seen any of it. */}
      {view.kind !== "player" &&
        (syncState.authFailed || syncState.reconnectFailed || showReconnecting) && (
        <div style={styles.connectionBanner} role="status">
          <span>
            {syncState.authFailed
              ? "Session expired — close and reopen the activity to continue"
              : syncState.reconnectFailed
                ? "Disconnected from the watch party"
                // Between the drop and the twentieth failed retry there was
                // nothing at all, which is over a minute of browsing, queueing
                // and suggesting into a void that looked exactly like a quiet
                // room.
                : "Reconnecting to the watch party…"}
          </span>
          {syncState.reconnectFailed && (
            <button style={styles.connectionRetryBtn} onClick={() => syncActions.retryConnection()}>
              Reconnect
            </button>
          )}
        </div>
      )}

      {/* People & roles — role controls inside are host-gated */}
      {showPeoplePanel && (
        <PeoplePanel
          participants={syncState.participants}
          selfUserId={userId}
          isHost={effectiveIsHost}
          onPromoteHost={(uid) => {
            syncActions.sendPromoteHost(uid);
            setShowPeoplePanel(false);
          }}
          onSetCoHost={(uid, value) => syncActions.sendSetCoHost(uid, value)}
          onClose={() => setShowPeoplePanel(false)}
        />
      )}

      {/* Viewer suggestions — host only */}
      {effectiveIsHost && syncState.suggestions.length > 0 && (
        <div style={styles.suggestionsPanel}>
          {syncState.suggestions.map((s) => (
            <div key={s.ratingKey} style={styles.suggestionRow}>
              <span style={styles.suggestionText}>
                {s.fromUsername ? <strong>{s.fromUsername}</strong> : "Someone"} suggested{" "}
                {/* formatMediaTitle already appends the year for films, so no
                    separate year suffix here. */}
                <strong>{formatMediaTitle(s)}</strong>
              </span>
              <div style={styles.suggestionActions}>
                <button
                  onClick={() => {
                    // Carry the episode fields through, or the detail view and
                    // the browse label lose the show name all over again.
                    handleSelect({
                      ratingKey: s.ratingKey,
                      title: s.title,
                      type: s.type,
                      thumb: s.thumb,
                      year: s.year,
                      showTitle: s.showTitle,
                      parentTitle: s.parentTitle,
                      parentIndex: s.parentIndex,
                      index: s.index,
                    });
                    syncActions.sendDismissSuggestion(s.ratingKey);
                  }}
                  style={styles.suggestionViewBtn}
                >
                  View
                </button>
                <button
                  onClick={() => syncActions.sendDismissSuggestion(s.ratingKey)}
                  style={styles.suggestionDismissBtn}
                >
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Now Playing rejoin banner for viewers */}
      {showNowPlaying && (
        <div style={styles.nowPlayingBanner} onClick={handleRejoin}>
          {nowPlayingThumb ? (
            <img
              src={authUrl(nowPlayingThumb)}
              alt=""
              style={{ ...styles.nowPlayingPoster, objectFit: "cover" }}
            />
          ) : (
            <div style={styles.nowPlayingPoster} />
          )}
          <div style={styles.nowPlayingInfo}>
            <div style={styles.nowPlayingLabel}>NOW PLAYING</div>
            <div style={styles.nowPlayingTitle}>{syncState.title || "Untitled"}</div>
          </div>
          <button onClick={handleRejoin} style={styles.nowPlayingBtn}>
            Watch
          </button>
        </div>
      )}

      {/* Library stays mounted (hidden) while browsing details, so Back returns
          to the exact search results, filters, loaded pages, and scroll. Home
          bumps libraryEpoch to remount it fresh instead. */}
      <div style={{ display: view.kind === "library" ? undefined : "none" }}>
        {view.kind === "library" && !effectiveIsHost && !syncState.ratingKey && (
          <div style={styles.waitingBanner}>
            <div style={styles.waitingDot} />
            <div>
              <div style={styles.waitingPrimary}>
                {syncState.browseContext
                  ? `Host is ${syncState.browseContext.charAt(0).toLowerCase()}${syncState.browseContext.slice(1)}`
                  : "Host is browsing the library..."}
              </div>
              <div style={styles.waitingSecondary}>You can browse too — playback starts when the host picks something</div>
            </div>
          </div>
        )}
        <Library
          key={libraryEpoch}
          isHost={effectiveIsHost}
          onSelect={handleSelect}
          activeSection={librarySection}
          onSelectPerson={handleSelectPerson}
          onActiveSectionChange={setLibrarySection}
          onBrowseContext={effectiveIsHost ? (ctx) => syncActions.sendBrowse(ctx) : undefined}
          historyNonce={historyNonce}
          visible={view.kind === "library"}
        />
      </div>

      {view.kind === "show" && (
        <ShowDetail
          // Remount per title: the reveal gate's state has to start clean, and
          // clearing it in an effect raced the image refs (which fire during
          // commit) — the effect wiped a poster that had already reported in.
          key={view.item.ratingKey}
          item={view.item}
          onSelectSeason={handleShowSeason}
          // Resume jumps straight to the episode; the breadcrumb synthesizes the
          // show and season it skipped past, so Back still walks up properly.
          onSelectEpisode={handleSeasonEpisode}
          onSelect={handleSelectRelated}
          onSelectPerson={handleSelectPerson}
          onBack={popView}
        />
      )}

      {view.kind === "season" && (
        <SeasonDetail
          season={view.item}
          show={view.show}
          onSelectEpisode={handleSeasonEpisode}
          onShowClick={() => handleSeasonShowClick(view.show)}
          onBack={popView}
          isHost={effectiveIsHost}
          isPlaying={!!syncState.ratingKey}
          onAddToQueue={effectiveIsHost ? (qi) => syncActions.sendQueueAdd(qi) : undefined}
        />
      )}

      {view.kind === "detail" && (
        <MovieDetail
          key={view.item.ratingKey}
          item={view.item}
          isHost={effectiveIsHost}
          onPlay={handlePlay}
          onBack={popView}
          onShowClick={() => handleEpisodeShowClick(view.item)}
          onSeasonClick={() => handleEpisodeSeasonClick(view.item)}
          isPlaying={!!syncState.ratingKey}
          onAddToQueue={effectiveIsHost ? (qi) => syncActions.sendQueueAdd(qi) : undefined}
          onSuggest={!effectiveIsHost ? (item) => syncActions.sendSuggest(item) : undefined}
          onSelect={handleSelectRelated}
          onSelectPerson={handleSelectPerson}
        />
      )}

      {view.kind === "external-detail" && (
        <ExternalDetail
          key={view.item.ratingKey}
          item={view.item}
          onBack={popView}
          onSelectPerson={handleSelectPerson}
        />
      )}

      {view.kind === "person" && (
        <PersonDetail
          name={view.name}
          thumb={view.thumb}
          onSelect={handleSelectRelated}
          onBack={popView}
        />
      )}

      {view.kind === "player" && (
        <ErrorBoundary
          fallback={
            <div style={{
              display: "flex", flexDirection: "column", alignItems: "center",
              justifyContent: "center", minHeight: "100vh", gap: "16px",
              background: "#000", color: "#f0f0f0", fontFamily: "DM Sans, sans-serif",
            }}>
              <p style={{ fontSize: "16px", color: "#e74c3c" }}>Playback error</p>
              <button
                onClick={popView}
                style={{
                  padding: "10px 24px", borderRadius: "8px", border: "none",
                  background: "#e5a00d", color: "#000", fontSize: "14px",
                  fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                }}
              >
                Go Back
              </button>
            </div>
          }
          onReset={popView}
        >
          {/* Black with the same spinner playback itself uses, so a cold chunk
              load is indistinguishable from the buffering that follows it —
              and after the idle preload above, it is almost never seen. */}
          <Suspense fallback={<div style={styles.playerLoading}><div style={styles.playerSpinner} /></div>}>
          <Player
            item={view.item}
            isHost={effectiveIsHost}
            selfUserId={userId}
            subtitles={view.subtitles}
            resumePosition={view.resumePosition}
            mediaIndex={view.mediaIndex}
            audioStreamId={view.audioStreamId}
            subtitleStreamId={view.subtitleStreamId}
            onBack={popView}
            // Finishing an episode lands on the show, not on the episode that
            // just ended. Same rebuild the in-page show breadcrumb uses, so the
            // trail reads Home › Show rather than keeping the player's ancestry.
            onFinished={handleEpisodeShowClick}
            onInvite={canInvite ? openInvite : undefined}
            syncState={syncState}
            syncActions={syncActions}
            onPlayNext={handlePlayNext}
          />
          </Suspense>
        </ErrorBoundary>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  app: {
    minHeight: "100vh",
    background: "radial-gradient(ellipse at 50% 0%, #1a1a1a 0%, #0d0d0d 70%)",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    // Base spacing plus whatever Discord reports it is covering, so the header
    // clears its overlaid chrome in either orientation with no breakpoint of our
    // own. The safe-area variables are defined in index.html.
    paddingTop: "calc(16px + var(--sait, 0px))",
    paddingRight: "calc(24px + var(--sair, 0px))",
    paddingBottom: "16px",
    paddingLeft: "calc(24px + var(--sail, 0px))",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
  },
  logo: {
    // Match the breadcrumb row's height (its crumb buttons carry 6px vertical
    // padding) so the header is the same height on the library and detail views
    // and their Back buttons line up.
    display: "flex",
    alignItems: "center",
    minHeight: "32px",
    fontSize: "20px",
    fontWeight: 700,
    color: "#e5a00d",
    letterSpacing: "-0.02em",
  },
  breadcrumbs: {
    display: "flex",
    alignItems: "center",
    // Same fixed row height as the library logo so both headers match — see the
    // note on `logo`.
    minHeight: "32px",
    gap: "2px",
    minWidth: 0,
    flex: 1,
    marginRight: "16px",
    overflow: "hidden",
  },
  crumbWrap: {
    display: "flex",
    alignItems: "center",
    gap: "2px",
    minWidth: 0,
  },
  crumbSep: {
    color: "#555",
    fontSize: "16px",
    padding: "0 4px",
    flexShrink: 0,
  },
  crumb: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    fontSize: "14px",
    fontWeight: 600,
    maxWidth: "220px",
    minWidth: 0,
    fontFamily: "inherit",
  },
  crumbText: {
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
  crumbLink: {
    padding: "6px 10px",
    borderRadius: "8px",
    border: "none",
    background: "none",
    color: "#e5a00d",
    cursor: "pointer",
  },
  crumbCurrent: {
    padding: "6px 4px",
    color: "#e0e0e0",
    cursor: "default",
  },
  user: {
    fontSize: "13px",
    color: "#888",
    fontWeight: 500,
    // Flex so the people button can be reordered in landscape without moving it
    // in the DOM. `gap` replaces the margin the button used to carry.
    display: "inline-flex",
    alignItems: "center",
    gap: "10px",
    minWidth: 0,
  },
  userName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
  peopleBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: "5px",
    padding: "3px 9px",
    borderRadius: "999px",
    border: "1px solid rgba(229,160,13,0.35)",
    background: "rgba(229,160,13,0.08)",
    color: "#e5a00d",
    fontSize: "12px",
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
    verticalAlign: "middle",
    flexShrink: 0,
  },
  peopleBtnLandscape: {
    // Ahead of the name, putting it clear of Discord's Leave pill in the corner.
    order: -1,
  },
  center: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100vh",
    padding: "24px",
    textAlign: "center",
    gap: "16px",
  },
  loading: {
    fontSize: "16px",
    color: "#888",
    fontWeight: 500,
  },
  spinner: {
    width: "32px",
    height: "32px",
    border: "3px solid rgba(255,255,255,0.1)",
    borderTopColor: "#e5a00d",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  },
  error: {
    fontSize: "16px",
    color: "#e74c3c",
  },
  hint: {
    fontSize: "14px",
    color: "#888",
  },
  suggestionsPanel: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "8px",
    margin: "16px 24px 0",
  },
  suggestionRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    padding: "12px 16px",
    background: "linear-gradient(135deg, rgba(229,160,13,0.08), rgba(229,160,13,0.15))",
    border: "1px solid rgba(229,160,13,0.25)",
    borderRadius: "10px",
  },
  suggestionText: {
    color: "#e0e0e0",
    fontSize: "13px",
  },
  suggestionActions: {
    display: "flex",
    gap: "8px",
    flexShrink: 0,
  },
  suggestionViewBtn: {
    padding: "6px 14px",
    borderRadius: "8px",
    border: "none",
    background: "#e5a00d",
    color: "#000",
    fontSize: "12px",
    fontWeight: 700,
    fontFamily: "inherit",
    cursor: "pointer",
  },
  suggestionDismissBtn: {
    padding: "6px 14px",
    borderRadius: "8px",
    border: "1px solid rgba(255,255,255,0.15)",
    background: "transparent",
    color: "#888",
    fontSize: "12px",
    fontFamily: "inherit",
    cursor: "pointer",
  },
  waitingBanner: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    margin: "0 24px 16px",
    padding: "14px 18px",
    background: "linear-gradient(135deg, rgba(229,160,13,0.06), rgba(229,160,13,0.12))",
    border: "1px solid rgba(229,160,13,0.2)",
    borderRadius: "10px",
  },
  waitingDot: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    background: "#e5a00d",
    animation: "pulse 2s ease-in-out infinite",
    flexShrink: 0,
  },
  waitingPrimary: {
    color: "#e5a00d",
    fontSize: "13px",
    fontWeight: 500,
  },
  waitingSecondary: {
    color: "rgba(229,160,13,0.6)",
    fontSize: "11px",
    marginTop: "2px",
  },
  promotedToast: {
    position: "fixed",
    top: "16px",
    left: "50%",
    transform: "translateX(-50%)",
    padding: "10px 24px",
    borderRadius: "8px",
    background: "rgba(46, 160, 67, 0.9)",
    color: "#fff",
    fontSize: "14px",
    fontWeight: 600,
    zIndex: 1000,
    pointerEvents: "none",
  },
  playerLoading: {
    position: "fixed",
    inset: 0,
    background: "#000",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 50,
  },
  playerSpinner: {
    width: "48px",
    height: "48px",
    border: "3px solid rgba(229,160,13,0.3)",
    borderTopColor: "#e5a00d",
    borderRadius: "50%",
    animation: "spin 1s linear infinite",
  },
  connectionBanner: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "12px",
    // Amber rather than red: nothing is broken, and browsing still works — the
    // room just can't see you yet.
    background: "rgba(230, 126, 34, 0.16)",
    borderBottom: "1px solid rgba(230,126,34,0.35)",
    color: "#e8a765",
    padding: "9px 16px",
    fontSize: "13px",
    fontWeight: 600,
  },
  connectionRetryBtn: {
    padding: "3px 12px",
    borderRadius: "999px",
    border: "1px solid rgba(230,126,34,0.55)",
    background: "transparent",
    color: "#e8a765",
    fontSize: "12px",
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  nowPlayingBanner: {
    display: "flex",
    alignItems: "center",
    gap: "16px",
    margin: "0 24px 16px",
    padding: "16px",
    background: "linear-gradient(135deg, rgba(229,160,13,0.08), rgba(229,160,13,0.15))",
    border: "1px solid rgba(229,160,13,0.25)",
    borderRadius: "12px",
    cursor: "pointer",
  },
  nowPlayingPoster: {
    width: "48px",
    height: "72px",
    borderRadius: "6px",
    background: "linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.04))",
    flexShrink: 0,
  },
  nowPlayingInfo: {
    flex: 1,
    minWidth: 0,
  },
  nowPlayingLabel: {
    color: "rgba(229,160,13,0.7)",
    fontSize: "10px",
    textTransform: "uppercase",
    letterSpacing: "1px",
    fontWeight: 600,
    marginBottom: "3px",
  },
  nowPlayingTitle: {
    color: "#f0f0f0",
    fontSize: "15px",
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  nowPlayingBtn: {
    padding: "8px 20px",
    borderRadius: "8px",
    border: "none",
    background: "#e5a00d",
    color: "#000",
    fontSize: "13px",
    fontWeight: 700,
    fontFamily: "inherit",
    cursor: "pointer",
    flexShrink: 0,
  },
};
