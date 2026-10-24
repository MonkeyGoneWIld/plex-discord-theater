/**
 * PGS subtitles read and drawn here (lib/pgs.ts): display sets out of a .sup
 * as it comes in pieces, their pictures from the run lengths, their colours
 * as ffmpeg's decoder makes them, and which set is up when.
 */
import { PgsReader, decodeRle, displayAt, mergeDisplays, paletteRgba } from "../src/lib/pgs";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];

/** A .sup, segment by segment, as the server's test writes one. */
class Sup {
  parts: number[] = [];
  seg(pts: number, type: number, body: number[]) {
    const t = Math.round(pts * 90_000);
    this.parts.push(0x50, 0x47, (t >>> 24) & 0xff, (t >> 16) & 0xff, (t >> 8) & 0xff, t & 0xff, 0, 0, 0, 0, type, ...u16(body.length), ...body);
    return this;
  }
  /** A composition: objects [id, x, y, crop?] on a W×H canvas. */
  pcs(pts: number, W: number, H: number, n: number, state: number, palette: number,
    objects: Array<[number, number, number, [number, number, number, number]?]>) {
    const body = [...u16(W), ...u16(H), 0x10, ...u16(n), state, 0, palette, objects.length];
    for (const [id, x, y, crop] of objects) {
      body.push(...u16(id), 0, crop ? 0x80 : 0, ...u16(x), ...u16(y));
      if (crop) body.push(...crop.flatMap(u16));
    }
    return this.seg(pts, 0x16, body);
  }
  pds(pts: number, id: number, entries: number[][]) {
    return this.seg(pts, 0x14, [id, 0, ...entries.flat()]);
  }
  /** An object in fragments of `split` bytes of run lengths, when given. */
  ods(pts: number, id: number, w: number, h: number, rle: number[], split?: number) {
    const len = rle.length + 4;
    const chunks: number[][] = [];
    for (let i = 0; i < rle.length; i += split ?? rle.length) chunks.push(rle.slice(i, i + (split ?? rle.length)));
    chunks.forEach((c, i) => {
      const flag = (i === 0 ? 0x80 : 0) | (i === chunks.length - 1 ? 0x40 : 0);
      this.seg(pts, 0x15, i === 0
        ? [...u16(id), 0, flag, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff, ...u16(w), ...u16(h), ...c]
        : [...u16(id), 0, flag, ...c]);
    });
    return this;
  }
  end(pts: number) {
    return this.seg(pts, 0x80, []);
  }
  bytes() {
    return new Uint8Array(this.parts);
  }
}

/** Run lengths for a w×h block of one colour. */
const block = (w: number, h: number, colour: number) => {
  const out: number[] = [];
  for (let i = 0; i < h; i++) out.push(0, 0xc0 | ((w >> 8) & 0x3f), w & 0xff, colour, 0, 0);
  return out;
};
const WHITE = [1, 235, 128, 128, 255];

console.log("\n— display sets out of a .sup —");
{
  const sup = new Sup()
    .pcs(0.5, 1920, 1080, 0, 0x80, 0, [[0, 760, 900]]).pds(0.5, 0, [WHITE]).ods(0.5, 0, 400, 60, block(400, 60, 1)).end(0.5)
    .pcs(5, 1920, 1080, 1, 0, 0, []).end(5)
    .pcs(32, 1920, 1080, 2, 0x80, 0, [[0, 760, 900]]).pds(32, 0, [WHITE]).ods(32, 0, 400, 60, block(400, 60, 1), 1000).end(32)
    .pcs(40, 1920, 1080, 3, 0, 0, []).end(40)
    .bytes();
  // Fed in uneven chunks, as fetches come.
  const reader = new PgsReader();
  const sets = [];
  for (let i = 0; i < sup.length; i += 777) sets.push(...reader.push(sup.subarray(i, i + 777)));
  check("each set, at its time, whatever the chunks", sets.map((d) => [d.pts, d.objects.length]), [[0.5, 1], [5, 0], [32, 1], [40, 0]]);
  check("every byte counted, for where to go on from", reader.read, sup.length);
  check("on the film's canvas, where it was put", [sets[0].width, sets[0].height, sets[0].objects[0].x, sets[0].objects[0].y], [1920, 1080, 760, 900]);
  const px = decodeRle(sets[0].objects[0]);
  check("its picture is the whole box, white", [px.length, px[0], px[1], px[2], px[3], px[px.length - 1]], [400 * 60 * 4, 255, 255, 255, 255, 255]);
  const split = decodeRle(sets[2].objects[0]);
  check("an object sent in fragments is the same picture", [...split].every((v, i) => v === px[i]), true);
  check("up from when it is shown", displayAt(sets, 0.5)?.pts, 0.5);
  check("and until it is cleared", displayAt(sets, 4.99)?.pts, 0.5);
  check("nothing once it is", displayAt(sets, 5), null);
  check("nor before the first", displayAt(sets, 0.2), null);
  check("the second in its turn", displayAt(sets, 39)?.pts, 32);
}

console.log("\n— pieces —");
{
  const first = new Sup()
    .pcs(10, 1920, 1080, 0, 0x80, 0, [[0, 0, 0]]).pds(10, 0, [WHITE]).ods(10, 0, 4, 2, block(4, 2, 1)).end(10)
    .pcs(12, 1920, 1080, 1, 0, 0, []).end(12).bytes();
  // A piece that begins after the epoch did: its first set names an object it never had.
  const later = new Sup()
    .pcs(11, 1920, 1080, 5, 0, 0, [[0, 0, 0]]).end(11)
    .pcs(12, 1920, 1080, 1, 0, 0, []).end(12)
    .pcs(20, 1920, 1080, 2, 0x80, 0, [[0, 0, 0]]).pds(20, 0, [WHITE]).ods(20, 0, 4, 2, block(4, 2, 1)).end(20).bytes();
  const a = new PgsReader().push(first);
  const b = new PgsReader().push(later);
  check("a set naming what the piece hasn't is let go", b.map((d) => d.pts), [12, 20]);
  const merged = mergeDisplays(mergeDisplays([], b), a);
  check("pieces merged in film order, one of each", merged.map((d) => d.pts), [10, 12, 20]);
  check("an epoch starts afresh", new PgsReader().push(new Sup()
    .pcs(1, 720, 480, 0, 0x80, 0, [[0, 0, 0]]).pds(1, 0, [WHITE]).ods(1, 0, 2, 1, block(2, 1, 1)).end(1)
    .pcs(2, 720, 480, 1, 0x80, 0, [[0, 0, 0]]).end(2).bytes()).map((d) => d.pts), [1]);
}

console.log("\n— pictures —");
{
  // A line of 3 colour-1 pixels as single bytes, a run of 2 transparent, a long
  // run of colour 2; then a line ended early.
  const rle = [1, 1, 1, 0, 0x02, 0, 0x80 | 3, 2, 0, 0, 0, 0x40, 2, 0, 0];
  const palette = paletteRgba([[1, 235, 128, 128, 255], [2, 16, 128, 128, 128]], true);
  const px = decodeRle({ x: 0, y: 0, width: 8, height: 2, rle: new Uint8Array(rle), palette, crop: null });
  const alpha = Array.from({ length: 16 }, (_, i) => px[i * 4 + 3]);
  check("pixels, runs, and lines, as the stream has them", alpha, [255, 255, 255, 0, 0, 128, 128, 128, 0, 0, 0, 0, 0, 0, 0, 0]);
  check("a long run of colour 0 is transparent", px[8 * 4 + 3], 0);
  // Red, as ffmpeg makes it in each: BT.709 above 576 lines, BT.601 at or below.
  const red709 = paletteRgba([[0, 63, 240, 102, 255]], true);
  const red601 = paletteRgba([[0, 81, 240, 90, 255]], false);
  const near = (px: Uint8ClampedArray, rgb: number[]) => rgb.every((v, i) => Math.abs(px[i] - v) <= 1);
  check("BT.709 limited range, for HD", near(red709, [255, 0, 0]), true);
  check("BT.601 limited range, for SD", near(red601, [255, 0, 0]), true);
  const ends = paletteRgba([[0, 235, 128, 128, 255], [1, 16, 128, 128, 255]], true);
  check("white is white and black black", [...ends.subarray(0, 3), ...ends.subarray(4, 7)], [255, 255, 255, 0, 0, 0]);
  const cropped = new PgsReader().push(new Sup()
    .pcs(1, 1920, 1080, 0, 0x80, 0, [[0, 100, 200, [10, 0, 20, 5]]]).pds(1, 0, [WHITE]).ods(1, 0, 40, 5, block(40, 5, 1)).end(1).bytes());
  check("a cropped object says which part is shown", cropped[0]?.objects[0].crop, { x: 10, y: 0, width: 20, height: 5 });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
