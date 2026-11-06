/**
 * Which of a subtitle's cues are on screen at a moment.
 *
 * More than one can be. Dialogue overlaps when two people talk at once, and a
 * typeset anime release puts a sign at the top while someone speaks at the
 * bottom. Showing only one of them at a time — which is what this replaced —
 * dropped lines, and flickered between them.
 */
export interface TimedCue {
  start: number;
  end: number;
  text: string;
  /** Drawn at the top of the picture. */
  top?: boolean;
  italic?: boolean;
}

/** The longest any cue runs, which bounds how far back one still showing can
 *  have started. */
export function longestCue(cues: readonly TimedCue[]): number {
  let longest = 0;
  for (const c of cues) longest = Math.max(longest, c.end - c.start);
  return longest;
}

/**
 * The cues showing at `at`, in the order they started, from a list sorted by
 * start. A binary search for the last one to have started, then back through
 * those that started within `longest` of it — a handful, not the whole film.
 */
export function activeCues(cues: readonly TimedCue[], at: number, longest: number): TimedCue[] {
  let lo = 0;
  let hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= at) lo = mid + 1;
    else hi = mid;
  }
  const out: TimedCue[] = [];
  for (let i = lo - 1; i >= 0 && cues[i].start >= at - longest; i--) {
    if (cues[i].end >= at) out.push(cues[i]);
  }
  return out.reverse();
}

/** Whether two answers from activeCues are the same cues. */
export function sameCues(a: readonly TimedCue[], b: readonly TimedCue[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

/** Seconds where every line has come: from, and to — null for the end. */
export type CoveredSpan = [number, number | null];

/**
 * How far past `at` every line is known to have come: 0 or more when `at` is
 * inside a stretch that has, null when it isn't — when no line there may yet
 * mean one still on its way rather than a quiet moment in the film.
 */
export function coveredAhead(spans: readonly CoveredSpan[], at: number): number | null {
  for (const [from, to] of spans) {
    if (from <= at && (to === null || at < to)) return to === null ? Infinity : to - at;
  }
  return null;
}

/**
 * What is known, with an answer for one stretch of the film in: the answer's
 * cues replace whatever was known inside [from, to), and the rest is kept —
 * for skipping back to, until the next answer for there. Sorted by start.
 */
export function withStretch<T extends TimedCue>(known: readonly T[], from: number, to: number, cues: readonly T[]): T[] {
  const kept = known.filter((c) => c.end <= from || c.start >= to);
  return [...kept, ...cues].sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Where to ask for lines, if anywhere: where the picture is heading after a
 * skip (headingToS, the place the bar is held at), when none of it is known
 * yet, so its lines are in hand by the time the loading screen drops rather
 * than asked for once the picture has got there; else where the picture is,
 * when nothing is known there. Null when both are known, and before the
 * first answer (spans null), which is asked for anyway.
 */
export function placeToAsk(spans: readonly CoveredSpan[] | null, atS: number, headingToS: number | null): number | null {
  if (!spans) return null;
  if (headingToS !== null && coveredAhead(spans, headingToS) === null) return headingToS;
  return coveredAhead(spans, atS) === null ? atS : null;
}

/** How many subtitles' lines are kept — see keepLines. */
export const KEPT_SUBTITLES = 8;
const kept = new Map<string, readonly TimedCue[]>();

/**
 * A subtitle's lines, all of them, kept once they have come, so a layer that
 * starts again (a PiP opened or closed, a stream rebuilt) draws them at once
 * rather than asking the bot again. On 6 November each PiP opened on Pirates
 * went 0.8 s without lines while its 187 KB of them came again. The last
 * KEPT_SUBTITLES of them.
 */
export function keepLines(key: string, cues: readonly TimedCue[]): void {
  kept.delete(key);
  kept.set(key, cues);
  while (kept.size > KEPT_SUBTITLES) kept.delete(kept.keys().next().value as string);
}

export function keptLines<T extends TimedCue>(key: string): readonly T[] | null {
  return (kept.get(key) as readonly T[] | undefined) ?? null;
}

/**
 * Whether the plain lines draw an ASS subtitle (the Player's SubtitleLayer):
 * when it isn't drawn styled, in a PiP, where the styled drawing isn't (see
 * the Player), and until a styled drawing is up, so a PiP closed leaves no
 * moment without lines while libass starts again.
 */
export function plainLinesDraw(o: { styled: boolean; styledUp: boolean; inPip: boolean }): boolean {
  return !o.styled || o.inPip || !o.styledUp;
}
