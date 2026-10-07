/**
 * How far behind the playhead the browser's buffer can be cut.
 *
 * A cut never stops where it is asked to. Chrome removes up to the first
 * keyframe at or after the requested end, because the frames in between
 * depend on what was cut — and a copied film has keyframes up to ten seconds
 * apart. Cutting to "five seconds behind" took the frames being played as
 * well. Chrome, having lost its place, played out what it had already decoded
 * and then sat on a still frame with half a minute buffered ahead: Pressure
 * froze like that three seconds after each trim, on both players, until a
 * nudge got it going again.
 *
 * Every segment starts on a keyframe, so the start of the segment before the
 * one playing is always safe to cut to: the next keyframe after it is, at the
 * latest, the start of the segment playing.
 */

export interface FragmentSpan {
  start: number;
  duration: number;
}

/**
 * Where a cut behind `nowS` may end: `wantS`, or less if that would reach into
 * the segment before the one playing. Null when nothing behind the playhead
 * can be cut at all — the playhead is in the first segment, or nothing is
 * known about the segments.
 */
export function safeBackCutS(
  fragments: ReadonlyArray<FragmentSpan> | null | undefined,
  nowS: number,
  wantS: number,
): number | null {
  if (!fragments || fragments.length === 0) return null;
  // The last segment starting at or before the playhead — the one playing, or
  // the one whose end it has just passed.
  let lo = 0;
  let hi = fragments.length - 1;
  let playing = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fragments[mid].start <= nowS + 0.001) {
      playing = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (playing < 1) return null;
  const limit = fragments[playing - 1].start;
  const cut = Math.min(wantS, limit);
  return cut > 0 ? cut : null;
}
