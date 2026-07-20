import { useState, useEffect } from "react";
import { fetchMeta, type StreamTrack } from "../lib/api";

interface TrackSwitcherProps {
  ratingKey: string;
  onClose: () => void;
  onTrackChange: (partId: number, audioStreamID?: number, subtitleStreamID?: number) => void;
  /** Co-hosts may change subtitles but not audio — hides the Audio tab. */
  subtitlesOnly?: boolean;
}

export function TrackSwitcher({ ratingKey, onClose, onTrackChange, subtitlesOnly = false }: TrackSwitcherProps) {
  const [tab, setTab] = useState<"audio" | "subtitles">(subtitlesOnly ? "subtitles" : "audio");
  const [audioTracks, setAudioTracks] = useState<StreamTrack[]>([]);
  const [subtitleTracks, setSubtitleTracks] = useState<StreamTrack[]>([]);
  const [partId, setPartId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMeta(ratingKey)
      .then((meta) => {
        setAudioTracks(meta.audioTracks);
        setSubtitleTracks(meta.subtitleTracks);
        setPartId(meta.partId);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [ratingKey]);

  const handleSelect = (type: "audio" | "subtitle", streamId: number) => {
    if (partId == null) return;
    if (type === "audio") {
      onTrackChange(partId, streamId, undefined);
    } else {
      onTrackChange(partId, undefined, streamId);
    }
    onClose();
  };

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.headerTitle}>{subtitlesOnly ? "Subtitles" : "Track Settings"}</span>
          <button onClick={onClose} style={styles.closeBtn}>{"\u2715"}</button>
        </div>

        {!subtitlesOnly && (
          <div style={styles.tabs}>
            <button
              onClick={() => setTab("audio")}
              style={{ ...styles.tab, ...(tab === "audio" ? styles.tabActive : {}) }}
            >Audio</button>
            <button
              onClick={() => setTab("subtitles")}
              style={{ ...styles.tab, ...(tab === "subtitles" ? styles.tabActive : {}) }}
            >Subtitles</button>
          </div>
        )}

        {loading ? (
          <div style={styles.loading}>Loading tracks...</div>
        ) : tab === "audio" ? (
          <div style={styles.trackList}>
            {audioTracks.map((t) => (
              <button
                key={t.id}
                onClick={() => handleSelect("audio", t.id)}
                style={t.selected ? styles.trackSelected : styles.track}
              >
                <div>
                  <div style={{ color: t.selected ? "#f0f0f0" : "#ccc", fontSize: 13 }}>{t.title}</div>
                  {t.codec && (
                    <div style={{ color: t.selected ? "#888" : "#666", fontSize: 11 }}>
                      {t.codec}{t.channels ? ` ${t.channels}ch` : ""}
                    </div>
                  )}
                </div>
                {t.selected && <span style={styles.checkmark}>{"\u2713"}</span>}
              </button>
            ))}
          </div>
        ) : (
          <div style={styles.trackList}>
            <button
              onClick={() => handleSelect("subtitle", 0)}
              style={!subtitleTracks.some((t) => t.selected) ? styles.trackSelected : styles.track}
            >
              <div style={{ color: !subtitleTracks.some((t) => t.selected) ? "#f0f0f0" : "#ccc", fontSize: 13 }}>None</div>
              {!subtitleTracks.some((t) => t.selected) && <span style={styles.checkmark}>{"\u2713"}</span>}
            </button>
            {subtitleTracks.map((t) => (
              <button
                key={t.id}
                onClick={() => handleSelect("subtitle", t.id)}
                style={t.selected ? styles.trackSelected : styles.track}
              >
                <div style={{ color: t.selected ? "#f0f0f0" : "#ccc", fontSize: 13 }}>{t.title}</div>
                {t.selected && <span style={styles.checkmark}>{"\u2713"}</span>}
              </button>
            ))}
          </div>
        )}

        <div style={styles.disclaimer}>
          Changing tracks briefly restarts the stream at your current position.
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "absolute",
    inset: 0,
    background: "rgba(0,0,0,0.6)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 20,
  },
  modal: {
    width: 320,
    background: "rgba(13,13,13,0.95)",
    backdropFilter: "blur(20px)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 12,
    padding: 20,
    display: "flex",
    flexDirection: "column",
    gap: 18,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerTitle: { color: "#f0f0f0", fontSize: 15, fontWeight: 600 },
  closeBtn: {
    width: 28, height: 28, borderRadius: "50%",
    background: "rgba(255,255,255,0.08)", border: "none",
    color: "#aaa", fontSize: 14, cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit",
  },
  tabs: {
    display: "flex", borderRadius: 8, overflow: "hidden",
    border: "1px solid rgba(255,255,255,0.08)",
  },
  tab: {
    flex: 1, padding: "8px", textAlign: "center",
    background: "rgba(255,255,255,0.03)", color: "#888",
    fontSize: 12, fontWeight: 500, border: "none", cursor: "pointer", fontFamily: "inherit",
  },
  tabActive: {
    background: "rgba(229,160,13,0.15)", color: "#e5a00d", fontWeight: 600,
  },
  trackList: {
    display: "flex", flexDirection: "column", gap: 4, maxHeight: 240, overflowY: "auto",
  },
  track: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "8px 10px", borderRadius: 6,
    background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)",
    cursor: "pointer", textAlign: "left", fontFamily: "inherit", color: "inherit",
  },
  trackSelected: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "8px 10px", borderRadius: 6,
    background: "rgba(229,160,13,0.12)", border: "1px solid rgba(229,160,13,0.3)",
    cursor: "pointer", textAlign: "left", fontFamily: "inherit", color: "inherit",
  },
  checkmark: { color: "#e5a00d", fontSize: 12 },
  loading: { color: "#888", fontSize: 13, textAlign: "center", padding: 20 },
  disclaimer: {
    color: "#666", fontSize: 11, lineHeight: "1.4",
    borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 12,
  },
};
