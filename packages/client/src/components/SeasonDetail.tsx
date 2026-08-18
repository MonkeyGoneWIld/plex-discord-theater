import { useState, useEffect, useMemo } from "react";
import {
  fetchChildren, fetchProgressMany, fetchSeasonEpisodes, getSessionToken,
  type HistoryEntry, type PlexItem, type SeasonEpisode,
} from "../lib/api";
import {
  describeGaps, findSeasonGaps, formatAirDate, type GapEpisode,
} from "../lib/seasonGaps";
import { formatTimecode } from "../lib/format";
import { SkeletonBlock } from "./SkeletonBlock";
import type { QueueItem } from "../hooks/useSync";

interface SeasonDetailProps {
  season: PlexItem;
  show: PlexItem;
  onSelectEpisode: (episode: PlexItem) => void;
  onBack: () => void;
  /** Jump to the show landing page from the in-content breadcrumb. */
  onShowClick?: () => void;
  isHost?: boolean;
  isPlaying?: boolean;
  onAddToQueue?: (item: QueueItem) => void;
}

function authUrl(url: string, w?: number, h?: number): string {
  const token = getSessionToken();
  if (!token || !url) return url;
  const sep = url.includes("?") ? "&" : "?";
  let out = `${url}${sep}token=${encodeURIComponent(token)}`;
  if (w && h) out += `&w=${w}&h=${h}`;
  return out;
}

function fmtDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0
    ? `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
    : `${m}:${s.toString().padStart(2, "0")}`;
}

export function SeasonDetail({ season, show, onSelectEpisode, onBack, onShowClick, isHost, isPlaying, onAddToQueue }: SeasonDetailProps) {
  const [episodes, setEpisodes] = useState<PlexItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  // The viewer's own watch history for these episodes, keyed by rating key.
  // Not host-gated: it's their history either way, and it's information rather
  // than a control, so there's nothing here a viewer shouldn't see.
  const [progress, setProgress] = useState<Record<string, HistoryEntry>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchChildren(season.ratingKey)
      .then((res) => { if (!cancelled) setEpisodes(res.items); })
      .catch(console.error)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [season.ratingKey]);

  // One request for the whole season, once the episode keys are known. This
  // component remounts on every visit, so backing out of an episode refreshes
  // the marks without any extra signal.
  useEffect(() => {
    setProgress({});
    if (episodes.length === 0) return;
    let cancelled = false;
    fetchProgressMany(episodes.map((e) => e.ratingKey))
      .then((res) => { if (!cancelled) setProgress(res.entries); })
      .catch(() => { /* marks are a nicety — never break the list over them */ });
    return () => { cancelled = true; };
  }, [episodes]);

  // What this season is supposed to contain, so the gaps can be worked out. Its
  // own request, deliberately after the Plex one and never blocking it: the
  // episodes that are actually here are what the page is for, and this is an
  // annotation on top. The server picks the source — TVDB where it can, since
  // that is what Sonarr monitors — and hands back a list already checked against
  // Plex's own numbering.
  const [sourceEpisodes, setSourceEpisodes] = useState<SeasonEpisode[] | null>(null);
  const [showGaps, setShowGaps] = useState(false);
  const [gapToggleHover, setGapToggleHover] = useState(false);

  useEffect(() => {
    setSourceEpisodes(null);
    setShowGaps(false);
    let cancelled = false;
    fetchSeasonEpisodes(season.ratingKey)
      .then((res) => { if (!cancelled) setSourceEpisodes(res.episodes); })
      .catch(() => { /* optional annotation — never surface an error over a real list */ });
    return () => { cancelled = true; };
  }, [season.ratingKey]);

  /**
   * Episodes the source knows about that Plex doesn't have.
   *
   * Empty when Plex has none of the season at all: that is a *wholly* missing
   * season, which the show page already represents as a single request card, and
   * listing twenty absent episodes inside it would be a worse answer to the same
   * question. It's only reachable at all when Plex has a season row with no
   * children, which is rare, but the guard costs nothing.
   */
  const gaps = useMemo(() => findSeasonGaps(episodes, sourceEpisodes), [sourceEpisodes, episodes]);

  /**
   * The list as rendered: what Plex has, plus the gaps when they're shown,
   * interleaved by episode number.
   *
   * Interleaved rather than appended, because a gap only reads as a gap where it
   * falls — a block of absent episodes at the bottom looks like a separate list
   * of something else, and you can't see at a glance that it's episode 4 that
   * never downloaded.
   */
  type Row =
    | { kind: "have"; ep: PlexItem }
    | { kind: "gap"; ep: GapEpisode };

  const rows = useMemo<Row[]>(() => {
    const have: Row[] = episodes.map((ep) => ({ kind: "have", ep }));
    if (!showGaps || gaps.length === 0) return have;
    const num = (r: Row) =>
      r.kind === "have" ? (r.ep.index ?? Number.MAX_SAFE_INTEGER) : r.ep.episodeNumber;
    return [...have, ...gaps.map((ep) => ({ kind: "gap" as const, ep }))]
      .sort((a, b) => num(a) - num(b));
  }, [episodes, gaps, showGaps]);

  const gapLabel = describeGaps(gaps);

  const seasonLabel = season.index != null ? `Season ${season.index}` : season.title;

  const addToQueue = (ep: PlexItem) => {
    onAddToQueue?.({
      ratingKey: ep.ratingKey,
      title: ep.title,
      type: ep.type,
      thumb: ep.thumb,
      subtitles: false,
      parentTitle: show.title,
      parentIndex: season.index,
      index: ep.index,
    });
  };

  return (
    <div style={styles.page}>
      <button onClick={onBack} style={styles.backBtn}>
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Back
      </button>

      <div style={styles.breadcrumb}>
        {onShowClick ? (
          <button
            type="button"
            onClick={onShowClick}
            style={{ ...styles.buttonReset, ...styles.breadcrumbShow }}
            onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
            onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
          >
            {show.title}
          </button>
        ) : (
          <span style={styles.breadcrumbShow}>{show.title}</span>
        )}
        <span style={styles.breadcrumbSep}>&rsaquo;</span>
        {/* The season is the current page, so it stays static (not a link). */}
        <span style={styles.breadcrumbSeason}>{seasonLabel}</span>
      </div>

      {loading ? (
        <div style={{ padding: "0 24px", display: "flex", flexDirection: "column", gap: "16px" }}>
          <SkeletonBlock width="30%" height={18} />
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={{ display: "flex", gap: "16px", alignItems: "center" }}>
              <SkeletonBlock width={200} height={112} borderRadius={8} />
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "8px" }}>
                <SkeletonBlock width="50%" height={16} />
                <SkeletonBlock width="80%" height={12} />
                <SkeletonBlock width="60%" height={12} />
              </div>
            </div>
          ))}
        </div>
      ) : episodes.length === 0 ? (
        <div style={{
          display: "flex", flexDirection: "column" as const, alignItems: "center",
          padding: "48px 24px", gap: "12px",
        }}>
          <p style={{ color: "#666", fontSize: "14px" }}>No episodes available</p>
        </div>
      ) : (
        <div style={styles.list}>
          {rows.map((row) => {
            if (row.kind === "gap") {
              const g = row.ep;
              const still = g.still;
              const aired = formatAirDate(g.airDate);
              const isMissing = g.kind === "missing";
              return (
                // A div, not a button: these aren't selectable. Requests are
                // per-season — Sonarr monitors a season, and offering a
                // single-episode request would promise something the request
                // flow can't deliver.
                <div
                  key={`gap-${g.episodeNumber}`}
                  style={{ ...styles.episodeCard, ...styles.gapCard }}
                  aria-label={`Episode ${g.episodeNumber}, ${isMissing ? "not in library" : "not yet aired"}`}
                >
                  <div style={styles.thumbWrap}>
                    {still ? (
                      <img src={still} alt="" style={{ ...styles.episodeThumb, ...styles.gapThumb }} loading="lazy" />
                    ) : (
                      <div style={styles.episodePlaceholder}>No Image</div>
                    )}
                    {/* Same badge, same corner as a real episode's duration —
                        the row is meant to read as one of the list, just
                        greyed. TMDB doesn't always have a runtime. */}
                    {g.runtime != null && g.runtime > 0 && (
                      <div style={{ ...styles.durationBadge, ...styles.gapDurationBadge }}>
                        {fmtDuration(g.runtime * 60_000)}
                      </div>
                    )}
                  </div>
                  <div style={styles.episodeInfo}>
                    <div style={styles.episodeMeta}>
                      <span style={styles.gapEpisodeNumber}>E{g.episodeNumber}</span>
                      <span style={styles.gapEpisodeTitle}>{g.name}</span>
                      <span style={isMissing ? styles.missingTag : styles.unairedTag}>
                        {isMissing ? "Missing" : "Not aired"}
                      </span>
                    </div>
                    {(aired || g.overview) && (
                      <p style={styles.gapSummary}>
                        {aired && (
                          <span style={styles.airDate}>
                            {isMissing ? "Aired" : "Airs"} {aired}
                          </span>
                        )}
                        {aired && g.overview ? " · " : ""}
                        {g.overview}
                      </p>
                    )}
                  </div>
                </div>
              );
            }
            const ep = row.ep;
            const isHovered = hoveredKey === ep.ratingKey;
            const seen = progress[ep.ratingKey];
            const watched = seen?.watched === true;
            // Part-watched only: a finished episode gets the tick instead, and a
            // full-width bar under it would read as "still going".
            const partial =
              seen && !watched && seen.durationMs > 0 && seen.positionMs > 0
                ? Math.min(1, seen.positionMs / seen.durationMs)
                : null;
            return (
              <button
                key={ep.ratingKey}
                onClick={() => onSelectEpisode(ep)}
                onMouseEnter={() => setHoveredKey(ep.ratingKey)}
                onMouseLeave={() => setHoveredKey(null)}
                style={{
                  ...styles.episodeCard,
                  ...(isHovered ? styles.episodeCardHover : {}),
                }}
              >
                <div style={styles.thumbWrap}>
                  {ep.thumb ? (
                    <img
                      src={authUrl(ep.thumb, 400, 225)}
                      alt=""
                      // Dimmed when finished, so a season scans at a glance
                      // rather than needing the badges read one by one.
                      style={{ ...styles.episodeThumb, ...(watched ? styles.thumbWatched : {}) }}
                      loading="eager"
                    />
                  ) : (
                    <div style={styles.episodePlaceholder}>No Image</div>
                  )}
                  <div style={{ ...styles.playOverlay, opacity: isHovered ? 1 : 0 }}>
                    <div style={styles.playCircle}>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="#fff">
                        <path d="M4 2.5L13 8L4 13.5V2.5Z"/>
                      </svg>
                    </div>
                  </div>
                  {watched && (
                    <div style={styles.watchedBadge} title="Watched">
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                        <path d="M3 8.5L6.5 12L13 4.5" stroke="currentColor" strokeWidth="2.2"
                          strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>
                  )}
                  {ep.duration && (
                    // Lifted clear of the progress bar when there is one.
                    <div style={{ ...styles.durationBadge, ...(partial != null ? { bottom: "10px" } : {}) }}>
                      {fmtDuration(ep.duration)}
                    </div>
                  )}
                  {partial != null && (
                    <div style={styles.progressTrack}>
                      <div style={{ ...styles.progressFill, width: `${partial * 100}%` }} />
                    </div>
                  )}
                  {isHost && isPlaying && onAddToQueue && (
                    // A <button> here would be nested inside the card's own
                    // button — invalid HTML, and browsers handle the nesting
                    // inconsistently. React builds it via the DOM API so it
                    // renders anyway, which is what made it easy to miss.
                    // Same span/role treatment as MovieCard's dismiss control.
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`Add ${ep.title} to the queue`}
                      onClick={(e) => {
                        e.stopPropagation();
                        addToQueue(ep);
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.preventDefault();
                        e.stopPropagation();
                        addToQueue(ep);
                      }}
                      style={styles.queueBtn}
                    >
                      + Queue
                    </span>
                  )}
                </div>
                <div style={styles.episodeInfo}>
                  <div style={styles.episodeMeta}>
                    <span style={styles.episodeNumber}>E{ep.index ?? "?"}</span>
                    <span style={styles.episodeTitle}>{ep.title}</span>
                    {watched ? (
                      <span style={styles.watchedTag}>Watched</span>
                    ) : partial != null ? (
                      <span style={styles.partialTag}>
                        {formatTimecode(seen!.durationMs - seen!.positionMs)} left
                      </span>
                    ) : null}
                  </div>
                  {ep.summary && (
                    <p style={styles.episodeSummary}>{ep.summary}</p>
                  )}
                </div>
              </button>
            );
          })}
          {/* Below the list, not above it.
              Above, it displaced every episode by its own height the moment a
              season turned out to be incomplete — the page shifted down for a
              control most people never press. Here it can only grow downward,
              so nothing already on screen moves. Rendered at all only when the
              season has gaps, and collapsed until asked: a complete season
              should look complete, and one still airing shouldn't open with a
              list of episodes that don't exist yet. */}
          {gaps.length > 0 && (
            <button
              type="button"
              onClick={() => setShowGaps((v) => !v)}
              onMouseEnter={() => setGapToggleHover(true)}
              onMouseLeave={() => setGapToggleHover(false)}
              style={{
                ...styles.gapToggle,
                ...(gapToggleHover ? styles.gapToggleHover : {}),
              }}
              aria-expanded={showGaps}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                <path
                  d={showGaps ? "M3 10.5L8 5.5L13 10.5" : "M3 5.5L8 10.5L13 5.5"}
                  stroke="currentColor" strokeWidth="1.8"
                  strokeLinecap="round" strokeLinejoin="round"
                />
              </svg>
              {showGaps ? "Hide" : "Show"} {gapLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: "100vh", background: "#0d0d0d" },
  backBtn: {
    display: "flex", alignItems: "center", gap: "6px",
    margin: "16px 24px", padding: "8px 16px", borderRadius: "8px",
    border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.05)",
    color: "#f0f0f0", cursor: "pointer", fontSize: "14px", fontWeight: 500, fontFamily: "inherit",
  },
  breadcrumb: {
    display: "flex", alignItems: "center", gap: "8px",
    padding: "0 24px 16px", maxWidth: "1100px", margin: "0 auto",
  },
  // Strips native button chrome so the linked crumb matches the static text.
  // Spread before breadcrumbShow so its font/color win.
  buttonReset: {
    background: "transparent", border: "none", padding: 0, margin: 0,
    fontFamily: "inherit", cursor: "pointer",
  },
  breadcrumbShow: { fontSize: "14px", color: "#888", fontWeight: 500 },
  breadcrumbSep: { fontSize: "16px", color: "#555" },
  breadcrumbSeason: { fontSize: "14px", color: "#e5a00d", fontWeight: 600 },
  loadingWrap: { display: "flex", justifyContent: "center", padding: "64px" },
  spinner: {
    width: "32px", height: "32px",
    border: "3px solid rgba(255,255,255,0.1)", borderTopColor: "#e5a00d",
    borderRadius: "50%", animation: "spin 0.8s linear infinite",
  },
  empty: { textAlign: "center", padding: "64px", color: "#666", fontSize: "15px" },
  list: {
    maxWidth: "1100px", margin: "0 auto", padding: "0 24px 48px",
    display: "flex", flexDirection: "column", gap: "10px",
  },
  episodeCard: {
    // `border` here and in episodeCardHover must stay the same property. React
    // clears style keys the next render drops by assigning "", and because the
    // shorthand has already expanded into border-color in the CSSOM, clearing a
    // borderColor override doesn't fall back to this line — it falls back to
    // the CSS initial value, currentColor, i.e. the near-white text colour. That
    // left every hovered card wearing a solid white border afterwards.
    display: "flex", gap: "14px", padding: "10px", borderRadius: "8px",
    border: "1px solid rgba(255,255,255,0.06)", background: "rgba(255,255,255,0.03)",
    cursor: "pointer", color: "inherit", textAlign: "left", fontFamily: "inherit",
    transition: "all 0.2s ease", width: "100%",
  },
  episodeCardHover: {
    // Whole `border` shorthand, not just borderColor: the base style sets
    // `border`, and an override that names only the longhand leaves React
    // unable to restore it. See the note on episodeCard.
    border: "1px solid rgba(229,160,13,0.3)", background: "rgba(255,255,255,0.05)",
    transform: "scale(1.01)",
  },
  thumbWrap: {
    width: "200px", height: "112px", borderRadius: "6px", flexShrink: 0,
    position: "relative", overflow: "hidden", background: "rgba(255,255,255,0.03)",
  },
  episodeThumb: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  episodePlaceholder: {
    width: "100%", height: "100%", display: "flex", alignItems: "center",
    justifyContent: "center", color: "#555", fontSize: "12px", fontWeight: 500,
  },
  playOverlay: {
    position: "absolute", inset: 0, display: "flex", alignItems: "center",
    justifyContent: "center", transition: "opacity 0.2s ease", background: "rgba(0,0,0,0.3)",
  },
  playCircle: {
    width: "36px", height: "36px", borderRadius: "50%", background: "rgba(0,0,0,0.6)",
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  durationBadge: {
    position: "absolute", bottom: "4px", right: "6px",
    background: "rgba(0,0,0,0.7)", padding: "1px 6px", borderRadius: "3px",
    fontSize: "10px", color: "#ccc",
  },
  episodeInfo: {
    display: "flex", flexDirection: "column", justifyContent: "center",
    gap: "4px", flex: 1, minWidth: 0,
  },
  episodeMeta: { display: "flex", alignItems: "center", gap: "8px" },
  episodeNumber: { color: "#e5a00d", fontSize: "12px", fontWeight: 700 },
  episodeTitle: {
    color: "#f0f0f0", fontSize: "14px", fontWeight: 500,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  queueBtn: {
    position: "absolute", bottom: "8px", right: "8px",
    padding: "4px 10px", borderRadius: "6px",
    border: "1px solid rgba(229,160,13,0.4)", background: "rgba(0,0,0,0.6)",
    color: "#e5a00d", fontSize: "11px", fontWeight: 600,
    cursor: "pointer", fontFamily: "inherit",
  },
  thumbWatched: { opacity: 0.45 },
  watchedBadge: {
    position: "absolute", top: "6px", right: "6px",
    width: "22px", height: "22px", borderRadius: "50%",
    display: "flex", alignItems: "center", justifyContent: "center",
    background: "rgba(0,0,0,0.72)", color: "#6a9955",
  },
  progressTrack: {
    position: "absolute", left: 0, right: 0, bottom: 0,
    height: "4px", background: "rgba(0,0,0,0.55)",
  },
  progressFill: { height: "100%", background: "#e5a00d" },
  watchedTag: {
    flexShrink: 0, color: "#6a9955", fontSize: "11px", fontWeight: 600,
    letterSpacing: "0.3px", textTransform: "uppercase" as const,
  },
  partialTag: {
    flexShrink: 0, color: "rgba(229,160,13,0.75)", fontSize: "11px", fontWeight: 600,
  },
  episodeSummary: {
    color: "#888", fontSize: "12px", lineHeight: "1.4", margin: 0,
    display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
  },
  // ─── Missing / unaired episodes ────────────────────────────────
  // Same card, turned down. The shape stays identical to a real episode so the
  // list reads as one season rather than two lists; everything that says "you
  // can't play this" is a matter of contrast, not of layout.
  gapToggle: {
    // Full width and dashed, matching the cards it reveals — it reads as the
    // end of the list rather than a control bolted underneath it.
    display: "flex", alignItems: "center", justifyContent: "center", gap: "7px",
    width: "100%", padding: "11px", borderRadius: "8px",
    // Full shorthand, as everywhere else in this file — see episodeCard.
    border: "1px dashed rgba(255,255,255,0.12)", background: "transparent",
    color: "#8a8a8a", fontSize: "12px", fontWeight: 600,
    cursor: "pointer", fontFamily: "inherit", transition: "all 0.2s ease",
  },
  gapToggleHover: {
    border: "1px dashed rgba(255,255,255,0.22)", background: "rgba(255,255,255,0.03)",
    color: "#bbb",
  },
  gapCard: {
    // No hover, no pointer: nothing here responds to a click.
    cursor: "default",
    background: "rgba(255,255,255,0.015)",
    border: "1px dashed rgba(255,255,255,0.09)",
  },
  gapThumb: { opacity: 0.35, filter: "grayscale(0.6)" },
  gapDurationBadge: { background: "rgba(0,0,0,0.5)", color: "#777" },
  gapEpisodeNumber: { color: "rgba(229,160,13,0.45)", fontSize: "12px", fontWeight: 700 },
  gapEpisodeTitle: {
    color: "#8a8a8a", fontSize: "14px", fontWeight: 500,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  missingTag: {
    flexShrink: 0, color: "#c98a3e", fontSize: "11px", fontWeight: 600,
    letterSpacing: "0.3px", textTransform: "uppercase" as const,
  },
  unairedTag: {
    flexShrink: 0, color: "#6c7a89", fontSize: "11px", fontWeight: 600,
    letterSpacing: "0.3px", textTransform: "uppercase" as const,
  },
  gapSummary: {
    color: "#666", fontSize: "12px", lineHeight: "1.4", margin: 0,
    display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
  },
  airDate: { color: "#7d7d7d", fontWeight: 600 },
};
