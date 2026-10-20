/**
 * What one viewer of a stream this server makes or measures downloads, kbps,
 * for the qBittorrent manager's upload budget (routes/qbt-manager.ts): one
 * figure for the stream, as Plex gives one for each of its own.
 *
 * Plex's own figure for a copy is no use to it. On 18 October the manager
 * took a Direct Stream of a 1 to 5 Mbps film at 121 Mbps — how fast Plex was
 * handing Theater the segments over the LAN, measured ahead of the watcher
 * (direct-stream.ts) — and cut qBittorrent's upload to its minimum.
 *
 * Nor a figure that moves as the film does. Measured over the next two
 * minutes, it moved by a few kbps every poll, and the manager wrote a new
 * limit to qBittorrent every few seconds for it (20 October), for nothing:
 * a few hundred kbps either way change nothing qBittorrent does.
 */

/** In hand, at least, for an average to count, when there is no target to give. */
const AVERAGE_FROM_S = 30;

export interface Bandwidth {
  kbps: number;
  source: "measured" | "target";
}

/** What a stream keeps for its figure: its target, and its average once worked out. */
export interface BandwidthOf {
  /** The file's average for a copy; a re-encode's video target and its sound. */
  targetKbps: number | null;
  /** Worked out once, with no target, from the first AVERAGE_FROM_S in hand. */
  averageKbps: number | null;
  segments: ReadonlyArray<{ start: number; end: number; bytes: number }>;
}

/**
 * The stream's figure, the same from its start to its end: its target, or,
 * with none, the average of what it first had in hand — every byte of its
 * segments over their length — once that is AVERAGE_FROM_S, kept on `s` from
 * then on. Null until then.
 */
export function streamBandwidth(s: BandwidthOf): Bandwidth | null {
  if (s.targetKbps && s.targetKbps > 0) return { kbps: clampKbps(s.targetKbps), source: "target" };
  if (s.averageKbps === null) {
    let bytes = 0;
    let heldS = 0;
    for (let i = 0; i < s.segments.length; i++) {
      const seg = s.segments[i];
      // Its length as the playlist has it: up to where the next one starts.
      const lengthS = (s.segments[i + 1]?.start ?? seg.end) - seg.start;
      if (lengthS <= 0) continue;
      bytes += seg.bytes;
      heldS += lengthS;
    }
    if (heldS < AVERAGE_FROM_S) return null;
    s.averageKbps = (bytes * 8) / heldS / 1000;
  }
  return { kbps: clampKbps(s.averageKbps), source: "measured" };
}

function clampKbps(kbps: number): number {
  return Math.min(10_000_000, Math.max(1, Math.round(kbps)));
}
