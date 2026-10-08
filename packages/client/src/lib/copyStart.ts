/**
 * Where a copied film starts when everybody starts it together.
 *
 * A copy can only begin on a keyframe, so Plex begins it on the one before the
 * point asked for, and its first segment runs from there to the next keyframe
 * — usually ending a second or two after that point. A player says its picture
 * is ready with READY_AHEAD_S of it in front of the playhead, so started at
 * the point asked for, every player waited for the second segment as well
 * before the room could start. On the night of 8 October that was 45 starts
 * and skips out of 96, two to five seconds each, and once twenty: the second
 * segment was 23 MB and came in at 10 Mbps while the first had sat ready.
 *
 * Started on the keyframe instead, the first segment is enough. It means
 * beginning a few seconds before the point asked for, which for a resume is
 * what anybody would want anyway.
 */

/** Seconds of picture past the playhead a player has before it says it is
 *  ready for the room to start. */
export const READY_AHEAD_S = 3;
/** A three-second keyframe interval buffers as 2.98s. */
export const READY_TOLERANCE_S = 0.1;
/** Further back than this from where it was asked to start, a start waits for
 *  the next segment rather than begin there. */
export const MAX_START_BACK_S = 6;

/** Whether this much picture ahead — with `leftS` of the film left — is enough to start on. */
export function enoughToStart(aheadS: number, leftS = Infinity): boolean {
  return aheadS + READY_TOLERANCE_S >= Math.min(READY_AHEAD_S, Math.max(0, leftS));
}

/**
 * Where to start a copied stream that was asked to start at `atS`, given the
 * stretch of picture `range` that holds it — its first segment, once in. The
 * start of that stretch when the point asked for is too near its end to start
 * on and the whole of it isn't; otherwise `atS`.
 */
export function pictureStartFor(atS: number, range: { start: number; end: number } | null): number {
  if (!range || atS < range.start - 0.1 || atS > range.end) return atS;
  if (enoughToStart(range.end - atS)) return atS;
  if (!enoughToStart(range.end - range.start)) return atS;
  if (atS - range.start > MAX_START_BACK_S) return atS;
  return range.start;
}
