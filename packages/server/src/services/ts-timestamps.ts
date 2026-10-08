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
 * happens to use. Audio (0xC0–0xDF) is read too, for where it starts: hls.js
 * lines a stream up by whichever of the two starts first, and in a copy begun
 * mid-film the audio can start well before the first keyframe.
 */

import { isISlice } from "./h264.js";

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
  /** Earliest audio presentation time, Plex's clock, or null with no audio. */
  audioStart: number | null;
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
  let audioStart: number | null = null;
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
    const video = streamId >= 0xe0 && streamId <= 0xef;
    const audio = streamId >= 0xc0 && streamId <= 0xdf;
    if (!video && !audio) continue;
    if ((buf[payload + 7] & 0x80) === 0) continue; // no PTS on this one
    const at = readPts(buf, payload + 9);
    if (video) pts.push(at);
    else if (audioStart === null || at < audioStart) audioStart = at;
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
    audioStart: audioStart === null ? null : audioStart / PTS_HZ,
  };
}

/**
 * Whether a segment opens on an IDR frame or on a plain I-frame — see
 * keyframes.ts for why a copy of the second kind is re-encoded. Read from the
 * first video access unit's slices; null when the video isn't H.264 with an
 * access unit delimiter, which is how Plex writes it, or can't be read.
 */
export function firstKeyframe(buf: Uint8Array): "idr" | "not-idr" | null {
  const first = alignment(buf);
  if (first < 0) return null;
  let pid = -1;
  const es: number[] = [];
  for (let p = first; p + PACKET <= buf.length && es.length < 65_536; p += PACKET) {
    if (buf[p] !== SYNC) continue;
    const start = (buf[p + 1] & 0x40) !== 0;
    const packetPid = ((buf[p + 1] & 0x1f) << 8) | buf[p + 2];
    const adaptation = (buf[p + 3] >> 4) & 0x03;
    if (adaptation === 0 || adaptation === 2) continue;
    let payload = adaptation === 3 ? p + 5 + buf[p + 4] : p + 4;
    if (pid < 0) {
      if (!start || payload + 9 > p + PACKET) continue;
      if (buf[payload] !== 0 || buf[payload + 1] !== 0 || buf[payload + 2] !== 1) continue;
      const streamId = buf[payload + 3];
      if (streamId < 0xe0 || streamId > 0xef) continue;
      pid = packetPid;
      payload += 9 + buf[payload + 8];
    } else if (packetPid !== pid) {
      continue;
    } else if (start) {
      break; // the next frame
    }
    for (let i = payload; i < p + PACKET; i++) es.push(buf[i]);
  }
  // NAL units by their start codes.
  const nals: number[] = [];
  for (let i = 0; i + 3 < es.length; i++) {
    if (es[i] === 0 && es[i + 1] === 0 && es[i + 2] === 1) nals.push(i + 3);
  }
  if (nals.length === 0 || es[nals[0]] !== 0x09) return null;
  for (let n = 0; n < nals.length; n++) {
    const type = es[nals[n]] & 0x1f;
    if (type === 5) return "idr";
    if (type === 1) {
      const end = n + 1 < nals.length ? nals[n + 1] : es.length;
      return isISlice(Uint8Array.from(es.slice(nals[n], Math.min(end, nals[n] + 64)))) ? "not-idr" : null;
    }
  }
  return null;
}
