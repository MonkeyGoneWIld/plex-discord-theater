/**
 * The rule that nobody in a room is shown the same seconds twice.
 *
 * The room's clock is the host's playhead. When the host's picture freezes,
 * everybody else plays on and ends up ahead of it — and the sync used to send
 * them back to it, up to nine seconds at a time, several times a minute on a
 * struggling host. Somebody ahead of the room now stops where they are and
 * picks up when the room gets there. Only a seek sends anybody back, because
 * that is somebody choosing to rewatch.
 */

/**
 * How far ahead of the room a follower may be and still wait for it.
 *
 * A freeze leaves people a few seconds ahead. This far ahead is the room
 * having gone somewhere else without a seek, and the room is followed.
 */
export const MAX_WAIT_FOR_ROOM_S = 30;

/** Whether a follower this far ahead of the room waits for it rather than going back. */
export function waitsForRoom(aheadS: number): boolean {
  return aheadS > 0 && aheadS <= MAX_WAIT_FOR_ROOM_S;
}

/**
 * What a follower stopped at `hereS` does about a room at `roomS`: keep
 * waiting, play on because the room has arrived (within `toleranceS`), or
 * follow the room because it is too far behind to be waited for.
 */
export function roomWaitOutcome(hereS: number, roomS: number, toleranceS: number): "wait" | "play" | "follow" {
  if (roomS >= hereS - toleranceS) return "play";
  if (hereS - roomS > MAX_WAIT_FOR_ROOM_S) return "follow";
  return "wait";
}

/** Where a follower was when its stream was torn down, ahead of the room. */
export interface AheadAtRebuild {
  ratingKey: string;
  atS: number;
  /** Where the room was at the time. */
  roomAtS: number;
}

/**
 * Where a rebuilt stream starts for a follower that was ahead of the room
 * when the old one went, or null to land on the room's clock as usual.
 *
 * Following a host whose transcode froze and was restarted is the usual way
 * here: the restart begins where the host froze, which is exactly the part
 * everybody else has already watched.
 */
export function resumeAheadAt(
  carried: AheadAtRebuild | null,
  now: {
    ratingKey: string;
    roomRatingKey: string | null;
    roomS: number;
    /** Where the new stream's segments begin. */
    streamStartS: number;
    /** Closer than this to the room isn't worth a jump of its own. */
    toleranceS: number;
    /** A room this far behind where it was has been sent back: a seek. */
    seekedBackS: number;
  },
): number | null {
  if (!carried) return null;
  if (carried.ratingKey !== now.ratingKey || now.roomRatingKey !== carried.ratingKey) return null;
  if (now.roomS < carried.roomAtS - now.seekedBackS) return null;
  const aheadS = carried.atS - now.roomS;
  if (aheadS <= now.toleranceS || !waitsForRoom(aheadS)) return null;
  if (carried.atS < now.streamStartS) return null;
  return carried.atS;
}

/**
 * Where a player that has just shown its first frames after joining moves to,
 * to make up what starting cost it — or null to stay put.
 *
 * Only ever forward, and no further than it has buffered: past that it would
 * be seeking into a segment it hasn't got. A room behind is waited for by the
 * ordinary sync, never gone back to.
 */
export function settleForward(
  hereS: number,
  bufferedAheadS: number,
  roomS: number,
  toleranceS: number,
): number | null {
  const reachable = Math.min(roomS, hereS + bufferedAheadS - 0.5);
  return reachable - hereS > toleranceS ? reachable : null;
}
