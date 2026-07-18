import { useState, useCallback, useEffect, useRef } from "react";
import { useDiscord } from "./hooks/useDiscord";
import { useSync } from "./hooks/useSync";
import { Library } from "./components/Library";
import { MovieDetail } from "./components/MovieDetail";
import { ShowDetail } from "./components/ShowDetail";
import { SeasonDetail } from "./components/SeasonDetail";
import { Player } from "./components/Player";
import { ErrorBoundary } from "./components/ErrorBoundary";
import type { PlexItem } from "./lib/api";
import type { QueueItem } from "./hooks/useSync";

type View =
  | { kind: "library" }
  | { kind: "show"; item: PlexItem }
  | { kind: "season"; item: PlexItem; show: PlexItem }
  | { kind: "detail"; item: PlexItem }
  | { kind: "player"; item: PlexItem; subtitles: boolean };

export function App() {
  const { isReady, isHost, userId, username, instanceId, error } = useDiscord();
  const [viewStack, setViewStack] = useState<View[]>([{ kind: "library" }]);
  const view = viewStack[viewStack.length - 1];

  const { state: syncState, actions: syncActions } = useSync({
    instanceId,
    userId,
    username,
    enabled: isReady,
  });

  const effectiveIsHost = syncState.isHost ?? isHost;

  // Toast when promoted to host
  const [promotedToast, setPromotedToast] = useState(false);
  const prevSyncIsHost = useRef(syncState.isHost);
  useEffect(() => {
    const prev = prevSyncIsHost.current;
    prevSyncIsHost.current = syncState.isHost;
    if (syncState.isHost === true && prev !== true) {
      setPromotedToast(true);
      const timer = setTimeout(() => setPromotedToast(false), 2000);
      return () => clearTimeout(timer);
    }
  }, [syncState.isHost]);

  // Persist active library section across navigation
  const [librarySection, setLibrarySection] = useState<string | null>(null);

  const pushView = useCallback((v: View) => {
    setViewStack((s) => [...s, v]);
  }, []);

  const replaceView = useCallback((v: View) => {
    setViewStack((s) => (s.length > 1 ? [...s.slice(0, -1), v] : [v]));
  }, []);

  const popView = useCallback(() => {
    setViewStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }, []);

  const emitBrowse = useCallback((context: string) => {
    if (effectiveIsHost && syncActions) {
      syncActions.sendBrowse(context);
    }
  }, [effectiveIsHost, syncActions]);

  const goHome = useCallback(() => {
    setViewStack([{ kind: "library" }]);
    emitBrowse("Browsing the library");
  }, [emitBrowse]);

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
      };
      setViewStack((s) => {
        const base = s[s.length - 1]?.kind === "player" ? s.slice(0, -1) : s;
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

  const handleRejoin = useCallback(() => {
    if (!syncState.ratingKey) return;
    pushView({
      kind: "player",
      item: {
        ratingKey: syncState.ratingKey,
        title: syncState.title || "Untitled",
        type: "movie",
        thumb: null,
      },
      subtitles: syncState.subtitles,
    });
  }, [syncState.ratingKey, syncState.title, syncState.subtitles, pushView]);

  // Show "Now Playing" banner when viewer is not on the player but host is playing
  const showNowPlaying = !effectiveIsHost && !!syncState.ratingKey && view.kind !== "player";

  const handleSelect = useCallback((item: PlexItem) => {
    if (item.type === "show") {
      pushView({ kind: "show", item });
      emitBrowse(`Looking at ${item.title}`);
    } else {
      pushView({ kind: "detail", item });
      const label = item.parentTitle
        ? `Looking at ${item.parentTitle} \u2014 S${item.parentIndex ?? "?"}E${item.index ?? "?"} \u00b7 ${item.title}`
        : item.year
          ? `Looking at ${item.title} (${item.year})`
          : `Looking at ${item.title}`;
      emitBrowse(label);
    }
  }, [pushView, emitBrowse]);

  const handlePlay = useCallback((item: PlexItem, subtitles: boolean) => {
    pushView({ kind: "player", item, subtitles });
  }, [pushView]);

  const handleShowSeason = useCallback((season: PlexItem, show: PlexItem) => {
    pushView({ kind: "season", item: season, show });
    emitBrowse(`Looking at ${show.title} \u2014 Season ${season.index ?? "?"}`);
  }, [pushView, emitBrowse]);

  // For single-season shows: replace the show view with the season view
  // so back goes straight to library instead of looping
  const handleReplaceShowWithSeason = useCallback((season: PlexItem, show: PlexItem) => {
    replaceView({ kind: "season", item: season, show });
    emitBrowse(`Looking at ${show.title} \u2014 Season ${season.index ?? "?"}`);
  }, [replaceView, emitBrowse]);

  const handleSeasonEpisode = useCallback((episode: PlexItem) => {
    pushView({ kind: "detail", item: episode });
    const label = episode.parentTitle
      ? `Looking at ${episode.parentTitle} \u2014 S${episode.parentIndex ?? "?"}E${episode.index ?? "?"} \u00b7 ${episode.title}`
      : `Looking at ${episode.title}`;
    emitBrowse(label);
  }, [pushView, emitBrowse]);

  const handlePlayNext = useCallback((queueItem: QueueItem) => {
    const playerView: View = {
      kind: "player",
      item: {
        ratingKey: queueItem.ratingKey,
        title: queueItem.title,
        type: queueItem.type,
        thumb: queueItem.thumb,
        parentTitle: queueItem.parentTitle,
        parentIndex: queueItem.parentIndex,
        index: queueItem.index,
      },
      subtitles: queueItem.subtitles,
    };
    setViewStack((s) => {
      const base = s[s.length - 1]?.kind === "player" ? s.slice(0, -1) : s;
      return [...base, playerView];
    });
  }, []);

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
            <button onClick={goHome} style={styles.homeBtn}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                <path d="M3 10L10 3L17 10M5 8.5V16A1 1 0 006 17H9V12H11V17H14A1 1 0 0015 16V8.5"
                  stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Home
            </button>
          ) : (
            <h1 style={styles.logo}>Watch Together</h1>
          )}
          <span style={styles.user}>
            {username} {effectiveIsHost ? "(Host)" : "(Viewer)"}
            {!effectiveIsHost && syncState.connected && " \u2022 Synced"}
            {!effectiveIsHost && syncState.hostUsername && (
              <span style={styles.hostLabel}> &middot; Host: {syncState.hostUsername}</span>
            )}
          </span>
        </header>
      )}

      {/* Host promotion toast */}
      {promotedToast && (
        <div style={styles.promotedToast}>You are now the host</div>
      )}

      {/* Viewer suggestions — host only */}
      {effectiveIsHost && syncState.suggestions.length > 0 && (
        <div style={styles.suggestionsPanel}>
          {syncState.suggestions.map((s) => (
            <div key={s.ratingKey} style={styles.suggestionRow}>
              <span style={styles.suggestionText}>
                {s.fromUsername ? <strong>{s.fromUsername}</strong> : "Someone"} suggested{" "}
                <strong>{s.title}</strong>{s.year ? ` (${s.year})` : ""}
              </span>
              <div style={styles.suggestionActions}>
                <button
                  onClick={() => {
                    handleSelect({ ratingKey: s.ratingKey, title: s.title, type: s.type, thumb: s.thumb, year: s.year });
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
          <div style={styles.nowPlayingPoster} />
          <div style={styles.nowPlayingInfo}>
            <div style={styles.nowPlayingLabel}>NOW PLAYING</div>
            <div style={styles.nowPlayingTitle}>{syncState.title || "Untitled"}</div>
          </div>
          <button onClick={handleRejoin} style={styles.nowPlayingBtn}>
            Watch
          </button>
        </div>
      )}

      {view.kind === "library" && (
        <>
          {!effectiveIsHost && !syncState.ratingKey && (
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
            isHost={effectiveIsHost}
            onSelect={handleSelect}
            activeSection={librarySection}
            onActiveSectionChange={setLibrarySection}
            onBrowseContext={effectiveIsHost ? (ctx) => syncActions.sendBrowse(ctx) : undefined}
          />
        </>
      )}

      {view.kind === "show" && (
        <ShowDetail
          item={view.item}
          onSelectSeason={handleShowSeason}
          onReplaceWithSeason={handleReplaceShowWithSeason}
          onBack={popView}
        />
      )}

      {view.kind === "season" && (
        <SeasonDetail
          season={view.item}
          show={view.show}
          onSelectEpisode={handleSeasonEpisode}
          onBack={popView}
          isHost={effectiveIsHost}
          isPlaying={!!syncState.ratingKey}
          onAddToQueue={effectiveIsHost ? (qi) => syncActions.sendQueueAdd(qi) : undefined}
        />
      )}

      {view.kind === "detail" && (
        <MovieDetail
          item={view.item}
          isHost={effectiveIsHost}
          onPlay={handlePlay}
          onBack={popView}
          isPlaying={!!syncState.ratingKey}
          onAddToQueue={effectiveIsHost ? (qi) => syncActions.sendQueueAdd(qi) : undefined}
          onSuggest={!effectiveIsHost ? (item) => syncActions.sendSuggest(item) : undefined}
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
          <Player
            item={view.item}
            isHost={effectiveIsHost}
            subtitles={view.subtitles}
            onBack={popView}
            syncState={syncState}
            syncActions={syncActions}
            onPlayNext={handlePlayNext}
          />
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
    padding: "16px 24px",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
  },
  logo: {
    fontSize: "20px",
    fontWeight: 700,
    color: "#e5a00d",
    letterSpacing: "-0.02em",
  },
  homeBtn: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "6px 14px",
    borderRadius: "8px",
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(255,255,255,0.05)",
    color: "#e5a00d",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: 600,
    fontFamily: "inherit",
  },
  user: {
    fontSize: "13px",
    color: "#888",
    fontWeight: 500,
  },
  hostLabel: {
    color: "#e5a00d",
    fontWeight: 600,
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
