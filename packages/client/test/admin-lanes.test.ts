/**
 * The session timeline's lanes, worked out apart from the drawing
 * (admin/lanes.ts), the media processing steps' names and details
 * (admin/processing.ts), and transcode reasons in the dashboard's terms
 * (admin/parts.tsx reasonText).
 *
 * 18 November: the Activity and History pages put playback, each viewer's
 * status, and the data delivered by source on one timeline. A viewer's
 * buffering, loading and time away overlapped one another; a session with
 * two samples drew a spike at its end; the axis of a seven-day chart had
 * ticks every hour; and the reasons a stream was transcoded read in casual
 * terms ("frames dropped on this player").
 */
import {
  deliveryOf, fits, healthSummary, labelWidth, niceTicks, offsetText, placeLabels, playbackOf, roleSummary, sampleAt, seriesOf, timeTicks,
  viewerStatusOf, without,
} from "../admin/lanes";
import { duration, processingName, stepDetail } from "../admin/processing";
import { reasonText } from "../admin/parts";
import type { HealthPoint, PlayEvent } from "../admin/types";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; return; }
  fail++;
  console.log(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
}

let id = 0;
const ev = (at: number, kind: string, userId: string | null = "u1", detail: Record<string, unknown> | null = null, posS: number | null = null): PlayEvent =>
  ({ id: ++id, at, kind, userId, username: userId ? `name-${userId}` : null, posS, detail });
/** A sample: [time, drift, ahead, buffer, server bytes, cache bytes, peer bytes, up, shown, dropped, heap, peers, rate]. */
const hp = (at: number, server: number, cache = 0, peers = 0, drift = 0, buf = 30): HealthPoint =>
  [at, drift, 60, buf, server, cache, peers, 0, 0, 0, 100, 0, 1] as unknown as HealthPoint;

const S = 1_000;
const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);

// without: a span cut out of the middle, the start and nothing.
check("without: a cut in the middle leaves both sides",
  without([{ from: 0, to: 10 }], [{ from: 3, to: 5 }]), [{ from: 0, to: 3 }, { from: 5, to: 10 }]);
check("without: a cut over the start, and one outside",
  without([{ from: 0, to: 10 }], [{ from: -5, to: 2 }, { from: 20, to: 30 }]), [{ from: 2, to: 10 }]);
check("without: a cut that covers it all leaves nothing", without([{ from: 0, to: 10 }], [{ from: 0, to: 10 }]), []);

// playbackOf: play, pause, resume, stop, with the room waiting for the host's video inside the playing part.
{
  const events = [ev(T0, "play"), ev(T0 + 60 * S, "room waited", null, { ms: 5000 }), ev(T0 + 120 * S, "pause", "u2"),
    ev(T0 + 130 * S, "pause", "u1"), ev(T0 + 150 * S, "resume"), ev(T0 + 200 * S, "stop")];
  const segs = playbackOf(events, T0, T0 + 300 * S).map((s) => [s.state, (s.from - T0) / S, (s.to - T0) / S, s.by]);
  check("playback: one state at a time, the room's wait cut out of playing, a second pause ignored, nothing after stop", segs, [
    ["playing", 0, 55, "name-u1"], ["waiting", 55, 60, null], ["playing", 60, 120, "name-u1"],
    ["paused", 120, 150, "name-u2"], ["playing", 150, 200, "name-u1"]]);
  check("playback: the parts do not overlap", playbackOf(events, T0, T0 + 300 * S).every((s, i, a) => i === 0 || a[i - 1].to <= s.from), true);
  check("playback: still playing runs to the end", playbackOf([ev(T0, "play")], T0, T0 + 10 * S).map((s) => [s.state, s.to - T0]), [["playing", 10 * S]]);
}

// viewerStatusOf: buffering over loading over away, none overlapping.
{
  const events = [
    ev(T0 + 0 * S, "away from Discord"),
    ev(T0 + 20 * S, "loaded at start", "u1", { ms: 15_000 }),
    ev(T0 + 18 * S, "buffering", "u1", { ms: 6_000 }),
    ev(T0 + 40 * S, "back in Discord"),
    ev(T0 + 50 * S, "buffering", "u2", { ms: 5_000 }),
  ].sort((a, b) => a.at - b.at);
  const segs = viewerStatusOf(events, "u1", T0 + 100 * S).map((s) => [s.state, (s.from - T0) / S, (s.to - T0) / S, s.what]);
  check("status: buffering first, loading around it, away where neither is", segs, [
    ["away", 0, 5, "Away from Discord"], ["loading", 5, 12, "Loading at start"], ["buffering", 12, 18, "Buffering"],
    ["loading", 18, 20, "Loading at start"], ["away", 20, 40, "Away from Discord"]]);
  const all = viewerStatusOf(events, "u1", T0 + 100 * S);
  check("status: no two parts overlap", all.every((s, i) => i === 0 || all[i - 1].to <= s.from), true);
  check("status: another viewer's buffering is theirs", viewerStatusOf(events, "u2", T0 + 100 * S).map((s) => s.state), ["buffering"]);
  check("status: still away runs to when they were last seen",
    viewerStatusOf([ev(T0, "away from Discord")], "u1", T0 + 30 * S).map((s) => [s.from - T0, s.to - T0]), [[0, 30 * S]]);
}

// deliveryOf: each sample's bytes held over the time since the last, two viewers added together.
{
  const a = [hp(T0, 0), hp(T0 + 10 * S, 1_250_000), hp(T0 + 20 * S, 1_250_000, 250_000)];
  const b = [hp(T0 + 10 * S, 0), hp(T0 + 20 * S, 0, 0, 125_000)];
  const { points, stepMs } = deliveryOf({ a, b }, undefined);
  check("delivery: a 10-second step", stepMs, 10_000);
  check("delivery: bits a second, by source, the viewers summed", points.map((p) => [(p[0] - T0) / S, p[1], p[2], p[3]]), [
    [0, 1_000_000, 0, 0], [10, 1_000_000, 0, 100_000], [20, 1_000_000, 200_000, 100_000]]);
  const two = deliveryOf({ a: [hp(T0, 0), hp(T0 + 10 * S, 1_250_000)] }, undefined).points;
  check("delivery: a session of two samples is a flat rate, not a spike at its end", two.map((p) => p[1]), [1_000_000, 1_000_000]);
  check("delivery: one sample only falls back to the minute totals",
    deliveryOf({ a: [hp(T0, 5)] }, [[T0, 750_000, 0, 0]]).points, [[T0, 100_000, 0, 0]]);
  const gap = deliveryOf(undefined, [[T0, 60, 0, 0], [T0 + 10 * 60 * S, 60, 0, 0]]).points.map((p) => [(p[0] - T0) / 60 / S, p[1]]);
  check("delivery: the minute totals read as nothing across a gap", gap, [[0, 8], [1, 0], [9, 0], [10, 8]]);
  check("delivery: nothing at all", deliveryOf(undefined, undefined), { points: [], stepMs: 0 });
}

// seriesOf and sampleAt: a gap of over 30 seconds is a break, and the nearest sample within 15 seconds.
{
  const h = [hp(T0, 0, 0, 0, 0.5), hp(T0 + 10 * S, 0, 0, 0, 1.5), hp(T0 + 60 * S, 0, 0, 0, -1)];
  check("series: a break across a gap of over 30 seconds", seriesOf(h, 1).map(([t, v]) => [t - T0, v]),
    [[0, 0.5], [10 * S, 1.5], [10 * S + 1, null], [60 * S, -1]]);
  check("sample: the nearest within 15 seconds", sampleAt(h, T0 + 12 * S)?.[1], 1.5);
  check("sample: none further than 15 seconds", sampleAt(h, T0 + 35 * S), null);
}

// timeTicks: at least three, on round times, in days for a week.
{
  const hour = timeTicks(T0, T0 + 60 * 60 * S, 200);
  check("ticks: three at the least on a narrow chart", hour.ticks.length >= 3, true);
  check("ticks: on round times of the step", hour.ticks.every((t) => (t + -new Date(t).getTimezoneOffset() * 60 * S) % hour.stepMs === 0), true);
  const week = timeTicks(T0 - 7 * 86_400 * S, T0, 900, 110);
  check("ticks: a week is in days", week.stepMs, 86_400 * S);
  check("ticks: a week has a tick each day", week.ticks.length, 7);
  check("ticks: thirty days in two-day or weekly steps", [2, 7].includes(timeTicks(T0 - 30 * 86_400 * S, T0, 900, 110).stepMs / 86_400 / S), true);
  check("ticks: none for an empty span", timeTicks(T0, T0, 500).ticks, []);
}

// placeLabels: centred, kept inside, on the first line with room, null where none has.
{
  const placed = placeLabels([{ x: 50, w: 60 }, { x: 70, w: 60 }, { x: 90, w: 60 }, { x: 395, w: 40 }], 400);
  check("labels: centred where they fit, the next line for a clash, none where both are full", placed, [
    { line: 0, left: 20 }, { line: 1, left: 40 }, null, { line: 0, left: 360 }]);
  check("labels: kept inside the chart at its start", placeLabels([{ x: 2, w: 40 }], 400), [{ line: 0, left: 0 }]);
  check("label width and fit", [labelWidth("Paused"), fits("Paused", 51), fits("Paused", 50)], [51, true, false]);
}

// roleSummary and offsetText.
check("roles: in the order held, repeats folded", roleSummary([
  { role: "viewer", from: 0, to: 1 }, { role: "co-host", from: 1, to: 2 }, { role: "co-host", from: 2, to: 3 }, { role: "host", from: 3, to: 4 }] as never),
  "Viewer → Co-host → Host");
check("roles: none is a viewer", roleSummary([]), "Viewer");
check("offset: signed, to a hundredth as the player shows it", [offsetText(1.244), offsetText(-0.8), offsetText(0.02), offsetText(0.004)], ["+1.24 s", "−0.80 s", "+0.02 s", "0.00 s"]);

// processing: names, durations and details.
check("processing: names by mode", [processingName("whole file", true), processingName("whole file", false), processingName("first segment", false),
  processingName("probe"), processingName("something new")], ["Full-file transcode", "Full-file remux", "First segment (remux)", "File analysis", "something new"]);
check("processing: durations", [duration(850), duration(1400), duration(12_400), duration(64_000), duration(3_725_000)],
  ["850 ms", "1.4 s", "12 s", "1:04", "1:02:05"]);
check("processing: details in words", stepDetail({ id: 1, at: 0, kind: "whole file", hlsSessionId: null, ms: 1, ok: true,
  detail: { streams: 4, fromS: 4210, speedX: 39, format: "srt", cues: 812 } }), "4 tracks · From 1:10:10 · 39× real time · SRT · 812 lines");
check("processing: a start under an hour", stepDetail({ id: 1, at: 0, kind: "subtitle window", hlsSessionId: null, ms: 1, ok: true, detail: { fromS: 75 } }), "From 1:15");
check("processing: no detail", stepDetail({ id: 1, at: 0, kind: "probe", hlsSessionId: null, ms: 1, ok: true, detail: {} }), "");

// reasonText: the server's reasons, old sessions' too, in the dashboard's terms.
check("reasons: in the dashboard's terms", [
  "10-bit picture: frames dropped on this player",
  "HEVC: not decoded by this player",
  "HEVC: not decoded by Discord's player",
  "Above 1080p: this player can't decode it smoothly",
  "HDR tone-mapped for a screen in SDR",
  "video is mpeg2video",
  "no video stream",
  "picture size unknown",
  "no audio track 3",
  "Over the room's bandwidth: 12 Mbps over 8 Mbps",
].map(reasonText), [
  "10-bit video: frames dropped by the client",
  "HEVC: not supported by the client",
  "HEVC: not supported by Discord's player",
  "Above 1080p: not decoded smoothly by the client",
  "HDR tone-mapped on an SDR display",
  "Video codec mpeg2video not supported",
  "No video stream",
  "Video resolution unknown",
  "Audio track 3 not found",
  "Exceeds the session bandwidth limit: 12 Mbps over 8 Mbps",
]);
check("reasons: one already in the dashboard's terms is unchanged", reasonText("Audio codec not supported"), "Audio codec not supported");

// 18 November: the System page's upload axis read 0.7, 1.3, 2, 2.6 Mbps and bot memory 65, 130, 195, 260 MB.
check("an axis in round steps over the data", [niceTicks(2.6), niceTicks(254), niceTicks(16), niceTicks(0)],
  [[0, 1, 2, 3], [0, 100, 200, 300], [0, 5, 10, 15, 20], [0, 1]]);

// 18 November: buffer, frames, playback rate, peers and memory were recorded every 10 s for each viewer but shown nowhere.
{
  const hp = (at: number, drift: number | null, ahead: number | null, buf: number | null, shown: number | null, dropped: number | null,
    mem: number | null, peers: number | null, rate: number | null): HealthPoint => [at, drift, ahead, buf, 0, 0, 0, 0, shown, dropped, mem, peers, rate];
  const s = healthSummary([hp(0, 0.2, 30, 8, 240, 0, 150, 2, 1), hp(10, -1.4, 12, 4, 230, 10, 180, 3, 1.05), hp(20, 0.6, 24, null, 240, 2, 170, null, 0.98)]);
  check("a viewer's player over the session: sync either way, buffers at their average and lowest, frames, rate, peers, memory",
    [s.samples, s.syncAvgS!.toFixed(2), s.syncMaxS, s.aheadAvgS, s.aheadMinS, s.bufferAvgS, s.bufferMinS, s.framesShown, s.framesDropped,
      s.rateMin, s.rateMax, s.peersMax, s.memoryMaxMb],
    [3, "0.73", 1.4, 22, 12, 6, 4, 710, 12, 0.98, 1.05, 3, 180]);
  const host = healthSummary([hp(0, null, 30, 8, null, null, null, null, null)]);
  check("  the host has no sync offset; nothing recorded is null, not 0", [host.syncAvgS, host.framesDropped, host.rateMax], [null, null, null]);
}

console.log(`admin-lanes: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
