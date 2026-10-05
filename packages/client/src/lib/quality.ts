import { useSyncExternalStore } from "react";

/**
 * A viewer's own ceiling on their stream's bitrate — "Quality" in the player.
 *
 * For a connection that can't keep up with what the room is watching: a copied
 * remux can be 30 Mbps, and everyone pulls all of it from one home upload.
 * Choosing a level gives this viewer a stream of their own at no more than it
 * (the server's QUALITY_LEVELS_KBPS, which these must match) — a copy when the
 * file fits under it, a re-encode at it when it doesn't. 0 is no ceiling:
 * whatever the server sends everyone.
 *
 * Kept for the session only, in sessionStorage. A connection that was bad
 * tonight isn't necessarily bad tomorrow, and a ceiling nobody remembers
 * setting would quietly cost them picture quality for good. Wrapped in
 * try/catch like every other storage use here: inside a Discord Activity
 * iframe it can be unavailable or throw, and then the choice lasts as long as
 * the page does.
 */
export const QUALITY_LEVELS_KBPS = [20000, 12000, 8000, 4000];

const STORAGE_KEY = "pdt:quality";

function load(): number {
  try {
    const n = Number(sessionStorage.getItem(STORAGE_KEY));
    return QUALITY_LEVELS_KBPS.includes(n) ? n : 0;
  } catch {
    return 0;
  }
}

let current = load();
const listeners = new Set<() => void>();

export function preferredQuality(): number {
  return current;
}

export function setPreferredQuality(kbps: number): void {
  const next = QUALITY_LEVELS_KBPS.includes(kbps) ? kbps : 0;
  if (next === current) return;
  current = next;
  try {
    if (next) sessionStorage.setItem(STORAGE_KEY, String(next));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable: the choice lasts until the page goes.
  }
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The ceiling this viewer has chosen, re-rendering when it changes. */
export function usePreferredQuality(): number {
  return useSyncExternalStore(subscribe, preferredQuality, preferredQuality);
}

/** "8 Mbps", with "· 720p" for the level the server re-encodes at 720p. */
export function qualityLabel(kbps: number): string {
  if (!kbps) return "Auto";
  return `${kbps / 1000} Mbps${kbps <= 4000 ? " · 720p" : ""}`;
}

/**
 * The level to suggest to someone buffering on a stream of `nowKbps`: the
 * highest one under three quarters of what their connection has been measured
 * at — the lowest, if even that is more — or, with nothing measured, simply the
 * next one down. Null when there is nothing lower.
 */
export function lowerQualityFor(nowKbps: number, measuredBps: number): number | null {
  const below = QUALITY_LEVELS_KBPS.filter((l) => l < nowKbps);
  if (below.length === 0) return null;
  if (!(measuredBps > 0)) return below[0];
  return below.find((l) => l * 1000 <= measuredBps * 0.75) ?? below[below.length - 1];
}
