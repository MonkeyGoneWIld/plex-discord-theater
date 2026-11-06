/**
 * Which of an ASS subtitle's fonts a player fetches when (StyledSubtitleLayer).
 *
 * Every font the film carries used to be fetched before the subtitle was
 * drawn, beside the picture's first segments. On 6 November Steins;Gate's 29
 * fonts, 16.4 MB, came in beside its first two segments, 28 MB of picture, and
 * its starts took 16 and 18 s. Its first minute is drawn in one of them, of
 * 0.11 MB; 13 of them, 6.8 MB, no line of that subtitle uses at all.
 *
 * So the server says when each is drawn with (its `uses`), and a player
 * fetches beside the picture only those the lines within NEAR_S of where the
 * picture is need, and those there is no telling about; the subtitle is drawn
 * with them. The rest come one at a time, the one drawn with soonest first,
 * once the picture has SPARE_S in hand — or whatever it has, when its lines
 * come within NEAR_S as the film plays or after a skip. Those no line uses
 * come last, with picture to spare: libass might find a name in one that the
 * server didn't.
 */

/** A font as the server lists it: when it is drawn with, film seconds. */
export interface FontUses {
  id: string;
  /** Stretches of film it is drawn with; none for one no line uses; missing when there's no telling. */
  uses?: ReadonlyArray<readonly [number, number]>;
}

/** Fonts drawn with within this of the picture, seconds, are fetched whatever it has in hand. */
export const NEAR_S = 60;
/** The rest only with this much picture in hand, seconds — as a picture subtitle's further pieces. */
export const SPARE_S = 20;

/**
 * Seconds from `t` until a font is drawn with: 0 while it is, or with no
 * telling; Infinity when nothing after `t` is drawn with it.
 */
export function untilUseS(f: FontUses, t: number): number {
  if (!f.uses) return 0;
  let best = Infinity;
  for (const [from, to] of f.uses) {
    if (to < t) continue;
    best = Math.min(best, Math.max(0, from - t));
  }
  return best;
}

/** Whether a font is wanted beside the picture: drawn with within NEAR_S of `t`, or no telling. */
export function wantedNow(f: FontUses, t: number): boolean {
  return untilUseS(f, t) <= NEAR_S;
}

/**
 * The font to fetch next of those still to come, from `t`, or null for none
 * now: the one drawn with soonest, if that is within NEAR_S or the picture
 * has picture to spare; with it to spare, one drawn with only before `t`, or
 * never, after those.
 */
export function nextFont<F extends FontUses>(pending: readonly F[], t: number, spare: boolean): F | null {
  let best: F | null = null;
  let bestS = Infinity;
  for (const f of pending) {
    const s = untilUseS(f, t);
    if (best === null || s < bestS) {
      best = f;
      bestS = s;
    }
  }
  if (!best) return null;
  return bestS <= NEAR_S || spare ? best : null;
}
