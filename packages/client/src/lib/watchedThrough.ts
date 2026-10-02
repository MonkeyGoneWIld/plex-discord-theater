/**
 * Whether a title has been watched through. A title with a credits marker is
 * finished once the playhead reaches the first one, and the percentage plays no
 * part; only a title without one falls back to the share of the runtime the
 * server counts as watched.
 *
 * The same rule the server uses to mark history watched — keep the two in step
 * with packages/server/src/services/played-state.ts. Kept free of the player so
 * it can be tested on its own; the player uses it to tell a host who has
 * finished from one stepping away mid-film.
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
  if (creditsStarts.length > 0) return position >= Math.min(...creditsStarts);
  return duration > 0 && position >= duration * threshold;
}
