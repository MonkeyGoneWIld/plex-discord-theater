/**
 * The room server's clock, as near as this device can tell.
 *
 * A device's own clock can be well off: on 4 November the PC that ran Part F
 * was 22 to 25 seconds slow (every log line it sent was stamped that far
 * behind the server's, and an internet clock agreed with the server), while
 * the phone in the same room was within a second. Discord shows an
 * activity's timer from the timestamps it is sent, so the PC's presence
 * timer was that far off for everyone else. Timestamps meant for other
 * devices are taken from here instead.
 *
 * The server stamps what it sends with its time. Each stamp is that time less
 * however long the message took to arrive, so the latest-looking of the last
 * few is the nearest.
 */

const SAMPLES = 8;
const samples: number[] = [];
let offsetMs = 0;

/** A message stamped `serverMs` by the server arrived at `localMs`. */
export function noteServerTime(serverMs: number, localMs = Date.now()): void {
  if (!Number.isFinite(serverMs) || !Number.isFinite(localMs)) return;
  samples.push(serverMs - localMs);
  if (samples.length > SAMPLES) samples.shift();
  offsetMs = Math.max(...samples);
}

/** The server's time now; this device's own until the server has said. */
export function serverNow(localMs = Date.now()): number {
  return localMs + offsetMs;
}
