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
 * where a viewer starts — Original unless someone on a slow connection has
 * said otherwise. A choice made while watching is the viewer's for the
 * sitting: through the next title, a pop-out, the Activity closed and opened
 * again. Away from the player for more than SITTING_GAP_MS, they start at the
 * default again: a connection that struggled one evening says nothing about
 * the next, and a ceiling nobody remembers setting quietly costs them picture
 * quality from then on.
 *
 * Until 4 November a choice went with the player that made it, and only for
 * that title or show. In Part H a host and a viewer who had each chosen
 * 10 Mbps for Rain Man closed and opened the Activity five times in five
 * minutes, came back at Original every time, and chose 10 Mbps again; moving
 * on to Snowden, both were put back to Original and chose it again.
 */
export const QUALITY_LEVELS_KBPS = [20000, 12000, 10000, 8000, 4000];

export const DEFAULT_QUALITY_KEY = "pdt:defaultQuality";

/** Away from the player longer than this, a viewer starts at the default again. */
export const SITTING_GAP_MS = 30 * 60 * 1000;
/** Where the sitting's quality is kept, and when a player last had it open. */
export const SITTING_QUALITY_KEY = "pdt:sittingQuality";
/** How often an open player marks the sitting as still going: a page Discord
 *  closes runs nothing on its way out. */
const SITTING_MARK_MS = 30_000;

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
/** The default this sitting began under. Choosing another in Settings starts
 *  the next player there, sitting or not. */
let sittingUnder = 0;
let markTimer: ReturnType<typeof setInterval> | null = null;

let current = defaultQuality();
const listeners = new Set<() => void>();

function set(kbps: number): void {
  const next = QUALITY_LEVELS_KBPS.includes(kbps) ? kbps : 0;
  if (next === current) return;
  current = next;
  for (const fn of listeners) fn();
}

/** The sitting's quality as of `now`, a player open with it. */
function markSitting(now = Date.now()): void {
  try {
    localStorage.setItem(SITTING_QUALITY_KEY, JSON.stringify({ kbps: current, at: now, under: sittingUnder }));
  } catch {
    // Storage unavailable: it lasts as long as the page does.
  }
}

/** The quality of a sitting still going at `now`, if there is one. */
function sittingQuality(now: number, under: number): number | null {
  try {
    const s = JSON.parse(localStorage.getItem(SITTING_QUALITY_KEY) ?? "null") as
      { kbps?: unknown; at?: unknown; under?: unknown } | null;
    if (!s || typeof s.kbps !== "number" || typeof s.at !== "number" || s.under !== under) return null;
    // A minute's grace the other way, for a clock set back since.
    const away = now - s.at;
    return away > -60_000 && away <= SITTING_GAP_MS ? s.kbps : null;
  } catch {
    return null;
  }
}

export function preferredQuality(): number {
  return current;
}

/** Choose a ceiling while watching: this viewer's for the sitting. */
export function setPreferredQuality(kbps: number): void {
  set(kbps);
  if (playerOpen) markSitting();
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
  if (!playerOpen) set(level);
}

/** A player opened at `now`: at the sitting's quality if this viewer is only
 *  just back, otherwise at the default. */
export function beginQualitySession(now = Date.now()): void {
  playerOpen = true;
  const fallback = defaultQuality();
  set(sittingQuality(now, fallback) ?? fallback);
  sittingUnder = fallback;
  markSitting(now);
  if (markTimer) clearInterval(markTimer);
  markTimer = setInterval(() => markSitting(), SITTING_MARK_MS);
}

/** The player closed at `now`: the sitting is kept for SITTING_GAP_MS, and
 *  until a player opens again it is the default that shows. */
export function endQualitySession(now = Date.now()): void {
  if (markTimer) clearInterval(markTimer);
  markTimer = null;
  if (playerOpen) markSitting(now);
  playerOpen = false;
  set(defaultQuality());
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
 *
 * "Lower" means at least a tenth lower: 12 Mbps offered for a 12.5 Mbps file
 * is a re-encode for nothing, and was being offered.
 */
export function lowerQualityFor(nowKbps: number, measuredBps: number): number | null {
  const below = QUALITY_LEVELS_KBPS.filter((l) => l <= nowKbps * 0.9);
  if (below.length === 0) return null;
  if (!(measuredBps > 0)) return below[0];
  return below.find((l) => l * 1000 <= measuredBps * 0.75) ?? below[below.length - 1];
}
