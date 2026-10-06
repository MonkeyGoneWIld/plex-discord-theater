import { MAX_LEVEL } from "./audioBoost";

export const VOLUME_KEY = "pdt:volume";
/** Fired on window when Settings changes the volume, for an open player. */
export const VOLUME_CHOSEN_EVENT = "pdt:volume-chosen";

/** Starting volume when nothing has been stored yet. */
export const DEFAULT_VOLUME = 0.5;

/**
 * Last volume the user chose, or DEFAULT_VOLUME.
 *
 * Storage is wrapped in try/catch throughout: this runs inside a Discord
 * Activity iframe, where localStorage can be unavailable or throw outright
 * depending on the embedder's storage-partitioning rules. Volume memory is a
 * nicety, so every failure degrades to the default rather than surfacing.
 */
export function loadVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (raw === null) return DEFAULT_VOLUME;
    const v = parseFloat(raw);
    // Up to MAX_LEVEL, not 1: the level above 100% is a boost the player has
    // to rebuild each session, and a stored 1.5 that got clamped to the
    // default here would silently forget it.
    return Number.isFinite(v) && v >= 0 && v <= MAX_LEVEL ? v : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
}

/**
 * Remember a volume level across sessions.
 *
 * Zero is deliberately not persisted: muting sets volume to 0, and storing that
 * would make the app start silent with no visible cause — a confusing way to
 * open a watch party. Mute therefore lasts only for the session, while the
 * underlying level is what's remembered.
 */
export function saveVolume(v: number): void {
  if (!(v > 0)) return;
  try {
    localStorage.setItem(VOLUME_KEY, String(v));
  } catch {
    // Storage unavailable — volume simply won't persist.
  }
}

/**
 * A volume chosen in Settings: remembered like any other, and handed to a
 * player that is open behind the panel — minimised, still playing — so the
 * slider is heard rather than only saved.
 */
export function chooseVolume(v: number): void {
  saveVolume(v);
  try {
    window.dispatchEvent(new CustomEvent(VOLUME_CHOSEN_EVENT, { detail: v }));
  } catch {
    // No window to tell: nothing is playing.
  }
}
