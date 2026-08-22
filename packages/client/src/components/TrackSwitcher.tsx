import { useState, useEffect } from "react";
import { fetchMeta, versionOf, type StreamTrack } from "../lib/api";
import { saveAudioPref, saveSubtitlePref } from "../lib/trackPrefs";

interface TrackSwitcherProps {
  ratingKey: string;
  /** Which of the title's files is playing, for the few Plex holds more than one
   *  of. Stream ids belong to a file, so listing the default copy's tracks while
   *  a different one plays offers choices that quietly do nothing. Undefined
   *  resolves to the default, which is what a single-file title has. */
  mediaIndex?: number;
  onClose: () => void;
  onTrackChange: (partId: number, audioStreamID?: number, subtitleStreamID?: number) => void;
  /**
   * Who a change here affects.
   *
   * "room" for the host, whose choice carries to everyone watching their stream;
   * "self" for everybody else, who forks onto a stream of their own. Both get
   * the full choice of tracks — the difference is only in the reach, and saying
   * so is the point: a host changing the audio for six people should know that
   * is what they are doing.
   */
  scope?: "room" | "self";
  /**
   * The tracks this client is actually watching.
   *
   * Not read from the metadata's `selected` flags any more. Those describe the
   * *item*, which is now pointed at whichever stream started most recently — so
   * a viewer who turned subtitles off saw English still ticked the moment
   * anybody else started an English stream. The room has several answers to
   * "which track is playing" and only one of them is yours.
   */
  currentAudioId?: number | null;
  currentSubtitleId?: number | null;
}

export function TrackSwitcher({
  ratingKey,
  mediaIndex,
  onClose,
  onTrackChange,
  scope = "self",
  currentAudioId,
  currentSubtitleId,
}: TrackSwitcherProps) {
  const [tab, setTab] = useState<"audio" | "subtitles">("audio");
  const [audioTracks, setAudioTracks] = useState<StreamTrack[]>([]);
  const [subtitleTracks, setSubtitleTracks] = useState<StreamTrack[]>([]);
  const [partId, setPartId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMeta(ratingKey)
      .then((meta) => {
        const version = versionOf(meta, mediaIndex);
        setAudioTracks(version.audioTracks);
        setSubtitleTracks(version.subtitleTracks);
        setPartId(version.partId);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [ratingKey, mediaIndex]);

  // What this client is on. Falls back to the item's own flags only when the
  // player didn't say — an older caller, or before the first assignment lands.
  const activeAudio = currentAudioId ?? audioTracks.find((t) => t.selected)?.id ?? null;
  const activeSubtitle =
    currentSubtitleId ?? subtitleTracks.find((t) => t.selected)?.id ?? 0;

  const handleSelect = (type: "audio" | "subtitle", streamId: number) => {
    if (partId == null) return;
    if (type === "audio") {
      // Remembered by language, like the subtitle below, so the next episode
      // starts on the same one rather than the file's default.
      saveAudioPref(audioTracks.find((t) => t.id === streamId) ?? null);
      onTrackChange(partId, streamId, undefined);
    } else {
      // Remember the choice (streamId 0 is the "None" row) so the next episode
      // comes up with the same kind of subtitle already on.
      saveSubtitlePref(subtitleTracks.find((t) => t.id === streamId) ?? null);
      onTrackChange(partId, undefined, streamId);
    }
    onClose();
  };

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.headerTitle}>Audio &amp; Subtitles</span>
          <button className="btn" onClick={onClose} style={styles.closeBtn}>{"\u2715"}</button>
        </div>

        <div style={styles.tabs}>
            <button className="btn"
              onClick={() => setTab("audio")}
              style={{ ...styles.tab, ...(tab === "audio" ? styles.tabActive : {}) }}
            >Audio</button>
            <button className="btn"
              onClick={() => setTab("subtitles")}
              style={{ ...styles.tab, ...(tab === "subtitles" ? styles.tabActive : {}) }}
            >Subtitles</button>
        </div>

        {/* What a change here reaches. The host's carries; everyone else's
            forks onto a stream of their own, which nobody else sees. */}
        <p style={styles.scopeNote}>
          {scope === "room"
            ? "Changes apply to everyone watching your stream."
            : "Changes apply to you only."}
        </p>

        {loading ? (
          <div style={styles.loading}>Loading tracks...</div>
        ) : tab === "audio" ? (
          <div style={styles.trackList}>
            {audioTracks.map((t) => {
              const on = t.id === activeAudio;
              return (
                <button className="btn"
                  key={t.id}
                  onClick={() => handleSelect("audio", t.id)}
                  style={on ? styles.trackSelected : styles.track}
                >
                  <div>
                    <div style={{ color: on ? "#f0f0f0" : "#ccc", fontSize: 13 }}>{t.title}</div>
                    {t.codec && (
                      <div style={{ color: on ? "#888" : "#666", fontSize: 11 }}>
                        {t.codec}{t.channels ? ` ${t.channels}ch` : ""}
                      </div>
                    )}
                  </div>
                  {on && <span style={styles.checkmark}>{"\u2713"}</span>}
                </button>
              );
            })}
          </div>
        ) : (
          <div style={styles.trackList}>
            <button className="btn"
              onClick={() => handleSelect("subtitle", 0)}
              style={!activeSubtitle ? styles.trackSelected : styles.track}
            >
              <div style={{ color: !activeSubtitle ? "#f0f0f0" : "#ccc", fontSize: 13 }}>None</div>
              {!activeSubtitle && <span style={styles.checkmark}>{"\u2713"}</span>}
            </button>
            {subtitleTracks.map((t) => {
              const on = t.id === activeSubtitle;
              return (
                <button className="btn"
                  key={t.id}
                  onClick={() => handleSelect("subtitle", t.id)}
                  style={on ? styles.trackSelected : styles.track}
                >
                  <div style={{ color: on ? "#f0f0f0" : "#ccc", fontSize: 13 }}>{t.title}</div>
                  {on && <span style={styles.checkmark}>{"\u2713"}</span>}
                </button>
              );
            })}
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
  scopeNote: {
    margin: 0,
    padding: "0 16px 10px",
    color: "#7d7d7d",
    fontSize: "12px",
    lineHeight: 1.4,
  },
  loading: { color: "#888", fontSize: 13, textAlign: "center", padding: 20 },
  disclaimer: {
    color: "#666", fontSize: 11, lineHeight: "1.4",
    borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 12,
  },
};
