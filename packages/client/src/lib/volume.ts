const STORAGE_KEY = "pdt:volume";

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
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_VOLUME;
    const v = parseFloat(raw);
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_VOLUME;
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
    localStorage.setItem(STORAGE_KEY, String(v));
  } catch {
    // Storage unavailable — volume simply won't persist.
  }
}
