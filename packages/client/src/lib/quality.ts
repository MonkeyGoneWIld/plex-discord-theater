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
 * Not saved anywhere. A connection that struggled with one film says nothing
 * about the next, and a ceiling nobody remembers setting quietly costs them
 * picture quality from then on. So it lasts while the player stays open on the
 * same show — the next episode keeps it, for everyone who set one — and goes
 * back to Original when the player closes or moves to something else (see
 * carryQualityTo).
 */
export const QUALITY_LEVELS_KBPS = [20000, 12000, 8000, 4000];

let current = 0;
/** Where the current ceiling was chosen: the title, and the show it is an
 *  episode of (null for a film). */
let chosenFor: { ratingKey: string; show: string | null } | null = null;
const listeners = new Set<() => void>();

function set(kbps: number, where: { ratingKey: string; show: string | null } | null): void {
  const next = QUALITY_LEVELS_KBPS.includes(kbps) ? kbps : 0;
  chosenFor = next ? where : null;
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

/** Back to Original: the player closed. */
export function resetPreferredQuality(): void {
  set(0, null);
}

/**
 * The ceiling for a title starting in a player that is already open.
 *
 * Kept for the title it was chosen on and for other episodes of the same show —
 * moving on to the next one is still the same evening with the same connection.
 * Anything else is a fresh start, and starts at Original. Returns what applies.
 */
export function carryQualityTo(ratingKey: string, show: string | null): number {
  if (!current || !chosenFor) return current;
  if (chosenFor.ratingKey === ratingKey) return current;
  if (show !== null && chosenFor.show === show) {
    chosenFor = { ratingKey, show };
    return current;
  }
  set(0, null);
  return 0;
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
