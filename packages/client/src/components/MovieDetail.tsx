import { useState, useEffect, useCallback, useRef } from "react";
import { fetchMeta, fetchProgress, invalidateMeta, posterThumbUrl, setStreams, getSessionToken, versionOf, type Credit, type HistoryEntry, type PlexItem, type PlexMeta } from "../lib/api";
import { formatTimecode } from "../lib/format";
import { useMediaQuery, NARROW_QUERY } from "../lib/useMediaQuery";
import { useRevealTimeout } from "../lib/useRevealTimeout";
import { loadAudioPref, loadSubtitlePref, saveAudioPref, saveSubtitlePref, matchAudioTrack, matchSubtitleTrack } from "../lib/trackPrefs";
import { RatingsRow } from "./RatingsRow";
import { RelatedRows } from "./RelatedRows";
import { CastRow } from "./CastRow";
import { shelfStyles } from "./PosterShelf";
import { DetailLoading } from "./DetailLoading";
import { PlexMediaActions } from "./PlexMediaActions";
import type { QueueItem, SuggestionItem } from "../hooks/useSync";

interface MovieDetailProps {
  item: PlexItem;
  isHost: boolean;
  /** `resumePosition` (seconds) is set only when the host picked Resume.
   *  `mediaIndex` names the chosen file for a title Plex holds more than one of;
   *  omitted when there is only one, which lets the server pick. */
  onPlay: (
    item: PlexItem,
    subtitles: boolean,
    resumePosition?: number,
    mediaIndex?: number,
    /** The tracks chosen here. They name the room's opening stream, so a viewer
     *  who later picks the same ones joins it instead of starting a duplicate. */
    audioStreamId?: number,
    subtitleStreamId?: number,
  ) => void;
  onBack: () => void;
  isPlaying?: boolean;
  onAddToQueue?: (item: QueueItem) => void;
  /** Viewer-only: suggest this title to the host. Omit/undefined for the host. */
  onSuggest?: (item: SuggestionItem) => void;
  /** Episodes only: jump to the show landing page / the season's episode list.
   *  Omitted for movies (and when there's nothing to navigate to). */
  onShowClick?: () => void;
  onSeasonClick?: () => void;
  /** Open another title's detail page — used by the "also in this collection"
   *  rows. Omit to hide those rows. */
  onSelect?: (item: PlexItem) => void;
  /** Open a cast/crew member's page. Omit to render the row unclickable. */
  onSelectPerson?: (person: Credit) => void;
}

/**
 * Hard cap on the wait.
 *
 * The gate below reveals as soon as the page's header is in — poster, metadata
 * and ratings — and gives up waiting after a second regardless. A cached page
 * satisfies it within a frame or two and never shows the spinner at all.
 */
const REVEAL_TIMEOUT_MS = 1000;

function authUrl(url: string): string {
  const token = getSessionToken();
  if (!token || !url) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

function formatDuration(ms: number | undefined): string {
  if (!ms) return "";
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

interface DropdownOption {
  value: string;
  label: string;
}

/**
 * Custom dropdown replacing native <select>. Native selects hand their
 * options popup off to the OS/browser, which renders it in a light theme
 * on many platforms regardless of CSS (`color-scheme` is not reliably
 * respected). Building it ourselves guarantees it always matches the UI.
 */
function TrackDropdown({
  value,
  options,
  onChange,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, []);

  const selected = options.find((o) => o.value === value);

  return (
    <div ref={ref} style={dropdownStyles.wrap}>
      <button className="btn" type="button" onClick={() => setOpen((o) => !o)} style={dropdownStyles.trigger}>
        <span style={dropdownStyles.triggerLabel}>{selected?.label ?? ""}</span>
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none" style={{ flexShrink: 0, marginLeft: 8 }}>
          <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div style={dropdownStyles.menu}>
          {options.map((o) => (
            <button className="btn"
              key={o.value}
              type="button"
              onClick={() => { onChange(o.value); setOpen(false); }}
              style={{
                ...dropdownStyles.option,
                ...(o.value === value ? dropdownStyles.optionActive : {}),
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const dropdownStyles: Record<string, React.CSSProperties> = {
  wrap: { position: "relative", width: "100%" },
  trigger: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "9px 12px",
    borderRadius: "8px",
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.06)",
    color: "#ddd",
    fontSize: "14px",
    fontFamily: "inherit",
    cursor: "pointer",
  },
  triggerLabel: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  menu: {
    position: "absolute",
    top: "calc(100% + 6px)",
    left: 0,
    right: 0,
    maxHeight: "260px",
    overflowY: "auto" as const,
    borderRadius: "10px",
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(20,20,20,0.98)",
    backdropFilter: "blur(20px)",
    boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
    zIndex: 50,
    padding: "4px 0",
  },
  option: {
    display: "block",
    width: "100%",
    padding: "9px 14px",
    border: "none",
    background: "transparent",
    color: "#ccc",
    fontSize: "13px",
    fontFamily: "inherit",
    textAlign: "left" as const,
    cursor: "pointer",
  },
  optionActive: {
    color: "#e5a00d",
    background: "rgba(229,160,13,0.08)",
  },
};

export function MovieDetail({ item, isHost, onPlay, onBack, isPlaying, onAddToQueue, onSuggest, onShowClick, onSeasonClick, onSelect, onSelectPerson }: MovieDetailProps) {
  const [meta, setMeta] = useState<PlexMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedAudio, setSelectedAudio] = useState<number | null>(null);
  const [selectedSubtitle, setSelectedSubtitle] = useState<number | null>(null);
  // Which file to play, for the handful of titles Plex holds more than one of.
  // Null until the metadata arrives, and for everything with a single file.
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [suggested, setSuggested] = useState(false);
  // Distinguishes "metadata hasn't arrived yet" from "metadata failed". The page
  // renders either way now, so a failure is a note beside real content rather
  // than a blank screen.
  const [metaFailed, setMetaFailed] = useState(false);
  // The backdrop is the one thing that can't be drawn from the clicked card, so
  // it fades in on load instead of appearing hard.
  const [backdropLoaded, setBackdropLoaded] = useState(false);
  // Reveal gate — see `pageReady`.
  const [posterLoaded, setPosterLoaded] = useState(false);
  const [ratingsReady, setRatingsReady] = useState(false);
  // This viewer's saved position for the item, or null if they've never played
  // it. Playback controls remain host-only; linked-account actions do not.
  const [progress, setProgress] = useState<HistoryEntry | null>(null);
  // Phone portrait: the poster and the detail column can't sit side by side.
  // At 390px the fixed 240px poster leaves the text roughly 66px, which wraps
  // the title one word per line and pushes the buttons off the screen edge.
  const narrow = useMediaQuery(NARROW_QUERY);

  useEffect(() => {
    let cancelled = false;
    setMetaFailed(false);
    setBackdropLoaded(false);
    setSelectedVersion(null);
    fetchMeta(item.ratingKey)
      .then((m) => {
        if (cancelled) return;
        setMeta(m);
        // versions[0] is the server's pick — the best copy worth streaming, with
        // any 4K duplicate already dropped. The track defaults follow from it in
        // the effect below rather than here, because they have to be redone
        // whenever the choice changes and there is no reason to write that twice.
        setSelectedVersion(m.versions?.[0]?.mediaIndex ?? null);
      })
      .catch((err) => {
        console.error(err);
        if (!cancelled) setMetaFailed(true);
      })
;
    return () => { cancelled = true; };
  }, [item.ratingKey]);

  // Tracks and part id follow the chosen file — see versionOf.
  const resolved = meta ? versionOf(meta, selectedVersion ?? undefined) : null;
  const audioTracks = resolved?.audioTracks ?? [];
  const subtitleTracks = resolved?.subtitleTracks ?? [];
  const partId = resolved?.partId ?? null;

  /**
   * Default the audio and subtitle pickers to this version's own streams.
   *
   * Re-run on a version change and not only on arrival, because stream ids
   * belong to a file rather than to a title: keeping the previous selection
   * across a switch would send Plex an id from the file we are no longer
   * playing, which it accepts and silently ignores.
   */
  useEffect(() => {
    if (!meta) return;
    // The remembered language wins over the file's own default, matched the
    // same way subtitles are — a viewer who watches everything in Japanese
    // should not have to say so on every episode. Falls back to the file's
    // choice when it doesn't carry that language at all.
    const defaultAudio =
      matchAudioTrack(audioTracks, loadAudioPref())
      ?? audioTracks.find((t) => t.selected)
      ?? audioTracks[0];
    setSelectedAudio(defaultAudio ? defaultAudio.id : null);
    // Re-apply the viewer's remembered subtitle choice — matched by language
    // and flavour, since stream ids differ from episode to episode. With no
    // stored preference this resolves to null, the previous "off" default.
    const match = matchSubtitleTrack(subtitleTracks, loadSubtitlePref());
    setSelectedSubtitle(match ? match.id : null);
    // audioTracks/subtitleTracks are derived from exactly these two.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, selectedVersion]);

  // Deliberately not cached (unlike fetchMeta): this changes every time the item
  // is watched, and a stale resume point is worse than an extra request.
  useEffect(() => {
    setProgress(null);
    let cancelled = false;
    fetchProgress(item.ratingKey)
      .then((r) => { if (!cancelled) setProgress(r.progress); })
      .catch(() => { /* resume is a convenience — never block playback on it */ });
    return () => { cancelled = true; };
  }, [item.ratingKey]);

  const handlePlay = useCallback(async (resumeFromMs?: number) => {
    if (!partId) return;
    try {
      setError(null);
      /**
       * What you pressed play on is what you want to keep watching.
       *
       * The pickers already saved on *change*, which quietly missed the most
       * ordinary case of all: accepting what was preselected. Somebody who
       * started a season on its default Japanese audio had no stored preference
       * at all, so when they handed the host role over and the new host moved to
       * the next episode, there was nothing to carry and they were pulled onto
       * the new host's tracks. Changing a picker — to anything, even back again
       * — fixed it, which is how it was found.
       *
       * Recording the choice here covers both, and reads the same either way:
       * this is the pair the viewer chose to watch, whether they went looking
       * for it or simply left it alone.
       */
      saveAudioPref(audioTracks.find((t) => t.id === selectedAudio) ?? null);
      saveSubtitlePref(subtitleTracks.find((t) => t.id === selectedSubtitle) ?? null);
      if (selectedAudio != null) {
        await setStreams(partId, {
          audioStreamID: selectedAudio,
          subtitleStreamID: selectedSubtitle ?? 0,
        });
        // The cached meta now reports stale selected-track flags — drop it.
        invalidateMeta(item.ratingKey);
      }
      // The player works in seconds; history stores milliseconds.
      onPlay(
        item,
        selectedSubtitle != null,
        resumeFromMs != null ? resumeFromMs / 1000 : undefined,
        selectedVersion ?? undefined,
        selectedAudio ?? 0,
        selectedSubtitle ?? 0,
      );
    } catch (err) {
      console.error("Failed to set streams:", err);
      setError("Failed to configure playback. Please try again.");
    }
  }, [partId, selectedAudio, selectedSubtitle, audioTracks, subtitleTracks, item, onPlay, selectedVersion]);

  // Offer a resume only for a genuine part-watch: far enough in to matter, and
  // not already finished (the server flags that, so a rewatch starts clean).
  const resumeMs =
    progress && !progress.watched && progress.positionMs >= 60_000 ? progress.positionMs : null;
  const progressRatio =
    progress && progress.durationMs > 0
      ? Math.min(1, progress.positionMs / progress.durationMs)
      : null;

  const backdropUrl = meta?.art ? authUrl(meta.art) : null;
  // Same sized URL the card used, so the poster is already in the browser
  // cache and paints on the first frame (see posterThumbUrl).
  const posterSrc = meta?.thumb ?? item.thumb;
  const posterUrl = posterSrc ? posterThumbUrl(posterSrc) : null;

  // ── Optimistic render ────────────────────────────────────────
  //
  // There is no loading screen. The card that was clicked already carries the
  // title, year, runtime, synopsis and poster — and that poster is decoded in
  // the browser cache, because the card was displaying it a moment ago — so the
  // page can be drawn in full on the first frame and simply thicken as the
  // metadata lands.
  //
  // Only what genuinely isn't known yet waits: genres, ratings, the track
  // pickers, the cast. Each of those reserves its space (see `ratingsSlot` and
  // `trackSlot`) so filling in never moves the text above it.
  const dTitle = meta?.title ?? item.title;
  const dYear = meta?.year ?? item.year;
  const dDuration = meta?.duration ?? item.duration;
  const dSummary = meta?.summary ?? item.summary ?? null;

  // Waits on the header only: the poster, the metadata behind the title block,
  // and the ratings. The cast row and the collection rows are deliberately not
  // part of this — they sit below the fold and fill in on their own, and making
  // the whole page wait on the slowest headshot or on /collections is what made
  // every open feel long.
  //
  // Episodes have no ratings row, and a metadata failure renders none either.
  const wantsRatings = item.type === "movie" && meta != null;
  const revealTimedOut = useRevealTimeout(item.ratingKey, REVEAL_TIMEOUT_MS);
  const pageReady =
    ((meta != null || metaFailed) &&
      (posterLoaded || !posterUrl) &&
      (!wantsRatings || ratingsReady)) ||
    revealTimedOut;

  return (
    <div style={styles.page}>
      {!pageReady && <DetailLoading />}
      {/* Kept mounted behind the placeholder: the images and row requests the
          gate is waiting on only make progress once they're in the tree. */}
      <div style={pageReady ? styles.revealed : styles.prerender} aria-hidden={!pageReady}>
      {/* Backdrop — the one part that can't come from the clicked card, so it
          fades in on load rather than snapping into place. */}
      {backdropUrl && (
        <div style={styles.backdropWrap}>
          <img
            src={backdropUrl}
            alt=""
            style={{ ...styles.backdropImg, opacity: backdropLoaded ? 1 : 0 }}
            onLoad={() => setBackdropLoaded(true)}
          />
          <div style={styles.backdropOverlay} />
        </div>
      )}

      {/* Back button */}
      <button className="btn-icon" onClick={onBack} style={styles.backBtn}>
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Back
      </button>

      <>
        <div style={{ ...styles.content, ...(narrow ? styles.contentNarrow : {}) }}>
          {/* Poster + Info layout — stacks on phone portrait */}
          <div style={{ ...styles.layout, ...(narrow ? styles.layoutNarrow : {}) }}>
            {/* Poster */}
            {posterUrl && (
              <div
                style={{
                  ...styles.posterWrap,
                  ...(item.type === "episode" ? styles.posterWrapEpisode : {}),
                  ...(narrow
                    ? (item.type === "episode" ? styles.posterWrapNarrowEpisode : styles.posterWrapNarrow)
                    : {}),
                }}
              >
                <img
                  src={posterUrl}
                  alt={dTitle}
                  style={{ ...styles.poster, ...(item.type === "episode" ? styles.posterEpisode : {}) }}
                  onLoad={() => setPosterLoaded(true)}
                  onError={() => setPosterLoaded(true)}
                  // A poster served from the browser cache can finish decoding
                  // before onLoad is attached, in which case the event never
                  // arrives and the gate would wait for nothing.
                  ref={(el) => { if (el?.complete) setPosterLoaded(true); }}
                />
              </div>
            )}

            {/* Info */}
            <div style={styles.info}>
              {/* Episode label */}
              {item.type === "episode" && item.parentIndex != null && item.index != null && (
                <>
                  {item.showTitle &&
                    (onShowClick ? (
                      <button className="btn"
                        type="button"
                        onClick={onShowClick}
                        style={{ ...styles.buttonReset, ...styles.episodeShowTitle }}
                        onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
                        onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
                      >
                        {item.showTitle}
                      </button>
                    ) : (
                      <div style={styles.episodeShowTitle}>{item.showTitle}</div>
                    ))}
                  <div style={styles.episodeLabel}>
                    {onSeasonClick ? (
                      <button className="btn"
                        type="button"
                        onClick={onSeasonClick}
                        style={{ ...styles.buttonReset, ...styles.episodeLabelLink }}
                        onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
                        onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
                      >
                        Season {item.parentIndex}
                      </button>
                    ) : (
                      <>Season {item.parentIndex}</>
                    )}
                    , Episode {item.index}
                  </div>
                </>
              )}

              <h1 style={{ ...styles.title, ...(narrow ? styles.titleNarrow : {}) }}>{dTitle}</h1>

              {/* Meta row */}
              <div style={styles.metaRow}>
                {dYear && <span style={styles.metaItem}>{dYear}</span>}
                {dDuration && (
                  <>
                    <span style={styles.metaDot}>&middot;</span>
                    <span style={styles.metaItem}>{formatDuration(dDuration)}</span>
                  </>
                )}
                {/* Special-edition label ("Director's Cut", "Extended Edition",
                    "IMAX Edition", …) — only present when this file is a special
                    cut, so a plain theatrical release shows nothing. */}
                {meta?.editionTitle && (
                  <span style={styles.editionBadge}>{meta.editionTitle}</span>
                )}
              </div>

              {/* Genres — not on the card, so this appears with the metadata.
                  The row reserves its height so the synopsis doesn't jump. */}
              <div style={styles.genresSlot}>
                {meta && meta.genres.length > 0 && (
                  <div style={styles.genres}>
                    {meta.genres.map((g) => (
                      <span key={g} style={styles.genrePill}>{g}</span>
                    ))}
                  </div>
                )}
              </div>

              {/* External ratings — movies only (not episodes, per design).
                  Height reserved for the same reason as the genres above. */}
              {item.type === "movie" && (
                <div style={styles.ratingsSlot}>
                  {meta && (
                    <RatingsRow
                      imdbId={meta.imdbId}
                      tmdbId={meta.tmdbId}
                      mediaType="movie"
                      style={styles.ratings}
                      onReady={() => setRatingsReady(true)}
                    />
                  )}
                </div>
              )}

              {/* Summary — from the clicked card until the fuller one arrives. */}
              {dSummary && (
                <p style={styles.summary}>{dSummary}</p>
              )}

              {/* Audio & Subtitle selectors — these need the stream list, so they
                  can't be drawn from the card. The row holds its height while
                  the metadata is in flight so the Play button doesn't move. */}
              <div style={{ ...styles.trackRow, ...(narrow ? styles.trackRowNarrow : {}), ...styles.trackSlot }}>
                {/* Which file, for the few titles Plex holds more than one of.
                    First, because it decides what the other two can offer. A 4K
                    copy is missing from this list whenever a lower-resolution one
                    exists — see the note on PlexVersion. */}
                {meta && (meta.versions?.length ?? 0) > 1 && (
                  <div style={styles.trackField}>
                    <label style={styles.trackLabel}>Version</label>
                    <TrackDropdown
                      value={selectedVersion != null ? String(selectedVersion) : ""}
                      options={meta.versions!.map((v) => ({
                        value: String(v.mediaIndex),
                        label: v.label,
                      }))}
                      onChange={(v) => setSelectedVersion(Number(v))}
                    />
                  </div>
                )}

                {meta && audioTracks.length > 1 && (
                  <div style={styles.trackField}>
                    <label style={styles.trackLabel}>Audio</label>
                    <TrackDropdown
                      value={selectedAudio != null ? String(selectedAudio) : ""}
                      options={audioTracks.map((t) => ({ value: String(t.id), label: t.title }))}
                      onChange={(v) => {
                        const id = Number(v);
                        setSelectedAudio(id);
                        // Remembered by language, so the next episode comes up
                        // on the same one.
                        saveAudioPref(audioTracks.find((t) => t.id === id) ?? null);
                      }}
                    />
                  </div>
                )}

                {meta && subtitleTracks.length > 0 && (
                  <div style={styles.trackField}>
                    <label style={styles.trackLabel}>Subtitles</label>
                    <TrackDropdown
                      value={selectedSubtitle != null ? String(selectedSubtitle) : ""}
                      options={[
                        { value: "", label: "None" },
                        ...subtitleTracks.map((t) => ({ value: String(t.id), label: t.title })),
                      ]}
                      onChange={(v) => {
                        const id = v === "" ? null : Number(v);
                        setSelectedSubtitle(id);
                        // Remember it so the next episode starts with the same
                        // kind of track already selected.
                        saveSubtitlePref(subtitleTracks.find((t) => t.id === id) ?? null);
                      }}
                    />
                  </div>
                )}
              </div>

              {error && <p style={styles.errorText}>{error}</p>}
              {/* The page still shows everything the card knew, so this is a
                  note about what's missing rather than a dead end. */}
              {metaFailed && (
                <p style={styles.errorText}>
                  Couldn't load the full details for this title, so playback isn't available.
                </p>
              )}

              {/* Progress belongs to the current user. Only the host can turn
                  their resume choice into the room's shared playback. */}
              {isHost && progressRatio != null && resumeMs != null && (
                <div style={styles.progressWrap}>
                  <div style={styles.progressTrack}>
                    <div style={{ ...styles.progressFill, width: `${progressRatio * 100}%` }} />
                  </div>
                  <span style={styles.progressLabel}>
                    {formatTimecode(progress!.durationMs - progress!.positionMs)} left
                  </span>
                </div>
              )}
              {/* Above the row rather than inside it. The row is what you can
                  press, and it lines its children up in one horizontal band —
                  so a paragraph in there is a very wide sibling, and everything
                  after it starts where the *text* ends. That is what pushed a
                  viewer's watched tick out past the end of a sentence while the
                  host's sat neatly beside Play. */}
              {!isHost && (
                <p style={styles.waitingText}>Waiting for the host to start playback...</p>
              )}
              {/* Play / Waiting */}
              <div style={{ ...styles.actions, ...(narrow ? styles.actionsNarrow : {}) }}>
                {isHost ? (
                  <>
                    {resumeMs != null ? (
                      <>
                        <button className="btn"
                          onClick={() => handlePlay(resumeMs)}
                          disabled={!meta}
                          style={{ ...styles.playBtn, ...(narrow ? styles.playBtnNarrow : {}), ...(meta ? {} : styles.btnPending) }}
                        >
                          <svg width="22" height="22" viewBox="0 0 22 22" fill="none" style={{ marginRight: 8 }}>
                            <path d="M5 3.5L18 11L5 18.5V3.5Z" fill="currentColor"/>
                          </svg>
                          Resume from {formatTimecode(resumeMs)}
                        </button>
                        <button className="btn"
                          onClick={() => handlePlay()}
                          disabled={!meta}
                          style={{ ...styles.startOverBtn, ...(narrow ? styles.startOverBtnNarrow : {}), ...(meta ? {} : styles.btnPending) }}
                        >
                          Start Over
                        </button>
                      </>
                    ) : (
                      <button className="btn"
                        onClick={() => handlePlay()}
                        disabled={!meta}
                        style={{ ...styles.playBtn, ...(narrow ? styles.playBtnNarrow : {}), ...(meta ? {} : styles.btnPending) }}
                      >
                        <svg width="22" height="22" viewBox="0 0 22 22" fill="none" style={{ marginRight: 8 }}>
                          <path d="M5 3.5L18 11L5 18.5V3.5Z" fill="currentColor"/>
                        </svg>
                        {progress?.watched ? "Watch Again" : "Play"}
                      </button>
                    )}
                    {isPlaying && onAddToQueue && (
                      <button className="btn-icon"
                        onClick={() => {
                          if (!meta) return;
                          onAddToQueue({
                            ratingKey: item.ratingKey,
                            title: item.title,
                            type: item.type,
                            thumb: item.thumb,
                            subtitles: selectedSubtitle != null,
                            parentTitle: item.parentTitle,
                            parentIndex: item.parentIndex,
                            index: item.index,
                            year: item.year,
                          });
                        }}
                        style={styles.queueBtn}
                      >
                        Add to Queue
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    {onSuggest && (
                      <button className="btn"
                        onClick={() => {
                          onSuggest({
                            ratingKey: item.ratingKey,
                            title: item.title,
                            type: item.type,
                            thumb: item.thumb,
                            year: item.year,
                            showTitle: item.showTitle,
                            parentTitle: item.parentTitle,
                            parentIndex: item.parentIndex,
                            index: item.index,
                          });
                          setSuggested(true);
                          setTimeout(() => setSuggested(false), 2500);
                        }}
                        disabled={suggested}
                        style={suggested ? styles.suggestBtnSent : styles.suggestBtn}
                      >
                        {suggested ? "Suggested to host \u2713" : "Suggest to Host"}
                      </button>
                    )}
                  </>
                )}
                <PlexMediaActions
                  item={item}
                  progress={progress}
                  onProgressChange={setProgress}
                  inline
                />
              </div>
            </div>
          </div>
        </div>

        {/* Cast & Crew sits ahead of the collection rows — it's about this title,
            where those are about what to watch next. Shares the shelves' wrapper
            so every row on the page lines up on the same left edge. */}
        <div style={shelfStyles.wrap}>
          <CastRow
            cast={meta?.cast}
            directors={meta?.directors}
            onSelectPerson={onSelectPerson}
            loading={!meta && !metaFailed}
          />
        </div>

        {/* Collections then "More Like This" — same rows as the Home tab,
            rendered outside the narrow detail column so they span the page.
            Movies only: episodes belong to a show, not a collection, and TMDB
            has no per-episode recommendations. */}
        {item.type === "movie" && onSelect && (
          <RelatedRows
            ratingKey={item.ratingKey}
            recommendationsTitle="More Like This"
            onSelect={onSelect}
          />
        )}
        </>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    position: "relative",
    minHeight: "100vh",
    background: "#0d0d0d",
    overflow: "hidden",
  },
  // The two halves of the reveal. `prerender` keeps the real page mounted and
  // laid out at full width — so its images load and the shelves measure — while
  // painting nothing. Width is explicit because an absolutely-positioned box
  // would otherwise shrink-wrap.
  prerender: {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    opacity: 0,
    pointerEvents: "none" as const,
  },
  revealed: {
    opacity: 1,
    transition: "opacity 0.28s ease",
  },
  // Height reservations for the parts that can't be drawn from the clicked card
  // (see the optimistic-render note). Each holds exactly the space its content
  // will take, so filling in never nudges what sits below it.
  genresSlot: {
    minHeight: "34px",
  },
  ratingsSlot: {
    minHeight: "26px",
  },
  trackSlot: {
    minHeight: "62px",
  },
  // A control that exists but can't act yet, because it needs the stream list.
  // Dimmed rather than hidden so the button doesn't pop into the layout.
  btnPending: {
    opacity: 0.55,
    cursor: "default",
  },
  backdropWrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: "60vh",
    overflow: "hidden",
  },
  backdropImg: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    filter: "blur(20px) brightness(0.3)",
    transform: "scale(1.1)",
    transition: "opacity 0.4s ease",
  },
  backdropOverlay: {
    position: "absolute",
    inset: 0,
    background: "linear-gradient(to bottom, rgba(13,13,13,0.3) 0%, #0d0d0d 100%)",
  },
  backBtn: {
    position: "relative",
    zIndex: 10,
    display: "flex",
    alignItems: "center",
    gap: "6px",
    margin: "16px 24px",
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
  content: {
    position: "relative",
    // Above the shelves below it (shelfStyles.wrap is z-index 10). At equal
    // z-index the later element wins, so the Cast & Crew row painted over the
    // open audio/subtitle dropdown and clipped the list.
    zIndex: 20,
    maxWidth: "1100px",
    margin: "0 auto",
    padding: "0 24px 48px",
  },
  layout: {
    display: "flex",
    gap: "36px",
    alignItems: "flex-start",
  },
  // ─── Phone portrait overrides ──────────────────────────────────
  // Everything below is the same panel with the poster stacked above the text
  // instead of beside it, so the detail column gets the full screen width.
  contentNarrow: {
    padding: "0 16px 40px",
  },
  layoutNarrow: {
    flexDirection: "column",
    gap: "20px",
    alignItems: "stretch",
  },
  posterWrapNarrow: {
    // Centred and capped rather than full-bleed: a 2:3 poster at full phone
    // width is taller than the screen and buries everything below it.
    width: "min(180px, 45%)",
    alignSelf: "center",
  },
  posterWrapNarrowEpisode: {
    // Stills are 16:9, so full width costs little vertical space.
    width: "100%",
  },
  titleNarrow: {
    fontSize: "24px",
  },
  trackRowNarrow: {
    flexDirection: "column",
    gap: "12px",
  },
  actionsNarrow: {
    flexDirection: "column",
    alignItems: "stretch",
  },
  playBtnNarrow: {
    // Stretched to the column, so a long label like "Resume from 1:01:55"
    // wraps inside the button instead of running off the screen edge.
    justifyContent: "center",
    padding: "14px 20px",
    textAlign: "center",
  },
  startOverBtnNarrow: {
    textAlign: "center",
  },
  posterWrap: {
    flexShrink: 0,
    width: "240px",
    borderRadius: "12px",
    overflow: "hidden",
    boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
  },
  posterWrapEpisode: {
    // Episode stills are landscape (16:9) — a wider box than the movie/show
    // portrait poster avoids stretching or awkward cropping.
    width: "360px",
  },
  poster: {
    width: "100%",
    display: "block",
    aspectRatio: "2/3",
    objectFit: "cover",
  },
  posterEpisode: {
    aspectRatio: "16/9",
  },
  info: {
    flex: 1,
    minWidth: 0,
    paddingTop: "8px",
  },
  // Strips the native button chrome so an inline text button inherits the
  // surrounding typography. Spread it BEFORE the text style so font/color win.
  buttonReset: {
    background: "transparent",
    border: "none",
    padding: 0,
    margin: 0,
    fontFamily: "inherit",
    cursor: "pointer",
    display: "inline",
  },
  episodeShowTitle: {
    fontSize: "15px",
    fontWeight: 600,
    color: "#ccc",
    marginBottom: "4px",
    // Block so it sits on its own line like the original <div>.
    display: "block",
    textAlign: "left",
  },
  episodeLabel: {
    fontSize: "13px",
    fontWeight: 600,
    color: "#e5a00d",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    marginBottom: "6px",
  },
  // The clickable "Season N" inside episodeLabel — inherits the gold uppercase
  // run so only the interactivity (cursor/underline) sets it apart.
  episodeLabelLink: {
    fontSize: "inherit",
    fontWeight: "inherit",
    color: "inherit",
    textTransform: "inherit",
    letterSpacing: "inherit",
  },
  title: {
    fontSize: "32px",
    fontWeight: 700,
    lineHeight: 1.15,
    letterSpacing: "-0.02em",
    color: "#f0f0f0",
    marginBottom: "12px",
  },
  metaRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "16px",
  },
  metaItem: {
    fontSize: "15px",
    color: "#888",
    fontWeight: 500,
  },
  metaDot: {
    color: "#555",
    fontSize: "15px",
  },
  // Gold pill that sets a special edition apart from the plain year/runtime text
  // beside it, so an Extended/Director's/IMAX cut is obvious at a glance.
  editionBadge: {
    padding: "2px 10px",
    borderRadius: "6px",
    background: "rgba(229,160,13,0.15)",
    border: "1px solid rgba(229,160,13,0.3)",
    color: "#e5a00d",
    fontSize: "12px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.03em",
  },
  ratings: {
    marginBottom: "20px",
  },
  genres: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
    marginBottom: "20px",
  },
  genrePill: {
    padding: "4px 12px",
    borderRadius: "20px",
    background: "rgba(255,255,255,0.07)",
    border: "1px solid rgba(255,255,255,0.08)",
    color: "#aaa",
    fontSize: "13px",
    fontWeight: 500,
  },
  summary: {
    fontSize: "15px",
    lineHeight: 1.6,
    color: "#999",
    marginBottom: "28px",
    display: "-webkit-box",
    WebkitLineClamp: 4,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  },
  trackRow: {
    display: "flex",
    gap: "16px",
    marginBottom: "20px",
  },
  trackField: {
    flex: 1,
    minWidth: 0,
  },
  trackLabel: {
    display: "block",
    fontSize: "13px",
    fontWeight: 600,
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    marginBottom: "6px",
  },
  actions: {
    marginTop: "28px",
    display: "flex",
    gap: "12px",
    alignItems: "center",
    flexWrap: "wrap",
  },
  playBtn: {
    display: "inline-flex",
    alignItems: "center",
    padding: "14px 36px",
    borderRadius: "12px",
    border: "none",
    background: "#e5a00d",
    color: "#000",
    fontSize: "16px",
    fontWeight: 700,
    fontFamily: "inherit",
    cursor: "pointer",
    transition: "transform 0.15s ease, box-shadow 0.15s ease",
    boxShadow: "0 4px 20px rgba(229,160,13,0.3)",
  },
  waitingText: {
    color: "#888",
    fontSize: "15px",
    fontStyle: "italic",
    // Its own line above the actions row, with the same gap the row's own
    // margin gives — see the note where it is rendered.
    marginTop: "28px",
    marginBottom: "-16px",
  },
  suggestBtn: {
    padding: "10px 22px",
    borderRadius: "10px",
    border: "1px solid rgba(229,160,13,0.4)",
    background: "rgba(229,160,13,0.1)",
    color: "#e5a00d",
    fontSize: "14px",
    fontWeight: 600,
    fontFamily: "inherit",
    cursor: "pointer",
    transition: "background 0.15s ease",
  },
  suggestBtnSent: {
    padding: "10px 22px",
    borderRadius: "10px",
    border: "1px solid rgba(46,160,67,0.4)",
    background: "rgba(46,160,67,0.12)",
    color: "#4caf50",
    fontSize: "14px",
    fontWeight: 600,
    fontFamily: "inherit",
    cursor: "default",
  },
  queueBtn: {
    padding: "10px 20px", borderRadius: "8px",
    border: "1px solid rgba(229,160,13,0.4)", background: "transparent",
    color: "#e5a00d", fontSize: "14px", fontWeight: 600,
    cursor: "pointer", fontFamily: "inherit",
  },
  startOverBtn: {
    padding: "14px 26px", borderRadius: "12px",
    border: "1px solid rgba(255,255,255,0.18)", background: "transparent",
    color: "#ccc", fontSize: "15px", fontWeight: 600,
    cursor: "pointer", fontFamily: "inherit",
  },
  progressWrap: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    marginTop: "24px",
    maxWidth: "420px",
  },
  progressTrack: {
    flex: 1,
    height: "5px",
    borderRadius: "3px",
    background: "rgba(255,255,255,0.12)",
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    background: "#e5a00d",
    borderRadius: "3px",
  },
  progressLabel: {
    color: "#888",
    fontSize: "13px",
    fontWeight: 500,
    whiteSpace: "nowrap" as const,
  },
  errorText: {
    color: "#e74c3c",
    fontSize: "14px",
    marginBottom: "8px",
  },
};
