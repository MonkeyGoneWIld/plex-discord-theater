/**
 * PGS subtitles (a Blu-ray's), read from the .sup the server cuts out of the
 * film, for PictureSubtitleLayer to draw over the picture.
 *
 * A .sup is segments, each "PG", its time (90 kHz), a type and a length. A
 * display set is a run of them ending in END: a composition (PCS) saying
 * which objects go where on a canvas the size of the film, with the palettes
 * (PDS) and objects (ODS: run-length-encoded pictures) it needs, or none, which
 * clears the screen. Each set is kept as it came, run lengths and all, and a
 * picture is made of it only when it is up: a film's worth of them as
 * pictures would be a gigabyte.
 *
 * Colours as ffmpeg's decoder has them, so a subtitle drawn here is the one a
 * burned-in stream would show: limited-range YCbCr, BT.709 above 576 lines
 * and BT.601 at or below.
 */

const PCS = 0x16;
const WDS = 0x17;
const PDS = 0x14;
const ODS = 0x15;
const END = 0x80;

/** One object on the canvas: where, which part of it, its pixels and colours. */
export interface PgsObject {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Its run lengths, as the stream has them. */
  rle: Uint8Array;
  /** RGBA for each of its 256 colours. */
  palette: Uint8ClampedArray;
  /** The part of it shown, when it is cropped. */
  crop: { x: number; y: number; width: number; height: number } | null;
}

/** A display set: from `pts` (film seconds), these objects; none clears. */
export interface PgsDisplay {
  pts: number;
  width: number;
  height: number;
  objects: PgsObject[];
}

/** Colour by colour, YCbCr (limited range) to RGBA, as ffmpeg's pgssubdec. */
export function paletteRgba(entries: Array<[number, number, number, number, number]>, hd: boolean): Uint8ClampedArray {
  const out = new Uint8ClampedArray(256 * 4);
  // libavcodec's colorspace.h, YUV_TO_RGB1_CCIR(_BT709).
  const [kr, kgb, kgr, kb] = hd ? [1.5747, 0.1873, 0.4682, 1.8556] : [1.402, 0.34414, 0.71414, 1.772];
  for (const [id, y, cr, cb, a] of entries) {
    const Y = (y - 16) * 255 / 219;
    const Cb = (cb - 128) * 255 / 224;
    const Cr = (cr - 128) * 255 / 224;
    out[id * 4] = Math.round(Y + kr * Cr);
    out[id * 4 + 1] = Math.round(Y - kgb * Cb - kgr * Cr);
    out[id * 4 + 2] = Math.round(Y + kb * Cb);
    out[id * 4 + 3] = a;
  }
  return out;
}

/**
 * An object's pixels, RGBA, from its run lengths: a non-zero byte is a pixel
 * of that colour; 00 starts a run — 00 00 ends a line; 00 0L, 00 4L LL a run
 * of colour 0; 00 8L C, 00 CL LL C a run of colour C.
 */
export function decodeRle(o: PgsObject): Uint8ClampedArray<ArrayBuffer> {
  const { width, height, rle, palette } = o;
  const out = new Uint8ClampedArray(width * height * 4);
  let x = 0;
  let y = 0;
  let i = 0;
  const put = (colour: number, run: number) => {
    if (y >= height) return;
    const n = Math.min(run, width - x);
    if (n <= 0) return;
    const a = palette[colour * 4 + 3];
    if (a !== 0) {
      const r = palette[colour * 4], g = palette[colour * 4 + 1], b = palette[colour * 4 + 2];
      for (let k = (y * width + x) * 4, end = k + n * 4; k < end; k += 4) {
        out[k] = r;
        out[k + 1] = g;
        out[k + 2] = b;
        out[k + 3] = a;
      }
    }
    x += n;
  };
  while (i < rle.length && y < height) {
    const c = rle[i++];
    if (c !== 0) {
      put(c, 1);
      continue;
    }
    const flag = rle[i++] ?? 0;
    if (flag === 0) {
      x = 0;
      y++;
      continue;
    }
    const long = (flag & 0x40) !== 0;
    const run = long ? ((flag & 0x3f) << 8) | (rle[i++] ?? 0) : flag & 0x3f;
    const colour = (flag & 0x80) !== 0 ? rle[i++] ?? 0 : 0;
    put(colour, run);
  }
  return out;
}

interface Placement {
  objectId: number;
  x: number;
  y: number;
  crop: PgsObject["crop"];
}

interface StoredObject {
  width: number;
  height: number;
  /** How many bytes of run lengths the first fragment says there are. */
  length: number;
  parts: Uint8Array[];
}

/**
 * Reads display sets out of a .sup as it comes, a piece of it at a time.
 * Each piece the server cuts gets one of these: a piece can begin anywhere
 * in the film, and a set that names objects or a palette from before it began
 * is let go — the piece before has it.
 */
export class PgsReader {
  private rest = new Uint8Array(0);
  private palettes = new Map<number, Array<[number, number, number, number, number]>>();
  private objects = new Map<number, StoredObject>();
  private pcs: { pts: number; width: number; height: number; paletteId: number; placements: Placement[] } | null = null;
  /** Bytes read, all of them: where to ask the server to go on from. */
  read = 0;

  /** The display sets completed by these bytes. */
  push(bytes: Uint8Array): PgsDisplay[] {
    const buf = this.rest.length ? concat(this.rest, bytes) : bytes;
    this.read += bytes.length;
    const out: PgsDisplay[] = [];
    let at = 0;
    while (buf.length - at >= 13) {
      if (buf[at] !== 0x50 || buf[at + 1] !== 0x47) {
        // Not a segment: look for the next one.
        at++;
        continue;
      }
      const size = (buf[at + 11] << 8) | buf[at + 12];
      if (buf.length - at < 13 + size) break;
      const pts = ((buf[at + 2] << 24) >>> 0) + (buf[at + 3] << 16) + (buf[at + 4] << 8) + buf[at + 5];
      const type = buf[at + 10];
      const body = buf.subarray(at + 13, at + 13 + size);
      const shown = this.segment(type, pts / 90_000, body);
      if (shown) out.push(shown);
      at += 13 + size;
    }
    this.rest = buf.slice(at);
    return out;
  }

  private segment(type: number, pts: number, b: Uint8Array): PgsDisplay | null {
    const u16 = (i: number) => (b[i] << 8) | b[i + 1];
    if (type === PCS && b.length >= 11) {
      const state = b[7];
      // An epoch starts afresh: nothing from before it is drawn again.
      if (state & 0x80) {
        this.palettes.clear();
        this.objects.clear();
      }
      const count = b[10];
      const placements: Placement[] = [];
      let i = 11;
      for (let n = 0; n < count && i + 8 <= b.length; n++) {
        const flags = b[i + 3];
        const cropped = (flags & 0x80) !== 0;
        placements.push({
          objectId: u16(i), x: u16(i + 4), y: u16(i + 6),
          crop: cropped && i + 16 <= b.length
            ? { x: u16(i + 8), y: u16(i + 10), width: u16(i + 12), height: u16(i + 14) }
            : null,
        });
        i += cropped ? 16 : 8;
      }
      this.pcs = { pts, width: u16(0), height: u16(2), paletteId: b[9], placements };
      return null;
    }
    if (type === PDS && b.length >= 2) {
      const entries: Array<[number, number, number, number, number]> = [];
      for (let i = 2; i + 5 <= b.length; i += 5) entries.push([b[i], b[i + 1], b[i + 2], b[i + 3], b[i + 4]]);
      this.palettes.set(b[0], entries);
      return null;
    }
    if (type === ODS && b.length >= 4) {
      const id = u16(0);
      const seq = b[3];
      if (seq & 0x80) {
        if (b.length < 11) return null;
        const length = (b[4] << 16) | (b[5] << 8) | b[6];
        this.objects.set(id, { width: u16(7), height: u16(9), length: Math.max(0, length - 4), parts: [b.slice(11)] });
      } else {
        this.objects.get(id)?.parts.push(b.slice(4));
      }
      return null;
    }
    if (type === WDS) return null;
    if (type !== END || !this.pcs) return null;
    const pcs = this.pcs;
    this.pcs = null;
    const entries = this.palettes.get(pcs.paletteId);
    const objects: PgsObject[] = [];
    for (const p of pcs.placements) {
      const o = this.objects.get(p.objectId);
      // Named, but from before this piece began.
      if (!o || !entries) return null;
      const rle = o.parts.length === 1 ? o.parts[0] : concat(...o.parts);
      objects.push({
        x: p.x, y: p.y, width: o.width, height: o.height, crop: p.crop,
        rle: rle.length > o.length && o.length > 0 ? rle.subarray(0, o.length) : rle,
        palette: paletteRgba(entries, pcs.height > 576),
      });
    }
    return { pts: pcs.pts, width: pcs.width, height: pcs.height, objects };
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Display sets from every piece, in film order, one of each: where two pieces
 * overlap both have the sets there.
 */
export function mergeDisplays(into: PgsDisplay[], more: PgsDisplay[]): PgsDisplay[] {
  if (!more.length) return into;
  const byTime = new Map<number, PgsDisplay>();
  for (const d of into) byTime.set(Math.round(d.pts * 1000), d);
  for (const d of more) {
    const key = Math.round(d.pts * 1000);
    if (!byTime.has(key)) byTime.set(key, d);
  }
  return [...byTime.values()].sort((a, b) => a.pts - b.pts);
}

/** The set on screen at `t` (film seconds): the last at or before it, unless that cleared it. */
export function displayAt(list: PgsDisplay[], t: number): PgsDisplay | null {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].pts <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const d = found >= 0 ? list[found] : null;
  return d && d.objects.length ? d : null;
}
