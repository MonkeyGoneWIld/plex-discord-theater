/**
 * Which segment the picture needs next: the first one not held from the
 * playhead, which downloads in all its parts at once while a segment beside
 * it gets one at a time (Player's partsAtOnce, lib/segmentParts).
 *
 * hls.js ends a segment it has parsed at the later of its audio and video,
 * and on every reload of a growing playlist starts the unparsed ones after it
 * there too; what is held — the browser's buffer, the engine's segment times
 * — ends at the earlier. On the ffmpeg engine's cuts they are 0.06 to 0.11 s
 * apart, past the 0.05 s this allowed, so it named the segment just come in:
 * the one the picture did need came one part at a time, at a single
 * download's 4 to 5 Mbps through Discord's proxy, and on 18 October every
 * start and skip ran dry about 9 s in. So a segment the engine holds is never
 * the one needed, and the slack is the 0.3 s the rest of the player allows
 * for the same difference.
 */

/** How far past what is held a segment may end and still count as held. */
export const NEXT_NEEDED_SLACK_S = 0.3;

export interface ListedSegment {
  start: number;
  duration: number;
  url?: string;
  gap?: boolean;
}

/** The URL of the first of `segments` not held up to `heldToS`, and not among those `held` by the engine. */
export function nextNeededSegment(
  segments: ReadonlyArray<ListedSegment>,
  heldToS: number,
  held: { has(url: string): boolean },
): string | null {
  return segments.find((s) => !s.gap && !(s.url && held.has(s.url)) && s.start + s.duration > heldToS + NEXT_NEEDED_SLACK_S)?.url ?? null;
}
