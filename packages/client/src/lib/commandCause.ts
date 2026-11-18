/**
 * What this player's next seek or new title comes from, for the Theater
 * Dashboard's events: "skip intro", "timeline", "next episode". Noted by the
 * control just before it acts, and read once by useSync as it sends the
 * command. Without it the dashboard could say only that somebody seeked, or
 * that a title started.
 *
 * The server keeps only the causes it knows (sync.ts, CAUSES).
 */

export type SeekCause = "skip intro" | "skip credits" | "timeline" | "jump back" | "jump forward";
export type PlayCause = "picked" | "next episode" | "previous episode" | "up next" | "end screen" | "queue";

/** A seek is sent at once; a new title only once its stream is chosen and started. */
const SEEK_KEEP_MS = 5_000;
const PLAY_KEEP_MS = 120_000;

let seek: { cause: SeekCause; at: number } | null = null;
let play: { cause: PlayCause; ratingKey: string; at: number } | null = null;

export function noteSeekCause(cause: SeekCause, now = Date.now()): void {
  seek = { cause, at: now };
}

export function notePlayCause(cause: PlayCause, ratingKey: string, now = Date.now()): void {
  play = { cause, ratingKey, at: now };
}

/** The cause of the seek being sent, once. */
export function takeSeekCause(now = Date.now()): SeekCause | null {
  const s = seek;
  seek = null;
  return s && now - s.at <= SEEK_KEEP_MS ? s.cause : null;
}

/** The cause of the start of this title, once: a rebuild of it after gets none. */
export function takePlayCause(ratingKey: string, now = Date.now()): PlayCause | null {
  const p = play;
  if (!p || p.ratingKey !== ratingKey) return null;
  play = null;
  return now - p.at <= PLAY_KEEP_MS ? p.cause : null;
}
