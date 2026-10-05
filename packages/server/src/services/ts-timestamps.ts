/**
 * Where an MPEG-TS segment's video starts and ends, read straight from its
 * packets.
 *
 * Direct Stream needs this because Plex won't say. When it copies a video
 * stream it cuts a segment at every keyframe — anywhere from one second to ten
 * — while its playlist claims three seconds for every one, so by the middle of
 * a film the playlist is minutes away from what the segments hold. The bytes
 * are the only honest account, and the presentation timestamps on the video
 * PES headers are all of it that is needed: no demuxer, no ffmpeg.
 *
 * Video is found by its PES stream id (0xE0–0xEF) rather than through the
 * PAT/PMT, which keeps this a single pass and indifferent to which PID Plex
 * happens to use.
 */

const PACKET = 188;
const SYNC = 0x47;
const PTS_HZ = 90_000;

export interface VideoSpan {
  /** Earliest presentation time in the segment, in seconds of Plex's clock. */
  start: number;
  /** Where the segment's last frame ends — its latest timestamp plus one frame. */
  end: number;
  /** Video frames found. */
  frames: number;
}

/** The first offset at which two consecutive packets both start with a sync byte. */
function alignment(buf: Uint8Array): number {
  for (let i = 0; i < Math.min(buf.length, PACKET); i++) {
    if (buf[i] === SYNC && (i + PACKET >= buf.length || buf[i + PACKET] === SYNC)) return i;
  }
  return -1;
}

/** A 33-bit PTS from the five bytes at `b`, in 90 kHz ticks. */
function readPts(buf: Uint8Array, b: number): number {
  const high = (buf[b] >> 1) & 0x07;
  const mid = ((buf[b + 1] << 8) | buf[b + 2]) >> 1;
  const low = ((buf[b + 3] << 8) | buf[b + 4]) >> 1;
  return high * 2 ** 30 + mid * 2 ** 15 + low;
}

/**
 * The span of video in one segment, or null when it holds none — which is how
 * Plex's copied streams end: past the real last segment, every one it serves is
 * a lone 188-byte packet.
 */
export function videoSpan(buf: Uint8Array): VideoSpan | null {
  const first = alignment(buf);
  if (first < 0) return null;
  const pts: number[] = [];
  for (let p = first; p + PACKET <= buf.length; p += PACKET) {
    if (buf[p] !== SYNC) continue;
    // A PES header only ever begins where a payload unit starts.
    if ((buf[p + 1] & 0x40) === 0) continue;
    const adaptation = (buf[p + 3] >> 4) & 0x03;
    if (adaptation === 0 || adaptation === 2) continue; // no payload
    const payload = adaptation === 3 ? p + 5 + buf[p + 4] : p + 4;
    if (payload + 14 > p + PACKET) continue;
    if (buf[payload] !== 0 || buf[payload + 1] !== 0 || buf[payload + 2] !== 1) continue;
    const streamId = buf[payload + 3];
    if (streamId < 0xe0 || streamId > 0xef) continue;
    if ((buf[payload + 7] & 0x80) === 0) continue; // no PTS on this one
    pts.push(readPts(buf, payload + 9));
  }
  if (pts.length === 0) return null;

  pts.sort((a, b) => a - b);
  // One frame's length, from the commonest gap between neighbours — B-frames
  // arrive out of order, which the sort above has already undone.
  const gaps: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const gap = pts[i] - pts[i - 1];
    if (gap > 0) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  const frame = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  return {
    start: pts[0] / PTS_HZ,
    end: (pts[pts.length - 1] + frame) / PTS_HZ,
    frames: pts.length,
  };
}
