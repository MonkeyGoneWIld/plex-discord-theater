import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAGIC = Buffer.from([0x89, 0x42, 0x49, 0x46, 13, 10, 26, 10]);
const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_FRAME_BYTES = 10 * 1024 * 1024;

/** The preview tiers, coarsest first — the order they are sent in. */
const PREVIEW_DETAILS = ["coarse", "medium", "fine", "full"] as const;

/** Nested, evenly distributed cumulative tiers. v1 is retained for cached clients. */
export function previewTierIndices(count: number, version: 1 | 2 = 2) {
  if (version === 1) {
    const stride = Math.max(1, Math.ceil(count / 96));
    const grid = (step: number) => {
      const result = Array.from({ length: Math.ceil(count / step) }, (_, i) => i * step);
      if (result[result.length - 1] !== count - 1) result.push(count - 1);
      return result;
    };
    // v1 had no fine tier; giving it medium's grid leaves that pass empty.
    const medium = grid(stride);
    return { coarse: grid(stride * 4), medium, fine: medium };
  }
  // n evenly spread picks out of `length` candidates, so each tier is drawn
  // from the next finer one and contains every tier before it.
  const spread = (n: number, length: number, pick: (i: number) => number) =>
    Array.from({ length: n }, (_, i) => pick(n === 1 ? 0 : Math.floor(i * (length - 1) / (n - 1))));
  const fine = spread(Math.max(1, Math.ceil(count * 0.40)), count, (i) => i);
  const medium = spread(Math.max(1, Math.ceil(count * 0.15)), fine.length, (i) => fine[i]);
  const coarse = spread(Math.max(1, Math.ceil(count * 0.05)), medium.length, (i) => medium[i]);
  return { coarse, medium, fine };
}

export interface PreviewTierProgress {
  tier: typeof PREVIEW_DETAILS[number];
  frames: number;
  bytes: number;
  ready: number;
}

/** v1 wire format: uint32 head length, BIF header/index + first JPEG marker,
 * then records of uint32 frame number, uint32 length, JPEG bytes (all LE).
 * Each image is sent exactly once, a tier at a time: 5% coarse, then the rest
 * of 15% medium, of 40% fine, and of full. v1 requests retain the original
 * fixed-size grids, with an empty fine pass.
 * Deferred images go to a temporary file, not a movie-sized heap allocation.
 *
 * With `pass` (0 coarse to 3 full), the head is followed by that pass's records
 * alone, so a client can ask for each pass when it is ready for it.
 */
export async function* progressivePreview(
  body: ReadableStream<Uint8Array>, signal?: AbortSignal,
  onTierComplete?: (progress: PreviewTierProgress) => void,
  version: 1 | 2 = 2,
  pass?: number,
) {
  const reader = body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  let chunk: Uint8Array = new Uint8Array(0);
  let offset = 0;
  let consumed = 0;
  let tierFrames = 0;
  let tierBytes = 0;
  let ready = 0;
  let directory: string | undefined;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  const take = async (length: number): Promise<Buffer> => {
    signal?.throwIfAborted();
    if (consumed + length > MAX_BYTES) throw new Error("Preview exceeds size limit");
    const out = Buffer.alloc(length);
    let written = 0;
    while (written < length) {
      if (offset === chunk.length) {
        // A stalled Plex response must not retain a spool file indefinitely.
        const timeout = setTimeout(cancel, 30_000);
        let next: ReadableStreamReadResult<Uint8Array>;
        try { next = await reader.read(); }
        finally { clearTimeout(timeout); }
        if (next.done) throw new Error("Truncated preview index");
        chunk = next.value;
        offset = 0;
      }
      const n = Math.min(length - written, chunk.length - offset);
      out.set(chunk.subarray(offset, offset + n), written);
      offset += n;
      written += n;
    }
    consumed += length;
    return out;
  };
  const record = (i: number, bytes: Buffer) => {
    const header = Buffer.alloc(8);
    header.writeUInt32LE(i, 0);
    header.writeUInt32LE(bytes.length, 4);
    tierFrames++;
    ready++;
    tierBytes += header.length + bytes.length;
    return Buffer.concat([header, bytes]);
  };
  const completeTier = (tier: PreviewTierProgress["tier"]) => {
    onTierComplete?.({ tier, frames: tierFrames, bytes: tierBytes, ready });
    tierFrames = 0;
    tierBytes = 0;
  };
  try {
    const header = await take(64);
    const count = header.readUInt32LE(12);
    if (!header.subarray(0, 8).equals(MAGIC) || header.readUInt32LE(8) !== 0 || count < 1 || count > 500_000) {
      throw new Error("Invalid preview header");
    }
    const table = await take((count + 1) * 8);
    const indexEnd = 64 + table.length;
    const positions = Array.from({ length: count + 1 }, (_, i) => table.readUInt32LE(i * 8 + 4));
    if (positions[0] !== indexEnd || positions[count] > MAX_BYTES) throw new Error("Invalid preview offsets");
    for (let i = 0; i < count; i++) {
      const size = positions[i + 1] - positions[i];
      if (size < 2 || size > MAX_FRAME_BYTES) throw new Error("Invalid preview frame size");
    }
    const marker = await take(2);
    if (marker[0] !== 0xff || marker[1] !== 0xd8) throw new Error("Invalid preview JPEG");
    const length = Buffer.alloc(4);
    length.writeUInt32LE(indexEnd + 2);
    yield Buffer.concat([length, header, table, marker]);

    // Which pass each frame goes out in: its coarsest tier, finest first so
    // the coarser tiers that contain it overwrite.
    const tiers = previewTierIndices(count, version);
    const stages = new Uint8Array(count).fill(3);
    for (const i of tiers.fine) stages[i] = 2;
    for (const i of tiers.medium) stages[i] = 1;
    for (const i of tiers.coarse) stages[i] = 0;
    const stage = (i: number) => stages[i];
    // The next image in the file; the first one's marker was read with the index.
    const image = async (i: number) => {
      const size = positions[i + 1] - positions[i];
      const bytes = i === 0 ? Buffer.concat([marker, await take(size - 2)]) : await take(size);
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Invalid preview JPEG");
      return bytes;
    };

    if (pass !== undefined) {
      // One pass on its own: its images as they come up, nothing to hold back,
      // and no reading past the last of them.
      const last = stages.lastIndexOf(pass);
      for (let i = 0; i <= last; i++) {
        const bytes = await image(i);
        if (stage(i) === pass) yield record(i, bytes);
      }
      completeTier(PREVIEW_DETAILS[pass]);
      return;
    }

    directory = await mkdtemp(join(tmpdir(), "plex-previews-"));
    file = await open(join(directory, "frames"), "w+");
    for (let i = 0; i < count; i++) {
      const size = positions[i + 1] - positions[i];
      const bytes = await image(i);
      if (stage(i) === 0) yield record(i, bytes);
      else {
        let written = 0;
        while (written < size) {
          const result = await file.write(bytes, written, size - written, positions[i] + written);
          if (!result.bytesWritten) throw new Error("Preview spool write failed");
          written += result.bytesWritten;
        }
      }
    }
    completeTier("coarse");
    // Stop the upstream even if Plex appended bytes past the BIF terminator.
    await reader.cancel();
    for (const level of [1, 2, 3]) {
      for (let i = 0; i < count; i++) {
        signal?.throwIfAborted();
        if (stage(i) !== level) continue;
        const bytes = Buffer.alloc(positions[i + 1] - positions[i]);
        let read = 0;
        while (read < bytes.length) {
          const result = await file.read(bytes, read, bytes.length - read, positions[i] + read);
          if (!result.bytesRead) throw new Error("Truncated preview spool");
          read += result.bytesRead;
        }
        yield record(i, bytes);
      }
      completeTier(PREVIEW_DETAILS[level]);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    try { await file?.close(); }
    finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  }
}
