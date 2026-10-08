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
 * what anybody would want anyway — but only when the second segment will be
 * in before the first has played out. That 23 MB one wouldn't have been: the
 * film would have started, and stopped three seconds later for ten. The host
 * decides, from how fast its own first segment came, and everybody else
 * starts where the host does.
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
 * How long the next segment, `bytes` of it, will take to come in at the speed
 * the first did — at half that speed, since once the first is in the player
 * fetches two at once. Infinity without a speed to go on.
 */
export function nextSegmentInS(bytes: number, firstBitsPerS: number): number {
  if (!(firstBitsPerS > 0) || !(bytes > 0)) return Infinity;
  return (2 * bytes * 8) / firstBitsPerS;
}

/**
 * Where to start a copied stream that was asked to start at `atS`, given the
 * stretch of picture `range` that holds it — its first segment, once in — and
 * how long the next segment will take to come in. The start of that stretch
 * when the point asked for is too near its end to start on, the whole of it
 * isn't, and the next segment will be in before it has played; otherwise
 * `atS`.
 */
export function pictureStartFor(
  atS: number,
  range: { start: number; end: number } | null,
  nextInS = 0,
): number {
  if (!range || atS < range.start - 0.1 || atS > range.end) return atS;
  if (enoughToStart(range.end - atS)) return atS;
  if (!enoughToStart(range.end - range.start)) return atS;
  if (atS - range.start > MAX_START_BACK_S) return atS;
  if (nextInS > range.end - range.start) return atS;
  return range.start;
}
