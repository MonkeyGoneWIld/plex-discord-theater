/**
 * Matroska files and MPEG-TS segments just big enough to read keyframes from —
 * for keyframes.test.ts and direct-stream.test.ts — and Matroska files with
 * subtitle tracks and their index, for subtitle-reading.test.ts.
 */
import { deflateSync } from "node:zlib";

/** One frame: an IDR keyframe, a plain I-frame keyframe, a P-frame, or a
 *  P-frame a careless muxer marked as a keyframe. */
export type Frame = "idr" | "i" | "p" | "p-key";

/** Each frame's one slice: its NAL header, then first_mb_in_slice = 0 and the slice type. */
export const NAL: Record<Frame, number[]> = {
  idr: [0x65, 0x88, 0x84, 0x00], // IDR, slice_type 7 (I)
  i: [0x21, 0x88, 0x84, 0x00], // non-IDR, slice_type 7 (I)
  p: [0x41, 0x98, 0x84, 0x00], // non-IDR, slice_type 5 (P)
  "p-key": [0x41, 0x98, 0x84, 0x00],
};

function size(n: number): Buffer {
  for (let length = 1; length <= 8; length++) {
    if (n < 2 ** (7 * length) - 1) {
      const out = Buffer.alloc(length);
      let v = n;
      for (let i = length - 1; i >= 0; i--) {
        out[i] = v % 256;
        v = Math.floor(v / 256);
      }
      out[0] |= 0x80 >> (length - 1);
      return out;
    }
  }
  throw new Error("too big");
}

const UNKNOWN = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

function el(id: number[], data: Buffer | string | number[], unknownSize = false): Buffer {
  const body = typeof data === "string" ? Buffer.from(data, "latin1") : Buffer.from(data);
  return Buffer.concat([Buffer.from(id), unknownSize ? UNKNOWN : size(body.length), body]);
}

function block(frame: Frame, at: number): Buffer {
  const nal = Buffer.from(NAL[frame]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(nal.length);
  const key = frame === "p" ? 0 : 0x80;
  return Buffer.concat([Buffer.from([0x81, (at >> 8) & 0xff, at & 0xff, key]), length, nal]);
}

/**
 * A Matroska file holding one AVC track of these frames. `groups` writes them
 * as BlockGroups (a keyframe is one without a ReferenceBlock) instead of
 * SimpleBlocks; `unknownSizes` leaves the segment's and cluster's sizes open,
 * as a file still being written does.
 */
export function matroska(frames: Frame[], opts: { groups?: boolean; unknownSizes?: boolean } = {}): Buffer {
  const header = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], "matroska"));
  // avcC with four-byte NAL lengths, no parameter sets: enough for this.
  const avcC = [1, 0x64, 0x00, 0x28, 0xff, 0xe0, 0x00];
  const tracks = el([0x16, 0x54, 0xae, 0x6b], el([0xae], Buffer.concat([
    el([0xd7], [1]),
    el([0x83], [1]),
    el([0x86], "V_MPEG4/ISO/AVC"),
    el([0x63, 0xa2], avcC),
  ])));
  const blocks = frames.map((frame, i) => {
    if (!opts.groups) return el([0xa3], block(frame, i * 42));
    const simple = block(frame, i * 42);
    simple[3] = 0;
    const parts = [el([0xa1], simple)];
    if (frame === "p") parts.push(el([0xfb], [0xd6]));
    return el([0xa0], Buffer.concat(parts));
  });
  const cluster = el([0x1f, 0x43, 0xb6, 0x75], Buffer.concat([el([0xe7], [0]), ...blocks]), opts.unknownSizes);
  return Buffer.concat([header, el([0x18, 0x53, 0x80, 0x67], Buffer.concat([tracks, cluster]), opts.unknownSizes)]);
}

/**
 * An MPEG-TS segment whose first video frame is `frame`: a PES on PID 0x100
 * holding an access unit delimiter and the frame's slice, or the slice alone
 * with `delimiter` false.
 */
export function tsSegment(frame: Frame, delimiter = true): Buffer {
  const packet = Buffer.alloc(188, 0xff);
  packet.set([0x47, 0x41, 0x00, 0x10], 0);
  // A PES header with a PTS and nothing else.
  packet.set([0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, 0x21, 0x00, 0x01, 0x00, 0x01], 4);
  const es = [...(delimiter ? [0, 0, 1, 0x09, 0xf0] : []), 0, 0, 1, ...NAL[frame]];
  packet.set(es, 18);
  const next = Buffer.alloc(188, 0xab);
  next.set([0x47, 0x01, 0x00, 0x11], 0);
  return Buffer.concat([packet, next]);
}

// ── Subtitles in a Matroska file, with or without their index ─────

/** One subtitle line, in seconds. */
export interface FixtureLine {
  start: number;
  end: number;
  text: string;
  /** The block as it is, for a picture subtitle's display set: `text` unused. */
  bytes?: Buffer;
}

export interface FixtureSubtitleTrack {
  codec: "S_TEXT/UTF8" | "S_TEXT/ASS" | "S_HDMV/PGS";
  /** An ASS track's header — script info, styles, the events' Format line. */
  header?: string;
  lines: FixtureLine[];
  /** Its blocks zlib-packed, as old mkvmerge did by default. */
  zlib?: boolean;
}

/** An unsigned integer in `bytes` bytes, big-endian. */
function uintOf(n: number, bytes = 0): Buffer {
  const out: number[] = [];
  let v = n;
  do { out.unshift(v % 256); v = Math.floor(v / 256); } while (v > 0);
  while (out.length < bytes) out.unshift(0);
  return Buffer.from(out);
}

/** An element whose size is written in eight bytes, as some muxers write
 *  a cluster's. */
function wideEl(id: number[], body: Buffer): Buffer {
  const sz = Buffer.alloc(8);
  sz[0] = 0x01;
  let v = body.length;
  for (let i = 7; i > 0; i--) { sz[i] = v % 256; v = Math.floor(v / 256); }
  return Buffer.concat([Buffer.from(id), sz, body]);
}

/**
 * A film of `durationS` seconds — a video track of padding and these subtitle
 * tracks — in clusters of `clusterS` seconds, each led by `paddingBytes` of
 * "video" so its lines sit apart in the file the way a real film's do. The
 * index lists every cluster for the video and, unless `subtitleCues` is false
 * (ffmpeg's muxer), every subtitle line with where it is in its cluster and
 * how long it lasts, as mkvmerge writes it. `wideClusters` writes every other
 * cluster's size in eight bytes.
 */
export function matroskaWithSubtitles(opts: {
  durationS: number;
  tracks: FixtureSubtitleTrack[];
  clusterS?: number;
  paddingBytes?: number;
  subtitleCues?: boolean;
  wideClusters?: boolean;
}): Buffer {
  const clusterS = opts.clusterS ?? 5;
  const padding = opts.paddingBytes ?? 20_000;
  const header = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], "matroska"));
  const info = el([0x15, 0x49, 0xa9, 0x66], el([0x2a, 0xd7, 0xb1], uintOf(1_000_000)));
  const entries = [el([0xae], Buffer.concat([el([0xd7], [1]), el([0x83], [1]), el([0x86], "V_MPEG4/ISO/AVC")]))];
  opts.tracks.forEach((t, i) => {
    const fields = [el([0xd7], [i + 2]), el([0x83], [0x11]), el([0x86], t.codec)];
    if (t.header) fields.push(el([0x63, 0xa2], Buffer.from(t.header, "utf-8")));
    if (t.zlib) {
      fields.push(el([0x6d, 0x80], el([0x62, 0x40], el([0x50, 0x34], el([0x42, 0x54], [0])))));
    }
    entries.push(el([0xae], Buffer.concat(fields)));
  });
  const tracks = el([0x16, 0x54, 0xae, 0x6b], Buffer.concat(entries));

  // Clusters, noting where each subtitle block is in its cluster's data.
  const clusters: Buffer[] = [];
  const cuePoints: Array<{ time: number; track: number; cluster: number; relative: number; duration?: number }> = [];
  let readOrder = 0;
  let offset = 0; // from the end of SeekHead/Info/Tracks, filled in below
  const clusterOffsets: number[] = [];
  for (let c = 0; c * clusterS < opts.durationS; c++) {
    const from = c * clusterS;
    const parts: Buffer[] = [el([0xe7], uintOf(from * 1000))];
    // The video: one keyframe of padding.
    parts.push(el([0xa3], Buffer.concat([Buffer.from([0x81, 0, 0, 0x80]), Buffer.alloc(padding, 0x55)])));
    cuePoints.push({ time: from * 1000, track: 1, cluster: -1 - c, relative: 0 });
    opts.tracks.forEach((t, i) => {
      for (const line of t.lines.filter((l) => l.start >= from && l.start < from + clusterS)) {
        const relative = parts.reduce((n, p) => n + p.length, 0);
        let payload = line.bytes ?? Buffer.from(t.codec === "S_TEXT/ASS" ? `${readOrder++},${line.text}` : line.text, "utf-8");
        if (t.zlib) payload = deflateSync(payload);
        const ms = Math.round((line.start - from) * 1000);
        const blockBody = Buffer.concat([Buffer.from([0x80 | (i + 2), (ms >> 8) & 0xff, ms & 0xff, 0]), payload]);
        const duration = Math.round((line.end - line.start) * 1000);
        parts.push(el([0xa0], Buffer.concat([el([0xa1], blockBody), el([0x9b], uintOf(duration))])));
        if (opts.subtitleCues !== false) {
          cuePoints.push({ time: Math.round(line.start * 1000), track: i + 2, cluster: -1 - c, relative, duration });
        }
      }
    });
    const body = Buffer.concat(parts);
    const cluster = opts.wideClusters && c % 2 === 1 ? wideEl([0x1f, 0x43, 0xb6, 0x75], body) : el([0x1f, 0x43, 0xb6, 0x75], body);
    clusterOffsets.push(offset);
    offset += cluster.length;
    clusters.push(cluster);
  }

  // Positions are from the start of the segment's data: SeekHead (fixed
  // size), Info, Tracks, the clusters, then Cues.
  const seek = (id: number[], position: number) =>
    el([0x4d, 0xbb], Buffer.concat([el([0x53, 0xab], id), el([0x53, 0xac], uintOf(position, 8))]));
  const seekHeadLength = el([0x11, 0x4d, 0x9b, 0x74], Buffer.concat([
    seek([0x15, 0x49, 0xa9, 0x66], 0), seek([0x16, 0x54, 0xae, 0x6b], 0), seek([0x1c, 0x53, 0xbb, 0x6b], 0),
  ])).length;
  const clustersAt = seekHeadLength + info.length + tracks.length;
  const sorted = cuePoints
    .map((p) => ({ ...p, cluster: clustersAt + clusterOffsets[-1 - p.cluster] }))
    .sort((a, b) => a.time - b.time || a.track - b.track);
  const cues = el([0x1c, 0x53, 0xbb, 0x6b], Buffer.concat(sorted.map((p) => el([0xbb], Buffer.concat([
    el([0xb3], uintOf(p.time)),
    el([0xb7], Buffer.concat([
      el([0xf7], [p.track]),
      el([0xf1], uintOf(p.cluster)),
      el([0xf0], uintOf(p.relative)),
      ...(p.duration !== undefined ? [el([0xb2], uintOf(p.duration))] : []),
    ])),
  ])))));
  const cuesAt = clustersAt + offset;
  const seekHead = el([0x11, 0x4d, 0x9b, 0x74], Buffer.concat([
    seek([0x15, 0x49, 0xa9, 0x66], seekHeadLength),
    seek([0x16, 0x54, 0xae, 0x6b], seekHeadLength + info.length),
    seek([0x1c, 0x53, 0xbb, 0x6b], cuesAt),
  ]));
  const segment = Buffer.concat([seekHead, info, tracks, ...clusters, cues]);
  return Buffer.concat([header, el([0x18, 0x53, 0x80, 0x67], segment)]);
}
