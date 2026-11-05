/**
 * A copy's big segments, listed as pieces of about PIECE_BYTES.
 *
 * A copy is cut only where the film has a keyframe (plan.ts copyArgs), and
 * some films go half a minute without one. On 4 November ratingKey 20578 opened
 * on a keyframe and had no other for 28.9 s: its first segment was 97.6 MB,
 * which a player has to have whole before it shows anything, so the picture
 * took 33 and 36 s to come up, and the buffer grew 30 s at a time instead of 4.
 *
 * So a segment of SPLIT_OVER_BYTES or more is cut again here into pieces of
 * about PIECE_BYTES, at frame boundaries, its frames as ffmpeg wrote them.
 * Only the first piece opens on a keyframe. Played on from the piece before,
 * a piece is decoded like the rest of its segment would have been; a player
 * that jumps into one loads its group from the keyframe piece (the client's
 * lib/keyframeGroups).
 *
 * By size, not length. Cut into pieces of about 4 s, as it was on 4 November,
 * 3 from Hell's 3.4 MB first segment came as a 10 KB piece and two of 1.4 and
 * 1.9 MB: a player fetches a segment in parts of 150 KB, sixteen at most at
 * once (the client's segmentParts), so those came in 10 and 13 parts at 4.6
 * and 6.7 Mbps where the whole one had come in 16 at 14, and its start took
 * 6.2 s instead of 3.7. Starts from the beginning ran a second slower that
 * evening (median 4.7 s, from 3.7 and 3.9 the two days before). A piece of
 * 4 MB is sixteen parts of 250 KB; a segment under 6 MB comes in about as
 * fast whole, however long it is.
 *
 * MPEG-TS is cut at the packet where a picture starts, ffmpeg writing each
 * PES whole, and every piece but the first gets the segment's PAT and PMT
 * first. fMP4 has its one moof and mdat written again as one per piece, each
 * sample's duration, size, flags and composition offset said outright.
 * Anything laid out otherwise is left whole.
 */
import type { Mp4Track } from "../mp4-timestamps.js";

/** About how big a piece is, bytes: sixteen of a player's 150 KB parts and more. */
export const PIECE_BYTES = 4_000_000;
/** A segment smaller than this, bytes, is listed whole: it comes in about as fast. */
export const SPLIT_OVER_BYTES = 6_000_000;
/** No piece shorter than this, seconds. */
export const MIN_PIECE_S = 1;

export interface SplitOptions {
  /** About how big each piece is, bytes: PIECE_BYTES. */
  pieceBytes?: number;
  /** Smaller than this, bytes, a segment is left whole: SPLIT_OVER_BYTES. */
  splitOverBytes?: number;
  /** No cut before this, seconds on the segment's clock: a run's first
   *  segment, whose keyframe is before where the player starts, so that the
   *  piece the player starts in has it. */
  notBeforeS?: number;
}

/**
 * The pieces of a segment too big to list whole, in order; null to list it as
 * it is — small enough, or not laid out as ffmpeg lays it out. `tracks` is
 * the run's init segment's (fMP4); null for MPEG-TS.
 */
export function splitSegment(data: Uint8Array, tracks: readonly Mp4Track[] | null, o: SplitOptions = {}): Buffer[] | null {
  return tracks ? splitMp4(data, tracks, o) : splitTs(data, o);
}

/**
 * Where to cut, as indexes into `dts` (the pictures' decode times in order,
 * seconds) of a segment of `total` bytes that ends at `endS`, `at` being where
 * in its bytes each picture is: at the first picture a piece's share of the
 * bytes past where the piece began, and a second or more past it; none before
 * `notBeforeS`, the piece there running on from the keyframe; and none leaving
 * less than half a piece, or a second, at the end. Empty for none.
 */
function cutsAt(dts: readonly number[], at: readonly number[], total: number, endS: number, o: SplitOptions): number[] {
  if (dts.length < 2 || total < (o.splitOverBytes ?? SPLIT_OVER_BYTES)) return [];
  const pieces = Math.round(total / (o.pieceBytes ?? PIECE_BYTES));
  if (pieces < 2) return [];
  const share = total / pieces;
  const notBefore = o.notBeforeS ?? -Infinity;
  const cuts: number[] = [];
  let from = 0;
  for (let i = 1; i < dts.length; i++) {
    if (dts[i] < notBefore || at[i] - at[from] < share || dts[i] - dts[from] < MIN_PIECE_S) continue;
    if (total - at[i] < share / 2 || endS - dts[i] < MIN_PIECE_S) break;
    cuts.push(i);
    from = i;
  }
  return cuts;
}

// ─── MPEG-TS ────────────────────────────────────────────────────

const PACKET = 188;
const PTS_HZ = 90_000;

const tsTime = (b: Uint8Array, at: number) =>
  ((b[at] >> 1) & 0x07) * 2 ** 30 + (((b[at + 1] << 8) | b[at + 2]) >> 1) * 2 ** 15 + (((b[at + 3] << 8) | b[at + 4]) >> 1);

/** Where a packet's PES header is, when a PES starts in it; -1 otherwise. */
function pesStart(b: Uint8Array, p: number): number {
  if ((b[p + 1] & 0x40) === 0) return -1;
  const adaptation = (b[p + 3] >> 4) & 0x03;
  if (adaptation === 0 || adaptation === 2) return -1;
  const payload = adaptation === 3 ? p + 5 + b[p + 4] : p + 4;
  if (payload + 19 > p + PACKET) return -1;
  return b[payload] === 0 && b[payload + 1] === 0 && b[payload + 2] === 1 ? payload : -1;
}

function splitTs(b: Uint8Array, o: SplitOptions): Buffer[] | null {
  if (b.length < PACKET * 2 || b.length % PACKET !== 0) return null;
  for (let p = 0; p < b.length; p += PACKET) if (b[p] !== 0x47) return null;
  // The tables before the first PES: what every piece but the first opens with.
  let head = -1;
  const starts: number[] = [];
  const dts: number[] = [];
  for (let p = 0; p < b.length; p += PACKET) {
    const pes = pesStart(b, p);
    if (pes < 0) continue;
    if (head < 0) head = p;
    const id = b[pes + 3];
    if (id < 0xe0 || id > 0xef) continue;
    const times = b[pes + 7] >> 6;
    if (times < 2) continue;
    starts.push(p);
    dts.push(tsTime(b, times === 3 ? pes + 14 : pes + 9) / PTS_HZ);
  }
  if (head <= 0 || head > PACKET * 8 || starts.length < 2) return null;
  // One frame on from the last, to its end.
  const frame = (dts[dts.length - 1] - dts[0]) / (dts.length - 1);
  const cuts = cutsAt(dts, starts, b.length, dts[dts.length - 1] + frame, o);
  if (!cuts.length) return null;
  const tables = Buffer.from(b.subarray(0, head));
  const bounds = [0, ...cuts.map((c) => starts[c]), b.length];
  return bounds.slice(1).map((end, j) => {
    const body = Buffer.from(b.subarray(bounds[j], end));
    return j === 0 ? body : Buffer.concat([tables, body]);
  });
}

// ─── Fragmented MP4 ─────────────────────────────────────────────

const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
const i32 = (b: Uint8Array, at: number) => (b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3];
const u64 = (b: Uint8Array, at: number) => u32(b, at) * 2 ** 32 + u32(b, at + 4);

interface Box { type: string; at: number; start: number; end: number }

/** The boxes directly inside b[from, to); null if they don't fill it exactly. */
function boxesOf(b: Uint8Array, from: number, to: number): Box[] | null {
  const out: Box[] = [];
  let at = from;
  while (at < to) {
    if (at + 8 > to) return null;
    let size = u32(b, at);
    let head = 8;
    if (size === 1) {
      if (at + 16 > to) return null;
      size = u64(b, at + 8);
      head = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < head || at + size > to) return null;
    out.push({ type: String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7]), at, start: at + head, end: at + size });
    at += size;
  }
  return out;
}

interface Sample { dts: number; duration: number; size: number; flags: number; cto: number; offset: number }

interface Traf {
  track: Mp4Track;
  /** Its tfhd's body, as written. */
  tfhd: Uint8Array;
  version: number;
  cto: boolean;
  samples: Sample[];
}

/** A box: its type and what's in it. */
function box(type: string, ...parts: Uint8Array[]): Buffer {
  const size = 8 + parts.reduce((n, p) => n + p.length, 0);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(size, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, ...parts]);
}

/** A segment's one moof as the samples in it, track by track; null when it isn't one ffmpeg would write. */
function readMoof(b: Uint8Array, moof: Box, mdat: Box, tracks: readonly Mp4Track[]): { mfhd: Uint8Array; trafs: Traf[] } | null {
  const inMoof = boxesOf(b, moof.start, moof.end);
  if (!inMoof) return null;
  const mfhd = inMoof.find((x) => x.type === "mfhd");
  if (!mfhd || inMoof.some((x) => x.type !== "mfhd" && x.type !== "traf")) return null;
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const trafs: Traf[] = [];
  // Where data starts when a run doesn't say: the end of the track's before
  // it, unless its tfhd counts from the moof.
  let dataEnd = moof.at;
  for (const traf of inMoof.filter((x) => x.type === "traf")) {
    const inTraf = boxesOf(b, traf.start, traf.end);
    if (!inTraf || inTraf.some((x) => x.type !== "tfhd" && x.type !== "tfdt" && x.type !== "trun")) return null;
    const tfhd = inTraf.find((x) => x.type === "tfhd");
    const tfdt = inTraf.find((x) => x.type === "tfdt");
    const truns = inTraf.filter((x) => x.type === "trun");
    if (!tfhd || !tfdt || !truns.length) return null;
    const track = byId.get(u32(b, tfhd.start + 4));
    const flags = u32(b, tfhd.start) & 0xffffff;
    // A base data offset counts from somewhere outside the segment; an empty
    // duration is no samples.
    if (!track || flags & 0x1 || flags & 0x10000) return null;
    let at = tfhd.start + 8;
    if (flags & 0x2) at += 4;
    let defaultDuration = track.defaultDuration;
    let defaultSize = track.defaultSize;
    let defaultFlags = track.defaultFlags;
    if (flags & 0x8) { defaultDuration = u32(b, at); at += 4; }
    if (flags & 0x10) { defaultSize = u32(b, at); at += 4; }
    if (flags & 0x20) { defaultFlags = u32(b, at); at += 4; }
    const base = flags & 0x20000 ? moof.at : dataEnd;
    // Where a run that doesn't say starts: where the one before it ended.
    let dataAt = base;
    let dts = b[tfdt.start] === 1 ? u64(b, tfdt.start + 4) : u32(b, tfdt.start + 4);
    const samples: Sample[] = [];
    let version = 0;
    let cto = false;
    for (const trun of truns) {
      version = Math.max(version, b[trun.start]);
      const tf = u32(b, trun.start) & 0xffffff;
      cto ||= !!(tf & 0x800);
      const count = u32(b, trun.start + 4);
      let p = trun.start + 8;
      let offset = dataAt;
      if (tf & 0x1) { offset = base + i32(b, p); p += 4; }
      let firstFlags: number | null = null;
      if (tf & 0x4) { firstFlags = u32(b, p); p += 4; }
      const each = 4 * (+!!(tf & 0x100) + +!!(tf & 0x200) + +!!(tf & 0x400) + +!!(tf & 0x800));
      if (p + count * each > trun.end) return null;
      for (let i = 0; i < count; i++) {
        const s: Sample = { dts, duration: defaultDuration, size: defaultSize, flags: defaultFlags, cto: 0, offset };
        if (tf & 0x100) { s.duration = u32(b, p); p += 4; }
        if (tf & 0x200) { s.size = u32(b, p); p += 4; }
        if (tf & 0x400) { s.flags = u32(b, p); p += 4; } else if (i === 0 && firstFlags !== null) s.flags = firstFlags;
        if (tf & 0x800) { s.cto = b[trun.start] === 1 ? i32(b, p) : u32(b, p); p += 4; }
        if (s.offset < mdat.start || s.offset + s.size > mdat.end) return null;
        samples.push(s);
        dts += s.duration;
        offset += s.size;
      }
      dataAt = offset;
    }
    dataEnd = dataAt;
    trafs.push({ track, tfhd: b.subarray(tfhd.start, tfhd.end), version, cto, samples });
  }
  return trafs.length ? { mfhd: b.subarray(mfhd.start, mfhd.end), trafs } : null;
}

/** One piece's moof and mdat: these samples of each track, those with none left out. */
function writePiece(b: Uint8Array, styp: Uint8Array | null, mfhd: Uint8Array, parts: Array<{ traf: Traf; samples: Sample[] }>): Buffer {
  const present = parts.filter((p) => p.samples.length);
  const build = (offsets: number[]) => box("moof", box("mfhd", mfhd), ...present.map(({ traf, samples }, k) => {
    const tfhd = Buffer.from(traf.tfhd);
    // Data offsets count from the moof.
    tfhd.writeUInt32BE((tfhd.readUInt32BE(0) | 0x20000) >>> 0, 0);
    const tfdt = Buffer.alloc(12);
    tfdt.writeUInt32BE(0x01000000, 0);
    tfdt.writeUInt32BE(Math.floor(samples[0].dts / 2 ** 32), 4);
    tfdt.writeUInt32BE(samples[0].dts % 2 ** 32, 8);
    const each = traf.cto ? 16 : 12;
    const trun = Buffer.alloc(12 + samples.length * each);
    trun.writeUInt32BE(((traf.version << 24) | 0x701 | (traf.cto ? 0x800 : 0)) >>> 0, 0);
    trun.writeUInt32BE(samples.length, 4);
    trun.writeInt32BE(offsets[k], 8);
    samples.forEach((s, i) => {
      const at = 12 + i * each;
      trun.writeUInt32BE(s.duration, at);
      trun.writeUInt32BE(s.size, at + 4);
      trun.writeUInt32BE(s.flags >>> 0, at + 8);
      if (traf.cto) {
        if (traf.version === 1) trun.writeInt32BE(s.cto, at + 12);
        else trun.writeUInt32BE(s.cto >>> 0, at + 12);
      }
    });
    return box("traf", box("tfhd", tfhd), box("tfdt", tfdt), box("trun", trun));
  }));
  const sizes = present.map(({ samples }) => samples.reduce((n, s) => n + s.size, 0));
  const moofSize = build(present.map(() => 0)).length;
  const offsets = sizes.map((_, k) => moofSize + 8 + sizes.slice(0, k).reduce((n, x) => n + x, 0));
  const data = present.flatMap(({ samples }) => samples.map((s) => b.subarray(s.offset, s.offset + s.size)));
  return Buffer.concat([...(styp ? [styp] : []), build(offsets), box("mdat", ...data)]);
}

function splitMp4(b: Uint8Array, tracks: readonly Mp4Track[], o: SplitOptions): Buffer[] | null {
  const top = boxesOf(b, 0, b.length);
  if (!top) return null;
  // Its styp and sidx, then one moof and its mdat: how ffmpeg's HLS muxer
  // writes a segment.
  const moofAt = top.findIndex((x) => x.type === "moof");
  if (moofAt < 0 || moofAt !== top.length - 2 || top[moofAt + 1].type !== "mdat") return null;
  if (top.slice(0, moofAt).some((x) => x.type !== "styp" && x.type !== "sidx" && x.type !== "prft")) return null;
  const read = readMoof(b, top[moofAt], top[moofAt + 1], tracks);
  if (!read) return null;
  const video = read.trafs.filter((t) => t.track.kind === "video");
  if (video.length !== 1 || video[0].samples.length < 2) return null;
  const v = video[0];
  const scale = v.track.timescale;
  const dts = v.samples.map((s) => s.dts / scale);
  const last = v.samples[v.samples.length - 1];
  // Where each picture is in the segment's bytes: the pictures' share of
  // them, the sound sharing out alongside.
  const videoBytes = v.samples.reduce((n, s) => n + s.size, 0);
  const at: number[] = [];
  let sum = 0;
  for (const s of v.samples) { at.push((sum / videoBytes) * b.length); sum += s.size; }
  const cuts = cutsAt(dts, at, b.length, (last.dts + last.duration) / scale, o);
  if (!cuts.length) return null;
  const bounds = [-Infinity, ...cuts.map((c) => dts[c]), Infinity];
  const stypBox = top.find((x) => x.type === "styp");
  const styp = stypBox ? b.subarray(stypBox.at, stypBox.end) : null;
  return bounds.slice(1).map((end, j) => writePiece(b, styp, read.mfhd, read.trafs.map((traf) => ({
    traf,
    samples: traf === v
      ? v.samples.slice(j === 0 ? 0 : cuts[j - 1], j < cuts.length ? cuts[j] : undefined)
      : traf.samples.filter((s) => s.dts / traf.track.timescale >= bounds[j] && s.dts / traf.track.timescale < end),
  }))));
}
