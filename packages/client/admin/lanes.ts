import type { HealthPoint, PlayEvent } from "./types";
import { awayOf, type Span } from "./session";
import type { RoleSpan } from "./clients";

/**
 * What the session timeline draws, worked out apart from the drawing so each
 * piece can be checked on its own (test/admin-events.test.ts): playback's
 * states, each viewer's status with one state at a time, the data delivered
 * by source, each viewer's sync and buffer series, the axis's times, and
 * where labels fit.
 */

/** What is left of each of `segs` once every span in `cut` is taken out of it, in order. */
export function without<T extends Span>(segs: T[], cut: Span[]): T[] {
  let out = segs;
  for (const c of cut) {
    if (c.to <= c.from) continue;
    out = out.flatMap((s) => {
      if (c.to <= s.from || c.from >= s.to) return [s];
      const parts: T[] = [];
      if (c.from > s.from) parts.push({ ...s, to: c.from });
      if (c.to < s.to) parts.push({ ...s, from: c.to });
      return parts;
    });
  }
  return out;
}

export type PlaybackState = "playing" | "paused" | "waiting";
export interface PlaybackSeg extends Span {
  state: PlaybackState;
  /** Who started, resumed or paused it. */
  by: string | null;
  /** The room's wait for the host's video, while waiting. */
  event?: PlayEvent;
}

/**
 * Playback over the session, one state at a time: playing or paused from its
 * play, pause and resume events, and waiting for the host's video wherever
 * the room held; nothing while stopped.
 */
export function playbackOf(events: PlayEvent[], start: number, end: number): PlaybackSeg[] {
  const out: PlaybackSeg[] = [];
  let state: "playing" | "paused" | null = null;
  let by: string | null = null;
  let since = start;
  const close = (t: number) => {
    if (state && t > since) out.push({ from: since, to: t, state, by });
    since = t;
  };
  for (const e of events) {
    const who = e.username ?? e.userId ?? null;
    if (e.kind === "play" || e.kind === "resume") { close(e.at); state = "playing"; by = who; }
    else if (e.kind === "pause") { if (state === "paused") continue; close(e.at); state = "paused"; by = who; }
    else if (e.kind === "stop" || e.kind === "ended") { close(e.at); state = null; by = null; }
  }
  close(end);
  const waits: PlaybackSeg[] = events.filter((e) => e.kind === "room waited").map((e) => {
    const ms = Math.max(0, Number(e.detail?.ms) || 0);
    return { from: Math.max(start, e.at - ms), to: Math.min(end, e.at), state: "waiting" as const, by: null, event: e };
  }).filter((w) => w.to > w.from);
  return [...without(out, waits), ...waits].sort((a, b) => a.from - b.from);
}

export type ViewerState = "buffering" | "loading" | "away";
export interface StatusSeg extends Span {
  state: ViewerState;
  /** "Buffering", "Loading at start", "Loading after seek", "Away from Discord". */
  what: string;
  posS: number | null;
}

/**
 * A viewer's status over the session, one at a time: buffering first, then
 * loading (at the start or after a seek), then time away from the Discord
 * window, each cut where a more pressing one covers it, so none overlaps
 * another.
 */
export function viewerStatusOf(events: PlayEvent[], userId: string, lastSeen: number): StatusSeg[] {
  const mine = events.filter((e) => e.userId === userId);
  const stall = (kinds: string[], state: ViewerState) => mine.filter((e) => kinds.includes(e.kind)).map((e) => {
    const ms = Math.max(0, Number(e.detail?.ms) || 0);
    const what = e.kind === "buffering" ? "Buffering" : e.kind === "loaded at start" ? "Loading at start" : "Loading after seek";
    return { from: e.at - ms, to: e.at, state, what, posS: e.posS };
  }).filter((s) => s.to > s.from);
  const buffering = stall(["buffering"], "buffering");
  const loading = without(stall(["loaded at start", "loaded after seek"], "loading"), buffering);
  const away = without(awayOf(events, userId, lastSeen).map((s) => ({ ...s, state: "away" as const, what: "Away from Discord", posS: null })),
    [...buffering, ...loading]);
  return [...buffering, ...loading, ...away].sort((a, b) => a.from - b.from);
}

/** [time, server, Discord cache, peers], in bits a second. */
export type DeliveryPoint = [number, number, number, number];

/**
 * The data the players received, by source, over the session: from each
 * viewer's samples (every 10 seconds), each sample's bytes spread evenly over
 * the time since the one before, and the viewers added together a step at a
 * time; else from the minute totals older sessions have. A time no sample
 * covers is nothing rather than a line joined across it.
 */
export function deliveryOf(health: Record<string, HealthPoint[]> | undefined, flow: Array<[number, number, number, number]> | undefined):
  { points: DeliveryPoint[]; stepMs: number } {
  const users = Object.values(health ?? {}).filter((h) => h.length > 1);
  if (users.length > 0) {
    // Each viewer's rates, held from one sample to the next: [from, to, server, cache, peers] in bits a second.
    const spans = users.map((pts) => {
      const out: Array<[number, number, number, number, number]> = [];
      for (let i = 1; i < pts.length; i++) {
        const from = pts[i - 1][0];
        const to = pts[i][0];
        const s = Math.max(1, (to - from) / 1000);
        out.push([from, to, (pts[i][4] * 8) / s, (pts[i][5] * 8) / s, (pts[i][6] * 8) / s]);
      }
      return out;
    });
    const first = Math.min(...spans.map((s) => s[0]?.[0] ?? Infinity));
    const last = Math.max(...spans.map((s) => s[s.length - 1]?.[1] ?? -Infinity));
    // Every 10 seconds, or wider over a long session: at most 1,500 steps.
    const STEP = Math.max(10_000, Math.ceil((last - first) / 1500 / 10_000) * 10_000);
    const points: DeliveryPoint[] = [];
    const at = spans.map(() => 0);
    for (let t = Math.ceil(first / STEP) * STEP; t <= last; t += STEP) {
      const p: DeliveryPoint = [t, 0, 0, 0];
      spans.forEach((list, u) => {
        while (at[u] < list.length && list[at[u]][1] < t) at[u]++;
        const s = list[at[u]];
        if (s && s[0] <= t && t <= s[1]) { p[1] += s[2]; p[2] += s[3]; p[3] += s[4]; }
      });
      points.push(p);
    }
    return { points, stepMs: STEP };
  }
  if (flow && flow.length > 0) {
    const points = flow.map((m): DeliveryPoint => [m[0], (m[1] * 8) / 60, (m[2] * 8) / 60, (m[3] * 8) / 60]);
    return { points: withBreaks(points, 60_000), stepMs: 60_000 };
  }
  return { points: [], stepMs: 0 };
}

/** Points with a zero either side of each gap longer than two steps, so a quiet stretch reads as nothing. */
function withBreaks(points: DeliveryPoint[], step: number): DeliveryPoint[] {
  const out: DeliveryPoint[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && p[0] - last[0] > step * 2) {
      out.push([last[0] + step, 0, 0, 0]);
      out.push([p[0] - step, 0, 0, 0]);
    }
    out.push(p);
  }
  return out;
}

/** One measure of a viewer's samples over time: null where it was not reported, and across a gap of over 30 seconds. */
export function seriesOf(health: HealthPoint[], index: 1 | 2 | 3 | 9): Array<[number, number | null]> {
  const out: Array<[number, number | null]> = [];
  let prev: number | null = null;
  for (const h of health) {
    if (prev !== null && h[0] - prev > 30_000) out.push([prev + 1, null]);
    const v = h[index];
    out.push([h[0], typeof v === "number" && Number.isFinite(v) ? v : null]);
    prev = h[0];
  }
  return out;
}

/** A viewer's sample nearest a time, within 15 seconds of it. */
export function sampleAt(health: HealthPoint[] | undefined, t: number): HealthPoint | null {
  let best: HealthPoint | null = null;
  for (const h of health ?? []) if (Math.abs(h[0] - t) <= 15_000 && (!best || Math.abs(h[0] - t) < Math.abs(best[0] - t))) best = h;
  return best;
}

const MIN = 60_000;
const TIME_STEPS = [10_000, 15_000, 30_000, MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, 60 * MIN, 120 * MIN, 180 * MIN, 360 * MIN,
  720 * MIN, 1440 * MIN, 2 * 1440 * MIN, 7 * 1440 * MIN];

/**
 * The times along the axis: on round local times (each 5, 10, 15 or 30
 * minutes, each hour), as many as fit at about one per `spacing` pixels.
 */
export function timeTicks(from: number, to: number, widthPx: number, spacing = 96): { ticks: number[]; stepMs: number } {
  if (!(to > from) || widthPx <= 0) return { ticks: [], stepMs: 0 };
  // Three at the least, so a phone's narrow chart still reads its start, middle and end.
  const most = Math.max(3, Math.floor(widthPx / spacing));
  const stepMs = TIME_STEPS.find((s) => (to - from) / s <= most) ?? Math.ceil((to - from) / most / (1440 * MIN)) * 1440 * MIN;
  // On the local clock: 9:00 PM where the page is open, not 9:00 PM UTC.
  const offset = -new Date(from).getTimezoneOffset() * MIN;
  const ticks: number[] = [];
  for (let t = Math.ceil((from + offset) / stepMs) * stepMs - offset; t <= to; t += stepMs) ticks.push(t);
  return { ticks, stepMs };
}

/** About how wide a label is in pixels at the timeline's 11.5 px type. */
export const labelWidth = (text: string) => Math.ceil(text.length * 6.4) + 12;

/** Whether a label fits in a span of this many pixels. */
export const fits = (text: string, px: number) => labelWidth(text) <= px;

/**
 * Where each label goes on up to `lines` lines above a chart, left to right:
 * centred on its point where it can be, kept inside the chart, and on the
 * first line with room for it; null where no line has room (its point keeps
 * it on hover).
 */
export function placeLabels(items: Array<{ x: number; w: number }>, width: number, lines = 2, gap = 8): Array<{ line: number; left: number } | null> {
  const order = items.map((it, i) => ({ ...it, i })).sort((a, b) => a.x - b.x);
  const right = Array.from({ length: lines }, () => -Infinity);
  const out: Array<{ line: number; left: number } | null> = items.map(() => null);
  for (const it of order) {
    const left = Math.min(Math.max(0, it.x - it.w / 2), Math.max(0, width - it.w));
    const line = right.findIndex((r) => left >= r + gap);
    if (line < 0) continue;
    right[line] = left + it.w;
    out[it.i] = { line, left };
  }
  return out;
}

const ROLE_NAMES: Record<string, string> = { host: "Host", "co-host": "Co-host", viewer: "Viewer" };

/** A viewer's roles in the order they held them: "Viewer", "Viewer → Co-host → Host". */
export function roleSummary(roles: RoleSpan[]): string {
  const names: string[] = [];
  for (const r of roles) if (names[names.length - 1] !== ROLE_NAMES[r.role]) names.push(ROLE_NAMES[r.role]);
  return names.length ? names.join(" → ") : "Viewer";
}

/** "+1.2 s", "−0.8 s", "0.0 s": a player's offset from the room. */
export const offsetText = (s: number) => `${s >= 0.005 ? "+" : s <= -0.005 ? "−" : ""}${Math.abs(s).toFixed(2)} s`;

/**
 * Round steps for an axis from 0 to at least `top`: 1, 2, 2.5 or 5 times a
 * power of ten, at most `most` ticks — 0, 1, 2, 3 Mbps rather than 0.7, 1.3, 2, 2.6.
 */
export function niceTicks(top: number, most = 5): number[] {
  if (!(top > 0)) return [0, 1];
  const raw = top / (most - 1);
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * p >= raw - 1e-9) ?? 10) * p;
  const n = Math.max(1, Math.ceil(top / step - 1e-9));
  return Array.from({ length: n + 1 }, (_, i) => Number((i * step).toPrecision(12)));
}

/** A viewer's player over a session, from its health samples: what the History page lists for each viewer. */
export interface HealthSummary {
  samples: number;
  /** Distance from the session position, in seconds, ignoring direction; null for the host, who sets it. */
  syncAvgS: number | null;
  syncMaxS: number | null;
  /** Video downloaded ahead of the position. */
  aheadAvgS: number | null;
  aheadMinS: number | null;
  /** Video in the browser's media buffer ahead of the position. */
  bufferAvgS: number | null;
  bufferMinS: number | null;
  framesShown: number | null;
  framesDropped: number | null;
  /** Playback rate: 1 except while the player corrects its sync. */
  rateMin: number | null;
  rateMax: number | null;
  peersMax: number | null;
  memoryMaxMb: number | null;
}

/** Averages, extremes and totals of one viewer's health samples (see HealthPoint for the fields). */
export function healthSummary(points: HealthPoint[]): HealthSummary {
  const col = (i: number) => points.map((p) => p[i]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const avg = (v: number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : null);
  const min = (v: number[]) => (v.length ? Math.min(...v) : null);
  const max = (v: number[]) => (v.length ? Math.max(...v) : null);
  const sum = (v: number[]) => (v.length ? v.reduce((s, x) => s + x, 0) : null);
  const sync = col(1).map(Math.abs);
  const ahead = col(2);
  const buffer = col(3);
  const rate = col(12);
  return {
    samples: points.length,
    syncAvgS: avg(sync), syncMaxS: max(sync),
    aheadAvgS: avg(ahead), aheadMinS: min(ahead),
    bufferAvgS: avg(buffer), bufferMinS: min(buffer),
    framesShown: sum(col(8)), framesDropped: sum(col(9)),
    rateMin: min(rate), rateMax: max(rate),
    peersMax: max(col(11)), memoryMaxMb: max(col(10)),
  };
}
