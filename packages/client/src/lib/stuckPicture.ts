/**
 * Whether this device's decoder has stopped giving pictures: the video is in
 * hand where it plays, and next to none of it is shown.
 *
 * On 5 November a laptop in Discord (Chrome 152, its own HEVC Main10 stream of
 * an AV1 film) stopped decoding as that stream started: 18 to 60 s of video in
 * hand at the playhead, and no picture (readyState 1) for 15 to 20 s at a
 * time, rebuilt stream after rebuilt stream. From then on nothing in that
 * Discord gave a picture — not H.264 it had played that evening, nor 8-bit
 * HEVC, which gave 4 frames in 10 s of play (Hot Fuzz) with the page painting
 * 60 a second and none dropped — until Discord was quit and opened again; the
 * same stream as the first thing after a restart stopped it again, and on the
 * 4th the same had happened after a Dolby Vision film. The decoder is the
 * browser's, shared by every page Discord opens, so neither a rebuilt stream
 * nor reopening the activity gets it back, and frames dropping (frameDrops.ts)
 * never says so: nothing was dropped.
 *
 * So the picture is looked at every STUCK_TICK_S. A look says it is stuck
 * when the page is shown and STUCK_AHEAD_S of video is in hand at the
 * playhead, and either there is no picture at all (readyState 1 over the
 * tick) or it plays with fewer than SLIDE_FPS frames shown a second of film.
 * STUCK_S of such looks in a row: the player gives up the codec it is on
 * (AV1, or HEVC), as frames dropping does, and on a stream with nothing
 * lighter (H.264), tells the viewer to restart Discord.
 */

/** Seconds between looks at the picture. */
export const STUCK_TICK_S = 2;
/** Seconds stuck before anything is done about it. */
export const STUCK_S = 10;
/** Video in hand at the playhead, in seconds, for no picture to be the decoder's doing. */
export const STUCK_AHEAD_S = 3;
/** Fewer frames shown than this a second of film is a picture that has stopped. */
export const SLIDE_FPS = 3;

export interface PictureLook {
  /** When, in seconds on any steady clock. */
  at: number;
  /** The page not shown: a browser may stop decoding for it. */
  hidden: boolean;
  paused: boolean;
  seeking: boolean;
  readyState: number;
  /** The stream has a picture (videoWidth). */
  hasVideo: boolean;
  /** Seconds of video in hand from the playhead. */
  aheadS: number;
  /** Where the video's clock is. */
  time: number;
  /** Frames shown and dropped so far (getVideoPlaybackQuality). */
  shown: number;
  dropped: number;
}

export type LookVerdict =
  /** Video in hand, and no picture. */
  | "no picture"
  /** Playing with video in hand, a frame now and then. */
  | "barely moving"
  /** Playing, frames shown as they come. */
  | "moving"
  /** Nothing to go by: hidden, short of video, paused, a new stream, a late timer. */
  | "skipped";

/** What the stretch from one look to the next says of the decoder. */
export function lookVerdict(last: PictureLook, now: PictureLook): LookVerdict {
  const seconds = now.at - last.at;
  // A new stream counts from 0 again; a timer that ran late wasn't a tick.
  if (seconds <= 0 || seconds > 2 * STUCK_TICK_S || now.shown < last.shown || now.dropped < last.dropped) return "skipped";
  if (last.hidden || now.hidden || !now.hasVideo) return "skipped";
  const shown = now.shown - last.shown;
  const playedS = now.time - last.time;
  const playing = !last.paused && !now.paused && !last.seeking && !now.seeking && now.readyState >= 2;
  if (playing && playedS >= seconds / 2 && shown >= SLIDE_FPS * playedS) return "moving";
  if (now.aheadS < STUCK_AHEAD_S) return "skipped";
  const noPicture = (r: number) => r >= 1 && r < 2;
  if (noPicture(last.readyState) && noPicture(now.readyState) && shown === 0) return "no picture";
  if (playing && playedS >= seconds / 2) return "barely moving";
  return "skipped";
}

/** Since when the picture has been stuck, given since when it was at the
 *  last look; null when this look doesn't say it is. */
export function stuckSince(since: number | null, last: PictureLook | null, now: PictureLook): number | null {
  if (!last) return null;
  const verdict = lookVerdict(last, now);
  return verdict === "no picture" || verdict === "barely moving" ? since ?? last.at : null;
}

/** Whether it has been stuck long enough to do something about it. */
export const stuckLongEnough = (since: number | null, now: PictureLook) => since !== null && now.at - since >= STUCK_S;
