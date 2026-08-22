/**
 * Plex's scrubbing preview frames, read from the part's BIF index.
 *
 * Plex stores every preview frame for a file in one BIF (the Roku format) and
 * will also serve them one at a time from
 * /library/parts/<id>/indexes/sd/<offsetMs>. One at a time is what the player
 * used to do, and it costs a round trip out to Plex per frame — through
 * Discord's proxy, which is why a frame arrived a second or two after the
 * cursor did and a sweep across the bar mostly showed nothing at all.
 *
 * Fetching the file instead costs one request for the whole set, and every
 * hover afterwards is a slice of memory.
 *
 * The index sits at the front of the file, which is what makes the length of
 * the video stop mattering: the frame table is readable from the first few
 * kilobytes, and each frame becomes available the moment its own bytes arrive.
 * A six hour film is tens of megabytes of JPEG, and waiting for all of it
 * before showing anything is the difference between previews that work in a
 * second and previews that look broken for a minute.
 *
 * Layout, all integers little-endian:
 *
 *     0   magic  89 'B' 'I' 'F' 0d 0a 1a 0a
 *     8   version
 *    12   image count
 *    16   timestamp multiplier in ms (0 means the 1000ms default)
 *    20   reserved, to 64
 *    64   index: (count + 1) entries of (timestamp, absolute offset).
 *         The extra entry is a terminator — its offset marks the end of the
 *         last image rather than the start of another.
 */

const MAGIC = [0x89, 0x42, 0x49, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];
const HEADER_BYTES = 64;
const INDEX_ENTRY_BYTES = 8;
/** The multiplier the format defines for a header that leaves it at zero. */
const DEFAULT_TIMESTAMP_MS = 1000;

/**
 * Sanity bounds on the interval the header describes.
 *
 * The one part of the format with any ambiguity in practice is whether the
 * index holds frame numbers to be scaled by the multiplier or timestamps that
 * are already absolute. Both readings parse; only one gives an interval a
 * preview grid could plausibly use. Plex generates at 2s (HD) or 10s (SD), so
 * anything outside this band means the timestamps were read wrong — the frames
 * are evenly spaced regardless, so we fall back to spreading them across the
 * runtime, which needs no header at all.
 */
const MIN_INTERVAL_MS = 500;
const MAX_INTERVAL_MS = 120_000;

/**
 * A bound on the frame count, so a corrupt header cannot send the index loop
 * somewhere absurd.
 *
 * Deliberately far past anything real rather than sized to a plausible film:
 * a six hour video at Plex's two second interval is 10,800 frames, and this
 * has no business being the thing that decides whether a long video gets
 * previews. The byte-range checks below are what actually reject a bad file.
 */
const MAX_FRAMES = 500_000;

interface Frame {
  /** Milliseconds into the file, or null when the header wasn't usable. */
  at: number | null;
  start: number;
  end: number;
}

interface Index {
  frames: Frame[];
  /** Whether the header's timestamps survived the interval check. */
  timed: boolean;
}

/** Not a BIF, as opposed to not enough of one yet. */
const REJECTED = Symbol("rejected");

/**
 * Read the header and frame table out of however much of the file has arrived.
 *
 * Three answers, because the caller has three things to do with them: an index
 * to use, `null` for "keep reading", and REJECTED for a file that will never
 * parse however much more of it turns up.
 *
 * What `bytes` holds is all this knows about: the checks that need the tail of
 * the file are skipped when the tail is not in it. Mid-download the caller
 * passes the head of the file, which is where the whole index lives.
 */
function readIndex(bytes: Uint8Array): Index | null | typeof REJECTED {
  const available = bytes.length;
  // The magic first, before anything about length: eight bytes are enough to
  // know this is not a BIF, and a reader that waits for eighty of them before
  // saying so keeps a doomed download running.
  if (available < MAGIC.length) return null;
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) return REJECTED;
  }
  if (available < HEADER_BYTES + INDEX_ENTRY_BYTES * 2) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(12, true);
  if (count === 0 || count > MAX_FRAMES) return REJECTED;

  const multiplier = view.getUint32(16, true) || DEFAULT_TIMESTAMP_MS;
  // The terminator entry is part of the index, hence count + 1.
  const indexEnd = HEADER_BYTES + (count + 1) * INDEX_ENTRY_BYTES;
  if (available < indexEnd) return null;

  const frames: Frame[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const entry = HEADER_BYTES + i * INDEX_ENTRY_BYTES;
    const start = view.getUint32(entry + 4, true);
    const end = view.getUint32(entry + INDEX_ENTRY_BYTES + 4, true);
    // Every image has to live after the index, and the offsets have to
    // advance. The upper bound is only checkable once the file is complete,
    // so it is left to the caller — a frame past the end simply never becomes
    // available.
    if (start < indexEnd || end <= start) return REJECTED;
    frames[i] = { at: view.getUint32(entry, true) * multiplier, start, end };
  }

  // The offsets can all be in range and still be wrong — a header read the
  // wrong way round lands inside the images rather than outside them. Every
  // image in a BIF is a JPEG, so its first two bytes are the one cheap way to
  // tell a correct index from a plausible one.
  //
  // The first image's marker is required rather than checked when convenient:
  // an index accepted without it is an index nothing has verified, and the
  // frames it hands out later would be whatever those offsets happen to point
  // at. It costs two bytes past the end of the index to wait for.
  if (frames[0].start + 2 > available) return null;
  // The last image's is checked when it is there, which mid-download it is not.
  for (const i of [0, count - 1]) {
    const { start } = frames[i];
    if (start + 2 > available) continue;
    if (bytes[start] !== 0xff || bytes[start + 1] !== 0xd8) return REJECTED;
  }

  // Even spacing is what makes the fallback exact rather than approximate, so
  // the check is on the interval the header implies across the whole file.
  const span = (frames[count - 1].at ?? 0) - (frames[0].at ?? 0);
  const interval = count > 1 ? span / (count - 1) : DEFAULT_TIMESTAMP_MS;
  const timed = interval >= MIN_INTERVAL_MS && interval <= MAX_INTERVAL_MS;
  if (!timed) for (const frame of frames) frame.at = null;

  return { frames, timed };
}

/** Which frame covers `ms`, or -1 when there is nothing to answer with. */
function frameIndexAt(index: Index, ms: number, durationMs: number): number {
  const { frames, timed } = index;
  const count = frames.length;
  const at = ms >= 0 ? ms : 0;
  let i: number;
  if (timed) {
    // The frame at or before the cursor — the last one whose timestamp hasn't
    // passed it.
    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((frames[mid].at as number) <= at) lo = mid;
      else hi = mid - 1;
    }
    i = lo;
  } else {
    if (!(durationMs > 0)) return -1;
    i = Math.floor((at / durationMs) * count);
  }
  if (i < 0) return 0;
  if (i > count - 1) return count - 1;
  return i;
}

export interface PreviewFrames {
  readonly count: number;
  /** How many of them have arrived. Equal to `count` once the file is complete. */
  readonly ready: number;
  /**
   * A blob URL for the frame at or before `ms`, or null when that frame's
   * bytes have not arrived yet — in which case the caller falls back to asking
   * Plex for the single frame, which is what it did for all of them before.
   *
   * Frames are materialised on first use and kept, so scrubbing back over
   * ground already covered costs nothing.
   *
   * `durationMs` is only consulted for a file whose header timestamps didn't
   * survive the sanity check above.
   */
  frameAt(ms: number, durationMs: number): string | null;
  /** Release every blob URL handed out. Call when the item changes. */
  dispose(): void;
}

/**
 * Somewhere to put bytes as they arrive, and a growing set of frames to read
 * back out of them.
 *
 * The chunks are kept as they came rather than concatenated into one buffer.
 * Growing a single ArrayBuffer means copying everything already downloaded
 * each time it is resized, which on a file this size is the most expensive
 * thing the player would be doing while it is also decoding video.
 */
export interface PreviewFrameReader {
  /** Take another piece of the file. */
  push(chunk: Uint8Array): void;
  /**
   * The frames, once the index has been read. Null while there is still not
   * enough of the file to say, and null for good once it is clear this is not
   * a BIF — see `rejected`.
   */
  frames(): PreviewFrames | null;
  /** This will never parse; stop feeding it. */
  rejected(): boolean;
  dispose(): void;
}

export function createPreviewFrameReader(): PreviewFrameReader {
  const chunks: Uint8Array[] = [];
  // Where each chunk starts in the file, so a frame's bytes can be found
  // without walking the list from the beginning.
  const chunkStart: number[] = [];
  let total = 0;

  let index: Index | null = null;
  let done = false;
  // The header and index in one piece, kept because every parse attempt needs
  // them contiguous and they are a fraction of the file.
  let head: Uint8Array | null = null;

  const urls = new Map<number, string>();

  const headBytes = (upTo: number): Uint8Array => {
    if (head && head.length >= upTo) return head;
    const out = new Uint8Array(Math.min(upTo, total));
    copyInto(out, 0);
    head = out;
    return out;
  };

  /** Copy `out.length` bytes starting at file offset `from` into `out`. */
  function copyInto(out: Uint8Array, from: number): void {
    // The chunk holding `from`.
    let lo = 0;
    let hi = chunks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (chunkStart[mid] <= from) lo = mid;
      else hi = mid - 1;
    }
    let written = 0;
    let offset = from - chunkStart[lo];
    for (let c = lo; c < chunks.length && written < out.length; c++, offset = 0) {
      const chunk = chunks[c];
      const take = Math.min(chunk.length - offset, out.length - written);
      out.set(chunk.subarray(offset, offset + take), written);
      written += take;
    }
  }

  /**
   * How much of the front of the file to hold contiguous for a parse: the
   * header, the whole index, and the two bytes after it that are the first
   * image's JPEG marker — the one check that tells a correct index from a
   * merely plausible one.
   */
  const headWanted = (): number => {
    if (total < HEADER_BYTES + INDEX_ENTRY_BYTES * 2) return total;
    const probe = headBytes(Math.min(total, HEADER_BYTES));
    const view = new DataView(probe.buffer, probe.byteOffset, probe.byteLength);
    const count = view.getUint32(12, true);
    if (count === 0 || count > MAX_FRAMES) return HEADER_BYTES;
    return Math.min(total, HEADER_BYTES + (count + 1) * INDEX_ENTRY_BYTES + 2);
  };

  const tryParse = (): void => {
    if (index || done) return;
    const result = readIndex(headBytes(headWanted()));
    if (result === REJECTED) { done = true; return; }
    if (result) index = result;
  };

  const view: PreviewFrames = {
    get count() { return index ? index.frames.length : 0; },
    get ready() {
      if (!index) return 0;
      // Frames arrive in order, so the first one whose bytes are incomplete
      // marks the end of what is usable.
      let lo = 0;
      let hi = index.frames.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (index.frames[mid].end <= total) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    },
    frameAt(ms: number, durationMs: number): string | null {
      if (!index) return null;
      const i = frameIndexAt(index, ms, durationMs);
      if (i < 0) return null;
      const cached = urls.get(i);
      if (cached) return cached;
      const { start, end } = index.frames[i];
      if (end > total) return null;
      const bytes = new Uint8Array(end - start);
      copyInto(bytes, start);
      const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
      urls.set(i, url);
      return url;
    },
    dispose() {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    },
  };

  return {
    push(chunk: Uint8Array) {
      if (done && !index) return;
      chunkStart.push(total);
      chunks.push(chunk);
      total += chunk.length;
      tryParse();
    },
    frames() { return index ? view : null; },
    rejected() { return done && !index; },
    dispose() {
      view.dispose();
      chunks.length = 0;
      chunkStart.length = 0;
      head = null;
      index = null;
      total = 0;
    },
  };
}

/**
 * Read a complete BIF in one go.
 *
 * The streaming reader above is what the player uses; this is the same parse
 * against a whole file, which is what a test can hold in its hand.
 */
export function createPreviewFrames(buf: ArrayBuffer): PreviewFrames | null {
  const bytes = new Uint8Array(buf);
  const index = readIndex(bytes);
  if (!index || index === REJECTED) return null;
  // Only checkable with the whole file: an offset past the end of it.
  for (const frame of index.frames) {
    if (frame.end > bytes.length) return null;
  }

  const reader = createPreviewFrameReader();
  reader.push(bytes);
  return reader.frames();
}
