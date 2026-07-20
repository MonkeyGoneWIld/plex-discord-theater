import { useState, useEffect, useCallback, useRef } from "react";
import { fetchMeta, setStreams, getSessionToken, type PlexItem, type PlexMeta } from "../lib/api";
import { SkeletonBlock } from "./SkeletonBlock";
import type { QueueItem, SuggestionItem } from "../hooks/useSync";

interface MovieDetailProps {
  item: PlexItem;
  isHost: boolean;
  onPlay: (item: PlexItem, subtitles: boolean) => void;
  onBack: () => void;
  isPlaying?: boolean;
  onAddToQueue?: (item: QueueItem) => void;
  /** Viewer-only: suggest this title to the host. Omit/undefined for the host. */
  onSuggest?: (item: SuggestionItem) => void;
}

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
      <button type="button" onClick={() => setOpen((o) => !o)} style={dropdownStyles.trigger}>
        <span style={dropdownStyles.triggerLabel}>{selected?.label ?? ""}</span>
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none" style={{ flexShrink: 0, marginLeft: 8 }}>
          <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div style={dropdownStyles.menu}>
          {options.map((o) => (
            <button
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

export function MovieDetail({ item, isHost, onPlay, onBack, isPlaying, onAddToQueue, onSuggest }: MovieDetailProps) {
  const [meta, setMeta] = useState<PlexMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedAudio, setSelectedAudio] = useState<number | null>(null);
  const [selectedSubtitle, setSelectedSubtitle] = useState<number | null>(null);
  const [suggested, setSuggested] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchMeta(item.ratingKey)
      .then((m) => {
        if (cancelled) return;
        setMeta(m);
        const defaultAudio = m.audioTracks.find((t) => t.selected) ?? m.audioTracks[0];
        if (defaultAudio) setSelectedAudio(defaultAudio.id);
        // Default to no subtitles
        setSelectedSubtitle(null);
      })
      .catch(console.error)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [item.ratingKey]);

  const handlePlay = useCallback(async () => {
    if (!meta?.partId) return;
    try {
      setError(null);
      if (selectedAudio != null) {
        await setStreams(meta.partId, {
          audioStreamID: selectedAudio,
          subtitleStreamID: selectedSubtitle ?? 0,
        });
      }
      onPlay(item, selectedSubtitle != null);
    } catch (err) {
      console.error("Failed to set streams:", err);
      setError("Failed to configure playback. Please try again.");
    }
  }, [meta, selectedAudio, selectedSubtitle, item, onPlay]);

  const backdropUrl = meta?.art ? authUrl(meta.art) : null;
  const posterUrl = meta?.thumb ? authUrl(meta.thumb) : (item.thumb ? authUrl(item.thumb) : null);

  if (loading) {
    return (
      <div style={styles.page}>
        <button onClick={onBack} style={styles.backBtn}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Back
        </button>
        <SkeletonBlock width="100%" height={300} borderRadius={0} />
        <div style={{ display: "flex", gap: "24px", padding: "24px", maxWidth: 1100 }}>
          <SkeletonBlock
            width={item.type === "episode" ? 320 : 180}
            height={item.type === "episode" ? 180 : 270}
            borderRadius={8}
          />
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "12px" }}>
            <SkeletonBlock width="60%" height={24} />
            <SkeletonBlock width="40%" height={16} />
            <div style={{ display: "flex", gap: "8px" }}>
              <SkeletonBlock width={60} height={24} borderRadius={12} />
              <SkeletonBlock width={80} height={24} borderRadius={12} />
              <SkeletonBlock width={50} height={24} borderRadius={12} />
            </div>
            <SkeletonBlock width="100%" height={14} />
            <SkeletonBlock width="90%" height={14} />
            <SkeletonBlock width="70%" height={14} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      {/* Backdrop */}
      {backdropUrl && (
        <div style={styles.backdropWrap}>
          <img src={backdropUrl} alt="" style={styles.backdropImg} />
          <div style={styles.backdropOverlay} />
        </div>
      )}

      {/* Back button */}
      <button onClick={onBack} style={styles.backBtn}>
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Back
      </button>

      {meta ? (
        <div style={styles.content}>
          {/* Poster + Info layout */}
          <div style={styles.layout}>
            {/* Poster */}
            {posterUrl && (
              <div style={{ ...styles.posterWrap, ...(item.type === "episode" ? styles.posterWrapEpisode : {}) }}>
                <img
                  src={posterUrl}
                  alt={meta.title}
                  style={{ ...styles.poster, ...(item.type === "episode" ? styles.posterEpisode : {}) }}
                />
              </div>
            )}

            {/* Info */}
            <div style={styles.info}>
              {/* Episode label */}
              {item.type === "episode" && item.parentIndex != null && item.index != null && (
                <>
                  {item.showTitle && (
                    <div style={styles.episodeShowTitle}>{item.showTitle}</div>
                  )}
                  <div style={styles.episodeLabel}>
                    Season {item.parentIndex}, Episode {item.index}
                  </div>
                </>
              )}

              <h1 style={styles.title}>{meta.title}</h1>

              {/* Meta row */}
              <div style={styles.metaRow}>
                {meta.year && <span style={styles.metaItem}>{meta.year}</span>}
                {meta.duration && (
                  <>
                    <span style={styles.metaDot}>&middot;</span>
                    <span style={styles.metaItem}>{formatDuration(meta.duration)}</span>
                  </>
                )}
              </div>

              {/* Genres */}
              {meta.genres.length > 0 && (
                <div style={styles.genres}>
                  {meta.genres.map((g) => (
                    <span key={g} style={styles.genrePill}>{g}</span>
                  ))}
                </div>
              )}

              {/* Summary */}
              {meta.summary && (
                <p style={styles.summary}>{meta.summary}</p>
              )}

              {/* Audio & Subtitle selectors */}
              <div style={styles.trackRow}>
                {meta.audioTracks.length > 1 && (
                  <div style={styles.trackField}>
                    <label style={styles.trackLabel}>Audio</label>
                    <TrackDropdown
                      value={selectedAudio != null ? String(selectedAudio) : ""}
                      options={meta.audioTracks.map((t) => ({ value: String(t.id), label: t.title }))}
                      onChange={(v) => setSelectedAudio(Number(v))}
                    />
                  </div>
                )}

                {meta.subtitleTracks.length > 0 && (
                  <div style={styles.trackField}>
                    <label style={styles.trackLabel}>Subtitles</label>
                    <TrackDropdown
                      value={selectedSubtitle != null ? String(selectedSubtitle) : ""}
                      options={[
                        { value: "", label: "None" },
                        ...meta.subtitleTracks.map((t) => ({ value: String(t.id), label: t.title })),
                      ]}
                      onChange={(v) => setSelectedSubtitle(v === "" ? null : Number(v))}
                    />
                  </div>
                )}
              </div>

              {error && <p style={styles.errorText}>{error}</p>}

              {/* Play / Waiting */}
              <div style={styles.actions}>
                {isHost ? (
                  <>
                    <button onClick={handlePlay} style={styles.playBtn}>
                      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" style={{ marginRight: 8 }}>
                        <path d="M5 3.5L18 11L5 18.5V3.5Z" fill="currentColor"/>
                      </svg>
                      Play
                    </button>
                    {isPlaying && onAddToQueue && (
                      <button
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
                  <div style={styles.viewerActions}>
                    <p style={styles.waitingText}>Waiting for the host to start playback...</p>
                    {onSuggest && (
                      <button
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
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div style={styles.loadingWrap}>
          <p style={styles.loadingText}>Failed to load metadata</p>
        </div>
      )}
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
  loadingWrap: {
    position: "relative",
    zIndex: 10,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "50vh",
    gap: "16px",
  },
  spinner: {
    width: "32px",
    height: "32px",
    border: "3px solid rgba(255,255,255,0.1)",
    borderTopColor: "#e5a00d",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  },
  loadingText: {
    color: "#888",
    fontSize: "15px",
  },
  content: {
    position: "relative",
    zIndex: 10,
    maxWidth: "1100px",
    margin: "0 auto",
    padding: "0 24px 48px",
  },
  layout: {
    display: "flex",
    gap: "36px",
    alignItems: "flex-start",
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
  episodeShowTitle: {
    fontSize: "15px",
    fontWeight: 600,
    color: "#ccc",
    marginBottom: "4px",
  },
  episodeLabel: {
    fontSize: "13px",
    fontWeight: 600,
    color: "#e5a00d",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    marginBottom: "6px",
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
  },
  viewerActions: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "12px",
    alignItems: "flex-start",
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
  errorText: {
    color: "#e74c3c",
    fontSize: "14px",
    marginBottom: "8px",
  },
};
