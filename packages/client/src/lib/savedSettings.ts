import { AUDIO_PREF_KEY, SUBTITLE_PREF_KEY } from "./trackPrefs";
import { ZOOM_PREFS_KEY } from "./videoZoom";
import { VOLUME_KEY } from "./volume";
import { DEFAULT_QUALITY_KEY, setDefaultQuality } from "./quality";
import { SUBTITLE_STYLE_KEY, forgetSubtitleStyle } from "./subtitleStyle";

/**
 * Everything the player remembers on this device between sittings, by what a
 * person would call it.
 *
 * Not on the list: whether this browser can play HEVC (a fact about the
 * device, found out the hard way, not a choice), whether to share what you
 * watch in your Discord status (a privacy choice, which a reset shouldn't turn
 * back on), and the watch-history setting, which belongs to your Discord
 * account rather than to this device.
 */
export const SAVED_SETTINGS: Array<{ key: string; label: string }> = [
  { key: SUBTITLE_PREF_KEY, label: "subtitle choice" },
  { key: AUDIO_PREF_KEY, label: "audio language" },
  { key: SUBTITLE_STYLE_KEY, label: "subtitle look" },
  { key: DEFAULT_QUALITY_KEY, label: "default quality" },
  { key: VOLUME_KEY, label: "default volume" },
  { key: ZOOM_PREFS_KEY, label: "zoom for each show and film" },
];

/**
 * Put every saved player setting back to its default. Returns how many there
 * were to clear. Wrapped like every other use of storage here: inside a
 * Discord Activity iframe it can be unavailable or throw.
 */
export function resetSavedSettings(): number {
  let cleared = 0;
  for (const { key } of SAVED_SETTINGS) {
    try {
      if (localStorage.getItem(key) !== null) cleared++;
      localStorage.removeItem(key);
    } catch {
      // Nothing stored, then.
    }
  }
  forgetSubtitleStyle();
  setDefaultQuality(0);
  return cleared;
}
