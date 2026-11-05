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
 * said otherwise. A choice made while watching lasts for the title it was
 * made on and the other episodes of its show — the next episode is still the
 * same evening with the same connection — and anything else starts at the
 * default (carryQualityTo): a connection that struggled with one film says
 * nothing about the next, and a ceiling nobody remembers setting quietly
 * costs them picture quality from then on.
 *
 * It lasts through a pop-out, and the Activity closed and opened again, unless
 * they were away from the player for more than SITTING_GAP_MS. Until
 * 4 November it ended with the player: in Part H a host and a viewer who had
 * each chosen 10 Mbps for Rain Man closed and opened the Activity five times
 * in five minutes, came back at Original every time, and chose 10 Mbps again.
 */
export const QUALITY_LEVELS_KBPS = [20000, 12000, 10000, 8000, 4000];

export const DEFAULT_QUALITY_KEY = "pdt:defaultQuality";

/** Away from the player longer than this, a viewer starts at the default again.
 *  Long enough for a pop-out or the Activity opened again; 30 minutes until
 *  4 November, which kept a quality chosen for a bad moment well past it. */
export const SITTING_GAP_MS = 5 * 60 * 1000;
/** Where the sitting's quality is kept, what it was chosen on, and when a
 *  player last had it open. */
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
/** Where the current ceiling was chosen: the title, and the show it is an
 *  episode of (null for a film). */
type ChosenFor = { ratingKey: string; show: string | null };
let chosenFor: ChosenFor | null = null;
const listeners = new Set<() => void>();

function set(kbps: number, where: ChosenFor | null): void {
  const next = QUALITY_LEVELS_KBPS.includes(kbps) ? kbps : 0;
  chosenFor = where;
  if (next === current) return;
  current = next;
  for (const fn of listeners) fn();
}

/**
 * Where the sitting goes besides this device's storage: the server, which
 * hands it back to the next page this account opens in this browser (hooks/
 * useSync). Firefox keeps nothing for the Activity between pages — on
 * 4 November none of its pages found the last one's volume or quality — so a
 * quality chosen there was gone after every pop-out (run 29, C again).
 */
let sittingSink: ((sitting: object) => void) | null = null;
export function setSittingSink(fn: ((sitting: object) => void) | null): void {
  sittingSink = fn;
}

/** The sitting's quality as of `now`, a player open with it. */
function markSitting(now = Date.now()): void {
  const sitting = { kbps: current, chosenFor, at: now, under: sittingUnder };
  try {
    localStorage.setItem(SITTING_QUALITY_KEY, JSON.stringify(sitting));
  } catch {
    // Storage unavailable: it lasts as long as the page does.
  }
  sittingSink?.(sitting);
}

/** The quality of a sitting still going at `now`, and what it was chosen on,
 *  if there is one. */
function sittingQuality(now: number, under: number): { kbps: number; chosenFor: ChosenFor | null } | null {
  try {
    return readSitting(JSON.parse(localStorage.getItem(SITTING_QUALITY_KEY) ?? "null"), now, under);
  } catch {
    return null;
  }
}

/** A sitting `raw` as kept, read as of `now` under the default `under`: null
 *  if it isn't one, or has ended. */
function readSitting(raw: unknown, now: number, under: number): { kbps: number; chosenFor: ChosenFor | null } | null {
  {
    const s = raw as { kbps?: unknown; chosenFor?: unknown; at?: unknown; under?: unknown } | null;
    if (!s || typeof s !== "object" || typeof s.kbps !== "number" || typeof s.at !== "number" || s.under !== under) return null;
    // A minute's grace the other way, for a clock set back since.
    const away = now - s.at;
    if (!(away > -60_000 && away <= SITTING_GAP_MS)) return null;
    const c = s.chosenFor as Partial<ChosenFor> | null | undefined;
    const where = c && typeof c.ratingKey === "string"
      ? { ratingKey: c.ratingKey, show: typeof c.show === "string" ? c.show : null }
      : null;
    return { kbps: s.kbps, chosenFor: where };
  }
}

/** Whether the open player began on a sitting of this device's own. */
let openedOnOwnSitting = false;
/** The sitting the server handed back, for a player not yet open. */
let sittingFromServer: unknown = null;
/** The title the open player is on, as carryQualityTo was last told. */
let openOn: ChosenFor | null = null;

/**
 * The sitting the server kept for this account in this browser (setSittingSink),
 * `raw`, handed back on joining. Taken only by a player that found none of its
 * own here, as one it had found — so over the same SITTING_GAP_MS, and for the
 * same titles (carryQualityTo).
 */
export function adoptSitting(raw: unknown, now = Date.now()): void {
  if (!playerOpen) {
    sittingFromServer = raw;
    return;
  }
  if (openedOnOwnSitting) return;
  const back = readSitting(raw, now, sittingUnder);
  if (!back) return;
  openedOnOwnSitting = true;
  set(back.kbps, back.chosenFor);
  if (openOn) carryQualityTo(openOn.ratingKey, openOn.show);
  markSitting(now);
}

export function preferredQuality(): number {
  return current;
}

/**
 * Choose a ceiling, watching `where` — what decides whether it carries into the
 * next title (carryQualityTo).
 */
export function setPreferredQuality(kbps: number, where: ChosenFor | null = chosenFor): void {
  set(kbps, where);
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
  if (!playerOpen) set(level, null);
}

/** A player opened at `now`: at the sitting's quality if this viewer is only
 *  just back, otherwise at the default. Whether it carries into the title the
 *  player opens on is carryQualityTo's to say, as for any title. */
export function beginQualitySession(now = Date.now()): void {
  playerOpen = true;
  const fallback = defaultQuality();
  const own = sittingQuality(now, fallback);
  openedOnOwnSitting = own !== null;
  const back = own ?? readSitting(sittingFromServer, now, fallback);
  sittingFromServer = null;
  openOn = null;
  set(back?.kbps ?? fallback, back?.chosenFor ?? null);
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
/**
 * Whether going from one quality to another needs the stream made again. A
 * copy of the file is what the server sends at Original and under any ceiling
 * at or above the file's own bitrate (routes/plex.ts rules a copy out only for
 * a file over the ceiling), so between those it would make the same copy
 * again. Rain Man (run 29, A8 retest) is under 10 Mbps: Original to 10 Mbps,
 * then to 12, each reloaded the room for the same copy.
 *
 * A re-encode is made at the lower of what the ceiling allows and what the
 * file's own picture needs (server ffmpeg/plan.ts sourceMatchedKbps, on both
 * engines). One made under what was allowed (`allowed`) was set by the file,
 * and any ceiling above it, and above the 720p level, makes it again as it is.
 * Snowden for a player that can't decode HEVC (run 29, C): an H.264 re-encode
 * at 4 Mbps, made again at 4 Mbps for 8 Mbps chosen. Not one re-encoded for
 * the ceiling itself, which a higher one may let through as a copy; nor back
 * to Original from a ceiling, whose rate the server alone knows. A stream not
 * yet loaded (no notes) is made again as before.
 */
export function qualityChangesStream(
  notes: StreamFacts | null,
  from: number,
  to: number,
): boolean {
  if (from === to) return false;
  if (notes?.video === "transcode") {
    const kbps = notes.kbps;
    if (!kbps || !notes.allowed || kbps >= notes.allowed || notes.reason?.includes("quality cap")) return true;
    const sameReencode = (c: number) => c > QUALITY_720P_KBPS && c > kbps;
    return !((from === 0 || sameReencode(from)) && sameReencode(to));
  }
  const fileKbps = notes?.video === "copy" ? notes.kbps : null;
  if (!fileKbps) return true;
  const sameCopy = (kbps: number) => kbps === 0 || kbps >= fileKbps;
  return !(sameCopy(from) && sameCopy(to));
}

/** What qualityChangesStream reads of a stream's notes (lib/streamNotes). */
type StreamFacts = {
  video: "copy" | "transcode" | null;
  kbps: number | null;
  allowed?: number | null;
  reason?: string | null;
};
/** At this ceiling and under, the server re-encodes at 720p (routes/plex.ts). */
const QUALITY_720P_KBPS = 4000;

/**
 * The quality to send with a change of tracks: the chosen one, unless the
 * stream this player is on already stands for it (qualityChangesStream), in
 * which case the quality that stream was made at. The server keys a stream by
 * its quality too, so the chosen one would read as another stream. Rain Man
 * (run 29, B6): 10 Mbps chosen over its 8.9 Mbps copy, then an ASS subtitle
 * turned on, which is drawn here and changes nothing about the stream; the
 * server took 302993:0@10000 for a new one and rebuilt it.
 */
export function qualityForTracks(
  notes: StreamFacts | null,
  streamQuality: number,
  chosen: number,
): number {
  return qualityChangesStream(notes, streamQuality, chosen) ? chosen : streamQuality;
}

export function carryQualityTo(ratingKey: string, show: string | null): number {
  openOn = { ratingKey, show };
  if (!chosenFor) return current;
  if (chosenFor.ratingKey === ratingKey) return current;
  if (show !== null && chosenFor.show === show) {
    chosenFor = { ratingKey, show };
    if (playerOpen) markSitting();
    return current;
  }
  set(defaultQuality(), null);
  if (playerOpen) markSitting();
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
 * The share of the connection a suggested level may take. It was three
 * quarters, and on 5 November 10.5 Mbps fell short of 8 Mbps by a hair:
 * 4 Mbps was suggested.
 */
const FITS_SHARE = 0.8;

/**
 * The level to suggest to someone buffering on a stream of `nowKbps`: the
 * highest one within FITS_SHARE of what their connection has been measured
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
  return below.find((l) => l * 1000 <= measuredBps * FITS_SHARE) ?? below[below.length - 1];
}
