import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAGIC = Buffer.from([0x89, 0x42, 0x49, 0x46, 13, 10, 26, 10]);
const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_FRAME_BYTES = 10 * 1024 * 1024;

export interface PreviewTierProgress {
  tier: "coarse" | "medium" | "full";
  frames: number;
  bytes: number;
  ready: number;
}

/** v1 wire format: uint32 head length, BIF header/index + first JPEG marker,
 * then records of uint32 frame number, uint32 length, JPEG bytes (all LE).
 * Each image is sent exactly once: ~24 overview frames, ~96 medium frames,
 * then the rest. The last image is also in the overview.
 * Deferred images go to a temporary file, not a movie-sized heap allocation.
 */
export async function* progressivePreview(
  body: ReadableStream<Uint8Array>, signal?: AbortSignal,
  onTierComplete?: (progress: PreviewTierProgress) => void,
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

    directory = await mkdtemp(join(tmpdir(), "plex-previews-"));
    file = await open(join(directory, "frames"), "w+");
    const medium = Math.max(1, Math.ceil(count / 96));
    const coarse = medium * 4;
    const stage = (i: number) => i % coarse === 0 || i === count - 1 ? 0 : i % medium === 0 ? 1 : 2;
    for (let i = 0; i < count; i++) {
      const size = positions[i + 1] - positions[i];
      const bytes = i === 0 ? Buffer.concat([marker, await take(size - 2)]) : await take(size);
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Invalid preview JPEG");
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
    for (const level of [1, 2]) {
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
      completeTier(level === 1 ? "medium" : "full");
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    try { await file?.close(); }
    finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  }
}
