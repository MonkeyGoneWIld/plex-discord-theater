/**
 * The "Buffering a lot?" hint: when a player's stalls say its connection
 * can't carry the stream, so a lower quality is offered (lib/quality,
 * lowerQualityFor), and when it has caught up again and the hint goes.
 *
 * The player asks once a second, while the room plays.
 */

/** Stalls further back than this are forgotten. */
export const OFFER_WINDOW_MS = 180_000;
/**
 * Offered for stalls that keep coming back: this many, apart, within the
 * window, and this many seconds stalled in all. One long stall is a join, a
 * seek or a stream made again, not a connection; until 4 November 12 s of any
 * kind within two minutes offered it.
 */
export const OFFER_STALLS = 3;
export const OFFER_STARVED_S = 20;
/** Seconds stalled further apart than this are separate stalls. */
const SAME_STALL_GAP_MS = 2_000;
/**
 * A connection carrying this much more than the stream needs is not why it
 * stalls, and a lower quality won't help: on 4 November a viewer bringing in
 * 14 to 24 Mbps for an 11.7 Mbps stream was offered 10 Mbps four times.
 */
export const CARRIES_MARGIN = 1.2;
/** The hint goes once this long has passed since the last stall, with
 *  CALM_BUFFER_S in hand — or at once, with HEALTHY_BUFFER_S in hand. It was
 *  20 s and 10 s, or 30 s in hand, and stayed up long after it was over. */
export const CALM_MS = 8_000;
export const CALM_BUFFER_S = 5;
export const HEALTHY_BUFFER_S = 15;

/** This player, this second. */
export interface PlayerNow {
  isHost: boolean;
  /** What this player last told the room as its host: its picture isn't
   *  moving, so the room waits for it. */
  hostHoldingRoom: boolean;
  roomPlaying: boolean;
  paused: boolean;
  seeking: boolean;
  bufferAheadS: number;
  readyState: number;
}

/**
 * Whether the picture is stopped this second for want of data; null when the
 * second counts neither way (paused, seeking, the room not playing). A host
 * short of picture holds the whole room, its own video paused with
 * everybody's: buffering too — Firefox, hosting on 24 October, held the room
 * 21 s and was offered nothing.
 */
export function starvedNow(p: PlayerNow): boolean | null {
  // The host's only: a viewer that took over a stream while the room waited
  // for its host kept the word, and every second it played after counted.
  const holdingRoom = p.isHost && p.hostHoldingRoom && !p.seeking;
  if (!holdingRoom && (!p.roomPlaying || p.paused || p.seeking)) return null;
  return holdingRoom || (p.bufferAheadS < 0.5 && p.readyState < 3);
}

/**
 * Whether to offer a lower quality, from the seconds this player was stalled
 * (`starvedAt`, oldest first, within OFFER_WINDOW_MS) and what is arriving
 * against what the stream needs, kbps (null for not known).
 */
export function offerLower(
  starvedAt: number[],
  now: number,
  streamKbps: number | null,
  arrivingKbps: number | null,
): boolean {
  const recent = starvedAt.filter((t) => now - t < OFFER_WINDOW_MS);
  if (recent.length < OFFER_STARVED_S) return false;
  let separate = 1;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] - recent[i - 1] > SAME_STALL_GAP_MS) separate++;
  }
  if (separate < OFFER_STALLS) return false;
  // Not measured, it goes by the stalls alone.
  if (streamKbps !== null && arrivingKbps !== null && arrivingKbps >= streamKbps * CARRIES_MARGIN) return false;
  return true;
}

/** Whether the hint, up, should go: the buffering that raised it is over. */
export function takeOfferDown(lastStarvedAt: number, now: number, bufferAheadS: number): boolean {
  const calm = now - lastStarvedAt >= CALM_MS && bufferAheadS >= CALM_BUFFER_S;
  return calm || bufferAheadS >= HEALTHY_BUFFER_S;
}
