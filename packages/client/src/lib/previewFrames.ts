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
 * Fetching the file instead costs one request for the whole set, at roughly the
 * bandwidth of two hundred of those frames, and every hover afterwards is a
 * slice of memory.
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
 * Refuse a file claiming more frames than any real one has.
 *
 * At the 2s interval, a twelve-hour file. Purely a guard against a corrupt
 * count sending the index loop somewhere absurd; the byte-range checks below
 * would reject it anyway, just more slowly.
 */
const MAX_FRAMES = 25_000;

interface Frame {
  /** Milliseconds into the file, or null when the header wasn't usable. */
  at: number | null;
  start: number;
  end: number;
}

export interface PreviewFrames {
  readonly count: number;
  /**
   * A blob URL for the frame at or before `ms`. Frames are materialised on
   * first use and kept, so scrubbing back over ground already covered costs
   * nothing.
   *
   * `durationMs` is only consulted for a file whose header timestamps didn't
   * survive the sanity check above.
   */
  frameAt(ms: number, durationMs: number): string | null;
  /** Release every blob URL handed out. Call when the item changes. */
  dispose(): void;
}

/**
 * Read a BIF into a frame index, or null if it isn't one.
 *
 * Null is not an error worth surfacing: the caller keeps the per-frame request
 * path as a fallback, so an unreadable index costs the old behaviour rather
 * than the feature.
 */
export function createPreviewFrames(buf: ArrayBuffer): PreviewFrames | null {
  if (buf.byteLength < HEADER_BYTES + INDEX_ENTRY_BYTES * 2) return null;

  const bytes = new Uint8Array(buf);
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) return null;
  }

  const view = new DataView(buf);
  const count = view.getUint32(12, true);
  if (count === 0 || count > MAX_FRAMES) return null;

  const multiplier = view.getUint32(16, true) || DEFAULT_TIMESTAMP_MS;
  // The terminator entry is part of the index, hence count + 1.
  const indexEnd = HEADER_BYTES + (count + 1) * INDEX_ENTRY_BYTES;
  if (buf.byteLength < indexEnd) return null;

  const frames: Frame[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const entry = HEADER_BYTES + i * INDEX_ENTRY_BYTES;
    const start = view.getUint32(entry + 4, true);
    const end = view.getUint32(entry + INDEX_ENTRY_BYTES + 4, true);
    // Every image has to live after the index and inside the file, and the
    // offsets have to advance. A file failing this isn't one we can slice.
    if (start < indexEnd || end <= start || end > buf.byteLength) return null;
    frames[i] = { at: view.getUint32(entry, true) * multiplier, start, end };
  }

  // The offsets can all be in range and still be wrong — a header read the
  // wrong way round lands inside the images rather than outside them. Every
  // image in a BIF is a JPEG, so its first two bytes are the one cheap way to
  // tell a correct index from a plausible one. First and last: a partial
  // misread that happens to leave the opening image intact would still put the
  // end of the file somewhere else.
  for (const i of [0, count - 1]) {
    if (bytes[frames[i].start] !== 0xff || bytes[frames[i].start + 1] !== 0xd8) return null;
  }

  // Even spacing is what makes the fallback exact rather than approximate, so
  // the check is on the interval the header implies across the whole file.
  const span = (frames[count - 1].at ?? 0) - (frames[0].at ?? 0);
  const interval = count > 1 ? span / (count - 1) : DEFAULT_TIMESTAMP_MS;
  if (!(interval >= MIN_INTERVAL_MS && interval <= MAX_INTERVAL_MS)) {
    for (const frame of frames) frame.at = null;
  }

  const timed = frames[0].at != null;
  const urls = new Map<number, string>();

  const urlFor = (i: number): string => {
    const cached = urls.get(i);
    if (cached) return cached;
    const blob = new Blob([buf.slice(frames[i].start, frames[i].end)], { type: "image/jpeg" });
    const url = URL.createObjectURL(blob);
    urls.set(i, url);
    return url;
  };

  return {
    count,
    frameAt(ms: number, durationMs: number): string | null {
      if (!(ms >= 0)) ms = 0;
      let i: number;
      if (timed) {
        // The frame at or before the cursor — the last one whose timestamp
        // hasn't passed it.
        let lo = 0;
        let hi = count - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if ((frames[mid].at as number) <= ms) lo = mid;
          else hi = mid - 1;
        }
        i = lo;
      } else {
        if (!(durationMs > 0)) return null;
        i = Math.floor((ms / durationMs) * count);
      }
      if (i < 0) i = 0;
      if (i > count - 1) i = count - 1;
      return urlFor(i);
    },
    dispose() {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    },
  };
}
