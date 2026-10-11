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
