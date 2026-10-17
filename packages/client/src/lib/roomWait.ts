/**
 * The rule that nobody in a room is shown the same seconds twice.
 *
 * The room's clock is the host's playhead. When the host's picture freezes,
 * everybody else plays on and ends up ahead of it — and the sync used to send
 * them back to it, up to nine seconds at a time, several times a minute on a
 * struggling host. Somebody ahead of the room now stops where they are and
 * picks up when the room gets there. Only a seek sends anybody back, because
 * that is somebody choosing to rewatch.
 */

/**
 * How far ahead of the room a follower may be and still wait for it.
 *
 * A freeze leaves people a few seconds ahead. This far ahead is the room
 * having gone somewhere else without a seek, and the room is followed.
 */
export const MAX_WAIT_FOR_ROOM_S = 30;

/** Whether a follower this far ahead of the room waits for it rather than going back. */
export function waitsForRoom(aheadS: number): boolean {
  return aheadS > 0 && aheadS <= MAX_WAIT_FOR_ROOM_S;
}

/**
 * What a follower stopped at `hereS` does about a room at `roomS`: keep
 * waiting, play on because the room has arrived (within `toleranceS`), or
 * follow the room because it is too far behind to be waited for.
 */
export function roomWaitOutcome(hereS: number, roomS: number, toleranceS: number): "wait" | "play" | "follow" {
  if (roomS >= hereS - toleranceS) return "play";
  if (hereS - roomS > MAX_WAIT_FOR_ROOM_S) return "follow";
  return "wait";
}

/** Where a follower was when its stream was torn down, ahead of the room. */
export interface AheadAtRebuild {
  ratingKey: string;
  atS: number;
  /** Where the room was at the time. */
  roomAtS: number;
}

/**
 * Where a rebuilt stream starts for a follower that was ahead of the room
 * when the old one went, or null to land on the room's clock as usual.
 *
 * Following a host whose transcode froze and was restarted is the usual way
 * here: the restart begins where the host froze, which is exactly the part
 * everybody else has already watched.
 */
export function resumeAheadAt(
  carried: AheadAtRebuild | null,
  now: {
    ratingKey: string;
    roomRatingKey: string | null;
    roomS: number;
    /** Where the new stream's segments begin. */
    streamStartS: number;
    /** Closer than this to the room isn't worth a jump of its own. */
    toleranceS: number;
    /** A room this far behind where it was has been sent back: a seek. */
    seekedBackS: number;
  },
): number | null {
  if (!carried) return null;
  if (carried.ratingKey !== now.ratingKey || now.roomRatingKey !== carried.ratingKey) return null;
  if (now.roomS < carried.roomAtS - now.seekedBackS) return null;
  const aheadS = carried.atS - now.roomS;
  if (aheadS <= now.toleranceS || !waitsForRoom(aheadS)) return null;
  if (carried.atS < now.streamStartS) return null;
  return carried.atS;
}

/**
 * Where a player that has just shown its first frames after joining moves to,
 * to make up what starting cost it — or null to stay put.
 *
 * Only ever forward, and no further than it has buffered: past that it would
 * be seeking into a segment it hasn't got. A room behind is waited for by the
 * ordinary sync, never gone back to.
 */
export function settleForward(
  hereS: number,
  bufferedAheadS: number,
  roomS: number,
  toleranceS: number,
): number | null {
  const reachable = Math.min(roomS, hereS + bufferedAheadS - 0.5);
  return reachable - hereS > toleranceS ? reachable : null;
}

/**
 * How far past the room a follower that has fallen behind it goes, to wait
 * there for it: as long as its last segment took to come in, half as long
 * again and a second more, so the part it lands in is in before the room
 * gets there — between 3 and 20 seconds, 6 with nothing to go on.
 */
export function catchUpLeadS(lastSegmentMs: number | null): number {
  const s = lastSegmentMs === null || !(lastSegmentMs > 0) ? 6 : (lastSegmentMs / 1000) * 1.5 + 1;
  return Math.round(Math.min(20, Math.max(3, s)) * 10) / 10;
}

/** Less of its segment than this past a landing, and it is a sliver — see landingFor. */
export const LAND_MIN_LEFT_S = 3;
/** How far into the next segment a landing moved there goes, so that it is
 *  that segment the player fetches, not the end of the one before it. */
export const LAND_INTO_SEGMENT_S = 0.1;

/**
 * Where a follower going a little past the room lands: at `targetS`, unless
 * that leaves only a sliver of its segment to play — less than three seconds
 * of it, and less than half — when it lands at the start of the next segment
 * instead, if that is no further than `limitS`. A segment is fetched whole,
 * so a landing at the end of one fetched all of it for a moment of picture,
 * and stopped for the next: the test page's host, back from a pop-out,
 * landed 0.82 seconds from the end of a four-second segment, played them,
 * and stopped for two.
 */
export function landingFor(
  targetS: number,
  segments: ReadonlyArray<{ start: number; duration: number }> | null | undefined,
  limitS: number,
): number {
  if (!segments?.length) return targetS;
  const i = segments.findIndex((s) => targetS >= s.start && targetS < s.start + s.duration);
  if (i < 0 || i + 1 >= segments.length) return targetS;
  const here = segments[i];
  const leftS = here.start + here.duration - targetS;
  if (leftS >= LAND_MIN_LEFT_S || leftS >= here.duration / 2) return targetS;
  const landS = segments[i + 1].start + LAND_INTO_SEGMENT_S;
  return landS <= limitS ? landS : targetS;
}

/** How far past where it lands a follower looks for a segment that would come too late — see landingBySize. */
export const LAND_LOOK_AHEAD_S = 20;
/** The share of the speed segments came at that a landing counts on, and the seconds it keeps to spare. */
const LAND_SPEED_MARGIN = 0.8;
const LAND_SPARE_S = 1;

/**
 * Where a follower going past the room lands, by the sizes of the segments it
 * will play: at `targetS`, or further past the room `roomS` — no further than
 * `limitS` — if, fetched one after another from now at `bytesPerS` (less a
 * fifth), the segment it lands in or one in the LAND_LOOK_AHEAD_S after it
 * would come in after the room got to it, and the picture with it. The lead
 * before went by the time the last segment took, whatever its size: on 13
 * October a page back from a pop-out landed 3.7 s past the room, the last
 * page's last segment having taken 1.8 s, where the segment it landed in was
 * 26 MB and took 9.5 s; the room went by it, and it was jumped ahead twice.
 *
 * A segment after the one it lands in is needed when the room gets to it,
 * wherever before it the landing is, so a heavy one is only ever got past by
 * landing beyond it, at the start of the next. Unchanged with no speed to go
 * by, or no sizes; and where nothing within the limit would do, as far past
 * the room as the segment it lands in needs alone (catchUpLeadS).
 *
 * A segment `cached` — out of the browser's cache, as a page back from a
 * pop-out finds the page before's (lib/segmentParts inBrowserCache) — comes
 * in no time, so a landing on what is cached can be the room's own place, a
 * second past it. On 14 October three pages back had their next 30 to 40
 * seconds there and landed 3, 7 and 11 seconds past the room all the same,
 * by the speed of the bot, and waited that long for it with the picture in.
 * With no speed to go by, one that isn't cached is taken to come too late.
 *
 * With the sizes and a speed to go by, the search starts at the room itself,
 * not at `targetS` — the guess (catchUpLeadS) for when there is no telling,
 * which only ever moved the landing further. On 17 October a viewer whose
 * first segment took 16 s was sent the guess's most, 20 s past the room, and
 * sat out all 20; what it landed in needed 18 of them, and on a faster
 * connection a few would have done.
 */
export function landingBySize(
  targetS: number,
  roomS: number,
  segments: ReadonlyArray<{ start: number; duration: number; bytes: number | null; cached?: boolean }> | null | undefined,
  bytesPerS: number | null,
  limitS: number,
): number {
  if (!segments?.length) return targetS;
  const speed = bytesPerS && bytesPerS > 0 ? bytesPerS * LAND_SPEED_MARGIN : null;
  /** Seconds a segment takes to come in, fetched now; null when there is no telling. */
  const takesS = (s: { bytes: number | null; cached?: boolean }): number | null =>
    s.cached ? 0 : speed && s.bytes && s.bytes > 0 ? s.bytes / speed : null;
  const segmentAt = (t: number) => segments.findIndex((s) => t >= s.start && t < s.start + s.duration);
  const nearS = roomS + LAND_SPARE_S;
  const near = nearS < targetS ? segmentAt(nearS) : -1;
  const startS = near >= 0 && takesS(segments[near]) !== null ? nearS : targetS;
  const first = segmentAt(startS);
  if (first < 0 || takesS(segments[first]) === null) return targetS;
  for (let i = first; i < segments.length; i++) {
    const seg = segments[i];
    const fromS = i === first ? startS : seg.start + LAND_INTO_SEGMENT_S;
    if (fromS > limitS) break;
    const inS = takesS(seg);
    if (inS === null) break;
    // The ones after it, each needed when the room gets to it.
    let doneS = inS;
    let fits = true;
    for (let j = i + 1; j < segments.length && segments[j].start < fromS + LAND_LOOK_AHEAD_S; j++) {
      const s = takesS(segments[j]);
      if (s === null) {
        // A size not known goes as it always did; a speed not known can't
        // say an uncached segment will come in time.
        if (!speed && !segments[j].cached) fits = false;
        break;
      }
      doneS += s;
      if (doneS > segments[j].start - roomS - LAND_SPARE_S) { fits = false; break; }
    }
    if (!fits) continue;
    // And the one it lands in, by the time the room gets to the landing.
    const landS = Math.max(fromS, roomS + inS + LAND_SPARE_S);
    if (landS < seg.start + seg.duration && landS <= limitS) return landS;
  }
  const firstSeg = segments[first];
  const alone = roomS + catchUpLeadS(
    !firstSeg.cached && bytesPerS && firstSeg.bytes ? (firstSeg.bytes / bytesPerS) * 1000 : null,
  );
  return Math.max(targetS, Math.min(alone, limitS));
}

/**
 * Whether a segment that came in `bytes` in `ms` came out of the browser's
 * cache — faster than any player's connection to the bot — and so says
 * nothing of how fast the next will come. A page back from a pop-out finds the
 * last page's segments there (lib/segmentParts).
 */
export function cameFromCache(bytes: number, ms: number): boolean {
  return bytes > 0 && (bytes * 8) / Math.max(1, ms) / 1000 > CACHE_MBPS;
}
/** Faster than this, a segment came out of the cache — see cameFromCache. */
const CACHE_MBPS = 200;

/** Where the last segment's download time is kept across a reload. */
const LAST_SEGMENT_KEY = "pdt:lastSegmentMs";
/** How long it is worth anything: a connection changes. */
const LAST_SEGMENT_FOR_MS = 10 * 60_000;

/**
 * Keep how long this player's last segment took, for the page that replaces
 * this one — Discord's pop-out reloads the activity, and the new page knew
 * nothing of the connection: blah0391 popped out on 12 October and landed six
 * seconds ahead of the room, where a 29 MB segment needed 5.6 to come.
 */
export function rememberSegmentMs(ms: number, now = Date.now(), bytesPerS: number | null = null): void {
  try {
    localStorage.setItem(LAST_SEGMENT_KEY, JSON.stringify({
      ms: Math.round(ms), at: now, ...(bytesPerS && bytesPerS > 0 ? { bps: Math.round(bytesPerS) } : {}),
    }));
  } catch {
    // Storage unavailable: the next page guesses, as it did.
  }
}

/** The last segment's download time from a page before this one, if recent. */
export function recentSegmentMs(now = Date.now()): number | null {
  try {
    const kept = JSON.parse(localStorage.getItem(LAST_SEGMENT_KEY) ?? "null") as { ms?: number; at?: number } | null;
    if (!kept || !(Number(kept.ms) > 0) || !(now - Number(kept.at) < LAST_SEGMENT_FOR_MS)) return null;
    return Number(kept.ms);
  } catch {
    return null;
  }
}

/** How fast segments came in, bytes a second, on a page before this one, if recent — see landingBySize. */
export function recentSegmentBytesPerS(now = Date.now()): number | null {
  try {
    const kept = JSON.parse(localStorage.getItem(LAST_SEGMENT_KEY) ?? "null") as { bps?: number; at?: number } | null;
    if (!kept || !(Number(kept.bps) > 0) || !(now - Number(kept.at) < LAST_SEGMENT_FOR_MS)) return null;
    return Number(kept.bps);
  } catch {
    return null;
  }
}
