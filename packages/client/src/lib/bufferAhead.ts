/**
 * How far ahead of the playhead the picture is downloaded.
 *
 * The browser's own buffer has a size limit — around 150 MB of video, which is
 * under a minute of a 30 Mbps copy — and the P2P engine keeps fetching past it
 * into its own memory, where it stays until the playhead has passed it. A skip
 * forward into what the engine holds plays as soon as it is handed over, so for
 * whoever is watching, the buffer is both together: what the browser has,
 * carried on through what the engine has after it. Reporting the browser's half
 * alone showed a heavy film stuck at forty seconds of buffer with two minutes
 * downloaded.
 */

/** Gaps smaller than this between pieces are taken as joined: segment edges. */
const JOIN_TOLERANCE_S = 0.5;

/**
 * Seconds of picture, from `nowS`, covered without a break by `ranges` — each
 * [start, end] in film time, in any order, overlapping or not.
 */
export function coveredAheadS(nowS: number, ranges: ReadonlyArray<readonly [number, number]>): number {
  const sorted = ranges
    .filter(([start, end]) => end > nowS && end > start)
    .sort((a, b) => a[0] - b[0]);
  let reach = nowS;
  for (const [start, end] of sorted) {
    if (start > reach + JOIN_TOLERANCE_S) break;
    if (end > reach) reach = end;
  }
  return Math.max(0, reach - nowS);
}

/** The pieces of a media element's own buffer, as ranges. */
export function bufferedRanges(buffered: TimeRanges): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < buffered.length; i++) out.push([buffered.start(i), buffered.end(i)]);
  return out;
}

/** A segment the engine holds: [start, end] in film time, and its size in bytes. */
export type HeldSegment = readonly [number, number, number];

/** What the engine holds, as ranges. */
export function heldRanges(held: Map<string, HeldSegment>): Array<readonly [number, number]> {
  return [...held.values()].map(([start, end]) => [start, end] as const);
}

/**
 * Let go of what the engine lets go of: once everything together is over
 * `limitBytes`, what the playhead at `nowS` has passed, earliest first, until
 * it isn't — what its memory does (p2p-media-loader-core's
 * segment-memory-storage, patched to treat every stream alike: see
 * p2pCorePatch.ts). Nothing the playhead hasn't reached goes.
 */
export function forgetEvicted(held: Map<string, HeldSegment>, nowS: number, limitBytes: number): void {
  let total = 0;
  for (const [, , bytes] of held.values()) total += bytes;
  if (total <= limitBytes) return;
  const passed = [...held.entries()].filter(([, [, end]]) => end < nowS).sort((a, b) => a[1][0] - b[1][0]);
  for (const [key, [, , bytes]] of passed) {
    if (total <= limitBytes) return;
    held.delete(key);
    total -= bytes;
  }
}
