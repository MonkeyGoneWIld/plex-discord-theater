import { useState, useEffect } from "react";
import {
  authUrl, fetchDiscoverMeta, fetchSeerrStatus, seerrRequest,
  type PlexItem, type DiscoverMeta, type SeerrMediaType,
} from "../lib/api";

interface ExternalDetailProps {
  item: PlexItem;
  onBack: () => void;
}

function formatRuntime(ms: number | null): string {
  if (!ms) return "";
  const min = Math.round(ms / 60000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Seerr MediaStatus → label for an already-tracked title.
const STATUS_LABEL: Record<number, string> = {
  2: "Requested",
  3: "Processing",
  4: "Partially available",
  5: "Available",
};

/**
 * Detail view for an online (Discover) title the user doesn't own. Shows the
 * richer provider metadata (summary, genres, runtime) when available, falling
 * back to what search already gave us, plus a placeholder Request button.
 */
export function ExternalDetail({ item, onBack }: ExternalDetailProps) {
  const [meta, setMeta] = useState<DiscoverMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const mediaType: SeerrMediaType = item.type === "show" ? "tv" : "movie";

  // Seerr request state. configured: null=unknown, then true/false. status is the
  // MediaStatus (null = not requested).
  const [seerrConfigured, setSeerrConfigured] = useState<boolean | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  useEffect(() => {
    if (!item.guid) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchDiscoverMeta(item.guid)
      .then((m) => { if (!cancelled) setMeta(m); })
      .catch(() => { /* degrade to the fields search already provided */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [item.guid]);

  // Once we know the TMDB id, pull the current request/availability status.
  const tmdbId = meta?.tmdbId ?? null;
  useEffect(() => {
    if (tmdbId == null) return;
    let cancelled = false;
    fetchSeerrStatus(tmdbId, mediaType)
      .then((s) => { if (!cancelled) { setSeerrConfigured(s.configured); setStatus(s.status); } })
      .catch(() => { if (!cancelled) setSeerrConfigured(false); });
    return () => { cancelled = true; };
  }, [tmdbId, mediaType]);

  const handleRequest = () => {
    if (tmdbId == null || requesting) return;
    setRequesting(true);
    setRequestError(null);
    seerrRequest(tmdbId, mediaType)
      .then((r) => setStatus(r.status ?? 2))
      .catch((err) => setRequestError(err instanceof Error ? err.message : "Request failed"))
      .finally(() => setRequesting(false));
  };

  // Prefer detail metadata; fall back to what the search result carried.
  const title = meta?.title ?? item.title;
  const year = meta?.year ?? item.year ?? null;
  const poster = meta?.thumb ?? item.thumb;
  const summary = meta?.summary ?? item.summary ?? null;
  const genres = meta?.genres ?? [];
  const runtime = formatRuntime(meta?.duration ?? null);
  const rating = meta?.contentRating ?? null;
  const facts = [year, runtime, rating].filter(Boolean).join("  ·  ");
  const statusLabel = status != null ? STATUS_LABEL[status] ?? null : null;

  return (
    <div style={styles.container}>
      <button onClick={onBack} style={styles.backBtn}>
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Back
      </button>
      <div style={styles.body}>
        {poster ? (
          <img src={authUrl(poster)} alt={title} style={styles.poster} />
        ) : (
          <div style={{ ...styles.poster, ...styles.posterPlaceholder }}>No Poster</div>
        )}
        <div style={styles.info}>
          <div style={styles.badge}>Not in your library</div>
          <h1 style={styles.title}>{title}</h1>
          {facts && <div style={styles.facts}>{facts}</div>}
          {genres.length > 0 && (
            <div style={styles.genres}>
              {genres.map((g) => (
                <span key={g} style={styles.genre}>{g}</span>
              ))}
            </div>
          )}
          {loading && !summary ? (
            <div style={styles.summaryMuted}>Loading details…</div>
          ) : summary ? (
            <p style={styles.summary}>{summary}</p>
          ) : (
            <div style={styles.summaryMuted}>No description available.</div>
          )}
          {/* Request button — hidden when Seerr isn't configured or the title has
              no TMDB id to request by. Shows the tracked status when already
              requested, otherwise a live Request action. */}
          {seerrConfigured !== false && tmdbId != null && (
            statusLabel ? (
              <button disabled style={{ ...styles.requestBtn, ...styles.requestBtnDone }}>
                {statusLabel}
              </button>
            ) : (
              <button
                onClick={handleRequest}
                disabled={requesting || seerrConfigured == null}
                style={styles.requestBtn}
              >
                {requesting ? "Requesting…" : "Request"}
              </button>
            )
          )}
          {requestError && <div style={styles.requestError}>{requestError}</div>}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: "100%",
  },
  // Matches MovieDetail's back button so navigation is consistent across pages.
  backBtn: {
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
  },
  body: {
    display: "flex",
    gap: "24px",
    alignItems: "flex-start",
    flexWrap: "wrap",
    maxWidth: "900px",
    margin: "0 auto",
    padding: "8px 24px 40px",
  },
  poster: {
    width: "220px",
    aspectRatio: "2/3",
    objectFit: "cover",
    borderRadius: "12px",
    flexShrink: 0,
    background: "rgba(255,255,255,0.04)",
  },
  posterPlaceholder: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#555",
    fontSize: "13px",
    fontWeight: 500,
  },
  info: {
    flex: 1,
    minWidth: "260px",
  },
  badge: {
    display: "inline-block",
    padding: "3px 8px",
    borderRadius: "5px",
    background: "rgba(255,255,255,0.08)",
    color: "rgba(255,255,255,0.7)",
    fontSize: "11px",
    fontWeight: 600,
    letterSpacing: "0.3px",
    textTransform: "uppercase",
    marginBottom: "12px",
  },
  title: {
    fontSize: "26px",
    fontWeight: 700,
    color: "#f0f0f0",
    margin: "0 0 8px",
    lineHeight: 1.2,
  },
  facts: {
    color: "#888",
    fontSize: "14px",
    marginBottom: "14px",
  },
  genres: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    marginBottom: "16px",
  },
  genre: {
    padding: "3px 10px",
    borderRadius: "12px",
    background: "rgba(255,255,255,0.05)",
    color: "#bbb",
    fontSize: "12px",
    fontWeight: 500,
  },
  summary: {
    color: "#ccc",
    fontSize: "15px",
    lineHeight: 1.6,
    margin: "0 0 24px",
  },
  summaryMuted: {
    color: "#666",
    fontSize: "14px",
    margin: "0 0 24px",
  },
  requestBtn: {
    padding: "11px 24px",
    borderRadius: "10px",
    border: "none",
    background: "#e5a00d",
    color: "#000",
    fontSize: "15px",
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  requestBtnDone: {
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(229,160,13,0.6)",
    color: "#e5a00d",
    cursor: "default",
  },
  requestError: {
    marginTop: "10px",
    color: "#e5834a",
    fontSize: "13px",
  },
};
