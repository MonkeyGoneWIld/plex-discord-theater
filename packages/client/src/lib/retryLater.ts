/**
 * Whether a failed request to the bot is worth making again, and when.
 *
 * A request through Discord's proxy now and then fails outright: the
 * browser's TypeError "Failed to fetch", at the same moment as a segment of
 * the video that hls.js then asks for again. A picture subtitle didn't ask
 * again: on 4 and 5 November five were burned into a re-encode on one such
 * failure each, 2 Guns' among them (its segment 3 failed in the same
 * millisecond). So a failure of the connection or the server for the moment
 * (a TypeError, a 5xx, 408 or 429) is tried again after 1, 2 and 4 s; one
 * that will be the same next time (any other 4xx, the server's own error), or
 * a fourth in a row, is not.
 */

/** How long to wait before each try again, in turn. */
export const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

/** The connection's or the server's failure for the moment, not the request's. */
export function isPassing(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const m = /^API error (\d{3}):/.exec(err instanceof Error ? err.message : String(err));
  if (!m) return false;
  const status = Number(m[1]);
  return status >= 500 || status === 408 || status === 429;
}

/** How long to wait before trying again after `err`, with `failedBefore`
 *  failures in a row before it; null to give up. */
export function retryDelayMs(err: unknown, failedBefore: number): number | null {
  return isPassing(err) && failedBefore < RETRY_DELAYS_MS.length ? RETRY_DELAYS_MS[failedBefore] : null;
}
