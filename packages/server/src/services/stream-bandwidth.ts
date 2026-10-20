/**
 * What one viewer of a stream this server measures downloads, kbps, for the
 * qBittorrent manager's upload budget (routes/qbt-manager.ts): picture, sound
 * and MPEG-TS together, from the segments already in hand.
 *
 * Plex's own figure for a copy is no use to it. On 18 October the manager
 * took a Direct Stream of a 1 to 5 Mbps film at 121 Mbps — how fast Plex was
 * handing Theater the segments over the LAN, measured ahead of the watcher
 * (direct-stream.ts) — and cut qBittorrent's upload to its minimum.
 */

/** How far past the watcher a stream is measured, and the least of it in hand that counts as a measure. */
const BANDWIDTH_AHEAD_S = 120;
const BANDWIDTH_MEASURED_S = 30;

export interface Bandwidth {
  kbps: number;
  source: "measured" | "target";
}

/**
 * Every byte of the segments between `fromS` and BANDWIDTH_AHEAD_S past it,
 * over their length — the one playing at `fromS` among them, none wholly
 * behind it, none that starts past the window. A two-hour film watched from
 * its middle is measured there, not on a loud prologue nobody is downloading
 * any more. Less than BANDWIDTH_MEASURED_S of it in hand — a stream just
 * started, or near the end of the film — is no measure, and `targetKbps` is
 * given instead; null when that isn't known either.
 */
export function measureBandwidth(
  segments: ReadonlyArray<{ start: number; end: number; bytes: number }>,
  fromS: number,
  targetKbps: number | null,
): Bandwidth | null {
  let bytes = 0;
  let madeS = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.end <= fromS || seg.start >= fromS + BANDWIDTH_AHEAD_S) continue;
    // Its length as the playlist has it: up to where the next one starts.
    const lengthS = (segments[i + 1]?.start ?? seg.end) - seg.start;
    if (lengthS <= 0) continue;
    bytes += seg.bytes;
    madeS += lengthS;
  }
  const measured = madeS >= BANDWIDTH_MEASURED_S;
  const kbps = measured ? (bytes * 8) / madeS / 1000 : targetKbps;
  if (!kbps) return null;
  return { kbps: Math.min(10_000_000, Math.max(1, Math.round(kbps))), source: measured ? "measured" : "target" };
}
