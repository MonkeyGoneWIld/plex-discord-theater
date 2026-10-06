import { AUDIO_PREF_KEY, SUBTITLE_PREF_KEY } from "./trackPrefs";
import { ZOOM_PREFS_KEY } from "./videoZoom";
import { VOLUME_KEY } from "./volume";
import { SUBTITLE_STYLE_KEY, forgetSubtitleStyle } from "./subtitleStyle";

/**
 * Everything the player remembers on this device between sittings, by what a
 * person would call it.
 *
 * Not on the list: whether this browser can play HEVC (a fact about the
 * device, found out the hard way, not a choice), and whether to share what you
 * watch in your Discord status (a privacy choice, which a reset shouldn't turn
 * back on).
 */
export const SAVED_SETTINGS: Array<{ key: string; label: string }> = [
  { key: SUBTITLE_PREF_KEY, label: "subtitle choice" },
  { key: AUDIO_PREF_KEY, label: "audio language" },
  { key: ZOOM_PREFS_KEY, label: "zoom for each show and film" },
  { key: SUBTITLE_STYLE_KEY, label: "subtitle look" },
  { key: VOLUME_KEY, label: "volume" },
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
  return cleared;
}
