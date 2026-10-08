/**
 * Whether a film's H.264 keyframes are ones a browser starts from and cuts at.
 *
 * A copied stream (direct-stream.ts) is cut by Plex at the file's keyframes,
 * and played and trimmed by the browser at the same places. In most files
 * every keyframe is an IDR frame. Some Blu-rays are encoded "open GOP": only
 * the very first frame is IDR, and every keyframe after it is a plain I-frame
 * that two frames before it still lean on. Inglourious Basterds (FraMeSToR's
 * remux) is one. In Discord on 8 October:
 *
 *  - From the start it played until the player trimmed what had been watched,
 *    and then both players lost everything they held: Discord's browser took
 *    no keyframe after the first as a place a cut could stop, so the cut ran on
 *    to the end of the buffer.
 *  - Started again at 1:13 it never showed a picture. With no IDR to begin on,
 *    nothing it was handed was kept, but one segment two minutes on.
 *
 * Even where a browser does start from such a keyframe, a stream begun
 * mid-film has its segments arrive out of order, and each loses the two frames
 * it shares with the one before: the picture has a hole every segment, and
 * hls.js loads the same segments over and over trying to fill them. A film
 * like that is re-encoded instead, which puts an IDR frame at every keyframe.
 *
 * Told from the start of the file, before Plex is asked for anything: the
 * first few megabytes, read through Plex, hold several keyframes. Only
 * Matroska is read — nearly every remux is one — and anything unclear is
 * "unknown", which is copied as before. direct-stream.ts also looks at every
 * segment it measures, for whatever this misses.
 */
import { isISlice } from "./h264.js";
import { plexFetch } from "./plex.js";

export type KeyframeKind = "idr" | "not-idr" | "unknown";

/** How much of a file is read: a few seconds of even a 40 Mbps Blu-ray. */
const PROBE_BYTES = 12 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 5_000;
/** IDR keyframes in a row that make a file's keyframes all IDR, as far as this goes. */
const IDR_ENOUGH = 3;

const known = new Map<string, KeyframeKind>();

// ── EBML, just enough of it ───────────────────────────────────────

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_CODEC_ID = 0x86;
const ID_CODEC_PRIVATE = 0x63a2;
const ID_CLUSTER = 0x1f43b675;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_REFERENCE_BLOCK = 0xfb;
/** Top-level elements: one of these ends a cluster of unknown size. */
const TOP_LEVEL = new Set([ID_CLUSTER, 0x1c53bb6b, 0x1254c367, 0x1043a770, 0x1941a469, 0x114d9b74, 0x1549a966, ID_TRACKS]);

interface Vint { value: number; length: number; unknown: boolean }

/** An element id: its length marker kept, as ids are written. */
function readId(buf: Uint8Array, at: number): Vint | null {
  const first = buf[at];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (length > 4 || at + length > buf.length) return null;
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + buf[at + i];
  return { value, length, unknown: false };
}

/** An element size: its length marker dropped; all ones is "unknown". */
function readSize(buf: Uint8Array, at: number): Vint | null {
  const first = buf[at];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (length > 8 || at + length > buf.length) return null;
  let value = first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[at + i];
    if (buf[at + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: allOnes };
}

interface Element { id: number; dataAt: number; end: number; unknown: boolean }

function element(buf: Uint8Array, at: number, parentEnd: number): Element | null {
  const id = readId(buf, at);
  if (!id) return null;
  const size = readSize(buf, at + id.length);
  if (!size) return null;
  const dataAt = at + id.length + size.length;
  return { id: id.value, dataAt, end: size.unknown ? parentEnd : dataAt + size.value, unknown: size.unknown };
}

/** The AVC track's number and the length of its NAL size fields, if there is one. */
function avcTrack(buf: Uint8Array, at: number, end: number): { track: number; nalLength: number } | null {
  for (let p = at; p < end;) {
    const entry = element(buf, p, end);
    if (!entry || entry.end > buf.length) return null;
    if (entry.id === ID_TRACK_ENTRY) {
      let track: number | null = null;
      let codec = "";
      let nalLength = 4;
      for (let q = entry.dataAt; q < entry.end;) {
        const child = element(buf, q, entry.end);
        if (!child) break;
        const data = buf.subarray(child.dataAt, child.end);
        if (child.id === ID_TRACK_NUMBER) track = data.reduce((n, b) => n * 256 + b, 0);
        else if (child.id === ID_CODEC_ID) codec = String.fromCharCode(...data).replace(/\0+$/, "");
        // avcC: its fifth byte holds the NAL length size, less one.
        else if (child.id === ID_CODEC_PRIVATE && data.length > 4) nalLength = (data[4] & 0x03) + 1;
        q = child.end;
      }
      if (codec === "V_MPEG4/ISO/AVC" && track !== null) return { track, nalLength };
    }
    p = entry.end;
  }
  return null;
}

interface Tally { idr: number; other: number }

/** One keyframe's slices: IDR, or a plain I-frame. */
function tallyKeyframe(data: Uint8Array, nalLength: number, tally: Tally): void {
  let idr = false;
  let iSlice = false;
  for (let p = 0; p + nalLength < data.length;) {
    let size = 0;
    for (let i = 0; i < nalLength; i++) size = size * 256 + data[p + i];
    const nal = data.subarray(p + nalLength, p + nalLength + size);
    const type = nal[0] & 0x1f;
    if (type === 5) idr = true;
    else if (type === 1 && !iSlice) iSlice = isISlice(nal);
    p += nalLength + size;
  }
  if (idr) tally.idr++;
  else if (iSlice) tally.other++;
}

/** A block of the AVC track, if it is a keyframe. Lacing is never used for video. */
function blockOf(buf: Uint8Array, at: number, end: number, track: number): { data: Uint8Array; flags: number } | null {
  const number = readSize(buf, at);
  if (!number || number.value !== track || at + number.length + 3 > end) return null;
  const flags = buf[at + number.length + 2];
  if ((flags & 0x06) !== 0) return null;
  return { data: buf.subarray(at + number.length + 3, end), flags };
}

/**
 * The keyframes at the start of a Matroska file, read from its first bytes:
 * "not-idr" as soon as a keyframe other than an IDR one turns up, "idr" after
 * IDR_ENOUGH IDR ones, "unknown" if neither (not Matroska, not H.264, or not
 * enough of it).
 */
export function matroskaKeyframes(buf: Uint8Array): KeyframeKind {
  const header = element(buf, 0, buf.length);
  if (!header || header.id !== ID_EBML) return "unknown";
  const segment = element(buf, header.end, buf.length);
  if (!segment || segment.id !== ID_SEGMENT) return "unknown";
  const segmentEnd = Math.min(segment.end, buf.length);
  let avc: { track: number; nalLength: number } | null = null;
  const tally: Tally = { idr: 0, other: 0 };
  const verdict = (): KeyframeKind | null =>
    tally.other > 0 ? "not-idr" : tally.idr >= IDR_ENOUGH ? "idr" : null;

  for (let p = segment.dataAt; p < segmentEnd;) {
    const top = element(buf, p, segmentEnd);
    if (!top) break;
    if (top.id === ID_TRACKS) {
      if (top.end > buf.length) break;
      avc = avcTrack(buf, top.dataAt, top.end);
      if (!avc) return "unknown";
    } else if (top.id === ID_CLUSTER) {
      if (!avc) return "unknown";
      let q = top.dataAt;
      const clusterEnd = Math.min(top.end, buf.length);
      while (q < clusterEnd) {
        const child = element(buf, q, clusterEnd);
        if (!child || (top.unknown && TOP_LEVEL.has(child.id))) break;
        if (child.end > buf.length) return verdict() ?? "unknown";
        if (child.id === ID_SIMPLE_BLOCK) {
          const block = blockOf(buf, child.dataAt, child.end, avc.track);
          if (block && (block.flags & 0x80)) tallyKeyframe(block.data, avc.nalLength, tally);
        } else if (child.id === ID_BLOCK_GROUP) {
          // A keyframe is a group without a reference to another block.
          let block: { data: Uint8Array; flags: number } | null = null;
          let referenced = false;
          for (let r = child.dataAt; r < child.end;) {
            const part = element(buf, r, child.end);
            if (!part) break;
            if (part.id === ID_BLOCK) block = blockOf(buf, part.dataAt, part.end, avc.track);
            else if (part.id === ID_REFERENCE_BLOCK) referenced = true;
            r = part.end;
          }
          if (block && !referenced) tallyKeyframe(block.data, avc.nalLength, tally);
        }
        const done = verdict();
        if (done) return done;
        q = child.end;
      }
      if (top.unknown) {
        p = q;
        continue;
      }
    }
    if (top.unknown) break;
    p = top.end;
  }
  return verdict() ?? "unknown";
}

/**
 * The keyframes of the file Plex keeps at `partKey` ("/library/parts/…/file.mkv"),
 * from its first PROBE_BYTES. Remembered per file; "unknown" is asked again.
 */
export async function fileKeyframes(partKey: string, fileSize: number | null): Promise<KeyframeKind> {
  if (!/\.mkv$/i.test(partKey)) return "unknown";
  const id = `${partKey}|${fileSize ?? ""}`;
  const remembered = known.get(id);
  if (remembered) return remembered;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await plexFetch(partKey, undefined, { Range: `bytes=0-${PROBE_BYTES - 1}` });
    if (!res.ok || !res.body) return "unknown";
    // Read no more than asked for, whatever the answer: a server that ignored
    // the range would otherwise send the whole film.
    const chunks: Uint8Array[] = [];
    let got = 0;
    const reader = res.body.getReader();
    abort.signal.addEventListener("abort", () => { reader.cancel().catch(() => {}); });
    while (got < PROBE_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      got += value.length;
    }
    reader.cancel().catch(() => {});
    const buf = new Uint8Array(Math.min(got, PROBE_BYTES));
    let at = 0;
    for (const chunk of chunks) {
      const take = Math.min(chunk.length, buf.length - at);
      buf.set(chunk.subarray(0, take), at);
      at += take;
      if (at >= buf.length) break;
    }
    const kind = matroskaKeyframes(buf);
    if (kind !== "unknown") known.set(id, kind);
    return kind;
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}
