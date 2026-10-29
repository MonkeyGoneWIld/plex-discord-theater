/**
 * HDR10 labelled for a browser on a screen in SDR to map brighter.
 *
 * Chrome maps an HDR picture to an SDR screen itself, at full precision from
 * its 10 bits, by a curve set by the brightest the stream says it gets: its
 * mastering display's peak, or its MaxCLL. At the usual 1,000 nits HDR's
 * reference white (203 nits) lands at grey 188 of 255 and a 100-nit face at
 * 136, a stop or more under Plex's app for Windows. Labelled 300 nits the same
 * face is 174 and reference white 240 (measured in Chrome 156, 29 October), and
 * whatever is brighter than 300 nits is white.
 *
 * Any mastering or light-level SEI in the stream outranks an MP4's own boxes,
 * whether in the frames or in the init's hvcC, so a labelled copy goes out with
 * its frames' prefix SEI left out (plan.ts, filter_units) and its init made
 * over here: hvcC without its SEI arrays, and mdcv and clli saying `peakNits`.
 */

const u16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];

interface Box {
  type: string;
  /** Where the box starts, its body starts, and it ends. */
  at: number;
  start: number;
  end: number;
}

/** The boxes directly inside b[from, to), each with a 32-bit size; null for anything else. */
function boxes(b: Uint8Array, from: number, to: number): Box[] | null {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    const size = u32(b, at);
    if (size < 8 || at + size > to) return null;
    out.push({ type: String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7]), at, start: at + 8, end: at + size });
    at += size;
  }
  return at === to ? out : null;
}

function box(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

const SEI_NAL_TYPES = new Set([39, 40]);

/** An hvcC body without its SEI arrays; null when it can't be read. */
function hvccWithoutSei(body: Uint8Array): Uint8Array | null {
  if (body.length < 23) return null;
  const kept: Uint8Array[] = [];
  let at = 23;
  for (let n = body[22]; n > 0; n--) {
    if (at + 3 > body.length) return null;
    const from = at;
    const type = body[at] & 0x3f;
    let count = u16(body, at + 1);
    at += 3;
    for (; count > 0; count--) {
      if (at + 2 > body.length) return null;
      at += 2 + u16(body, at);
    }
    if (at > body.length) return null;
    if (!SEI_NAL_TYPES.has(type)) kept.push(body.subarray(from, at));
  }
  const out = new Uint8Array(23 + kept.reduce((n, a) => n + a.length, 0));
  out.set(body.subarray(0, 22));
  out[22] = kept.length;
  let to = 23;
  for (const a of kept) {
    out.set(a, to);
    to += a.length;
  }
  return out;
}

/**
 * mdcv: a P3 display with D65 white, as HDR10 films are mastered, at
 * `peakNits` and 0.005 nits; clli: `peakNits` brightest, and an average no
 * higher than 400.
 */
function hdrBoxes(peakNits: number): Uint8Array[] {
  const mdcv = new Uint8Array(24);
  const m = new DataView(mdcv.buffer);
  // Green, blue, red, white, in 0.00002s.
  [13250, 34500, 7500, 3000, 34000, 16000, 15635, 16450].forEach((v, i) => m.setUint16(i * 2, v));
  m.setUint32(16, peakNits * 10_000);
  m.setUint32(20, 50);
  const clli = new Uint8Array(4);
  const c = new DataView(clli.buffer);
  c.setUint16(0, peakNits);
  c.setUint16(2, Math.min(peakNits, 400));
  return [box("mdcv", mdcv), box("clli", clli)];
}

/** A visual sample entry's own fields, before its boxes. */
const VISUAL_ENTRY_FIELDS = 78;

/**
 * The init segment with its HEVC labelled `peakNits` for a browser on a screen
 * in SDR (see above); null when it has no HEVC entry this can read.
 */
export function labelInitForSdr(init: Uint8Array, peakNits: number): Uint8Array | null {
  const nits = Math.round(peakNits);
  if (!(nits > 0 && nits <= 10_000)) return null;
  const top = boxes(init, 0, init.length);
  const moov = top?.find((x) => x.type === "moov");
  if (!moov) return null;
  const inside = (parent: Box, type: string) => boxes(init, parent.start, parent.end)?.filter((x) => x.type === type) ?? [];
  for (const trak of inside(moov, "trak")) {
    const mdia = inside(trak, "mdia")[0];
    const minf = mdia && inside(mdia, "minf")[0];
    const stbl = minf && inside(minf, "stbl")[0];
    const stsd = stbl && inside(stbl, "stsd")[0];
    if (!stsd) continue;
    // Version, flags and entry count, then the entries.
    const entries = boxes(init, stsd.start + 8, stsd.end);
    const entry = entries?.find((x) => x.type === "hvc1" || x.type === "hev1");
    if (!entry || entry.start + VISUAL_ENTRY_FIELDS > entry.end) continue;
    const children = boxes(init, entry.start + VISUAL_ENTRY_FIELDS, entry.end);
    if (!children) return null;
    const parts: Uint8Array[] = [init.subarray(entry.at, entry.start + VISUAL_ENTRY_FIELDS)];
    let hvcc = false;
    for (const ch of children) {
      if (ch.type === "mdcv" || ch.type === "clli") continue;
      if (ch.type === "hvcC") {
        const body = hvccWithoutSei(init.subarray(ch.start, ch.end));
        if (!body) return null;
        parts.push(box("hvcC", body));
        hvcc = true;
      } else {
        parts.push(init.subarray(ch.at, ch.end));
      }
    }
    if (!hvcc) return null;
    parts.push(...hdrBoxes(nits));
    const length = parts.reduce((n, p) => n + p.length, 0);
    const delta = length - (entry.end - entry.at);
    const out = new Uint8Array(init.length + delta);
    out.set(init.subarray(0, entry.at));
    let to = entry.at;
    for (const p of parts) {
      out.set(p, to);
      to += p.length;
    }
    out.set(init.subarray(entry.end), to);
    const view = new DataView(out.buffer);
    view.setUint32(entry.at, length);
    // Each box it is in grows or shrinks with it; they all start before it.
    for (const parent of [moov, trak, mdia, minf, stbl, stsd]) view.setUint32(parent.at, u32(init, parent.at) + delta);
    return out;
  }
  return null;
}
