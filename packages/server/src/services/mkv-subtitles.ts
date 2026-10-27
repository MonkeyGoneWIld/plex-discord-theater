/**
 * Subtitle lines read straight out of a Matroska file, around one place in it.
 *
 * Plex reads a subtitle out of a film by going through the whole file
 * (embedded-subtitles.ts). From the start that has the first lines within a
 * second or two, and keeps far ahead of anyone watching — American Honey, 17.7
 * GB, read at about 150 times the speed it plays. But someone who starts an
 * hour in, or skips there, is waiting for the read to get through the hour
 * before it. Plex can be asked to start reading somewhere else, and for a
 * subtitle it converts (SRT, MP4's text) that works: from 1:00:00 in A Place in
 * the Sun the first line came a second later. An ASS track it copies as it is,
 * though, and a copy started mid-film holds every line back until the end of
 * the file — Animal House from 50:00 sent nothing for six seconds, then all of
 * it at once.
 *
 * mkvmerge, which made nearly every remux, writes an entry in the file's index
 * for every subtitle line: where its block is, when it starts and how long it
 * lasts. Of 80 titles picked at random from a real library, every Matroska file
 * with text subtitles had them for all their text tracks but two, whose index
 * listed only the video. So the lines around any place are a handful of small
 * reads of the file through Plex — the way keyframes.ts reads its first bytes —
 * and come out the same as Plex's read of them, to the hundredth of a second.
 * A file without them is left to Plex.
 *
 * What comes back is subtitle text, for parseSubtitles: an ASS track's lines
 * under the track's own header (its styles say which lines sit at the top), a
 * plain-text track's as SRT.
 */

import fs from "node:fs";
import { inflateSync } from "node:zlib";
import { plexFetch } from "./plex.js";
import { LruMap } from "./lru.js";

// ── EBML, just enough of it ───────────────────────────────────────

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_SEEK_HEAD = 0x114d9b74;
const ID_SEEK = 0x4dbb;
const ID_SEEK_ID = 0x53ab;
const ID_SEEK_POSITION = 0x53ac;
const ID_INFO = 0x1549a966;
const ID_TIMESTAMP_SCALE = 0x2ad7b1;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_TYPE = 0x83;
const ID_CODEC_ID = 0x86;
const ID_CODEC_PRIVATE = 0x63a2;
const ID_CONTENT_ENCODINGS = 0x6d80;
const ID_CONTENT_ENCODING = 0x6240;
const ID_CONTENT_COMPRESSION = 0x5034;
const ID_CONTENT_COMP_ALGO = 0x4254;
const ID_CONTENT_COMP_SETTINGS = 0x4255;
const ID_CONTENT_ENCRYPTION = 0x5035;
const ID_CUES = 0x1c53bb6b;
const ID_CUE_POINT = 0xbb;
const ID_CUE_TIME = 0xb3;
const ID_CUE_TRACK_POSITIONS = 0xb7;
const ID_CUE_TRACK = 0xf7;
const ID_CUE_CLUSTER_POSITION = 0xf1;
const ID_CUE_RELATIVE_POSITION = 0xf0;
const ID_CUE_DURATION = 0xb2;
const ID_CLUSTER = 0x1f43b675;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_BLOCK_DURATION = 0x9b;

const TRACK_TYPE_SUBTITLE = 0x11;

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

/** An element size, or a block's track number: its length marker dropped. */
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

interface Element { id: number; at: number; dataAt: number; end: number; unknown: boolean }

function element(buf: Uint8Array, at: number, parentEnd: number): Element | null {
  const id = readId(buf, at);
  if (!id) return null;
  const size = readSize(buf, at + id.length);
  if (!size) return null;
  const dataAt = at + id.length + size.length;
  return { id: id.value, at, dataAt, end: size.unknown ? parentEnd : dataAt + size.value, unknown: size.unknown };
}

/** The children of [start, end), stopping at one that doesn't fit in `buf`. */
function* children(buf: Uint8Array, start: number, end: number): Generator<Element> {
  for (let at = start; at < end;) {
    const child = element(buf, at, end);
    if (!child || child.end > buf.length) return;
    yield child;
    at = child.end;
  }
}

function uint(buf: Uint8Array, el: Element): number {
  let value = 0;
  for (let i = el.dataAt; i < el.end; i++) value = value * 256 + buf[i];
  return value;
}

function text(buf: Uint8Array, el: Element): string {
  return new TextDecoder().decode(buf.subarray(el.dataAt, el.end)).replace(/\0+$/, "");
}

// ── Reading the file through Plex ─────────────────────────────────

/** A range of the file, or null when Plex wouldn't send it as one. */
export type RangeReader = (start: number, end: number) => Promise<Uint8Array | null>;

const RANGE_TIMEOUT_MS = 10_000;

function plexRanges(partKey: string): RangeReader {
  return async (start, end) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), RANGE_TIMEOUT_MS);
    try {
      const res = await plexFetch(partKey, undefined, { Range: `bytes=${start}-${end}` });
      // Anything but a range is the whole film coming: don't read it.
      if (res.status !== 206 || !res.body) {
        res.body?.cancel().catch(() => {});
        return null;
      }
      const want = end - start + 1;
      const chunks: Uint8Array[] = [];
      let got = 0;
      const reader = res.body.getReader();
      abort.signal.addEventListener("abort", () => { reader.cancel().catch(() => {}); });
      while (got < want) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        chunks.push(value);
        got += value.length;
      }
      reader.cancel().catch(() => {});
      const buf = new Uint8Array(Math.min(got, want));
      let at = 0;
      for (const chunk of chunks) {
        const take = Math.min(chunk.length, buf.length - at);
        buf.set(chunk.subarray(0, take), at);
        at += take;
        if (at >= buf.length) break;
      }
      return buf;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Ranges of a file mounted here through one handle, for thousands of reads
 * (a picture subtitle's blocks): opening the file for each costs more than
 * the read on a network mount. `close` when done.
 */
export async function openFileRanges(file: string): Promise<{ range: RangeReader; close: () => Promise<void> } | null> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, "r");
  } catch {
    return null;
  }
  return {
    range: async (start, end) => {
      try {
        const out = Buffer.alloc(Math.max(0, end - start + 1));
        const { bytesRead } = await handle.read(out, 0, out.length, start);
        return out.subarray(0, bytesRead);
      } catch {
        return null;
      }
    },
    close: () => handle.close().catch(() => {}),
  };
}

/** Ranges of a file mounted here (PLAYBACK_ENGINE=ffmpeg): the same bytes
 *  without asking Plex for them. */
export function fileRanges(file: string): RangeReader {
  return async (start, end) => {
    try {
      const handle = await fs.promises.open(file, "r");
      try {
        const out = Buffer.alloc(Math.max(0, end - start + 1));
        const { bytesRead } = await handle.read(out, 0, out.length, start);
        return out.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  };
}

// ── The index ─────────────────────────────────────────────────────

/** How much of the start is read first: the seek head, info and tracks are
 *  in it for nearly every file, ASS styles and all. */
const HEAD_BYTES = 256 * 1024;
/** The index of a long film whose typesetting is redrawn every frame runs to
 *  a few megabytes. Anything this size is not an index. */
const MAX_ELEMENT_BYTES = 32 * 1024 * 1024;

export interface MkvSubtitleTrack {
  number: number;
  codec: string;
  /** An ASS or SSA track's header — script info, styles and the events'
   *  Format line — which its lines are read against. */
  header: string | null;
  /** How its blocks are packed: zlib, or with bytes stripped off the front
   *  of each (header stripping). Null: as they are. */
  compression: { algo: 0 | 3; settings: Uint8Array } | null;
  /** Packed some other way, or encrypted: not something this reads. */
  unreadable: boolean;
}

export interface MkvIndexEntry {
  /** Seconds. */
  start: number;
  /** Seconds, from the index's CueDuration when it has one. */
  end: number | null;
  /** Where the block's cluster is in the file, and where the block is in it. */
  cluster: number;
  relative: number;
}

export interface MkvSubtitleIndex {
  /** Seconds per timestamp tick. */
  tick: number;
  /** Subtitle tracks, in the file's order. */
  tracks: MkvSubtitleTrack[];
  /** Each subtitle track's lines, by track number, in time order. Only
   *  entries that say where in their cluster the block is. */
  entries: Map<number, MkvIndexEntry[]>;
}

/** Read through an index, cached per file; a promise so callers share one read. */
const indexes = new LruMap<string, Promise<MkvSubtitleIndex | null>>(20);

/** A Matroska file's subtitle tracks and index, or null when it can't be read:
 *  through Plex, or `range` (fileRanges, for one mounted here). */
export function mkvSubtitleIndex(
  partKey: string, fileSize: number | null, range?: RangeReader,
): Promise<MkvSubtitleIndex | null> {
  const key = `${partKey}|${fileSize ?? ""}`;
  const known = indexes.get(key);
  if (known) return known;
  const reading = readIndex(range ?? plexRanges(partKey)).catch(() => null);
  indexes.set(key, reading);
  // A failed read is worth trying again later, not remembering.
  void reading.then((index) => { if (!index && indexes.get(key) === reading) indexes.delete(key); });
  return reading;
}

/** For tests: read an index through any source of bytes. */
export async function readIndex(range: RangeReader): Promise<MkvSubtitleIndex | null> {
  const head = await range(0, HEAD_BYTES - 1);
  if (!head) return null;
  const ebml = element(head, 0, head.length);
  if (!ebml || ebml.id !== ID_EBML) return null;
  const segment = element(head, ebml.end, head.length);
  if (!segment || segment.id !== ID_SEGMENT) return null;
  const segmentStart = segment.dataAt;

  // Top-level elements in the head, and where the seek head says the rest are.
  const inHead = new Map<number, Element>();
  const at = new Map<number, number>();
  const readSeekHead = (buf: Uint8Array, el: Element) => {
    for (const seek of children(buf, el.dataAt, el.end)) {
      if (seek.id !== ID_SEEK) continue;
      let id: number | null = null;
      let position: number | null = null;
      for (const field of children(buf, seek.dataAt, seek.end)) {
        if (field.id === ID_SEEK_ID) id = uint(buf, field);
        else if (field.id === ID_SEEK_POSITION) position = uint(buf, field);
      }
      if (id !== null && position !== null && !at.has(id)) at.set(id, segmentStart + position);
    }
  };
  for (let p = segmentStart; p < head.length;) {
    const top = element(head, p, head.length);
    if (!top || top.id === ID_CLUSTER || top.unknown) break;
    if (top.end <= head.length) {
      inHead.set(top.id, top);
      if (top.id === ID_SEEK_HEAD) readSeekHead(head, top);
    }
    p = top.end;
  }

  const read = async (id: number): Promise<{ buf: Uint8Array; el: Element } | null> => {
    const found = inHead.get(id);
    if (found) return { buf: head, el: found };
    const position = at.get(id);
    if (position === undefined) return null;
    const first = await range(position, position + 15);
    const el = first && element(first, 0, Infinity);
    if (!el || el.id !== id || el.unknown || el.end > MAX_ELEMENT_BYTES) return null;
    const buf = await range(position, position + el.end - 1);
    if (!buf || buf.length < el.end) return null;
    return { buf, el: element(buf, 0, buf.length)! };
  };

  // A second seek head, which a file can keep at the end and point to from
  // the first.
  if (!at.has(ID_CUES) && at.has(ID_SEEK_HEAD)) {
    const more = await read(ID_SEEK_HEAD);
    if (more) readSeekHead(more.buf, more.el);
  }

  let tick = 1e-3;
  const info = await read(ID_INFO);
  if (info) {
    for (const field of children(info.buf, info.el.dataAt, info.el.end)) {
      if (field.id === ID_TIMESTAMP_SCALE) tick = uint(info.buf, field) / 1e9;
    }
  }

  const tracksEl = await read(ID_TRACKS);
  if (!tracksEl) return null;
  const tracks: MkvSubtitleTrack[] = [];
  for (const entry of children(tracksEl.buf, tracksEl.el.dataAt, tracksEl.el.end)) {
    if (entry.id !== ID_TRACK_ENTRY) continue;
    const buf = tracksEl.buf;
    let number: number | null = null;
    let type: number | null = null;
    let codec = "";
    let header: string | null = null;
    let compression: MkvSubtitleTrack["compression"] = null;
    let unreadable = false;
    for (const field of children(buf, entry.dataAt, entry.end)) {
      if (field.id === ID_TRACK_NUMBER) number = uint(buf, field);
      else if (field.id === ID_TRACK_TYPE) type = uint(buf, field);
      else if (field.id === ID_CODEC_ID) codec = text(buf, field);
      else if (field.id === ID_CODEC_PRIVATE) header = text(buf, field);
      else if (field.id === ID_CONTENT_ENCODINGS) {
        for (const encoding of children(buf, field.dataAt, field.end)) {
          if (encoding.id !== ID_CONTENT_ENCODING) continue;
          for (const part of children(buf, encoding.dataAt, encoding.end)) {
            if (part.id === ID_CONTENT_ENCRYPTION) unreadable = true;
            if (part.id !== ID_CONTENT_COMPRESSION) continue;
            let algo = 0;
            let settings = new Uint8Array(0);
            for (const c of children(buf, part.dataAt, part.end)) {
              if (c.id === ID_CONTENT_COMP_ALGO) algo = uint(buf, c);
              else if (c.id === ID_CONTENT_COMP_SETTINGS) settings = buf.slice(c.dataAt, c.end);
            }
            if (algo === 0 || algo === 3) compression = { algo, settings };
            else unreadable = true;
          }
        }
      }
    }
    if (type !== TRACK_TYPE_SUBTITLE || number === null) continue;
    // A packed CodecPrivate isn't one this reads: the header's styles matter.
    tracks.push({ number, codec, header: /ASS|SSA/i.test(codec) ? header : null, compression, unreadable });
  }

  const entries = new Map<number, MkvIndexEntry[]>();
  const cues = await read(ID_CUES);
  if (cues) {
    const subtitle = new Set(tracks.map((t) => t.number));
    for (const point of children(cues.buf, cues.el.dataAt, cues.el.end)) {
      if (point.id !== ID_CUE_POINT) continue;
      let time: number | null = null;
      for (const field of children(cues.buf, point.dataAt, point.end)) {
        if (field.id === ID_CUE_TIME) { time = uint(cues.buf, field); continue; }
        if (field.id !== ID_CUE_TRACK_POSITIONS || time === null) continue;
        let track: number | null = null;
        let cluster: number | null = null;
        let relative: number | null = null;
        let duration: number | null = null;
        for (const p of children(cues.buf, field.dataAt, field.end)) {
          if (p.id === ID_CUE_TRACK) track = uint(cues.buf, p);
          else if (p.id === ID_CUE_CLUSTER_POSITION) cluster = uint(cues.buf, p);
          else if (p.id === ID_CUE_RELATIVE_POSITION) relative = uint(cues.buf, p);
          else if (p.id === ID_CUE_DURATION) duration = uint(cues.buf, p);
        }
        if (track === null || !subtitle.has(track) || cluster === null || relative === null) continue;
        const list = entries.get(track) ?? [];
        list.push({
          start: time * tick,
          end: duration === null ? null : (time + duration) * tick,
          cluster: segmentStart + cluster,
          relative,
        });
        entries.set(track, list);
      }
    }
    for (const list of entries.values()) list.sort((a, b) => a.start - b.start);
  }
  return { tick, tracks, entries };
}

// ── Which track a Plex stream is ──────────────────────────────────

/** The Matroska codec ids each of Plex's text codec names can be. */
const TEXT_CODECS: Record<string, string[]> = {
  srt: ["S_TEXT/UTF8", "S_TEXT/ASCII"],
  subrip: ["S_TEXT/UTF8", "S_TEXT/ASCII"],
  ass: ["S_TEXT/ASS", "S_ASS"],
  ssa: ["S_TEXT/SSA", "S_SSA"],
  webvtt: ["S_TEXT/WEBVTT", "D_WEBVTT/SUBTITLES"],
  vtt: ["S_TEXT/WEBVTT", "D_WEBVTT/SUBTITLES"],
};
/** And the picture ones, which only have to line up. */
const PICTURE_CODECS: Record<string, string[]> = {
  pgs: ["S_HDMV/PGS"],
  hdmv_pgs_subtitle: ["S_HDMV/PGS"],
  vobsub: ["S_VOBSUB"],
  dvd_subtitle: ["S_VOBSUB"],
  dvb_subtitle: ["S_DVBSUB"],
  dvbsub: ["S_DVBSUB"],
};

export interface PlexSubtitleStream {
  id: number;
  codec: string | null;
  /** Its place among the file's streams, as Plex numbers them. */
  index: number | null;
}

/**
 * The file's track for one of Plex's subtitle streams, or null when they can't
 * be lined up for certain.
 *
 * Plex numbers a file's streams in the order the tracks are listed, so its
 * subtitle streams in order are the file's subtitle tracks in order. That is
 * only trusted when every one of them agrees: as many on each side, each the
 * same kind of subtitle as the track in its place. Closed captions Plex lists
 * among them are in the picture's frames, not a track (173175's on 21
 * October: one track, two of Plex's, and its subtitle left to Plex).
 */
export function subtitleTrackFor(
  index: MkvSubtitleIndex, all: PlexSubtitleStream[], streamId: number, kind: "text" | "picture" = "text",
): MkvSubtitleTrack | null {
  const streams = all.filter((s) => !["eia_608", "eia_708"].includes((s.codec ?? "").toLowerCase()));
  if (streams.some((s) => s.index === null)) return null;
  const ordered = [...streams].sort((a, b) => a.index! - b.index!);
  if (ordered.length !== index.tracks.length) return null;
  for (let i = 0; i < ordered.length; i++) {
    const codec = (ordered[i].codec ?? "").toLowerCase();
    const allowed = TEXT_CODECS[codec] ?? PICTURE_CODECS[codec];
    if (!allowed || !allowed.includes(index.tracks[i].codec.toUpperCase())) return null;
  }
  const at = ordered.findIndex((s) => s.id === streamId);
  const track = at === -1 ? null : index.tracks[at];
  const codecs = kind === "text" ? TEXT_CODECS : PICTURE_CODECS;
  if (!track || track.unreadable || !codecs[(ordered[at].codec ?? "").toLowerCase()]) return null;
  return track;
}

/** Whether the index lists this track's lines with where each block is. */
export function indexesLines(index: MkvSubtitleIndex, track: MkvSubtitleTrack): boolean {
  return (index.entries.get(track.number)?.length ?? 0) > 0;
}

// ── Reading lines ─────────────────────────────────────────────────

/** Blocks this close together in the file are read in one go. */
const JOIN_BYTES = 64 * 1024;
/** Reads in flight at once, for one window. */
const PARALLEL_READS = 8;
/** A line's block is read this far past where it starts, and again if longer. */
const BLOCK_GUESS_BYTES = 4096;
/** A cluster's header: four bytes of id, one to eight of size. */
const CLUSTER_HEADER_MIN = 5;
const CLUSTER_HEADER_MAX = 12;
/** No subtitle line is this long; a block claiming to be isn't one. */
const MAX_BLOCK_BYTES = 1024 * 1024;

interface Line { start: number; end: number; payload: string }

/** A block of a track, unpacked: when it starts and ends, seconds. */
export interface MkvBlock { entry: MkvIndexEntry; start: number; end: number; payload: Uint8Array }

/**
 * The lines of `track` that start in [from, to), as subtitle text for
 * parseSubtitles — or null when the file couldn't be read for them. A line
 * whose block can't be found is left out, not guessed at.
 */
export async function mkvSubtitleText(
  partKey: string, index: MkvSubtitleIndex, track: MkvSubtitleTrack, from: number, to: number,
  range: RangeReader = plexRanges(partKey),
): Promise<string | null> {
  const all = index.entries.get(track.number) ?? [];
  const wanted = all.filter((e) => e.start >= from && e.start < to);
  if (wanted.length === 0) return compose(track, []);
  const blocks = await mkvBlocks(wanted, track, index.tick, range);
  if (!blocks) return null;
  const lines: Line[] = [];
  for (const b of blocks) {
    if (b) lines.push({ start: b.start, end: b.end, payload: new TextDecoder().decode(b.payload).replace(/\0+$/, "") });
  }
  lines.sort((a, b) => a.start - b.start);
  return compose(track, lines);
}

/**
 * The blocks of `track` the index `entries` point to, unpacked, in the order
 * of `entries`: null for one that wasn't where the index said. Null when the
 * file couldn't be read. `guess`: how much of each block is read at first.
 */
export async function mkvBlocks(
  entries: MkvIndexEntry[], track: MkvSubtitleTrack, tick: number, range: RangeReader, guess = BLOCK_GUESS_BYTES,
): Promise<Array<MkvBlock | null> | null> {
  const found = new Map<MkvIndexEntry, MkvBlock>();
  // Where each block is: its cluster's data starts CLUSTER_HEADER_MIN to _MAX
  // bytes after the cluster, and the block `relative` bytes after that.
  const runs: Array<{ start: number; end: number; entries: MkvIndexEntry[] }> = [];
  for (const e of [...entries].sort((a, b) => (a.cluster + a.relative) - (b.cluster + b.relative))) {
    const start = e.cluster + e.relative + CLUSTER_HEADER_MIN;
    const end = e.cluster + e.relative + CLUSTER_HEADER_MAX + guess;
    const last = runs.at(-1);
    if (last && start - last.end < JOIN_BYTES && end - last.start < 4 * JOIN_BYTES) {
      last.end = Math.max(last.end, end);
      last.entries.push(e);
    } else {
      runs.push({ start, end, entries: [e] });
    }
  }

  let failed = false;
  const readRun = async (run: typeof runs[number]) => {
    const buf = await range(run.start, run.end - 1);
    if (!buf) { failed = true; return; }
    for (const e of run.entries) {
      const at = e.cluster + e.relative + CLUSTER_HEADER_MIN;
      let block = blockAt(buf, at - run.start, track, e, tick);
      if (block && "need" in block) {
        // Longer than guessed: read this one again, all of it.
        const own = await range(at, at + block.need - 1);
        block = own ? blockAt(own, 0, track, e, tick) : null;
      }
      if (block && !("need" in block)) found.set(e, block);
    }
  };
  for (let i = 0; i < runs.length; i += PARALLEL_READS) {
    await Promise.all(runs.slice(i, i + PARALLEL_READS).map(readRun));
    if (failed) return null;
  }
  return entries.map((e) => found.get(e) ?? null);
}

/**
 * The block for `entry` near `offset` in `buf` — at one of the eight places a
 * cluster header of one to eight size bytes would put it, and only if it is a
 * block of this track. When it runs past the end of `buf`, how many bytes from
 * `offset` it needs.
 */
function blockAt(
  buf: Uint8Array, offset: number, track: MkvSubtitleTrack, entry: MkvIndexEntry, tick: number,
): MkvBlock | { need: number } | null {
  for (let skip = 0; skip <= CLUSTER_HEADER_MAX - CLUSTER_HEADER_MIN; skip++) {
    const at = offset + skip;
    const el = element(buf, at, Infinity);
    if (!el || el.unknown || (el.id !== ID_BLOCK_GROUP && el.id !== ID_SIMPLE_BLOCK)) continue;
    if (el.end - el.at > MAX_BLOCK_BYTES) continue;
    if (el.end > buf.length) {
      // Only worth reading again if it really is this track's block.
      const probe = el.id === ID_SIMPLE_BLOCK ? el.dataAt : blockInGroup(buf, el.dataAt);
      const number = probe === null ? null : readSize(buf, probe);
      if (number && number.value === track.number) return { need: el.end - offset };
      continue;
    }
    let block: { at: number; end: number } | null = null;
    let duration: number | null = null;
    if (el.id === ID_SIMPLE_BLOCK) block = { at: el.dataAt, end: el.end };
    else {
      for (const part of children(buf, el.dataAt, el.end)) {
        if (part.id === ID_BLOCK) block = { at: part.dataAt, end: part.end };
        else if (part.id === ID_BLOCK_DURATION) duration = uint(buf, part);
      }
    }
    if (!block) continue;
    const number = readSize(buf, block.at);
    if (!number || number.value !== track.number) continue;
    const flags = buf[block.at + number.length + 2];
    // Laced subtitle blocks aren't written by anything this has met.
    if (flags === undefined || (flags & 0x06) !== 0) return null;
    const payload = unpack(buf.subarray(block.at + number.length + 3, block.end), track);
    if (payload === null) return null;
    const end = duration !== null ? entry.start + duration * tick : entry.end;
    return { entry, start: entry.start, end: end ?? entry.start, payload };
  }
  return null;
}

/** Where a BlockGroup's Block starts, if it is the group's first child. */
function blockInGroup(buf: Uint8Array, at: number): number | null {
  const first = element(buf, at, Infinity);
  return first && first.id === ID_BLOCK ? first.dataAt : null;
}

/** A block's bytes, unpacked. */
function unpack(data: Uint8Array, track: MkvSubtitleTrack): Uint8Array | null {
  try {
    let bytes: Uint8Array = data;
    if (track.compression?.algo === 0) bytes = inflateSync(data);
    else if (track.compression?.algo === 3) {
      bytes = new Uint8Array(track.compression.settings.length + data.length);
      bytes.set(track.compression.settings, 0);
      bytes.set(data, track.compression.settings.length);
    }
    return bytes;
  } catch {
    return null;
  }
}

/** "1:02:03.45", the way ASS writes a time. */
function assTime(s: number): string {
  const cs = Math.max(0, Math.round(s * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor(cs / 6000) % 60;
  const sec = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

/** "01:02:03,456", the way SRT writes one. */
function srtTime(s: number): string {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const sec = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

/**
 * Subtitle text from a track's lines. An ASS or SSA block is the event's
 * fields without its times — "ReadOrder, Layer, Style, Name, MarginL, MarginR,
 * MarginV, Effect, Text" — so each goes back into a Dialogue line with them;
 * anything else is the line's text, and goes into SRT.
 */
function compose(track: MkvSubtitleTrack, lines: Line[]): string {
  if (track.header !== null) {
    let header = track.header.replace(/\r\n?/g, "\n").trimEnd();
    if (!/^\s*\[Events\]/im.test(header)) {
      header += "\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text";
    }
    const events = lines.map((l) => {
      const fields = l.payload.split(",");
      // Drop the ReadOrder; the next field is the Layer (Marked, in SSA).
      return `Dialogue: ${fields[1] ?? "0"},${assTime(l.start)},${assTime(l.end)},${fields.slice(2).join(",")}`;
    });
    return `${header}\n${events.join("\n")}\n`;
  }
  // A blank line inside a line's text would end its cue there.
  return lines.map((l, i) => {
    const body = l.payload.replace(/\r\n?/g, "\n").replace(/\n{2,}/g, "\n").trim();
    return `${i + 1}\n${srtTime(l.start)} --> ${srtTime(l.end)}\n${body}\n`;
  }).join("\n");
}
