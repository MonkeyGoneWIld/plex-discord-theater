/**
 * Whether a title has been watched through, by the same rule Plex uses to mark
 * it played: the playhead has reached the first credits marker, or the share of
 * the runtime the server counts as watched — whichever comes first.
 *
 * Kept free of the player so the rule can be tested on its own. The player uses
 * it to tell a host who has finished from one stepping away mid-film.
 */
import type { SkipMarker } from "./api";

/** Plex's own default for "Video played threshold". */
export const DEFAULT_PLAYED_THRESHOLD = 0.9;

export function isWatchedThrough(
  /** Seconds. */
  position: number,
  /** Seconds; 0 or less when unknown, which leaves only the credits rule. */
  duration: number,
  markers: readonly SkipMarker[],
  /** Fraction of the runtime, 0-1. */
  threshold: number = DEFAULT_PLAYED_THRESHOLD,
): boolean {
  if (!(position > 0)) return false;
  const creditsStarts = markers.filter((m) => m.type === "credits").map((m) => m.start);
  if (creditsStarts.length > 0 && position >= Math.min(...creditsStarts)) return true;
  return duration > 0 && position >= duration * threshold;
}
