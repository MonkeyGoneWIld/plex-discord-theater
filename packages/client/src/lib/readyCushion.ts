/**
 * When a player has picture enough in hand to go — to start, to start again
 * after its picture stopped, or back from a pop-out — and the room with it.
 *
 * Three seconds in hand is enough to start on (lib/copyStart), and with the
 * film coming in barely faster than it plays, it is a stop three seconds
 * later. On 13 October blah0391, back from a pop-out with nobody else in the
 * room, went on with 3 seconds in hand and stopped three times in sixteen
 * seconds: the film had segments of 23 MB coming, and its downloads ran at 11
 * to 40 Mbps. The first start that night did the same, at 5 seconds. A stop
 * is the room's too — everybody stops with the host — and a viewer's used to
 * end in it being jumped past what it hadn't seen.
 *
 * So, starting — a film, a resume, a return from a pop-out — a player goes
 * when every segment it will play in the next LOOK_AHEAD_S would come in
 * before the picture reaches it, at the speed things are coming in (less a
 * fifth, for the speed not holding) and fetched in order — the playlist of a
 * copy gives every segment's size (lib/segmentParts) — or with
 * MAX_READY_CUSHION_S in hand, whatever is coming, or once it has waited
 * MAX_EXTRA_WAIT_S for more: a connection that will never be ahead of the
 * film isn't waited on for ever. On a connection well ahead of the film that
 * is the three seconds it always was.
 *
 * Starting again after its picture stopped, the same, only never with less
 * than AFTER_STOPS_S in hand: 8 seconds, then 15, then 25, for each stop
 * lately. Every stop is everybody's — the room waits for whoever stopped — so
 * it is one wait for longer, rather than stopping again and again.
 *
 * And after a skip, as in every player, the moment it has picture enough to
 * start on, as it always has: somebody who skipped is waiting to see the place
 * they skipped to. If it stops after that, its next wait is a stop's.
 */
import { READY_AHEAD_S, READY_TOLERANCE_S } from "./copyStart";

/** A segment the player hasn't got yet. */
export interface UpcomingSegment {
  /** Film time it starts at, and how long it plays. */
  start: number;
  duration: number;
  /** Its size, if the playlist gives it — a copy's does; null otherwise. */
  bytes: number | null;
}

/** Whatever is coming, this much in hand is enough to go on. */
export const MAX_READY_CUSHION_S = 20;
/** How far past the playhead a player looks for a segment that would come in too late. */
export const LOOK_AHEAD_S = 60;
/** The share of the speed things are coming in at counted on — they won't always. */
export const SPEED_MARGIN = 0.8;
/** The longest a player with the least in hand waits for more before it goes anyway. */
export const MAX_EXTRA_WAIT_S = 10;
/** "Lately", for the picture stopping. */
export const RECENT_STOPS_MS = 3 * 60_000;
/** In hand, at least, to go on after the picture stopped once lately, twice, three times or more. */
export const AFTER_STOPS_S = [8, 15, 25] as const;

/** The least in hand to go on with, having stopped `stops` times lately. */
export function afterStopsS(stops: number): number {
  if (!(stops > 0)) return 0;
  return AFTER_STOPS_S[Math.min(stops, AFTER_STOPS_S.length) - 1];
}

/**
 * How late, at most, a segment of `upcoming` would be — seconds the picture
 * would stand waiting for it, playing from `nowS` — fetched one after another
 * in order at `bytesPerS`; 0 if none would. One with no size is taken at
 * `bytesPerFilmS` a second of film; with neither, there is no telling: null.
 */
export function lateByS(
  nowS: number,
  upcoming: readonly UpcomingSegment[],
  bytesPerS: number,
  bytesPerFilmS: number | null,
): number | null {
  if (!(bytesPerS > 0)) return null;
  let inAtS = 0;
  let late = 0;
  for (const seg of [...upcoming].sort((a, b) => a.start - b.start)) {
    const bytes = seg.bytes ?? (bytesPerFilmS && bytesPerFilmS > 0 ? seg.duration * bytesPerFilmS : null);
    if (bytes === null) return null;
    inAtS += bytes / bytesPerS;
    late = Math.max(late, inAtS - Math.max(0, seg.start - nowS));
  }
  return late;
}

export interface ReadyInput {
  /** The playhead, and how far from it the picture is held without a gap. */
  nowS: number;
  heldToS: number;
  /** Film left from the playhead. */
  leftS: number;
  /** The segments not held within LOOK_AHEAD_S of the playhead, or null without a playlist to go by. */
  upcoming: readonly UpcomingSegment[] | null;
  /** How fast things are coming in while anything is, bytes a second, or null before anything has. */
  bytesPerS: number | null;
  /** Bytes a second of film, from what is held, for a segment whose size isn't given. */
  bytesPerFilmS: number | null;
  /** Times the picture stopped for want of data lately — see RECENT_STOPS_MS. */
  stops: number;
  /** In hand to go on with, with nothing to measure by — see roomWait's catchUpLeadS. */
  fallbackS: number;
  /** Whether this is the wait after a skip — see the top of this file. */
  skip: boolean;
  /** How long it has had the least in hand and waited for more, seconds. */
  waitedS: number;
}

export interface Readiness {
  ready: boolean;
  /** What it goes by, for the log. */
  why: "enough in hand" | "the next minute comes in time" | "the next minute won't come in time" | "short of the least in hand" |
    "no speed to go by" | "a skip, with picture enough to start on" | "waited long enough for more";
  inHandS: number;
  /** The least it goes on with. */
  leastS: number;
  /** How late the next minute's slowest segment would be, if it was worked out. */
  lateS: number | null;
}

/** Whether a player has picture enough in hand to go — see the top of this file. */
export function readiness(o: ReadyInput): Readiness {
  const inHandS = Math.max(0, o.heldToS - o.nowS);
  const leftS = Math.max(0, o.leftS);
  if (o.skip) {
    const leastS = Math.min(READY_AHEAD_S, leftS);
    const enough = inHandS + READY_TOLERANCE_S >= leastS;
    return { ready: enough, why: enough ? "a skip, with picture enough to start on" : "short of the least in hand", lateS: null, inHandS, leastS };
  }
  const stopsS = afterStopsS(o.stops);
  const capS = Math.min(Math.max(MAX_READY_CUSHION_S, stopsS), leftS);
  const leastS = Math.min(Math.max(READY_AHEAD_S, stopsS), capS);
  const base = { inHandS, leastS };
  if (inHandS + READY_TOLERANCE_S < leastS) return { ready: false, why: "short of the least in hand", lateS: null, ...base };
  if (inHandS + READY_TOLERANCE_S >= capS) return { ready: true, why: "enough in hand", lateS: null, ...base };
  const lateS = o.upcoming && o.bytesPerS
    ? lateByS(o.nowS, o.upcoming, o.bytesPerS * SPEED_MARGIN, o.bytesPerFilmS)
    : null;
  if (lateS !== null && lateS <= READY_TOLERANCE_S) return { ready: true, why: "the next minute comes in time", lateS, ...base };
  if (o.waitedS >= MAX_EXTRA_WAIT_S) return { ready: true, why: "waited long enough for more", lateS, ...base };
  if (lateS !== null) return { ready: false, why: "the next minute won't come in time", lateS, ...base };
  const ready = inHandS + READY_TOLERANCE_S >= Math.min(Math.max(leastS, o.fallbackS), capS);
  return { ready, why: ready ? "enough in hand" : "no speed to go by", lateS: null, ...base };
}

/**
 * How fast things come in while anything is, bytes a second: from the
 * download meter's readings [when, bytes, ms with something in flight], over
 * the last `windowMs` of them — or over everything, when that window had
 * under a second and a half of downloading in it. Null with under a second of
 * downloading to go by.
 */
export function comingInBytesPerS(
  readings: ReadonlyArray<readonly [number, number, number]>,
  nowMs: number,
  windowMs = 10_000,
): number | null {
  if (readings.length < 2) return null;
  const last = readings[readings.length - 1];
  const from = readings.find(([at]) => nowMs - at <= windowMs) ?? readings[0];
  const recentMs = last[2] - from[2];
  if (recentMs >= 1_500) return ((last[1] - from[1]) * 1000) / recentMs;
  const first = readings[0];
  const allMs = last[2] - first[2];
  return allMs >= 1_000 ? ((last[1] - first[1]) * 1000) / allMs : null;
}
