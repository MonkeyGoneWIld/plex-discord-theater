import type { PlayEvent, PlayStream, TrackPoint } from "./types";

/**
 * What a session's events say of each viewer and of the room, for the
 * History page's cards and its session chart: time away from the Discord
 * window, the pauses and who made them, how long players took to load, and
 * which stream a viewer was on when — kept apart from the drawing so each can
 * be checked on its own (test/admin-events.test.ts).
 */

export interface Span { from: number; to: number }

/** When a viewer had switched away from the Discord window: each until they came back to it, left, or the session ended. */
export function awayOf(events: PlayEvent[], userId: string, end: number): Span[] {
  const out: Span[] = [];
  let since: number | null = null;
  for (const e of events) {
    if (e.userId !== userId) continue;
    if (e.kind === "away from Discord") since ??= e.at;
    else if ((e.kind === "back in Discord" || e.kind === "left") && since !== null) {
      if (e.at > since) out.push({ from: since, to: e.at });
      since = null;
    }
  }
  if (since !== null && end > since) out.push({ from: since, to: end });
  return out;
}

export interface Pause {
  userId: string | null;
  username: string | null;
  at: number;
  posS: number | null;
  /** Until playback resumed, the title stopped, or the session ended. */
  ms: number;
  /** Still paused when the session ended. */
  open: boolean;
}

/** Each pause: who made it, where in the title, and for how long. */
export function pausesOf(events: PlayEvent[], end: number): Pause[] {
  const out: Pause[] = [];
  let cur: PlayEvent | null = null;
  for (const e of events) {
    if (e.kind === "pause") cur ??= e;
    else if (cur && (e.kind === "resume" || e.kind === "play" || e.kind === "stop" || e.kind === "ended")) {
      out.push({ userId: cur.userId, username: cur.username, at: cur.at, posS: cur.posS, ms: Math.max(0, e.at - cur.at), open: false });
      cur = null;
    }
  }
  if (cur) out.push({ userId: cur.userId, username: cur.username, at: cur.at, posS: cur.posS, ms: Math.max(0, end - cur.at), open: true });
  return out;
}

export interface PauserTotals { userId: string | null; username: string | null; count: number; totalMs: number; longestMs: number; pauses: Pause[] }

/** The pauses by who made them, the most paused first. */
export function pausesByPerson(pauses: Pause[]): PauserTotals[] {
  const by = new Map<string, PauserTotals>();
  for (const p of pauses) {
    const k = p.userId ?? "";
    let t = by.get(k);
    if (!t) by.set(k, (t = { userId: p.userId, username: p.username, count: 0, totalMs: 0, longestMs: 0, pauses: [] }));
    t.count++;
    t.totalMs += p.ms;
    t.longestMs = Math.max(t.longestMs, p.ms);
    t.username ??= p.username;
    t.pauses.push(p);
  }
  return [...by.values()].sort((a, b) => b.totalMs - a.totalMs || b.count - a.count);
}

export interface LoadStats { count: number; avgMs: number; longestMs: number }

const stats = (ms: number[]): LoadStats | null =>
  ms.length ? { count: ms.length, avgMs: Math.round(ms.reduce((s, x) => s + x, 0) / ms.length), longestMs: Math.max(...ms) } : null;

/** How long a viewer's player (or, with null, every player) took to load at the start and after seeks. */
export function loadTimes(events: PlayEvent[], userId: string | null): { start: LoadStats | null; seek: LoadStats | null } {
  const ms = (kind: string) => events.filter((e) => e.kind === kind && (userId === null || e.userId === userId))
    .map((e) => Number(e.detail?.ms)).filter((n) => Number.isFinite(n) && n >= 0);
  return { start: stats(ms("loaded at start")), seek: stats(ms("loaded after seek")) };
}

/** Who was host at a time: whoever started the title as host, joined or came back as host, or was made host by then. */
export function hostAt(events: PlayEvent[], t: number): string | null {
  let host: string | null = null;
  for (const e of events) {
    if (e.at > t) break;
    if (!e.userId) continue;
    const to = e.kind === "role" ? e.detail?.to : e.kind === "play" || e.kind === "joined" || e.kind === "came back" ? e.detail?.role : undefined;
    if (to === "host") host = e.userId;
    else if (to !== undefined && host === e.userId) host = null;
  }
  return host;
}

/**
 * The stream a viewer was on at a time: the one they last moved onto, or
 * joined on, by then. With none recorded (one who joined onto the host's
 * stream before joins noted it), their own stream, else the one the host was
 * on, else the one the room shared, else the one running. A stream's later
 * restarts share its key: the one running then.
 */
export function streamAt(events: PlayEvent[], streams: PlayStream[], userId: string, t: number, viaHost = true): PlayStream | null {
  let key: string | null = null;
  for (const e of events) {
    if (e.at > t) break;
    if (e.userId !== userId) continue;
    if (e.kind === "stream changed" && typeof e.detail?.to === "string") key = e.detail.to;
    else if ((e.kind === "joined" || e.kind === "came back") && typeof e.detail?.stream === "string") key = e.detail.stream;
  }
  const running = (s: PlayStream) => s.startedAt <= t && (s.endedAt === null || s.endedAt >= t);
  if (key !== null) {
    const same = streams.filter((s) => s.variantKey === key);
    return same.find(running) ?? same.filter((s) => s.startedAt <= t).at(-1) ?? same[0] ?? null;
  }
  const own = streams.filter((s) => s.ownerUserId === userId);
  const host = viaHost ? hostAt(events, t) : null;
  const hosts = host && host !== userId ? streamAt(events, streams, host, t, false) : null;
  const shared = streams.filter((s) => !s.ownerUserId);
  return own.find(running) ?? hosts ?? shared.find(running) ?? streams.find(running) ?? own[0] ?? shared[0] ?? null;
}

export interface DeliveryPart { from: number; to: number; decision: "copy" | "transcode" | null }

/**
 * What of the title a viewer watched, by how it reached them: from their own
 * player's positions, each stretch it played on without a jump, coloured by
 * the stream they were on as it did; pieces that meet are joined.
 */
export function deliveryParts(track: TrackPoint[], events: PlayEvent[], streams: PlayStream[], userId: string): DeliveryPart[] {
  const raw: DeliveryPart[] = [];
  for (let i = 1; i < track.length; i++) {
    const [t1, p1, playing] = track[i - 1];
    const [t2, p2] = track[i];
    const dt = (t2 - t1) / 1000;
    if (!playing || p1 < 0 || p2 <= p1 || dt <= 0 || dt > 30 || Math.abs(p2 - p1 - dt) > 3) continue;
    const d = streamAt(events, streams, userId, t1)?.decision;
    raw.push({ from: p1, to: p2, decision: d === "copy" || d === "transcode" ? d : null });
  }
  raw.sort((a, b) => a.from - b.from || a.to - b.to);
  const out: DeliveryPart[] = [];
  for (const p of raw) {
    const last = [...out].reverse().find((x) => x.decision === p.decision);
    if (last && p.from <= last.to + 1) last.to = Math.max(last.to, p.to);
    else out.push({ ...p });
  }
  return out;
}
