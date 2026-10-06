import { useEffect, useState } from "react";
import { fetchHistorySettings, updateHistorySettings, type HistorySaveMode } from "../lib/api";
import { LANGUAGES, languageName, shortLanguageCode } from "../lib/languages";
import { QUALITY_LEVELS_KBPS, defaultQuality, qualityLabel, setDefaultQuality } from "../lib/quality";
import { SAVED_SETTINGS, resetSavedSettings } from "../lib/savedSettings";
import { useSubtitleStyle } from "../lib/subtitleStyle";
import {
  chooseAudioLanguage,
  chooseSubtitleLanguage,
  loadAudioPref,
  loadSubtitlePref,
} from "../lib/trackPrefs";
import { loadVolume, saveVolume } from "../lib/volume";
import { subtitleTextStyle } from "./SubtitleLayer";
import { SubtitleLookControls } from "./SubtitleLook";

/**
 * This viewer's own settings, from the home page.
 *
 * Everything here is what a player starts with — the quality, the volume, the
 * subtitle and audio language, how subtitles look — and is saved on this
 * device (watch history is the exception: it is saved to the Discord account,
 * and only changes what gets recorded from now on). Quality changed while
 * watching lasts for that sitting, so this is where its default is kept; the
 * volume is simply the last one used, here or in the player. None of it
 * reaches anyone else in the room.
 */
interface SettingsPanelProps {
  onClose: () => void;
}

/** A select's value for a stored subtitle or audio preference. */
function prefValue(pref: { off?: boolean; languageCode?: string | null; language?: string | null } | null): string {
  if (!pref) return "";
  if (pref.off) return "off";
  const code = shortLanguageCode(pref.languageCode);
  if (code) return `lang:${code}`;
  const byName = LANGUAGES.find((l) => l.name.toLowerCase() === (pref.language ?? "").toLowerCase());
  return byName ? `lang:${byName.code}` : "";
}

/** How a stored preference reads when it names more than a language: a
 *  particular track picked while watching ("English — Signs & Songs"). */
function prefDetail(pref: { off?: boolean; title?: string | null; language?: string | null } | null): string | null {
  if (!pref || pref.off || !pref.title) return null;
  const title = pref.title.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  if (!title || title.toLowerCase() === (pref.language ?? "").toLowerCase()) return null;
  return title;
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const look = useSubtitleStyle();
  // Re-read from storage after anything that changes it underneath — a reset.
  const [epoch, setEpoch] = useState(0);
  const [quality, setQuality] = useState(defaultQuality);
  const [volume, setVolume] = useState(() => Math.round(Math.min(1, loadVolume()) * 100));
  const [subtitle, setSubtitle] = useState(() => loadSubtitlePref());
  const [audio, setAudio] = useState(() => loadAudioPref());
  const [historyMode, setHistoryMode] = useState<HistorySaveMode | null>(null);
  const [historyNote, setHistoryNote] = useState<string | null>(null);
  const [reset, setReset] = useState<"idle" | "confirm" | number>("idle");

  useEffect(() => {
    setQuality(defaultQuality());
    setVolume(Math.round(Math.min(1, loadVolume()) * 100));
    setSubtitle(loadSubtitlePref());
    setAudio(loadAudioPref());
  }, [epoch]);

  useEffect(() => {
    let cancelled = false;
    fetchHistorySettings()
      .then((s) => { if (!cancelled) setHistoryMode(s.saveMode); })
      .catch(() => { if (!cancelled) setHistoryNote("Couldn't load your history setting."); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const chooseQuality = (kbps: number) => {
    setDefaultQuality(kbps);
    setQuality(kbps);
  };
  const chooseVolume = (percent: number) => {
    setVolume(percent);
    saveVolume(percent / 100);
  };
  const chooseSubtitle = (value: string) => {
    if (value === "current") return;
    chooseSubtitleLanguage(value === "" ? null : value === "off" ? "off" : (() => {
      const code = value.slice(5);
      return { code, name: languageName(code) };
    })());
    setSubtitle(loadSubtitlePref());
  };
  const chooseAudio = (value: string) => {
    if (value === "current") return;
    chooseAudioLanguage(value === "" ? null : { code: value.slice(5), name: languageName(value.slice(5)) });
    setAudio(loadAudioPref());
  };
  const chooseHistory = (mode: HistorySaveMode) => {
    const before = historyMode;
    setHistoryMode(mode);
    setHistoryNote(null);
    updateHistorySettings(mode)
      .then(() => setHistoryNote("Saved."))
      .catch(() => {
        setHistoryMode(before);
        setHistoryNote("Couldn't save your history setting.");
      });
  };

  const subtitleDetail = prefDetail(subtitle);
  const audioDetail = prefDetail(audio);
  // A track picked while watching names more than its language; it stays the
  // selected option, described, until something else is chosen.
  const subtitleValue = subtitleDetail ? "current" : prefValue(subtitle);
  const audioValue = audioDetail ? "current" : prefValue(audio);

  const sample = subtitleTextStyle(look, 22);

  return (
    <div style={styles.backdrop} onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="settings-scroll"
        style={styles.dialog}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={styles.titleRow}>
          <h2 id="settings-title" style={styles.title}>Settings</h2>
          <button className="btn" type="button" aria-label="Close settings" onClick={onClose} style={styles.closeBtn}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M4 4l10 10M14 4L4 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <p style={styles.intro}>
          What every stream starts with for you. Quality changed while watching lasts until you close the player.
        </p>

        <section style={styles.section}>
          <h3 style={styles.sectionTitle}>Default quality</h3>
          <div style={styles.chips} role="radiogroup" aria-label="Default quality">
            {[0, ...QUALITY_LEVELS_KBPS].map((kbps) => (
              <button key={kbps} className="btn" type="button" role="radio" aria-checked={quality === kbps}
                onClick={() => chooseQuality(kbps)}
                style={{ ...styles.chip, ...(quality === kbps ? styles.chipOn : {}) }}>
                {kbps ? `Up to ${qualityLabel(kbps)}` : qualityLabel(0)}
              </button>
            ))}
          </div>
          <p style={styles.note}>
            Original is the file itself whenever it can be. A lower one gives you a stream of your own, for a
            connection that can't keep up.
          </p>
        </section>

        <section style={styles.section}>
          <h3 style={styles.sectionTitle}>Volume</h3>
          <div style={styles.volumeRow}>
            <input type="range" min={5} max={100} step={5} value={volume} aria-label="Volume"
              onChange={(e) => chooseVolume(Number(e.target.value))} style={styles.range} />
            <span style={styles.reading}>{volume}%</span>
          </div>
          <p style={styles.note}>The last volume you used while watching is remembered, so this is where the next stream starts.</p>
        </section>

        <section style={styles.section}>
          <h3 style={styles.sectionTitle}>Subtitles and audio</h3>
          <label style={styles.field}>
            <span style={styles.fieldLabel}>Subtitles</span>
            <select value={subtitleValue} onChange={(e) => chooseSubtitle(e.target.value)} style={styles.select}>
              <option value="">Each title's own default</option>
              <option value="off">Off</option>
              {subtitleDetail && (
                <option value="current">{`${subtitle?.language ?? "Your last choice"} — ${subtitleDetail}`}</option>
              )}
              {LANGUAGES.map((l) => <option key={l.code} value={`lang:${l.code}`}>{l.name}</option>)}
            </select>
          </label>
          <label style={styles.field}>
            <span style={styles.fieldLabel}>Audio</span>
            <select value={audioValue} onChange={(e) => chooseAudio(e.target.value)} style={styles.select}>
              <option value="">Each title's own default</option>
              {audioDetail && (
                <option value="current">{`${audio?.language ?? "Your last choice"} — ${audioDetail}`}</option>
              )}
              {LANGUAGES.map((l) => <option key={l.code} value={`lang:${l.code}`}>{l.name}</option>)}
            </select>
          </label>
          <p style={styles.note}>
            Picked when a title starts, wherever it has that language. Choosing a track while watching updates these
            too.
          </p>
        </section>

        <section style={styles.section}>
          <h3 style={styles.sectionTitle}>Subtitle look</h3>
          {/* A line in the chosen look over something like a picture, since
              there is no film here to judge it against. */}
          <div style={styles.preview} aria-hidden="true">
            <div style={{ ...styles.sampleLine, ...sample }}>
              {look.background === "box"
                ? <span style={styles.sampleBox}>This is how subtitles will look.</span>
                : "This is how subtitles will look."}
            </div>
          </div>
          <div style={styles.lookControls}>
            <SubtitleLookControls />
          </div>
        </section>

        <section style={styles.section}>
          <h3 style={styles.sectionTitle}>Watch history</h3>
          <div style={styles.chips} role="radiogroup" aria-label="Save watch history" aria-busy={historyMode === null}>
            {([
              ["all", "All watch parties"],
              ["host_only", "Only when I host"],
            ] as Array<[HistorySaveMode, string]>).map(([mode, label]) => (
              <button key={mode} className="btn" type="button" role="radio" aria-checked={historyMode === mode}
                disabled={historyMode === null}
                onClick={() => chooseHistory(mode)}
                style={{ ...styles.chip, ...(historyMode === mode ? styles.chipOn : {}) }}>
                {label}
              </button>
            ))}
          </div>
          <p style={styles.note}>
            Which watch parties are added to your history. Saved to your Discord account, for future playback.
            {historyNote && <span style={styles.status}> {historyNote}</span>}
          </p>
        </section>

        <section style={{ ...styles.section, ...styles.lastSection }}>
          <h3 style={styles.sectionTitle}>Saved settings</h3>
          <p style={styles.note}>
            Your {SAVED_SETTINGS.map((s) => s.label).join(", ").replace(/, ([^,]*)$/, " and $1")}. Resetting puts
            them all back to their defaults on this device.
          </p>
          {reset === "idle" ? (
            <button className="btn" type="button" style={styles.quietBtn} onClick={() => setReset("confirm")}>
              Reset saved settings
            </button>
          ) : reset === "confirm" ? (
            <div style={styles.confirmRow} role="group" aria-label="Confirm reset">
              <span style={styles.confirmAsk}>Reset everything to the defaults?</span>
              <button className="btn" type="button" style={styles.quietBtn} onClick={() => setReset("idle")}>Keep</button>
              <button className="btn" type="button" style={styles.primaryBtn}
                onClick={() => { setReset(resetSavedSettings()); setEpoch((n) => n + 1); }}>
                Reset
              </button>
            </div>
          ) : (
            <div role="status" style={styles.done}>
              {reset > 0 ? "Done — everything is back to its default." : "Nothing was saved — everything is already at its default."}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 1000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "calc(16px + var(--sait, 0px)) 16px calc(16px + var(--saib, 0px))",
    background: "rgba(0,0,0,0.62)",
  },
  dialog: {
    width: "min(520px, 100%)",
    maxHeight: "100%",
    overflowY: "auto",
    overscrollBehavior: "contain",
    boxSizing: "border-box",
    padding: "22px 22px 18px",
    borderRadius: "14px",
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(16,16,17,0.97)",
    boxShadow: "0 20px 64px rgba(0,0,0,0.55)",
    color: "#f0f0f0",
  },
  titleRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" },
  title: { margin: 0, fontSize: "22px", fontWeight: 700 },
  closeBtn: {
    width: "32px", height: "32px", borderRadius: "50%", border: "none",
    background: "rgba(255,255,255,0.08)", color: "#bbb", cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  intro: { margin: "6px 0 4px", color: "#999", fontSize: "13px", lineHeight: 1.5 },
  section: { padding: "16px 0", borderBottom: "1px solid rgba(255,255,255,0.07)" },
  lastSection: { borderBottom: "none", paddingBottom: "4px" },
  sectionTitle: { margin: "0 0 10px", fontSize: "15px", fontWeight: 700 },
  chips: { display: "flex", flexWrap: "wrap", gap: "8px" },
  chip: {
    padding: "7px 12px",
    borderRadius: "999px",
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.14)",
    color: "#ddd",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  chipOn: { background: "rgba(229,160,13,0.16)", border: "1px solid rgba(229,160,13,0.65)", color: "#e5a00d" },
  note: { margin: "10px 0 0", color: "#8a8a8a", fontSize: "12px", lineHeight: 1.5 },
  status: { color: "#bbb" },
  volumeRow: { display: "flex", alignItems: "center", gap: "12px" },
  range: { flex: 1, accentColor: "#e5a00d", cursor: "pointer" },
  reading: { minWidth: "44px", textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" },
  field: { display: "flex", alignItems: "center", gap: "12px", marginBottom: "8px" },
  fieldLabel: { width: "72px", flexShrink: 0, color: "#aaa", fontSize: "13px" },
  select: {
    flex: 1,
    minWidth: 0,
    padding: "8px 10px",
    borderRadius: "8px",
    background: "#1d1d1f",
    border: "1px solid rgba(255,255,255,0.14)",
    color: "#eee",
    fontSize: "13px",
    fontFamily: "inherit",
  },
  preview: {
    height: "110px",
    borderRadius: "10px",
    marginBottom: "14px",
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
    padding: "0 12px 14px",
    // Bright in places and dark in others, as a picture is: an outline has to
    // read against both.
    background: "linear-gradient(120deg, #2b4a5a 0%, #8a9a6a 45%, #e8dcc0 62%, #3a3226 100%)",
    overflow: "hidden",
  },
  sampleLine: { textAlign: "center", lineHeight: 1.22 },
  sampleBox: {
    background: "rgba(0,0,0,0.72)",
    padding: "0.05em 0.35em",
    borderRadius: "0.15em",
  },
  lookControls: { display: "flex", flexDirection: "column", alignItems: "stretch", gap: "12px" },
  quietBtn: {
    padding: "8px 14px",
    borderRadius: "8px",
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.14)",
    color: "#ddd",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  primaryBtn: {
    padding: "8px 14px",
    borderRadius: "8px",
    border: "none",
    background: "#e5a00d",
    color: "#211700",
    fontSize: "13px",
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  confirmRow: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
  confirmAsk: { color: "#ddd", fontSize: "13px", marginRight: "auto" },
  done: { color: "#9fd49f", fontSize: "13px" },
};
