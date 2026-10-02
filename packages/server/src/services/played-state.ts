/**
 * When a title counts as watched.
 *
 * One rule, used for the history row's watched flag (and so for what gets
 * scrobbled to linked Plex accounts), and handed to the player so a host
 * backing out of a finished title ends the stream rather than parking it:
 *
 *   - a title with a credits marker is watched once playback reaches the first
 *     one, and the percentage plays no part;
 *   - a title without one is watched past the server's "Video played
 *     threshold" share of its runtime.
 *
 * The client keeps a copy of the rule in lib/watchedThrough.ts.
 */
import { plexJSON } from "./plex.js";

/** Plex's own default for "Video played threshold". */
export const DEFAULT_PLAYED_THRESHOLD = 0.9;
/** A server-wide setting that changes about never; no need to ask Plex per play. */
const PLAYED_THRESHOLD_TTL_MS = 10 * 60 * 1000;
let playedThresholdCache: { value: number; at: number } | null = null;

/**
 * The fraction of a video's runtime at which Plex counts it as watched — the
 * server's "Video played threshold" (Settings → Library). A failed read falls
 * back to Plex's default rather than failing whatever asked.
 */
export async function playedThreshold(): Promise<number> {
  if (playedThresholdCache && Date.now() - playedThresholdCache.at < PLAYED_THRESHOLD_TTL_MS) {
    return playedThresholdCache.value;
  }
  let value = DEFAULT_PLAYED_THRESHOLD;
  try {
    const data = await plexJSON<{ MediaContainer: { Setting?: Array<{ id: string; value?: unknown }> } }>("/:/prefs");
    const setting = data.MediaContainer.Setting?.find((s) => s.id === "LibraryVideoPlayedThreshold");
    const percent = Number(setting?.value);
    if (Number.isFinite(percent) && percent > 0 && percent <= 100) value = percent / 100;
  } catch (err) {
    console.warn("[Plex] Could not read the played threshold, using the default:", err);
  }
  playedThresholdCache = { value, at: Date.now() };
  return value;
}

/** Start of the earliest credits marker, in Plex's milliseconds, or null without one. */
export function firstCreditsStartMs(
  markers: ReadonlyArray<{ type?: string; startTimeOffset?: number }> | undefined,
): number | null {
  const starts = (markers ?? [])
    .filter((m) => m.type === "credits" && Number.isFinite(m.startTimeOffset))
    .map((m) => m.startTimeOffset!);
  return starts.length > 0 ? Math.min(...starts) : null;
}

/** Whether a position counts as having watched the title — see the module comment. */
export function isWatchedThrough(
  positionMs: number,
  durationMs: number,
  creditsStartMs: number | null,
  threshold: number = DEFAULT_PLAYED_THRESHOLD,
): boolean {
  if (!(positionMs > 0)) return false;
  if (creditsStartMs !== null) return positionMs >= creditsStartMs;
  return durationMs > 0 && positionMs >= durationMs * threshold;
}
