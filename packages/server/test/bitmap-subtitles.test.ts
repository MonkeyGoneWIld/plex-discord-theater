/**
 * VobSub and DVB subtitles made PGS for the player to draw
 * (services/ffmpeg/bitmap-subtitles.ts): a picture written as PGS reads back
 * the same in the player's reader (client lib/pgs.ts); and, where ffmpeg is
 * here, a film whose subtitle ffmpeg made VobSub or DVB out of that PGS comes
 * back through the /pgs route's cut (bitmapArgs, an MPEG-TS read here) as the
 * same pictures at the same times — whole, or a piece of it.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BitmapToSup, SupWriter, TsPes, bitmapCodecOf, vobsubHeader, type Bitmap, type BitmapSource,
} from "../src/services/ffmpeg/bitmap-subtitles";
import { PgsReader, decodeRle, type PgsDisplay } from "../../client/src/lib/pgs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bitmap-subs-"));
process.env.THUMB_CACHE_DIR = tmp;
process.env.LOG_TO_FILE = "0";
const { bitmapArgs, forgetPgs, pgsIndexOf, pgsStatus } = await import("../src/services/ffmpeg/picture-subtitles");
const { hexDumpBytes, probeExtradata } = await import("../src/services/ffmpeg/probe");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

const W = 720;
const H = 480;
const WHITE = 0xffffffff;
const BLACK = 0x000000ff;
// One of the colours ffmpeg's dvdsub encoder has (it has no other palette).
const GREY = 0xaaaaaaff;

/** A line of "text": white bars outlined in black over a grey band, `n` bars. */
function line(x: number, y: number, n: number): Bitmap {
  const width = 40 + n * 30;
  const height = 36;
  const pixels = new Uint8Array(width * height);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const bar = i >= 20 && (i - 20) % 30 < 20 && i < width - 20;
      const inner = bar && j >= 8 && j < height - 8;
      const edge = bar && j >= 6 && j < height - 6;
      pixels[j * width + i] = inner ? 1 : edge ? 2 : j >= 14 && j < 22 ? 3 : 0;
    }
  }
  const palette = new Uint32Array(256);
  palette[1] = WHITE;
  palette[2] = BLACK;
  palette[3] = GREY;
  return { x, y, width, height, pixels, palette };
}

/** RGBA of a picture as it is meant to look, over the canvas. */
function canvasOf(pictures: Array<{ x: number; y: number; width: number; height: number; rgba: (i: number) => number[] }>): Uint8Array {
  const out = new Uint8Array(W * H * 4);
  for (const p of pictures) {
    for (let j = 0; j < p.height; j++) {
      for (let i = 0; i < p.width; i++) {
        const [r, g, b, a] = p.rgba(j * p.width + i);
        if (!a) continue;
        out.set([r, g, b, a], ((p.y + j) * W + p.x + i) * 4);
      }
    }
  }
  return out;
}
const wanted = (b: Bitmap) => canvasOf([{
  ...b, rgba: (i) => { const c = b.palette[b.pixels[i]]; return [c >>> 24, (c >>> 16) & 255, (c >>> 8) & 255, c & 255]; },
}]);
const drawn = (d: PgsDisplay) => canvasOf(d.objects.map((o) => {
  const rgba = decodeRle(o);
  return { ...o, rgba: (i: number) => [...rgba.subarray(i * 4, i * 4 + 4)] };
}));
/** Pixels that differ by more than `by` in any channel (opacity: shown or not). */
function differ(a: Uint8Array, b: Uint8Array, by = 6): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if ((a[i + 3] > 127) !== (b[i + 3] > 127)) n++;
    else if (a[i + 3] > 127 && [0, 1, 2].some((k) => Math.abs(a[i + k] - b[i + k]) > by)) n++;
  }
  return n;
}
const displays = (sup: Buffer) => new PgsReader().push(sup);
const when = (list: PgsDisplay[]) => list.map((d) => [Math.round(d.pts * 1000) / 1000, d.objects.length]);

const A = line(240, 400, 4);
const B = line(200, 360, 6);

console.log("PGS as written here, read by the player");
{
  const sup = new SupWriter();
  const bytes = Buffer.concat([sup.show(1, W, H, A), sup.clear(3, W, H), sup.show(4, W, H, B), sup.clear(6, W, H)]);
  const list = displays(bytes);
  check("four sets: two lines and their ends", when(list), [[1, 1], [3, 0], [4, 1], [6, 0]]);
  check("the first line's pixels, colours and place", differ(drawn(list[0]), wanted(A)), 0);
  check("the second line's", differ(drawn(list[2]), wanted(B)), 0);
  check("cropped to what shows: the clear rows above and below left out",
    [list[0].objects[0].y, list[0].objects[0].height], [A.y + 6, A.height - 12]);
  check("the same line twice is the same bytes (a piece's overlap is kept once)",
    new SupWriter().show(1, W, H, A).equals(sup.show(1, W, H, A)), true);
  check("nothing to see: no set", sup.show(1, W, H, { ...A, pixels: new Uint8Array(A.pixels.length) }).length, 0);
}

console.log("Names and headers");
check("Plex's and ffmpeg's names", ["vobsub", "dvd_subtitle", "dvb_subtitle", "dvbsub", "pgs", "srt"].map(bitmapCodecOf),
  ["vobsub", "vobsub", "dvb", "dvb", null, null]);
check("an .idx header's canvas and colours",
  vobsubHeader("# VobSub index file, v7\nsize: 720x576\npalette: 000000, ffffff, 808080, 0000ff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0\n"),
  { width: 720, height: 576, palette: [0, 0xffffff, 0x808080, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
check("one without them", vobsubHeader(""), { width: null, height: null, palette: null });
check("ffprobe's hex dump read back", hexDumpBytes("00000000: 7369 7a65 3a20 3732 3078 3438 300a 7061  size: 720x480.pa\n00000010: 6c        l\n").toString(),
  "size: 720x480\npal");

const ffmpeg = spawnSync("ffmpeg", ["-hide_banner", "-version"]).status === 0;
if (!ffmpeg) console.log("  (ffmpeg isn't here: the round trips through it are skipped)");
else {
  const dir = tmp;
  try {
    const sup = new SupWriter();
    const supFile = path.join(dir, "in.sup");
    fs.writeFileSync(supFile, Buffer.concat([sup.show(1, W, H, A), sup.clear(3, W, H), sup.show(4, W, H, B), sup.clear(6, W, H)]));
    for (const [codec, encoder] of [["vobsub", "dvdsub"], ["dvb", "dvbsub"]] as const) {
      console.log(`${codec === "vobsub" ? "VobSub" : "DVB"}, as ffmpeg makes it out of that PGS`);
      const film = path.join(dir, `${codec}.mkv`);
      const made = spawnSync("ffmpeg", [
        "-hide_banner", "-v", "error", "-copyts", "-f", "lavfi", "-i", `color=black:s=${W}x${H}:r=25:d=8`,
        "-fix_sub_duration", "-i", supFile,
        "-map", "0:v", "-map", "1:s", "-c:v", "libx264", "-preset", "ultrafast", "-c:s", encoder, "-y", film,
      ], { encoding: "utf8" });
      check(`ffmpeg makes a film with ${encoder}`, made.status === 0 ? "made" : made.stderr.trim().split("\n").pop(), "made");
      if (made.status !== 0) continue;
      const input = ["-i", film];
      const header = codec === "vobsub" ? vobsubHeader(await probeExtradata(film, input, 1)) : null;
      if (codec === "vobsub") check("its header's canvas and colours, through ffprobe", [header?.width, header?.height, !!header?.palette], [W, H, true]);
      const cut = (fromS: number) => {
        const out = spawnSync("ffmpeg", bitmapArgs(input, 1, Math.max(0, fromS - 30), null), { maxBuffer: 64 << 20 });
        const pes = new TsPes();
        return [...pes.push(out.stdout), ...pes.flush()];
      };
      const source: BitmapSource = { codec, header, filmHeight: H };
      const packets = cut(0);
      check("the track's packets come out of the cut, timed", packets.length > 0 && packets.every((p) => p.atS !== null), true);
      const whole = new BitmapToSup(source);
      const bytes = Buffer.concat([...packets.map((p) => whole.push(p.payload, p.atS!)), whole.finish(null)]);
      const list = displays(bytes);
      // DVB's ends come at the page's time-out, in whole seconds, if no set clears it first.
      const ends = list.filter((d) => !d.objects.length).map((d) => Math.round(d.pts * 1000) / 1000);
      check("two lines at their times", list.filter((d) => d.objects.length).map((d) => d.pts), [1, 4]);
      check("each comes down at its end, before the next", ends.length === 2 && ends[0] >= 2.9 && ends[0] <= 4 && ends[1] >= 5.9, true);
      const shown = list.filter((d) => d.objects.length);
      check("the first line, as it was", differ(drawn(shown[0]), wanted(A)), 0);
      check("the second", differ(drawn(shown[1]), wanted(B)), 0);
      // A piece from 2 s to 5 s: the line up as it starts, at its own time, and its end; the next line; not its end.
      const piece = new BitmapToSup(source, 2);
      const inPiece = Buffer.concat([...packets.filter((p) => p.atS! < 5).map((p) => piece.push(p.payload, p.atS!)), piece.finish(5)]);
      check("a piece from 2 s to 5 s: the line up at 2 s, its end, the next line", when(displays(inPiece)),
        [[1, 1], [ends[0], 0], [4, 1]]);
      const late = new BitmapToSup(source, 3.5);
      const fromLate = Buffer.concat([...packets.map((p) => late.push(p.payload, p.atS!)), late.finish(null)]);
      check("one from 3.5 s, after the first line's end: the second line alone", when(displays(fromLate)), [[4, 1], [ends[1], 0]]);
      check("a cut from 3.5 s reads from before it, for what is up", cut(3.5).length, packets.length);
    }
    for (const [codec, encoder, plexCodec] of [["vobsub", "dvdsub", "vobsub"], ["dvb", "dvbsub", "dvb_subtitle"]] as const) {
      // Ten minutes, cut by the /pgs route's jobs: by ffmpeg, read at 60 times
      // the film's speed with a skip to 500 s part way; and through the index.
      console.log(`A ten-minute film's ${codec === "vobsub" ? "VobSub" : "DVB"}, cut as the player asks for it`);
      const long = path.join(dir, `long-${codec}.mkv`);
      const sup = new SupWriter();
      const lines = [[0.5, 5, A], [300, 305, B], [590, 595, A]] as const;
      fs.writeFileSync(path.join(dir, "long.sup"), Buffer.concat(lines.flatMap(([from, to, b]) => [sup.show(from, W, H, b), sup.clear(to, W, H)])));
      const made = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-copyts", "-f", "lavfi", "-i", "testsrc=size=64x36:rate=5:duration=600",
        "-fix_sub_duration", "-i", path.join(dir, "long.sup"), "-map", "0", "-map", "1", "-c:v", "libx264", "-preset", "ultrafast", "-g", "50",
        "-c:s", encoder, long]);
      if (made.status !== 0) throw new Error(`couldn't make ${long}: ${made.stderr}`);
      const header = codec === "vobsub" ? vobsubHeader(await probeExtradata(`${long}#long`, ["-i", long], 1)) : null;
      const bitmap: BitmapSource = { codec, header, filmHeight: 36 };
      const outcome = async (key: string, source: () => Promise<any>, skip: boolean) => {
        forgetPgs();
        type Seen = { reachedS?: number | null };
        let s = pgsStatus(key, source, 0);
        for (let i = 0; skip && i < 40 && !((s.pieces[0] as Seen | undefined)?.reachedS); i++) {
          await sleep(100);
          s = pgsStatus(key, source, 0);
        }
        for (let i = 0; i < 300 && !s.done && !s.failed; i++) {
          s = pgsStatus(key, source, skip ? 500 : 0);
          if (!s.done) await sleep(100);
        }
        const list = s.done ? displays(fs.readFileSync(path.join(dir, "subtitles-pgs", `${key}.sup`))) : [];
        return { s, list };
      };
      const shows = (list: PgsDisplay[]) => list.filter((d) => d.objects.length).map((d) => d.pts);
      // Each line comes down after it goes up and before the next goes up.
      const inTurn = (list: PgsDisplay[]) => list.length === 6 && list.every((d, i) => (d.objects.length > 0) === (i % 2 === 0)) &&
        list.every((d, i) => i === 0 || d.pts > list[i - 1].pts);
      const viaFfmpeg = await outcome(`long-${codec}`, async () => ({ kind: "film", input: ["-readrate", "60", "-i", long], index: 1, bitmap }), true);
      check("  by ffmpeg, with a skip: all there", [viaFfmpeg.s.done, viaFfmpeg.s.failed], [true, null]);
      check("  every line once, at its time", shows(viaFfmpeg.list), [0.5, 300, 590]);
      check("  each down before the next goes up", inTurn(viaFfmpeg.list), true);
      check("  the last line, as it was", viaFfmpeg.list[4] ? differ(drawn(viaFfmpeg.list[4]), wanted(A)) : -1, 0);
      const streams = [{ id: 31, codec: plexCodec, index: 1 }];
      const indexed = await pgsIndexOf(long, `${long}#index`, null, streams, 31, 0);
      check("  its packets are where the film's index says", indexed?.at.slice(0, 1), [0.5]);
      const viaIndex = await outcome(`index-${codec}`, async () => ({ kind: "film", input: ["-i", long], index: 1, indexed, bitmap }), false);
      check("  through the index: all there", [viaIndex.s.done, viaIndex.s.failed], [true, null]);
      check("  the same as ffmpeg's", when(viaIndex.list), when(viaFfmpeg.list));
    }
    forgetPgs();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
