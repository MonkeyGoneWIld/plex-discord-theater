import { useState, type ReactNode } from "react";
import { authUrl, seerrRequest, seerrPosterUrl, type SeerrSeason } from "../lib/api";

interface SeasonRequestGridProps {
  /** TMDB id for making requests; null renders the grid without request UI. */
  tmdbId: number | null;
  /** Seasons to render as request cards (typically the ones not in the library). */
  seasons: SeerrSeason[];
  /** Called after a successful request so the parent can re-fetch statuses. */
  onRequested: () => void;
  title?: string;
  /** Playable season cards (library shows) rendered ahead of the request cards. */
  children?: ReactNode;
}

// Seerr MediaStatus → badge for a season card.
const SEASON_STATUS: Record<number, { label: string; color: string }> = {
  2: { label: "Requested", color: "#e5a00d" },
  3: { label: "Processing", color: "#5aa9e6" },
  4: { label: "Partial", color: "#e5a00d" },
  5: { label: "In library", color: "#4caf7d" },
};

/**
 * The season grid shared by the library show page and the Discover detail page:
 * poster cards for seasons that can be requested (dimmed TMDB art, checkbox
 * multi-select), with "Select all missing" and the request button in the header.
 * Library pages pass their playable season cards as children so owned and
 * missing seasons share one grid.
 */
export function SeasonRequestGrid({
  tmdbId, seasons, onRequested, title = "Seasons", children,
}: SeasonRequestGridProps) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (n: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n); else next.add(n);
      return next;
    });

  const requestable = tmdbId != null ? seasons.filter((s) => s.status == null) : [];

  const submit = () => {
    if (tmdbId == null || selected.size === 0 || requesting) return;
    setRequesting(true);
    setError(null);
    seerrRequest(tmdbId, "tv", [...selected])
      .then(() => { setSelected(new Set()); onRequested(); })
      .catch((err) => setError(err instanceof Error ? err.message : "Request failed"))
      .finally(() => setRequesting(false));
  };

  return (
    <div>
      <div style={styles.header}>
        <h2 style={styles.title}>{title}</h2>
        {requestable.length > 0 && (
          <div style={styles.controls}>
            <button
              onClick={() =>
                setSelected(
                  selected.size === requestable.length
                    ? new Set()
                    : new Set(requestable.map((s) => s.seasonNumber)),
                )
              }
              style={styles.selectAllBtn}
            >
              {selected.size === requestable.length ? "Clear" : "Select all missing"}
            </button>
            <button
              onClick={submit}
              disabled={selected.size === 0 || requesting}
              style={{
                ...styles.requestBtn,
                ...(selected.size === 0 || requesting ? styles.requestBtnDisabled : {}),
              }}
            >
              {requesting
                ? "Requesting…"
                : selected.size > 0
                  ? `Request ${selected.size} season${selected.size > 1 ? "s" : ""}`
                  : "Request seasons"}
            </button>
          </div>
        )}
      </div>
      {error && <div style={styles.error}>{error}</div>}
      <div style={styles.grid}>
        {children}
        {seasons.map((s) => {
          const badge = s.status != null ? SEASON_STATUS[s.status] : null;
          const selectable = tmdbId != null && s.status == null;
          const isSel = selected.has(s.seasonNumber);
          const poster = seerrPosterUrl(s.posterPath);
          return (
            <button
              key={`request-${s.seasonNumber}`}
              onClick={selectable ? () => toggle(s.seasonNumber) : undefined}
              disabled={!selectable}
              style={{
                ...styles.card,
                ...(selectable ? { cursor: "pointer" } : {}),
                ...(isSel ? styles.cardSelected : {}),
              }}
            >
              <div style={styles.posterWrap}>
                {poster ? (
                  <img src={authUrl(poster)} alt={s.name} style={styles.poster} loading="lazy" />
                ) : (
                  <div style={styles.placeholder}>No Poster</div>
                )}
                {selectable && (
                  <span style={{ ...styles.check, ...(isSel ? styles.checkOn : {}) }}>
                    {isSel ? "✓" : ""}
                  </span>
                )}
                {badge && (
                  <div style={{ ...styles.statusBadge, color: badge.color, borderColor: badge.color }}>
                    {badge.label}
                  </div>
                )}
                {!badge && !isSel && <div style={styles.missingLabel}>Not in library</div>}
              </div>
              <div style={styles.info}>
                <div style={styles.cardTitle}>{s.name}</div>
                {s.episodeCount > 0 && (
                  <div style={styles.episodes}>
                    {s.episodeCount} {s.episodeCount === 1 ? "episode" : "episodes"}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    flexWrap: "wrap",
    marginBottom: "16px",
  },
  title: {
    fontSize: "20px",
    fontWeight: 600,
    color: "#e0e0e0",
    margin: 0,
  },
  controls: {
    display: "flex",
    alignItems: "center",
    gap: "14px",
  },
  selectAllBtn: {
    background: "none",
    border: "none",
    color: "#e5a00d",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  requestBtn: {
    padding: "9px 20px",
    borderRadius: "8px",
    border: "none",
    background: "#e5a00d",
    color: "#000",
    fontSize: "14px",
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  requestBtnDisabled: {
    background: "rgba(229,160,13,0.25)",
    color: "rgba(0,0,0,0.6)",
    cursor: "default",
  },
  error: {
    color: "#e5834a",
    fontSize: "13px",
    marginBottom: "12px",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
    gap: "14px",
  },
  // Request card — matches MovieCard's shape, dimmed poster.
  card: {
    background: "#141414",
    borderRadius: "10px",
    overflow: "hidden",
    border: "1px solid rgba(255,255,255,0.06)",
    color: "inherit",
    textAlign: "left",
    width: "100%",
    padding: 0,
    fontFamily: "inherit",
    cursor: "default",
    transition: "border-color 0.15s ease, box-shadow 0.15s ease",
  },
  cardSelected: {
    borderColor: "rgba(229,160,13,0.7)",
    boxShadow: "0 0 0 1px rgba(229,160,13,0.4)",
  },
  posterWrap: {
    position: "relative",
  },
  poster: {
    width: "100%",
    aspectRatio: "2/3",
    objectFit: "cover",
    display: "block",
    opacity: 0.55,
  },
  placeholder: {
    width: "100%",
    aspectRatio: "2/3",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(255,255,255,0.03)",
    color: "#555",
    fontSize: "13px",
    fontWeight: 500,
  },
  check: {
    position: "absolute",
    top: "8px",
    right: "8px",
    width: "22px",
    height: "22px",
    borderRadius: "6px",
    border: "1px solid rgba(255,255,255,0.35)",
    background: "rgba(0,0,0,0.55)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "13px",
    color: "#000",
  },
  checkOn: {
    background: "#e5a00d",
    borderColor: "#e5a00d",
  },
  statusBadge: {
    position: "absolute",
    top: "8px",
    left: "8px",
    padding: "3px 8px",
    borderRadius: "5px",
    border: "1px solid",
    background: "rgba(0,0,0,0.7)",
    fontSize: "10px",
    fontWeight: 700,
    letterSpacing: "0.3px",
    textTransform: "uppercase" as const,
  },
  missingLabel: {
    position: "absolute",
    top: "8px",
    left: "8px",
    padding: "3px 7px",
    borderRadius: "5px",
    background: "rgba(0,0,0,0.72)",
    color: "rgba(255,255,255,0.85)",
    fontSize: "10px",
    fontWeight: 600,
    letterSpacing: "0.3px",
    textTransform: "uppercase" as const,
  },
  info: {
    padding: "10px 10px 12px",
  },
  cardTitle: {
    fontSize: "13px",
    fontWeight: 600,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    color: "#e0e0e0",
  },
  episodes: {
    fontSize: "12px",
    color: "#666",
    marginTop: "3px",
    fontWeight: 500,
  },
};
