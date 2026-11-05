/**
 * Where a stream this player drives starts when nothing has said where: no
 * seek, no recovery, its offset spent by a run of the stream effect that the
 * next one replaced (Player's HLS effect runs twice in a burst, and the
 * second finds the one-shot offset gone).
 *
 * Its last picture of this title, if it has shown one. Otherwise, for a
 * viewer, where the room is: on 5 November a laptop starting its own stream
 * of 12 Angry Men with the room 20 minutes in asked for it from 0:00,
 * couldn't reach the room in it, rebuilt it from 0:00 again, and went round
 * that seven times in two and a half minutes. A host's own clock is the
 * room's, so for a host nothing — the start, or wherever its title resumes.
 */
export function ownStreamStart(
  lastGoodS: number,
  isHost: boolean,
  /** Where the room is now, on this title; null when it is on another. */
  roomS: number | null,
): { atS: number; from: "last picture" | "room" } | null {
  if (lastGoodS > 0) return { atS: lastGoodS, from: "last picture" };
  if (!isHost && roomS !== null && roomS > 0) return { atS: roomS, from: "room" };
  return null;
}
