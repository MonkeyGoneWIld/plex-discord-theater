import { MAX_LEVEL } from "./audioBoost";

export const VOLUME_KEY = "pdt:volume";

/** Starting volume when nothing has been stored yet. */
export const DEFAULT_VOLUME = 0.5;

/**
 * What the player does with volume.
 *
 * Two values. The default — set in Settings, saved on this device — is where
 * every player starts. Turning it up or down while watching is for that
 * sitting: it lasts while the player stays open, into the next episode and
 * through picture-in-picture, and the next player starts at the default again.
 * It used to save whatever the slider was last left at, so the default was
 * really "wherever the last film happened to need it".
 *
 * Storage is wrapped in try/catch throughout: this runs inside a Discord
 * Activity iframe, where localStorage can be unavailable or throw outright
 * depending on the embedder's storage-partitioning rules. Volume memory is a
 * nicety, so every failure degrades to the default rather than surfacing.
 */

/** This sitting's volume, while a player is open; null otherwise. */
let sessionVolume: number | null = null;

/** The volume a player starts at: the one chosen in Settings, or DEFAULT_VOLUME. */
export function defaultVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (raw === null) return DEFAULT_VOLUME;
    const v = parseFloat(raw);
    // Up to 1: a boost above 100% is something to reach for in a quiet film,
    // not a level to start every one at.
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
}

/** Choose the volume players start at. */
export function setDefaultVolume(v: number): void {
  const level = Math.max(0.05, Math.min(1, v));
  try {
    if (Math.abs(level - DEFAULT_VOLUME) < 0.001) localStorage.removeItem(VOLUME_KEY);
    else localStorage.setItem(VOLUME_KEY, String(level));
  } catch {
    // Storage unavailable — the default simply won't persist.
  }
}

/** The volume to play at now: this sitting's, or the default to start it. */
export function loadVolume(): number {
  return sessionVolume ?? defaultVolume();
}

/**
 * The volume was changed while watching. Kept for the sitting, up to
 * MAX_LEVEL — the boost has to be rebuilt each time a player opens.
 *
 * Zero is deliberately not kept: muting sets volume to 0, and holding that
 * would bring the next episode up silent with no visible cause. Mute is the
 * element's, while the underlying level is what's remembered.
 */
export function saveVolume(v: number): void {
  if (!(v > 0) || v > MAX_LEVEL) return;
  sessionVolume = v;
}

/** The player closed: the next one starts at the default. */
export function endVolumeSession(): void {
  sessionVolume = null;
}
