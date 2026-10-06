import { useSyncExternalStore } from "react";

/**
 * A viewer's own ceiling on their stream's bitrate — "Quality" in the player.
 *
 * For a connection that can't keep up with what the room is watching: a copied
 * remux can be 30 Mbps, and everyone pulls all of it from one home upload.
 * Choosing a level gives this viewer a stream of their own at no more than it
 * (the server's QUALITY_LEVELS_KBPS, which these must match) — a copy when the
 * file fits under it, a re-encode at it when it doesn't. 0 is no ceiling,
 * "Original": whatever the server sends everyone.
 *
 * Two values. The default, chosen in Settings and saved on this device, is
 * where every player starts — Original unless someone on a slow connection
 * has said otherwise. A choice made while watching is not saved: a connection
 * that struggled with one film says nothing about the next, and a ceiling
 * nobody remembers setting quietly costs them picture quality from then on.
 * It lasts while the player stays open on the same show — the next episode
 * keeps it, for everyone who set one — and goes back to the default when the
 * player closes or moves to something else (see carryQualityTo).
 */
export const QUALITY_LEVELS_KBPS = [20000, 12000, 10000, 8000, 4000];

export const DEFAULT_QUALITY_KEY = "pdt:defaultQuality";

/** The ceiling players start at — see setDefaultQuality. */
export function defaultQuality(): number {
  try {
    const n = Number(localStorage.getItem(DEFAULT_QUALITY_KEY));
    return QUALITY_LEVELS_KBPS.includes(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** A player is open: a default changed meanwhile waits for the next one. */
let playerOpen = false;

let current = defaultQuality();
/** Where the current ceiling was chosen: the title, and the show it is an
 *  episode of (null for a film). */
let chosenFor: { ratingKey: string; show: string | null } | null = null;
const listeners = new Set<() => void>();

function set(kbps: number, where: { ratingKey: string; show: string | null } | null): void {
  const next = QUALITY_LEVELS_KBPS.includes(kbps) ? kbps : 0;
  chosenFor = where;
  if (next === current) return;
  current = next;
  for (const fn of listeners) fn();
}

export function preferredQuality(): number {
  return current;
}

/**
 * Choose a ceiling, watching `where` — what decides whether it carries into the
 * next title (carryQualityTo).
 */
export function setPreferredQuality(
  kbps: number,
  where: { ratingKey: string; show: string | null } | null = chosenFor,
): void {
  set(kbps, where);
}

/** Choose the ceiling players start at. Saved; applies from the next player
 *  on, rather than restarting one already playing. */
export function setDefaultQuality(kbps: number): void {
  const level = QUALITY_LEVELS_KBPS.includes(kbps) ? kbps : 0;
  try {
    if (level) localStorage.setItem(DEFAULT_QUALITY_KEY, String(level));
    else localStorage.removeItem(DEFAULT_QUALITY_KEY);
  } catch {
    // Storage unavailable: it lasts as long as the page does.
  }
  if (!playerOpen) set(level, null);
}

/** A player opened: it starts at the default. */
export function beginQualitySession(): void {
  playerOpen = true;
  set(defaultQuality(), null);
}

/** Back to the default: the player closed. */
export function resetPreferredQuality(): void {
  playerOpen = false;
  set(defaultQuality(), null);
}

/**
 * The ceiling for a title starting in a player that is already open.
 *
 * Kept for the title it was chosen on and for other episodes of the same show —
 * moving on to the next one is still the same evening with the same connection.
 * Anything else is a fresh start, and starts at the default. Returns what
 * applies.
 */
export function carryQualityTo(ratingKey: string, show: string | null): number {
  if (!chosenFor) return current;
  if (chosenFor.ratingKey === ratingKey) return current;
  if (show !== null && chosenFor.show === show) {
    chosenFor = { ratingKey, show };
    return current;
  }
  set(defaultQuality(), null);
  return current;
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
  if (!kbps) return "Original";
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
