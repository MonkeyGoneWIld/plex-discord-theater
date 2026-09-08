import assert from "node:assert/strict";
import { progressivePreview, previewTierIndices as serverTierIndices, type PreviewTierProgress } from "../src/services/preview-stream.js";
import { createProgressivePreviewReader, previewTierIndices } from "../../client/src/lib/previewFrames.js";
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

const atOrBefore = (target: number, grid: number[]) => grid.filter((i) => i <= target).at(-1)!;
for (const count of [1, 2, 3, 7, 49, 50, 51, 96, 385, 3214, 10800]) {
  const sent: PreviewTierProgress[] = [];
  const received: PreviewTierProgress[] = [];
  const reader = createProgressivePreviewReader((progress) => received.push(progress));
  const order: number[] = [];
  let level = 0;
  const { coarse, medium } = previewTierIndices(count);
  assert.deepEqual(serverTierIndices(count), { coarse, medium });
  assert.equal(coarse.length, Math.ceil(count * 0.04));
  assert.equal(medium.length, Math.ceil(count * 0.40));
  assert.equal(new Set(medium).size, medium.length);
  assert.ok(coarse.every((i) => medium.includes(i)), "overview is a subset of medium");
  let header = true;
  for await (const chunk of progressivePreview(stream(bif(count)), undefined, (progress) => sent.push(progress))) {
    if (header) header = false;
    else {
      const i = chunk.readUInt32LE(0);
      const stage = coarse.includes(i) ? 0 : medium.includes(i) ? 1 : 2;
      assert.ok(stage >= level, "all overview records precede medium and full records");
      if (stage > level && count >= 385) {
        const frames = reader.frames()!;
        if (level === 0) {
          assert.equal(await identity(frames.frameAt(191_000, count * 1000)), atOrBefore(191, coarse));
          assert.equal(await identity(frames.frameAt(count * 1000, count * 1000)), count - 1);
        }
        if (stage === 2) assert.equal(await identity(frames.frameAt(191_000, count * 1000)), atOrBefore(191, medium));
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
  assert.deepEqual(received, sent, "client confirms the same three tiers that the server sent");
  assert.deepEqual(received.map((p) => p.tier), ["coarse", "medium", "full"]);
  if (count === 3214) {
    assert.deepEqual(received.map((p) => p.frames), [129, 1157, 1928]);
    assert.deepEqual(received.map((p) => p.ready), [129, 1286, 3214]);
  }
  const frames = reader.frames()!;
  assert.equal(frames.ready, count);
  if (count === 3214) {
    assert.equal(await identity(frames.frameAt(191_000, count * 1000, "medium")), atOrBefore(191, medium));
    assert.equal(await identity(frames.frameAt(191_000, count * 1000, "full")), 191);
    assert.equal(await identity(frames.frameAt(192_000, count * 1000, "full")), 192, "focused hover can select adjacent original frames");
  }
  const target = Math.min(191, count - 1);
  assert.equal(await identity(frames.frameAt(target * 1000, count * 1000)), target);
  const coarseTarget = atOrBefore(target, coarse);
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

// A proxy may combine an entire response into one read. Tier callbacks still
// fire at the actual protocol boundaries, not once per network chunk.
{
  const sent: PreviewTierProgress[] = [];
  const received: PreviewTierProgress[] = [];
  const chunks: Buffer[] = [];
  for await (const chunk of progressivePreview(stream(bif(3214)), undefined, (p) => sent.push(p))) chunks.push(chunk);
  const reader = createProgressivePreviewReader((p) => received.push(p));
  reader.push(Buffer.concat(chunks));
  assert.equal(reader.rejected(), false);
  assert.deepEqual(received, sent);
  reader.dispose();
  const outOfOrder = createProgressivePreviewReader();
  outOfOrder.push(chunks[0]);
  outOfOrder.push(chunks[66]); // first medium frame, before any overview
  assert.equal(outOfOrder.rejected(), true, "reject a medium tier sent before the overview");
  outOfOrder.dispose();
}

// A v1 client/server pair keeps its original ordering during rolling upgrades.
{
  const received: PreviewTierProgress[] = [];
  const reader = createProgressivePreviewReader((p) => received.push(p), 1);
  for await (const chunk of progressivePreview(stream(bif(3214)), undefined, undefined, 1)) reader.push(chunk);
  assert.equal(reader.rejected(), false);
  assert.deepEqual(received.map((p) => p.ready), [25, 96, 3214]);
  assert.equal(await identity(reader.frames()!.frameAt(191_000, 3214_000)), 191);
  reader.dispose();
}

const motion = createPreviewMotion();
assert.equal(motion.sample(0, 0, 1000), "medium");
assert.equal(motion.sample(0.02, 10, 1000), "coarse");
assert.equal(motion.sample(0, 20, 1000), "coarse", "reverse motion still counts as speed");

// Searching across the bar stays medium; a brief slowdown must not unlock full.
for (const velocity of [0.1, 0.06, 0.04]) {
  motion.reset();
  motion.sample(0, 0, 1000);
  for (let i = 1; i <= 100; i++) assert.equal(motion.sample(velocity * i * 0.02, i * 20, 1000), "medium");
}

// Slow movement is practical on both small and large timelines and does not
// become impossible just because a video has thousands of original frames.
for (const width of [400, 1000, 2400]) {
  motion.reset();
  motion.sample(0, 0, width);
  let result;
  for (let i = 1; i <= 60; i++) {
    result = motion.sample(i * 0.2 / width, i * 20, width); // 10 px/s
    if (i <= 20) assert.equal(result, "medium");
  }
  assert.equal(result, "full", "sustained slow inspection becomes full");
}

// Quantized one-pixel movement has fast individual samples, but slow average
// travel. It must not reset the precision dwell indefinitely.
motion.reset();
motion.sample(0, 0, 1000);
let precise;
for (let t = 16; t <= 1200; t += 16) precise = motion.sample(Math.floor(t / 100) / 1000, t, 1000);
assert.equal(precise, "full");

// Local searching/jitter must preserve the deadline rather than debounce it
// forever. This exercises the same delay calculation used by the UI timer.
motion.reset();
motion.sample(0.5, 0, 1000);
for (let t = 16; t < 650; t += 16) {
  motion.sample(0.5 + (t % 32 === 0 ? 0.001 : -0.001), t, 1000);
  assert.equal(motion.settleDelay(t), 650 - t);
}
assert.equal(motion.settle(649), "medium");
assert.equal(motion.settleDelay(649), 1, "an early timer must reschedule the final millisecond");
assert.equal(motion.settle(650), "full");
assert.equal(motion.sample(0.501, 670, 1000), "full", "focused movement retains full detail");
assert.equal(motion.sample(0.7, 680, 1000), "coarse", "leaving the area quickly restores overview");
motion.reset();
motion.sample(0.5, 0, 1000);
assert.equal(motion.settle(650), "full", "a completely stationary hover always refines");
motion.reset();
assert.equal(motion.sample(0.9, 1000, 1000), "medium", "re-entry starts fresh");
console.log("Progressive preview transfer and adaptive motion tests passed");
