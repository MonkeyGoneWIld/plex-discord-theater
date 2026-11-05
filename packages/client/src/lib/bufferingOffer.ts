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
 * Offered for stalls that come back: this many, apart, within the window, and
 * this many seconds stalled in all. One long stall is a join, a seek or a
 * stream made again, not a connection. Until 4 November 12 s of any kind
 * within two minutes offered it, a single wait included; then 20 s over three
 * stalls, and on 5 November Pirates of the Caribbean stalled for 43 s before
 * it came.
 */
export const OFFER_STALLS = 2;
export const OFFER_STARVED_S = 12;
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
  /** A viewer whose picture stopped for want of data, gone past the room to
   *  wait there for it (Player's catchUpAfterStop), and waiting still. */
  waitingOutStall: boolean;
}

/**
 * Whether the picture is stopped this second for want of data; null when the
 * second counts neither way (paused, seeking, the room not playing). A host
 * short of picture holds the whole room, its own video paused with
 * everybody's: buffering too — Firefox, hosting on 24 October, held the room
 * 21 s and was offered nothing.
 *
 * So is a viewer waiting, paused and seeking, past the room for the data its
 * picture stopped for: on 5 November a laptop on 12 Angry Men, short of a
 * 20 Mbps stream, stopped five times in three minutes and waited 44 s that
 * way. Only the second or so before each wait counted, and it was never
 * offered.
 */
export function starvedNow(p: PlayerNow): boolean | null {
  if (p.waitingOutStall && p.roomPlaying) return true;
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

/** Under this long a stream has too little behind it to say much. */
const LEAST_MEASURED_MS = 8_000;

/**
 * What this player's connection has brought in, kbps: all it downloaded over
 * the window, or since its stream started if that's sooner, from `samples`
 * as [when (ms), bytes]; null with nothing. Old entries are dropped as it
 * goes. The last 8 s alone swing too far — on 5 November, at 2 to 23 Mbps
 * in ten-second stretches, they read 7.9 Mbps on a connection that had
 * brought in 10.5 over three minutes, and 4 Mbps was suggested.
 */
export function connectionKbps(samples: Array<[number, number]>, nowMs: number, streamSinceMs: number): number | null {
  while (samples.length && nowMs - samples[0][0] > OFFER_WINDOW_MS) samples.shift();
  if (samples.length === 0) return null;
  const spanMs = Math.max(LEAST_MEASURED_MS, Math.min(OFFER_WINDOW_MS, nowMs - streamSinceMs));
  const bytes = samples.reduce((n, [, b]) => n + b, 0);
  return Math.round((bytes * 8) / spanMs);
}

/** Whether the hint, up, should go: the buffering that raised it is over. */
export function takeOfferDown(lastStarvedAt: number, now: number, bufferAheadS: number): boolean {
  const calm = now - lastStarvedAt >= CALM_MS && bufferAheadS >= CALM_BUFFER_S;
  return calm || bufferAheadS >= HEALTHY_BUFFER_S;
}
