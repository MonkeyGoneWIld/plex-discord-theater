/**
 * VobSub (a DVD's subtitles) and DVB (a broadcast's) made PGS, for the player
 * to draw as it draws a Blu-ray's (picture-subtitles.ts, the client's
 * PictureSubtitleLayer) rather than have them burned into a re-encode of the
 * film: a viewer with one on then shares the room's copy.
 *
 * All three are pictures of a few colours; only the coding differs. A VobSub
 * packet is one subtitle: a two-bit picture, its four colours picked from the
 * track's sixteen (its .idx header), and when it goes up and comes down. A DVB
 * display set paints objects into regions of a page from colour tables of 4,
 * 16 or 256 entries, and what it painted stays for the next set to change.
 * Both are read here as ffmpeg's decoders read them, colours included, so a
 * subtitle drawn is the one a burned-in stream shows. Each picture becomes a
 * PGS display set drawn afresh (an epoch start), and its end one that clears.
 */

export type BitmapCodec = "vobsub" | "dvb";

/** Plex's (or ffmpeg's) name for a subtitle codec, as one made PGS here; null otherwise. */
export function bitmapCodecOf(codec: string | null | undefined): BitmapCodec | null {
  const c = (codec ?? "").toLowerCase();
  if (c === "vobsub" || c === "dvd_subtitle") return "vobsub";
  if (c === "dvb_subtitle" || c === "dvbsub") return "dvb";
  return null;
}

/** A picture on the canvas: a palette index per pixel, and RGBA (0xRRGGBBAA)
 *  per index; index 0 is clear, whatever its colour. */
export interface Bitmap {
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: Uint8Array;
  palette: Uint32Array;
}

/** A VobSub track's canvas and sixteen colours (0xRRGGBB), from its .idx header. */
export interface VobsubHeader {
  width: number | null;
  height: number | null;
  palette: number[] | null;
}

export function vobsubHeader(text: string | null | undefined): VobsubHeader {
  const size = /^\s*size:\s*(\d+)\s*x\s*(\d+)/im.exec(text ?? "");
  const line = /^\s*palette:\s*(.+)$/im.exec(text ?? "");
  const colours = line ? line[1].split(/[,\s]+/).filter(Boolean).map((h) => parseInt(h, 16)) : [];
  return {
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
    palette: colours.length >= 16 && colours.slice(0, 16).every((c) => Number.isFinite(c)) ? colours.slice(0, 16) : null,
  };
}

const rgba = (r: number, g: number, b: number, a: number) =>
  ((clamp(r) << 24) | (clamp(g) << 16) | (clamp(b) << 8) | clamp(a)) >>> 0;
const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

// ── VobSub ─────────────────────────────────────────────────────────

export interface Spu {
  /** After the packet's time, milliseconds. Null stop: up until the next. */
  startMs: number;
  stopMs: number | null;
  bitmap: Bitmap | null;
}

/**
 * ffmpeg's guess at colours for a VobSub with no palette (one out of a VOB,
 * whose palette is in the DVD's IFO): grey levels of yellow by opacity, as
 * dvdsubdec's guess_palette.
 */
function guessPalette(colormap: number[], alpha: number[]): number[] {
  const levels = [[0xff], [0x00, 0xff], [0x00, 0x80, 0xff], [0x00, 0x55, 0xaa, 0xff]];
  const out = [0, 0, 0, 0];
  const opaque = new Set(colormap.filter((_, i) => alpha[i] !== 0)).size;
  if (opaque === 0) return out;
  const used = new Map<number, number>();
  let j = 0;
  for (let i = 0; i < 4; i++) {
    if (alpha[i] === 0) continue;
    const seen = used.get(colormap[i]);
    if (seen !== undefined) {
      out[i] = out[seen];
      continue;
    }
    const level = levels[opaque - 1][j++];
    out[i] = (((0xff * level) >> 8) << 16) | (((0xff * level) >> 8) << 8);
    used.set(colormap[i], i);
  }
  return out;
}

/** A field of a VobSub picture: every other line from `first`, two bits a pixel, run-length coded. */
function spuField(buf: Uint8Array, offset: number, pixels: Uint8Array, w: number, h: number, first: number): void {
  let nib = offset * 2;
  const end = buf.length * 2;
  const read = () => {
    const v = nib < end ? (nib & 1 ? buf[nib >> 1] & 15 : buf[nib >> 1] >> 4) : 0;
    nib++;
    return v;
  };
  for (let y = first; y < h; y += 2) {
    let x = 0;
    while (x < w) {
      if (nib >= end) return;
      let v = 0;
      for (let t = 1; v < t && t <= 0x40; t <<= 2) v = (v << 4) | read();
      const len = v < 4 ? w - x : Math.min(v >> 2, w - x);
      // Colours 1 to 4: 0 is left clear (Bitmap).
      pixels.fill((v & 3) + 1, y * w + x, y * w + x + len);
      x += len;
    }
    if (nib & 1) nib++;
  }
}

/** One VobSub packet as ffmpeg's dvdsubdec reads it; null for one too short to be one. */
export function decodeSpu(buf: Uint8Array, palette: number[] | null): Spu | null {
  // A zero size: an HD DVD's, with four-byte offsets, which this doesn't read.
  if (buf.length < 10 || (buf[0] === 0 && buf[1] === 0)) return null;
  const u16 = (i: number) => (buf[i] << 8) | buf[i + 1];
  const colormap = [0, 0, 0, 0];
  const alpha = [0, 0, 0, 0];
  let start = 0;
  let stop: number | null = null;
  let bitmap: Bitmap | null = null;
  let cmdPos = u16(2);
  for (let guard = 0; cmdPos > 0 && cmdPos + 4 <= buf.length && guard < 256; guard++) {
    const date = u16(cmdPos);
    const next = u16(cmdPos + 2);
    let pos = cmdPos + 4;
    let x1 = 0, y1 = 0, x2 = 0, y2 = 0, off1 = -1, off2 = -1;
    commands: while (pos < buf.length) {
      const cmd = buf[pos++];
      switch (cmd) {
        case 0x00:
          // Shown even with subtitles off: no matter, here.
          break;
        case 0x01:
          start = (date << 10) / 90;
          break;
        case 0x02:
          stop = (date << 10) / 90;
          break;
        case 0x03:
        case 0x04: {
          if (pos + 2 > buf.length) break commands;
          const to = cmd === 0x03 ? colormap : alpha;
          to[3] = buf[pos] >> 4;
          to[2] = buf[pos] & 15;
          to[1] = buf[pos + 1] >> 4;
          to[0] = buf[pos + 1] & 15;
          pos += 2;
          break;
        }
        case 0x05:
          if (pos + 6 > buf.length) break commands;
          x1 = (buf[pos] << 4) | (buf[pos + 1] >> 4);
          x2 = ((buf[pos + 1] & 15) << 8) | buf[pos + 2];
          y1 = (buf[pos + 3] << 4) | (buf[pos + 4] >> 4);
          y2 = ((buf[pos + 4] & 15) << 8) | buf[pos + 5];
          pos += 6;
          break;
        case 0x06:
          if (pos + 4 > buf.length) break commands;
          off1 = u16(pos);
          off2 = u16(pos + 2);
          pos += 4;
          break;
        default:
          // 0xFF ends the commands; anything else is a DVD menu's or broken.
          break commands;
      }
    }
    const w = x2 - x1 + 1;
    const h = y2 - y1 + 1;
    if (off1 >= 0 && off2 >= 0 && w > 0 && h > 0 && w <= 4096 && h <= 4096) {
      const pixels = new Uint8Array(w * h);
      spuField(buf, off1, pixels, w, h, 0);
      spuField(buf, off2, pixels, w, h, 1);
      const colours = palette ? colormap.map((c) => palette[c] & 0xffffff) : guessPalette(colormap, alpha);
      const pal = new Uint32Array(256);
      for (let i = 0; i < 4; i++) pal[i + 1] = ((colours[i] << 8) | (alpha[i] * 17)) >>> 0;
      bitmap = { x: x1, y: y1, width: w, height: h, pixels, palette: pal };
    }
    if (next <= cmdPos) break;
    cmdPos = next;
  }
  return { startMs: start, stopMs: stop, bitmap };
}

// ── DVB ────────────────────────────────────────────────────────────

/** Limited-range BT.601 YCbCr to RGB, as ffmpeg's YUV_TO_RGB1_CCIR. */
function ycc601(y: number, cr: number, cb: number, a: number): number {
  const Y = (y - 16) * 255 / 219;
  const Cb = (cb - 128) * 255 / 224;
  const Cr = (cr - 128) * 255 / 224;
  return rgba(Y + 1.402 * Cr, Y - 0.34414 * Cb - 0.71414 * Cr, Y + 1.772 * Cb, a);
}

interface Clut { c4: Uint32Array; c16: Uint32Array; c256: Uint32Array }

/** The tables a region uses when its own don't say: EN 300 743's, as ffmpeg's dvbsubdec has them. */
const DEFAULT_CLUT: Clut = (() => {
  const c4 = Uint32Array.from([rgba(0, 0, 0, 0), rgba(255, 255, 255, 255), rgba(0, 0, 0, 255), rgba(127, 127, 127, 255)]);
  const c16 = new Uint32Array(16);
  for (let i = 1; i < 16; i++) {
    const v = i < 8 ? 255 : 127;
    c16[i] = rgba(i & 1 ? v : 0, i & 2 ? v : 0, i & 4 ? v : 0, 255);
  }
  const c256 = new Uint32Array(256);
  for (let i = 1; i < 256; i++) {
    if (i < 8) {
      c256[i] = rgba(i & 1 ? 255 : 0, i & 2 ? 255 : 0, i & 4 ? 255 : 0, 63);
      continue;
    }
    const lo = (bit: number, hi: number, a: number, b: number) => ((i & bit) ? a : 0) + ((i & hi) ? b : 0);
    switch (i & 0x88) {
      case 0x00:
        c256[i] = rgba(lo(1, 0x10, 85, 170), lo(2, 0x20, 85, 170), lo(4, 0x40, 85, 170), 255);
        break;
      case 0x08:
        c256[i] = rgba(lo(1, 0x10, 85, 170), lo(2, 0x20, 85, 170), lo(4, 0x40, 85, 170), 127);
        break;
      case 0x80:
        c256[i] = rgba(127 + lo(1, 0x10, 43, 85), 127 + lo(2, 0x20, 43, 85), 127 + lo(4, 0x40, 43, 85), 255);
        break;
      default:
        c256[i] = rgba(lo(1, 0x10, 43, 85), lo(2, 0x20, 43, 85), lo(4, 0x40, 43, 85), 255);
    }
  }
  return { c4, c16, c256 };
})();

interface Region {
  width: number;
  height: number;
  depth: 2 | 4 | 8;
  clut: number;
  pixels: Uint8Array;
  objects: Array<{ id: number; x: number; y: number }>;
  /** Drawn in since it was made: one that isn't, isn't shown (as dvbsubdec). */
  dirty: boolean;
}

/** Reads bits off a buffer, most significant first. */
class Bits {
  private bit = 0;
  constructor(private buf: Uint8Array, private at: number, private end: number) {}
  get(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.at + (this.bit >> 3);
      const b = byte < this.end ? (this.buf[byte] >> (7 - (this.bit & 7))) & 1 : 0;
      v = (v << 1) | b;
      this.bit++;
    }
    return v;
  }
  get done(): boolean { return this.at + (this.bit >> 3) >= this.end; }
  /** The byte after the last bit read. */
  get next(): number { return this.at + ((this.bit + 7) >> 3); }
}

/**
 * A DVB subtitle track read display set by display set, as ffmpeg's
 * dvbsubdec: what a set leaves stays for the next to change, until a set
 * starts the page over (an acquisition point or a mode change).
 */
export class DvbDecoder {
  private regions = new Map<number, Region>();
  private cluts = new Map<number, Clut>();
  private page: Array<{ id: number; x: number; y: number }> = [];
  private timeoutS = 0;
  private paged = false;
  canvasWidth = 720;
  canvasHeight = 576;

  /** A packet's segments: what the page shows once they end a display set, or null when none does. */
  push(buf: Uint8Array): { bitmap: Bitmap | null; timeoutS: number } | null {
    // MPEG-TS's data identifier and stream id, which a demuxer may leave on.
    let p = 0;
    while (buf[p] === 0x20 && buf[p + 1] === 0x00) p += 2;
    let shown: { bitmap: Bitmap | null; timeoutS: number } | null = null;
    while (p + 6 <= buf.length && buf[p] === 0x0f) {
      const type = buf[p + 1];
      const length = (buf[p + 4] << 8) | buf[p + 5];
      const end = Math.min(buf.length, p + 6 + length);
      const d = buf.subarray(p + 6, end);
      if (type === 0x10) this.pageComposition(d);
      else if (type === 0x11) this.regionComposition(d);
      else if (type === 0x12) this.clutDefinition(d);
      else if (type === 0x13) this.objectData(d);
      else if (type === 0x14) this.displayDefinition(d);
      else if (type === 0x80) {
        shown = this.display();
        this.paged = false;
      }
      p = end;
    }
    // A packet without the end-of-display segment: its page is shown as it is.
    if (!shown && this.paged) {
      shown = this.display();
      this.paged = false;
    }
    return shown;
  }

  private pageComposition(d: Uint8Array): void {
    if (d.length < 2) return;
    this.timeoutS = d[0];
    const state = (d[1] >> 2) & 3;
    if (state === 1 || state === 2) {
      this.regions.clear();
      this.cluts.clear();
    }
    this.page = [];
    for (let i = 2; i + 6 <= d.length; i += 6) {
      this.page.push({ id: d[i], x: (d[i + 2] << 8) | d[i + 3], y: (d[i + 4] << 8) | d[i + 5] });
    }
    this.paged = true;
  }

  private regionComposition(d: Uint8Array): void {
    if (d.length < 10) return;
    const id = d[0];
    const fill = (d[1] >> 3) & 1;
    const width = (d[2] << 8) | d[3];
    const height = (d[4] << 8) | d[5];
    const depthCode = (d[6] >> 2) & 7;
    const depth = depthCode === 1 ? 2 : depthCode === 3 ? 8 : 4;
    if (!width || !height || width * height > 4096 * 4096) return;
    let region = this.regions.get(id);
    const fresh = !region || region.width !== width || region.height !== height;
    if (fresh) {
      region = { width, height, depth, clut: d[7], pixels: new Uint8Array(width * height), objects: [], dirty: false };
      this.regions.set(id, region);
    }
    region!.depth = depth;
    region!.clut = d[7];
    if (fill || fresh) {
      const bg = depth === 8 ? d[8] : depth === 4 ? d[9] >> 4 : (d[9] >> 2) & 3;
      region!.pixels.fill(bg);
    }
    region!.objects = [];
    for (let i = 10; i + 6 <= d.length;) {
      const type = d[i + 2] >> 6;
      region!.objects.push({ id: (d[i] << 8) | d[i + 1], x: ((d[i + 2] & 0x0f) << 8) | d[i + 3], y: ((d[i + 4] & 0x0f) << 8) | d[i + 5] });
      i += type === 1 || type === 2 ? 8 : 6;
    }
  }

  private clutDefinition(d: Uint8Array): void {
    if (d.length < 2) return;
    const id = d[0];
    const clut = this.cluts.get(id) ?? {
      c4: DEFAULT_CLUT.c4.slice(), c16: DEFAULT_CLUT.c16.slice(), c256: DEFAULT_CLUT.c256.slice(),
    };
    this.cluts.set(id, clut);
    for (let i = 2; i + 2 <= d.length;) {
      const entry = d[i];
      const flags = d[i + 1];
      let y: number, cr: number, cb: number, t: number;
      if (flags & 1) {
        if (i + 6 > d.length) break;
        [y, cr, cb, t] = [d[i + 2], d[i + 3], d[i + 4], d[i + 5]];
        i += 6;
      } else {
        if (i + 4 > d.length) break;
        const a = d[i + 2];
        const b = d[i + 3];
        y = a & 0xfc;
        cr = (((a & 3) << 2) | ((b >> 6) & 3)) << 4;
        cb = (b << 2) & 0xf0;
        t = (b << 6) & 0xc0;
        i += 4;
      }
      if (y === 0) t = 0xff;
      const colour = ycc601(y, cr, cb, 255 - t);
      if (flags & 0x80 && entry < 4) clut.c4[entry] = colour;
      else if (flags & 0x40 && entry < 16) clut.c16[entry] = colour;
      else if (flags & 0x20) clut.c256[entry] = colour;
    }
  }

  private displayDefinition(d: Uint8Array): void {
    if (d.length < 5) return;
    this.canvasWidth = ((d[1] << 8) | d[2]) + 1;
    this.canvasHeight = ((d[3] << 8) | d[4]) + 1;
  }

  private objectData(d: Uint8Array): void {
    if (d.length < 7) return;
    const id = (d[0] << 8) | d[1];
    const coding = (d[2] >> 2) & 3;
    const nonModifying = (d[2] >> 1) & 1;
    if (coding !== 0) return;
    const topLength = (d[3] << 8) | d[4];
    const bottomLength = (d[5] << 8) | d[6];
    const top = d.subarray(7, Math.min(d.length, 7 + topLength));
    const bottom = bottomLength ? d.subarray(7 + topLength, Math.min(d.length, 7 + topLength + bottomLength)) : top;
    for (const region of this.regions.values()) {
      for (const o of region.objects) {
        if (o.id !== id) continue;
        region.dirty = true;
        pixelBlock(top, region, o.x, o.y, nonModifying);
        pixelBlock(bottom, region, o.x, o.y + 1, nonModifying);
      }
    }
  }

  /** The page's regions as one picture, in colours; null bitmap for a page with nothing up. */
  private display(): { bitmap: Bitmap | null; timeoutS: number } {
    const shown = this.page.map((p) => ({ ...p, region: this.regions.get(p.id) })).filter((p) => p.region?.dirty);
    if (!shown.length) return { bitmap: null, timeoutS: this.timeoutS };
    const x0 = Math.min(...shown.map((p) => p.x));
    const y0 = Math.min(...shown.map((p) => p.y));
    const width = Math.min(4096, Math.max(...shown.map((p) => p.x + p.region!.width)) - x0);
    const height = Math.min(4096, Math.max(...shown.map((p) => p.y + p.region!.height)) - y0);
    const pixels = new Uint8Array(width * height);
    const palette = new Uint32Array(256);
    const ids = new Map<number, number>();
    for (const p of shown) {
      const r = p.region!;
      const clut = this.cluts.get(r.clut) ?? DEFAULT_CLUT;
      const table = r.depth === 2 ? clut.c4 : r.depth === 4 ? clut.c16 : clut.c256;
      for (let y = 0; y < r.height; y++) {
        const row = (p.y - y0 + y) * width + (p.x - x0);
        for (let x = 0; x < r.width; x++) {
          const colour = table[r.pixels[y * r.width + x]] ?? 0;
          if ((colour & 0xff) === 0) continue;
          let id = ids.get(colour);
          if (id === undefined) {
            // Colour 0 stays clear; past 255 colours, what is left isn't drawn.
            if (ids.size >= 255) continue;
            id = ids.size + 1;
            ids.set(colour, id);
            palette[id] = colour;
          }
          pixels[row + x] = id;
        }
      }
    }
    return { bitmap: { x: x0, y: y0, width, height, pixels, palette }, timeoutS: this.timeoutS };
  }
}

const MAP_2_TO_4 = [0x0, 0x7, 0x8, 0xf];
const MAP_2_TO_8 = [0x00, 0x77, 0x88, 0xff];
const MAP_4_TO_8 = Array.from({ length: 16 }, (_, i) => i * 0x11);

/** One field of an object's pixels into its region, as dvbsubdec's parse_pixel_data_block. */
function pixelBlock(buf: Uint8Array, region: Region, x: number, y: number, nonModifying: number): void {
  let at = 0;
  let px = x;
  let py = y;
  let map24 = MAP_2_TO_4, map28 = MAP_2_TO_8, map48 = MAP_4_TO_8;
  const w = region.width;
  const put = (code: number, run: number, map: number[] | null) => {
    if (py >= region.height) return;
    for (let i = 0; i < run && px < w; i++, px++) {
      if (nonModifying && code === 1) continue;
      region.pixels[py * w + px] = map ? map[code] : code;
    }
  };
  while (at < buf.length) {
    const type = buf[at++];
    if (type === 0x10 || type === 0x11) {
      const two = type === 0x10;
      if (!two && region.depth < 4) return;
      const map = two ? region.depth === 8 ? map28 : region.depth === 4 ? map24 : null : region.depth === 8 ? map48 : null;
      const bits = new Bits(buf, at, buf.length);
      const n = two ? 2 : 4;
      // As dvbsubdec, a line read to the region's edge ends there, its end
      // code read or not (ffmpeg's encoder leaves it out): 6 bits, or 8.
      for (;;) {
        if (bits.done) break;
        if (px >= w) {
          bits.get(two ? 6 : 8);
          break;
        }
        const code = bits.get(n);
        if (code) { put(code, 1, map); continue; }
        if (two) {
          if (bits.get(1)) { const run = bits.get(3) + 3; put(bits.get(2), run, map); continue; }
          if (bits.get(1)) { put(0, 1, map); continue; }
          const sw = bits.get(2);
          if (sw === 2) { const run = bits.get(4) + 12; put(bits.get(2), run, map); continue; }
          if (sw === 3) { const run = bits.get(8) + 29; put(bits.get(2), run, map); continue; }
          if (sw === 1) { put(0, 2, map); continue; }
          break;
        }
        if (!bits.get(1)) {
          const run = bits.get(3);
          if (!run) break;
          put(0, run + 2, map);
          continue;
        }
        if (!bits.get(1)) { const run = bits.get(2) + 4; put(bits.get(4), run, map); continue; }
        const sw = bits.get(2);
        if (sw === 2) { const run = bits.get(4) + 9; put(bits.get(4), run, map); continue; }
        if (sw === 3) { const run = bits.get(8) + 25; put(bits.get(4), run, map); continue; }
        put(0, sw === 1 ? 2 : 1, map);
      }
      at = bits.next;
    } else if (type === 0x12) {
      if (region.depth < 8) return;
      while (at < buf.length) {
        if (px >= w) {
          at++;
          break;
        }
        const code = buf[at++];
        if (code) { put(code, 1, null); continue; }
        const b = buf[at++] ?? 0;
        const run = b & 0x7f;
        if (!(b & 0x80)) {
          if (!run) break;
          put(0, run, null);
        } else {
          put(buf[at++] ?? 0, run, null);
        }
      }
    } else if (type === 0x20) {
      map24 = [buf[at] >> 4, buf[at] & 15, buf[at + 1] >> 4, buf[at + 1] & 15];
      at += 2;
    } else if (type === 0x21) {
      map28 = [buf[at], buf[at + 1], buf[at + 2], buf[at + 3]];
      at += 4;
    } else if (type === 0x22) {
      map48 = Array.from(buf.subarray(at, at + 16));
      at += 16;
    } else if (type === 0xf0) {
      px = x;
      py += 2;
    } else {
      return;
    }
  }
}

// ── PGS ────────────────────────────────────────────────────────────

/** RGBA to limited-range YCbCr, the inverse of how the player reads a PGS
 *  palette (its lib/pgs.ts): BT.709 above 576 lines, BT.601 at or below. */
function yccOf(colour: number, hd: boolean): [number, number, number, number] {
  const r = colour >>> 24, g = (colour >>> 16) & 0xff, b = (colour >>> 8) & 0xff, a = colour & 0xff;
  const [kr, kb] = hd ? [0.2126, 0.0722] : [0.299, 0.114];
  const kg = 1 - kr - kb;
  const y = kr * r + kg * g + kb * b;
  const lim = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
  return [
    lim(16 + y * 219 / 255, 16, 235),
    lim(128 + (r - y) / (2 * (1 - kr)) * 224 / 255, 16, 240),
    lim(128 + (b - y) / (2 * (1 - kb)) * 224 / 255, 16, 240),
    a,
  ];
}

/** A picture's lines run-length coded as PGS has them. */
function pgsRle(pixels: Uint8Array, width: number, height: number): Buffer {
  const out: number[] = [];
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width;) {
      const c = pixels[row + x];
      let run = 1;
      while (x + run < width && pixels[row + x + run] === c && run < 16383) run++;
      if (c === 0) out.push(...(run < 64 ? [0, run] : [0, 0x40 | (run >> 8), run & 0xff]));
      else if (run < 3) for (let i = 0; i < run; i++) out.push(c);
      else out.push(...(run < 64 ? [0, 0x80 | run, c] : [0, 0xc0 | (run >> 8), run & 0xff, c]));
      x += run;
    }
    out.push(0, 0);
  }
  return Buffer.from(out);
}

/**
 * Writes PGS display sets, as a .sup has them. A set's composition number is
 * of its time: the same line cut twice, by pieces that overlap, is the same
 * bytes, which the join keeps once (picture-subtitles.ts joined).
 */
export class SupWriter {
  private segment(atS: number, type: number, body: Buffer): Buffer {
    const head = Buffer.alloc(13);
    const time = Math.max(0, Math.round(atS * 90_000)) >>> 0;
    head.write("PG", 0, "latin1");
    head.writeUInt32BE(time, 2);
    head.writeUInt32BE(time, 6);
    head[10] = type;
    head.writeUInt16BE(body.length, 11);
    return Buffer.concat([head, body]);
  }

  private pcs(atS: number, w: number, h: number, fresh: boolean, object: { x: number; y: number } | null): Buffer {
    const body = Buffer.alloc(11 + (object ? 8 : 0));
    body.writeUInt16BE(w, 0);
    body.writeUInt16BE(h, 2);
    body[4] = 0x10;
    body.writeUInt16BE(Math.round(Math.max(0, atS) * 90_000) & 0xffff, 5);
    body[7] = fresh ? 0x80 : 0x00;
    body[8] = 0;
    body[9] = 0;
    body[10] = object ? 1 : 0;
    if (object) {
      body.writeUInt16BE(0, 11);
      body[13] = 0;
      body[14] = 0;
      body.writeUInt16BE(object.x, 15);
      body.writeUInt16BE(object.y, 17);
    }
    return this.segment(atS, 0x16, body);
  }

  /** A set showing `bitmap` alone on a `w`×`h` canvas; the part of it off
   *  the canvas, and clear rows and columns round it, left out. Empty for a
   *  picture with nothing to see. */
  show(atS: number, w: number, h: number, bitmap: Bitmap): Buffer {
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let y = 0; y < bitmap.height; y++) {
      const cy = bitmap.y + y;
      if (cy < 0 || cy >= h) continue;
      for (let x = 0; x < bitmap.width; x++) {
        const cx = bitmap.x + x;
        const c = bitmap.pixels[y * bitmap.width + x];
        if (cx < 0 || cx >= w || c === 0 || (bitmap.palette[c] & 0xff) === 0) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return Buffer.alloc(0);
    const width = x1 - x0 + 1;
    const height = y1 - y0 + 1;
    const pixels = new Uint8Array(width * height);
    const used = new Set<number>();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const c = bitmap.pixels[(y + y0) * bitmap.width + x + x0];
        const visible = c !== 0 && (bitmap.palette[c] & 0xff) !== 0;
        pixels[y * width + x] = visible ? c : 0;
        if (visible) used.add(c);
      }
    }
    const at = { x: bitmap.x + x0, y: bitmap.y + y0 };
    const hd = h > 576;
    const parts = [this.pcs(atS, w, h, true, at)];
    const wds = Buffer.alloc(10);
    wds[0] = 1;
    wds[1] = 0;
    wds.writeUInt16BE(at.x, 2);
    wds.writeUInt16BE(at.y, 4);
    wds.writeUInt16BE(width, 6);
    wds.writeUInt16BE(height, 8);
    parts.push(this.segment(atS, 0x17, wds));
    const entries = [...used].sort((a, b) => a - b);
    const pds = Buffer.alloc(2 + 5 * (entries.length + 1));
    pds[0] = 0;
    pds[1] = 0;
    [0, ...entries].forEach((id, k) => {
      const [y, cr, cb, a] = id === 0 ? [16, 128, 128, 0] : yccOf(bitmap.palette[id], hd);
      pds.set([id, y, cr, cb, a], 2 + 5 * k);
    });
    parts.push(this.segment(atS, 0x14, pds));
    const rle = pgsRle(pixels, width, height);
    for (let at2 = 0, first = true; first || at2 < rle.length; first = false) {
      const room = first ? 0xffff - 11 : 0xffff - 4;
      const chunk = rle.subarray(at2, at2 + room);
      at2 += chunk.length;
      const last = at2 >= rle.length;
      const head = Buffer.alloc(first ? 11 : 4);
      head.writeUInt16BE(0, 0);
      head[2] = 0;
      head[3] = (first ? 0x80 : 0) | (last ? 0x40 : 0);
      if (first) {
        head.writeUIntBE(rle.length + 4, 4, 3);
        head.writeUInt16BE(width, 7);
        head.writeUInt16BE(height, 9);
      }
      parts.push(this.segment(atS, 0x15, Buffer.concat([head, chunk])));
    }
    parts.push(this.segment(atS, 0x80, Buffer.alloc(0)));
    return Buffer.concat(parts);
  }

  /** A set that clears the screen. */
  clear(atS: number, w: number, h: number): Buffer {
    return Buffer.concat([this.pcs(atS, w, h, false, null), this.segment(atS, 0x80, Buffer.alloc(0))]);
  }
}

// ── A track, packet by packet ─────────────────────────────────────

export interface BitmapSource {
  codec: BitmapCodec;
  /** A VobSub's .idx header, read; null when it has none. */
  header: VobsubHeader | null;
  /** The film's height, for a VobSub whose header doesn't give its canvas. */
  filmHeight?: number | null;
}

/**
 * A VobSub or DVB track's packets, in film order, as a .sup. An end is held
 * back until the next picture or `until` shows it comes first: VobSub's stop
 * and DVB's time-out are only most lines' ends, and a line put up before
 * one's end is reached replaces it.
 *
 * `fromS`: where the piece being cut starts. Packets before it are read for
 * what is up there then, and only that is written: the line still up, at its
 * own time (the piece before has the same set, which the join keeps once),
 * and its end. A DVB page is drawn over several sets, so it needs those too.
 */
export class BitmapToSup {
  private sup = new SupWriter();
  private dvb: DvbDecoder | null;
  private clearAt: number | null = null;
  private up = false;
  private width: number;
  private height: number;
  /** The line up from before `fromS`, not written yet. */
  private held: Buffer | null = null;

  constructor(private source: BitmapSource, private fromS = 0) {
    this.dvb = source.codec === "dvb" ? new DvbDecoder() : null;
    this.width = source.header?.width ?? 720;
    this.height = source.header?.height ?? ((source.filmHeight ?? 576) <= 480 ? 480 : 576);
  }

  /** The .sup a packet at `atS` (film seconds) makes; `durationS` its block's, when its container says. */
  push(packet: Uint8Array, atS: number, durationS: number | null = null): Buffer {
    if (this.dvb) {
      const shown = this.dvb.push(packet);
      if (!shown) return Buffer.alloc(0);
      this.width = this.dvb.canvasWidth;
      this.height = this.dvb.canvasHeight;
      return this.put(atS, shown.bitmap, shown.timeoutS > 0 ? atS + shown.timeoutS : null);
    }
    const spu = decodeSpu(packet, this.source.header?.palette ?? null);
    if (!spu) return Buffer.alloc(0);
    const from = atS + spu.startMs / 1000;
    const to = spu.stopMs !== null && spu.stopMs > spu.startMs ? atS + spu.stopMs / 1000
      : durationS && durationS > 0 ? atS + durationS : null;
    if (!spu.bitmap) {
      // Only an end: the line up comes down then.
      if (to !== null && this.up) this.clearAt = Math.min(this.clearAt ?? Infinity, to);
      return Buffer.alloc(0);
    }
    return this.put(from, spu.bitmap, to);
  }

  private put(atS: number, bitmap: Bitmap | null, endS: number | null): Buffer {
    const before = this.until(atS);
    const set = bitmap ? this.sup.show(atS, this.width, this.height, bitmap) : Buffer.alloc(0);
    if (set.length) {
      this.up = true;
      this.clearAt = endS;
      return Buffer.concat([before, this.out(atS, set, true)]);
    }
    // Nothing to see: the screen clears now, if something was up.
    if (!this.up) return before;
    this.up = false;
    this.clearAt = null;
    return Buffer.concat([before, this.out(atS, this.sup.clear(atS, this.width, this.height), false)]);
  }

  /** A set at `atS`, written if it is in the piece, with the line from before it ahead of it. */
  private out(atS: number, set: Buffer, show: boolean): Buffer {
    if (atS < this.fromS) {
      this.held = show ? set : null;
      return Buffer.alloc(0);
    }
    const held = this.held;
    this.held = null;
    return held ? Buffer.concat([held, set]) : set;
  }

  /** The end held back, written when it comes at or before `t`; and the line
   *  up from before the piece, once `t` is in it. */
  until(t: number): Buffer {
    const parts: Buffer[] = [];
    if (this.clearAt !== null && this.clearAt <= t) {
      const at = this.clearAt;
      this.clearAt = null;
      this.up = false;
      parts.push(this.out(at, this.sup.clear(at, this.width, this.height), false));
    }
    if (this.held && t >= this.fromS) {
      parts.push(this.held);
      this.held = null;
    }
    return Buffer.concat(parts);
  }

  /** What is left at the piece's end, `toS` (null: the film's): the end held
   *  back, if it comes before then; the next piece has it otherwise. */
  finish(toS: number | null): Buffer {
    const end = this.clearAt !== null && (toS === null || this.clearAt < toS) ? this.until(this.clearAt) : Buffer.alloc(0);
    const held = this.held;
    this.held = null;
    return held ? Buffer.concat([held, end]) : end;
  }
}

// ── MPEG-TS, as ffmpeg writes the track out ───────────────────────

/** The PES packets of the first elementary stream in an MPEG-TS, as it comes:
 *  their PTS, seconds, and payload. */
export class TsPes {
  private rest = new Uint8Array(0);
  private pid = -1;
  private parts: Uint8Array[] = [];
  private have = 0;
  private want = 0;

  push(chunk: Uint8Array): Array<{ atS: number | null; payload: Uint8Array }> {
    const buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    const out: Array<{ atS: number | null; payload: Uint8Array }> = [];
    let at = 0;
    while (buf.length - at >= 188) {
      if (buf[at] !== 0x47) {
        at++;
        continue;
      }
      const p = buf.subarray(at, at + 188);
      at += 188;
      const pid = ((p[1] & 0x1f) << 8) | p[2];
      const start = (p[1] & 0x40) !== 0;
      const afc = (p[3] >> 4) & 3;
      if (!(afc & 1)) continue;
      const off = 4 + (afc & 2 ? 1 + p[4] : 0);
      if (off >= 188) continue;
      const payload = p.subarray(off);
      if (start && payload[0] === 0 && payload[1] === 0 && payload[2] === 1 && this.pid < 0 && pid !== 0) this.pid = pid;
      if (pid !== this.pid) continue;
      if (start) {
        const done = this.take();
        if (done) out.push(done);
        const length = (payload[4] << 8) | payload[5];
        this.want = length ? length + 6 : 0;
      }
      if (!start && !this.parts.length) continue;
      this.parts.push(payload.slice());
      this.have += payload.length;
      if (this.want && this.have >= this.want) {
        const done = this.take();
        if (done) out.push(done);
      }
    }
    this.rest = buf.slice(at);
    return out;
  }

  /** What is left, at the end. */
  flush(): Array<{ atS: number | null; payload: Uint8Array }> {
    const done = this.take();
    return done ? [done] : [];
  }

  private take(): { atS: number | null; payload: Uint8Array } | null {
    if (!this.parts.length) return null;
    const pes = Buffer.concat(this.parts);
    const end = this.want ? Math.min(this.want, pes.length) : pes.length;
    this.parts = [];
    this.have = 0;
    this.want = 0;
    if (pes.length < 9 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) return null;
    const headerEnd = 9 + pes[8];
    let atS: number | null = null;
    if (pes[7] & 0x80 && pes.length >= 14) {
      const pts = ((pes[9] >> 1) & 7) * 2 ** 30 + ((pes[10] << 22) | ((pes[11] >> 1) << 15) | (pes[12] << 7) | (pes[13] >> 1));
      atS = pts / 90_000;
    }
    return headerEnd <= end ? { atS, payload: pes.subarray(headerEnd, end) } : null;
  }
}
