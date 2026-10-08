/**
 * Matroska files and MPEG-TS segments just big enough to read keyframes from —
 * for keyframes.test.ts and direct-stream.test.ts.
 */

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
