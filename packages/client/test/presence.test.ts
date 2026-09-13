import assert from "node:assert/strict";
import { mock } from "node:test";
import { buildPresence, createPresenceSender } from "../src/lib/presence";
import type { PresenceActivity, PresenceInput } from "../src/lib/presence";

const now = 1_800_000_000_000;
const input: PresenceInput = {
  ratingKey: "1", title: "A Film (2026)", playing: true, position: 60,
  durationMs: 600_000, timelineVersion: 1, participantCount: 3,
  connected: true, shareDetails: true,
  artworkUrl: "https://theater.example/api/presence/artwork/opaque",
};
const first = buildPresence(input, now);
assert.deepEqual(first.activity.timestamps, { start: now - 60_000, end: now + 540_000 });
const heartbeat = buildPresence({ ...input, position: 65.3 }, now + 5_000, first);
assert.deepEqual(heartbeat.activity.timestamps, first.activity.timestamps, "heartbeat jitter does not shift the bar");
const seek = buildPresence({ ...input, position: 65.8, timelineVersion: 2 }, now + 5_000, heartbeat);
assert.equal(seek.activity.timestamps!.start, now - 60_800, "an explicit sub-second seek is not mistaken for jitter");
const replacement = buildPresence({ ...input, ratingKey: "2", position: 60.5 }, now, first);
assert.equal(replacement.activity.timestamps!.start, now - 60_500, "same-title media changes reset the anchor");
const paused = buildPresence({ ...input, playing: false }, now + 5_000, first);
assert.equal(paused.activity.timestamps, null, "pausing clears the running bar");
const resumed = buildPresence(input, now + 10_000, paused);
assert.equal(resumed.activity.timestamps!.start, now - 50_000, "resuming excludes paused wall time");
for (const change of [{ shareDetails: false }, { connected: false }, { ratingKey: null }]) {
  const activity = buildPresence({ ...input, ...change }, now, first).activity;
  assert.equal(activity.assets, null);
  assert.equal(activity.timestamps, null);
  assert.ok(!JSON.stringify(activity).includes(input.title!));
  assert.ok(!JSON.stringify(activity).includes(input.artworkUrl!));
}
assert.equal(buildPresence({ ...input, durationMs: null }, now).activity.timestamps, null);
const long = buildPresence({ ...input, title: "a".repeat(126) + "👨‍👩‍👧‍👦" }, now).activity.details;
assert.ok(long.length <= 128 && !long.includes("\u200d"), "truncation preserves grapheme boundaries");

// Flush promise continuations without advancing the mocked retry clock.
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
mock.timers.enable({ apis: ["Date", "setTimeout"], now });
try {
  const sent: PresenceActivity[] = [];
  let release!: () => void;
  const sender = createPresenceSender(async ({ activity }) => {
    sent.push(activity);
    if (sent.length === 1) await new Promise<void>((resolve) => { release = resolve; });
  });
  sender.update(input);
  sender.update({ ...input, title: "Skipped intermediate title" });
  sender.update({ ...input, shareDetails: false });
  assert.equal(sent.length, 1, "only one RPC may be in flight");
  release();
  await settled();
  assert.equal(sent.length, 2);
  assert.ok(!JSON.stringify(sent[1]).includes(input.title!));
  assert.equal(sent[1].assets, null, "latest privacy choice wins over queued metadata");
  sender.update({ ...input, shareDetails: false });
  await settled();
  assert.equal(sent.length, 2, "successful identical updates are deduplicated");
  sender.dispose();

  let attempts = 0;
  const failures: string[] = [];
  const failing = createPresenceSender(async () => { attempts++; throw { code: 1000 }; }, ({ kind }) => failures.push(kind));
  failing.update(input);
  await settled();
  mock.timers.tick(1_000);
  await settled();
  mock.timers.tick(4_000);
  await settled();
  assert.equal(attempts, 3, "initial failure gets exactly two retries");
  assert.deepEqual(failures, ["exhausted"]);
  failing.update({ ...input, position: 65 });
  mock.timers.tick(60_000);
  await settled();
  assert.equal(attempts, 3, "an identical heartbeat cannot restart exhausted retries");
  failing.update({ ...input, playing: false });
  await settled();
  assert.equal(attempts, 4, "a different desired presence can recover later");
  failing.dispose();
  mock.timers.tick(10_000);
  await settled();
  assert.equal(attempts, 4, "teardown cancels pending retries");

  let permissionAttempts = 0;
  const forbidden = createPresenceSender(async () => { permissionAttempts++; throw { code: 4006 }; });
  forbidden.update(input);
  await settled();
  forbidden.update({ ...input, playing: false });
  mock.timers.tick(60_000);
  await settled();
  assert.equal(permissionAttempts, 1, "permission rejection disables presence for this sender");
  forbidden.dispose();
} finally {
  mock.timers.reset();
}
console.log("Presence: timeline anchors, pause/resume, privacy clearing, latest-wins delivery, bounded retries and disposal passed");
