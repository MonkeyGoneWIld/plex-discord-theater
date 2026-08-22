/**
 * Reading a BIF preview index.
 *
 * This one is worth pinning down because the failure modes are quiet: a
 * misread header does not throw, it just points every hover at the wrong
 * frame, and there is no way to notice that from a screenshot. The cases below
 * are the ones where the format leaves room to be read two ways, plus the
 * malformed files that have to come back null so the player falls back to
 * asking Plex for frames one at a time.
 */
import { createPreviewFrames, createPreviewFrameReader } from "../src/lib/previewFrames";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

const MAGIC = [0x89, 0x42, 0x49, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];

interface BifOptions {
  count: number;
  /** Written to the multiplier field at offset 16. */
  multiplier: number;
  /** Index timestamps. Defaults to frame numbers, 0..count-1. */
  timestamps?: number[];
  /** Bytes per image, so a frame's identity is checkable from its content. */
  imageBytes?: number;
  /** Drop the JPEG start-of-image marker the parser checks for. */
  notJpeg?: boolean;
  magic?: number[];
  /** Overrides the count written into the header, leaving the index as built. */
  declaredCount?: number;
}

/**
 * Build a BIF whose image `i` is a JPEG start-of-image marker followed by a run
 * of the byte `i + 1`, so a frame can be identified by reading one byte back
 * out of the blob.
 */
function makeBif(opts: BifOptions): ArrayBuffer {
  const { count, multiplier, imageBytes = 4 } = opts;
  const timestamps = opts.timestamps ?? Array.from({ length: count }, (_, i) => i);
  const indexBytes = (count + 1) * 8;
  const buf = new ArrayBuffer(64 + indexBytes + count * imageBytes);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);

  const magic = opts.magic ?? MAGIC;
  for (let i = 0; i < magic.length; i++) bytes[i] = magic[i];
  view.setUint32(8, 0, true);
  view.setUint32(12, opts.declaredCount ?? count, true);
  view.setUint32(16, multiplier, true);

  for (let i = 0; i < count; i++) {
    const start = 64 + indexBytes + i * imageBytes;
    view.setUint32(64 + i * 8, timestamps[i], true);
    view.setUint32(64 + i * 8 + 4, start, true);
    bytes.fill(i + 1, start, start + imageBytes);
    if (!opts.notJpeg) { bytes[start] = 0xff; bytes[start + 1] = 0xd8; }
  }
  // The terminator: its offset marks the end of the last image.
  view.setUint32(64 + count * 8, 0xffffffff, true);
  view.setUint32(64 + count * 8 + 4, buf.byteLength, true);
  return buf;
}

/** The image byte behind a blob URL, i.e. which frame was handed back. */
async function frameNumberAt(
  frames: { frameAt(ms: number, durationMs: number): string | null },
  ms: number,
  durationMs: number,
): Promise<number | null> {
  const url = frames.frameAt(ms, durationMs);
  if (!url) return null;
  const body = new Uint8Array(await (await fetch(url)).arrayBuffer());
  // Past the two-byte JPEG marker makeBif writes ahead of the identity run.
  return body[2];
}

const TEN_MIN = 600_000;

console.log("\n— a Plex SD index, frame numbers scaled by the multiplier —");
{
  // 60 frames at 10s covers ten minutes, which is how Plex writes them.
  const frames = createPreviewFrames(makeBif({ count: 60, multiplier: 10_000 }));
  check("parses", frames?.count, 60);

  if (frames) {
    check("start of the file is frame 1", await frameNumberAt(frames, 0, TEN_MIN), 1);
    // 35s is inside the fourth bucket (30s–40s), so the frame at or before it
    // is the fourth. Landing on the fifth would mean showing the viewer a shot
    // from after the point they are pointing at.
    check("mid-bucket rounds down, never up", await frameNumberAt(frames, 35_000, TEN_MIN), 4);
    check("exactly on a boundary takes that frame", await frameNumberAt(frames, 30_000, TEN_MIN), 4);
    check("last frame", await frameNumberAt(frames, 599_000, TEN_MIN), 60);
    check("past the end clamps rather than returning nothing",
      await frameNumberAt(frames, 999_999_999, TEN_MIN), 60);
    check("negative clamps to the first frame", await frameNumberAt(frames, -5000, TEN_MIN), 1);
    frames.dispose();
  }
}

console.log("\n— the same frame twice is the same URL —");
{
  const frames = createPreviewFrames(makeBif({ count: 10, multiplier: 10_000 }));
  if (frames) {
    // Two hovers a second apart are inside one bucket. Minting a second blob
    // for the same frame would make the <img> reload it and flicker.
    const a = frames.frameAt(21_000, 100_000);
    const b = frames.frameAt(22_500, 100_000);
    check("one blob per frame, reused", a === b, true);
    check("a different frame is a different URL", a === frames.frameAt(31_000, 100_000), false);
    frames.dispose();
  }
}

console.log("\n— a header that leaves the multiplier at zero —");
{
  // The format's documented default is 1000ms. 60 frames one second apart.
  const frames = createPreviewFrames(makeBif({ count: 60, multiplier: 0 }));
  check("parses", frames?.count, 60);
  if (frames) {
    check("timestamps scale by the 1000ms default",
      await frameNumberAt(frames, 4500, 60_000), 5);
    frames.dispose();
  }
}

console.log("\n— an index whose implied interval is nonsense —");
{
  // Frame numbers scaled by a multiplier that is itself already milliseconds:
  // the reading gives ~10,000s between frames. Rather than point every hover
  // at frame one, the timestamps are dropped and the frames are spread across
  // the runtime — which is exact, because they are evenly spaced by
  // construction.
  const frames = createPreviewFrames(
    makeBif({ count: 60, multiplier: 10_000, timestamps: Array.from({ length: 60 }, (_, i) => i * 1000) }),
  );
  check("still parses", frames?.count, 60);
  if (frames) {
    check("falls back to spreading frames across the runtime",
      await frameNumberAt(frames, 35_000, TEN_MIN), 4);
    check("and still clamps at the end", await frameNumberAt(frames, TEN_MIN, TEN_MIN), 60);
    check("with no runtime to spread across, no frame",
      frames.frameAt(35_000, 0), null);
    frames.dispose();
  }
}

console.log("\n— files that are not usable indexes —");
{
  check("not a BIF at all", createPreviewFrames(makeBif({ count: 4, multiplier: 10_000, magic: [0, 1, 2, 3, 4, 5, 6, 7] })), null);
  check("too short to hold a header", createPreviewFrames(new ArrayBuffer(32)), null);
  check("no frames", createPreviewFrames(makeBif({ count: 0, multiplier: 10_000 })), null);

  // A count larger than the index actually holds would walk the loop off the
  // end of the buffer and hand back slices of nothing.
  const truncated = makeBif({ count: 8, multiplier: 10_000, declaredCount: 400 });
  check("a count the file cannot back", createPreviewFrames(truncated), null);

  // An offset pointing inside the index itself is not an image.
  const overlapping = makeBif({ count: 4, multiplier: 10_000 });
  new DataView(overlapping).setUint32(64 + 4, 8, true);
  check("an image offset inside the header", createPreviewFrames(overlapping), null);

  // Offsets have to advance; equal ones describe a zero-length image.
  const stalled = makeBif({ count: 4, multiplier: 10_000 });
  const stalledView = new DataView(stalled);
  stalledView.setUint32(64 + 8 + 4, stalledView.getUint32(64 + 4, true), true);
  check("offsets that do not advance", createPreviewFrames(stalled), null);

  // A terminator past the end of the file would slice out past the buffer.
  const overrun = makeBif({ count: 4, multiplier: 10_000 });
  new DataView(overrun).setUint32(64 + 4 * 8 + 4, overrun.byteLength + 4096, true);
  check("a terminator past the end of the file", createPreviewFrames(overrun), null);

  // Every offset in range, every offset advancing, and still not pointing at
  // an image — which is what a header read the wrong way round looks like.
  check("offsets that land somewhere other than a JPEG",
    createPreviewFrames(makeBif({ count: 4, multiplier: 10_000, notJpeg: true })), null);
}

console.log("\n— one frame —");
{
  // A file short enough that Plex generated a single preview. The interval
  // check has nothing to measure across, and must not reject it.
  const frames = createPreviewFrames(makeBif({ count: 1, multiplier: 10_000 }));
  check("parses", frames?.count, 1);
  if (frames) {
    check("every position is that frame", await frameNumberAt(frames, 8000, 10_000), 1);
    frames.dispose();
  }
}

console.log("\n— arriving a piece at a time —");
{
  // The point of the streaming reader: a long video's frames are tens of
  // megabytes, and the index that says where they all are is in the first few
  // kilobytes. Waiting for the whole file before showing anything is what made
  // a six hour video look like it had no previews at all.
  const buf = makeBif({ count: 40, multiplier: 10_000, imageBytes: 32 });
  const bytes = new Uint8Array(buf);
  // Header + index + the first image's marker: 64 + 41*8 + 2.
  const indexEnd = 64 + 41 * 8;

  const reader = createPreviewFrameReader();
  reader.push(bytes.subarray(0, 40));
  check("nothing to read from a header that is not all there yet", reader.frames(), null);
  check("and it is not rejected either", reader.rejected(), false);

  reader.push(bytes.subarray(40, indexEnd));
  check("still nothing without the first image's marker", reader.frames(), null);

  // The index plus the first image.
  reader.push(bytes.subarray(indexEnd, indexEnd + 32));
  const frames = reader.frames();
  check("the index reads once the first image is in", frames?.count, 40);
  check("one frame usable out of forty", frames?.ready, 1);

  if (frames) {
    check("the frame that has arrived", await frameNumberAt(frames, 0, 400_000), 1);
    // 25s is the third bucket, whose bytes are still on the wire. Null rather
    // than a wrong frame — the player asks Plex for that one and keeps going.
    check("a frame still on the wire is not guessed at",
      frames.frameAt(25_000, 400_000), null);

    // Halfway, in pieces small enough to split an image across two chunks.
    for (let at = indexEnd + 32; at < indexEnd + 32 * 20; at += 7) {
      reader.push(bytes.subarray(at, Math.min(at + 7, indexEnd + 32 * 20)));
    }
    check("twenty usable after twenty images", frames.ready, 20);
    check("a frame split across chunks still reads",
      await frameNumberAt(frames, 105_000, 400_000), 11);
    check("and the one after the boundary is still withheld",
      frames.frameAt(255_000, 400_000), null);

    reader.push(bytes.subarray(indexEnd + 32 * 20));
    check("all of them once the file is complete", frames.ready, 40);
    check("the last frame", await frameNumberAt(frames, 399_000, 400_000), 40);
  }
  reader.dispose();
}

{
  // A part with no BIF, or a proxy handing back an error page. The reader has
  // to say so rather than sit waiting for an index that is never coming.
  const reader = createPreviewFrameReader();
  reader.push(new TextEncoder().encode("<!doctype html><title>404 Not Found</title>"));
  check("something that is not a BIF is rejected on sight", reader.rejected(), true);
  check("and offers no frames", reader.frames(), null);
  reader.dispose();
}

{
  // One byte at a time, which is the pathological version of a slow connection.
  const bytes = new Uint8Array(makeBif({ count: 3, multiplier: 10_000 }));
  const reader = createPreviewFrameReader();
  for (const b of bytes) reader.push(new Uint8Array([b]));
  check("a file delivered one byte at a time still reads", reader.frames()?.count, 3);
  check("and all of it is usable", reader.frames()?.ready, 3);
  reader.dispose();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
