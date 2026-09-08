import assert from "node:assert/strict";
import { progressivePreview } from "../src/services/preview-stream.js";
import { createProgressivePreviewReader, previewStride } from "../../client/src/lib/previewFrames.js";
import { createPreviewMotion } from "../../client/src/lib/previewMotion.js";

function bif(count: number, multiplier = 1000) {
  const start = 64 + (count + 1) * 8;
  const bytes = Buffer.alloc(start + count * 6);
  bytes.set([0x89, 0x42, 0x49, 0x46, 13, 10, 26, 10]);
  bytes.writeUInt32LE(count, 12);
  bytes.writeUInt32LE(multiplier, 16);
  for (let i = 0; i <= count; i++) {
    bytes.writeUInt32LE(i === count ? 0xffffffff : i, 64 + i * 8);
    bytes.writeUInt32LE(start + i * 6, 68 + i * 8);
    if (i < count) { bytes.set([0xff, 0xd8], start + i * 6); bytes.writeUInt32LE(i, start + i * 6 + 2); }
  }
  return bytes;
}
function stream(bytes: Uint8Array, size = 17) {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at === bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.subarray(at, at + size));
      at = Math.min(at + size, bytes.length);
    },
  });
}
async function identity(url: string | null) {
  assert.ok(url);
  return new DataView(await (await fetch(url)).arrayBuffer()).getUint32(2, true);
}

for (const count of [1, 3, 96, 385, 10800]) {
  const reader = createProgressivePreviewReader();
  const order: number[] = [];
  let level = 0;
  const coarse = previewStride(count, "coarse");
  const medium = previewStride(count, "medium");
  let header = true;
  for await (const chunk of progressivePreview(stream(bif(count)))) {
    if (header) header = false;
    else {
      const i = chunk.readUInt32LE(0);
      const stage = i % coarse === 0 || i === count - 1 ? 0 : i % medium === 0 ? 1 : 2;
      assert.ok(stage >= level, "all overview records precede medium and full records");
      if (stage > level && count >= 385) {
        const frames = reader.frames()!;
        if (level === 0) {
          assert.equal(await identity(frames.frameAt(191_000, count * 1000)), Math.floor(191 / coarse) * coarse);
          assert.equal(await identity(frames.frameAt(count * 1000, count * 1000)), count - 1);
        }
        if (stage === 2) assert.equal(await identity(frames.frameAt(191_000, count * 1000)), Math.floor(191 / medium) * medium);
      }
      level = stage;
      order.push(i);
    }
    // Split both protocol fields and JPEG payloads across transport chunks.
    for (let at = 0; at < chunk.length; at += 7) reader.push(chunk.subarray(at, at + 7));
    assert.equal(reader.rejected(), false);
  }
  assert.equal(new Set(order).size, count, "each image transferred exactly once");
  assert.equal(order.length, count);
  const frames = reader.frames()!;
  assert.equal(frames.ready, count);
  const target = Math.min(191, count - 1);
  assert.equal(await identity(frames.frameAt(target * 1000, count * 1000)), target);
  const coarseTarget = target === count - 1 ? target : Math.floor(target / coarse) * coarse;
  assert.equal(await identity(frames.frameAt(target * 1000, count * 1000, "coarse")), coarseTarget);
  const url = frames.frameAt(0, count * 1000)!;
  reader.dispose();
  assert.equal(reader.frames(), null);
  await assert.rejects(fetch(url), "disposal revokes object URLs");
}

// Complete frame data remains usable if the transfer stops between records.
{
  const reader = createProgressivePreviewReader();
  const generator = progressivePreview(stream(bif(385)));
  reader.push((await generator.next()).value!);
  reader.push((await generator.next()).value!);
  await generator.return(undefined);
  assert.equal(reader.frames()?.ready, 1);
  assert.equal(await identity(reader.frames()!.frameAt(200_000, 385_000)), 0);
  reader.dispose();
}

for (const corrupt of [Buffer.alloc(80), bif(0), bif(5).subarray(0, 100)]) {
  await assert.rejects(async () => { for await (const _ of progressivePreview(stream(corrupt))) { /* drain */ } });
}
{
  const reader = createProgressivePreviewReader();
  reader.push(Buffer.from([255, 255, 255, 255]));
  assert.equal(reader.rejected(), true, "reject unbounded allocation requests");
  reader.dispose();
}
{
  const reader = createProgressivePreviewReader();
  const chunks: Buffer[] = [];
  for await (const chunk of progressivePreview(stream(bif(3)))) chunks.push(chunk);
  reader.push(chunks[0]);
  reader.push(chunks[1]);
  reader.push(chunks[1]);
  assert.equal(reader.rejected(), true, "reject duplicate frame records");
  reader.dispose();
}
{
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const abort = new AbortController();
  const generator = progressivePreview(body, abort.signal);
  const pending = generator.next();
  abort.abort();
  await assert.rejects(pending);
  assert.ok(cancelled, "disconnect cancels a stalled upstream read");
}

const motion = createPreviewMotion();
assert.equal(motion.sample(0, 0), "full");
assert.equal(motion.sample(0.02, 10), "coarse");
assert.equal(motion.sample(0, 20), "coarse", "reverse motion still counts as speed");
for (let i = 1; i <= 20; i++) motion.sample(i * 0.004, 20 + i * 20);
assert.equal(motion.sample(0.084, 440), "medium");
for (let i = 1; i <= 20; i++) motion.sample(0.084 + i * 0.0004, 440 + i * 20);
assert.equal(motion.sample(0.0924, 860), "full");
motion.reset();
assert.equal(motion.sample(0.9, 900), "full", "re-entry starts fresh");
console.log("Progressive preview transfer and adaptive motion tests passed");
