import { useState, useEffect, useCallback } from "react";
import { fetchSeerrTv, seerrRequest, type SeerrSeason } from "../lib/api";

interface SeasonRequestPanelProps {
  tmdbId: number;
  /** Section heading (default "Seasons"). */
  heading?: string;
  /** Drop seasons already in the library — used on the library show view where
   *  owned seasons already appear in the playable grid above. */
  hideAvailable?: boolean;
  /** Season numbers already in the local library. Source of truth for "owned",
   *  independent of Seerr's sync state. */
  ownedSeasons?: number[];
}

// Seerr MediaStatus → per-season badge.
const SEASON_STATUS: Record<number, { label: string; color: string }> = {
  2: { label: "Requested", color: "#e5a00d" },
  3: { label: "Processing", color: "#5aa9e6" },
  4: { label: "Partial", color: "#e5a00d" },
  5: { label: "In library", color: "#4caf7d" },
};

/**
 * Per-season availability + multi-select requesting for a show. Seasons already
 * owned/requested show a status badge; the rest are selectable and requested via
 * Seerr. Renders nothing when Seerr isn't configured or there are no seasons.
 */
export function SeasonRequestPanel({
  tmdbId, heading = "Seasons", hideAvailable = false, ownedSeasons = [],
}: SeasonRequestPanelProps) {
  const [seasons, setSeasons] = useState<SeerrSeason[] | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchSeerrTv(tmdbId)
      .then((tv) => { setConfigured(tv.configured); setSeasons(tv.seasons); })
      .catch(() => setConfigured(false));
  }, [tmdbId]);

  useEffect(() => { load(); }, [load]);

  const toggle = (n: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n); else next.add(n);
      return next;
    });

  // A season counts as owned if it's in the local library or Seerr reports it
  // available. On the library view (hideAvailable) owned seasons are dropped —
  // they're already in the playable grid above.
  const ownedSet = new Set(ownedSeasons);
  const isOwned = (s: SeerrSeason) => ownedSet.has(s.seasonNumber) || s.status === 5;
  const visible = (seasons ?? []).filter((s) => !hideAvailable || !isOwned(s));
  const requestable = visible.filter((s) => s.status == null && !isOwned(s));
  const allSelected = requestable.length > 0 && requestable.every((s) => selected.has(s.seasonNumber));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(requestable.map((s) => s.seasonNumber)));

  const submit = () => {
    if (selected.size === 0 || requesting) return;
    setRequesting(true);
    setError(null);
    seerrRequest(tmdbId, "tv", [...selected])
      .then(() => { setSelected(new Set()); load(); })
      .catch((err) => setError(err instanceof Error ? err.message : "Request failed"))
      .finally(() => setRequesting(false));
  };

  if (configured === false) return null;
  if (!seasons) return <div style={styles.loading}>Loading seasons…</div>;
  if (visible.length === 0) return null;

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.heading}>{heading}</span>
        {requestable.length > 0 && (
          <button onClick={toggleAll} style={styles.selectAll}>
            {allSelected ? "Clear" : "Select all missing"}
          </button>
        )}
      </div>
      <div style={styles.list}>
        {visible.map((s) => {
          const owned = isOwned(s);
          const st = owned
            ? { label: "In library", color: "#4caf7d" }
            : s.status != null ? SEASON_STATUS[s.status] : null;
          const selectable = !owned && s.status == null;
          const isSel = selected.has(s.seasonNumber);
          return (
            <button
              key={s.seasonNumber}
              onClick={selectable ? () => toggle(s.seasonNumber) : undefined}
              disabled={!selectable}
              style={{
                ...styles.row,
                ...(selectable ? styles.rowSelectable : {}),
                ...(isSel ? styles.rowSelected : {}),
              }}
            >
              {selectable && (
                <span style={{ ...styles.check, ...(isSel ? styles.checkOn : {}) }}>{isSel ? "✓" : ""}</span>
              )}
              <span style={styles.seasonName}>{s.name}</span>
              {s.episodeCount > 0 && <span style={styles.episodes}>{s.episodeCount} ep</span>}
              {st && (
                <span style={{ ...styles.statusBadge, color: st.color, borderColor: st.color }}>
                  {st.label}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {selected.size > 0 && (
        <button onClick={submit} disabled={requesting} style={styles.requestBtn}>
          {requesting ? "Requesting…" : `Request ${selected.size} season${selected.size > 1 ? "s" : ""}`}
        </button>
      )}
      {error && <div style={styles.error}>{error}</div>}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: { marginTop: "20px" },
  loading: { marginTop: "20px", color: "#666", fontSize: "14px" },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "10px",
  },
  heading: { fontSize: "16px", fontWeight: 600, color: "#f0f0f0" },
  selectAll: {
    background: "none",
    border: "none",
    color: "#e5a00d",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  list: { display: "flex", flexDirection: "column", gap: "6px" },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    width: "100%",
    padding: "10px 12px",
    borderRadius: "8px",
    border: "1px solid rgba(255,255,255,0.06)",
    background: "rgba(255,255,255,0.03)",
    color: "#ddd",
    fontSize: "14px",
    fontFamily: "inherit",
    textAlign: "left",
    cursor: "default",
  },
  rowSelectable: { cursor: "pointer" },
  rowSelected: { borderColor: "rgba(229,160,13,0.6)", background: "rgba(229,160,13,0.08)" },
  check: {
    width: "18px",
    height: "18px",
    flexShrink: 0,
    borderRadius: "4px",
    border: "1px solid rgba(255,255,255,0.25)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "12px",
    color: "#000",
  },
  checkOn: { background: "#e5a00d", borderColor: "#e5a00d" },
  seasonName: { flex: 1, minWidth: 0, fontWeight: 500, color: "#f0f0f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  episodes: { color: "#777", fontSize: "12px", flexShrink: 0 },
  statusBadge: {
    flexShrink: 0,
    padding: "2px 8px",
    borderRadius: "10px",
    border: "1px solid",
    fontSize: "11px",
    fontWeight: 600,
    background: "rgba(0,0,0,0.2)",
  },
  requestBtn: {
    marginTop: "12px",
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
  error: { marginTop: "10px", color: "#e5834a", fontSize: "13px" },
};
