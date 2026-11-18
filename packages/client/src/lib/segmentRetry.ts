/**
 * A segment that won't load, and what the player does about it.
 *
 * On 15 November one segment of Verity, near the end, failed to load. The
 * player asked again with startLoad five times, two minutes apart, every
 * try the same; then it took the failure for the blank tail Plex sometimes
 * leaves at the end of a stream and ended the film four minutes early.
 *  - A segment that failed is asked for again past every cache, under an
 *    address of its own (freshUrl), in case a bad answer was kept.
 *  - The same segment failing fatally again after startLoad rebuilds the
 *    stream instead of asking a sixth time (fragLoadFailure).
 *  - A segment that didn't load is never the end of the title while a rebuild
 *    is left (mayEndAtBreak): that is the way to the bot failing, not the
 *    stream ending.
 *
 * On 18 November, the segment after 7002.5 s never arrived, with no error at
 * all. The host was paused "holding for the room", the room waited for the
 * host, and the wedge watchdog, which looks only at a player that is playing,
 * never looked: it buffered until it was closed (waitsToPlay).
 */

const FRAG_LOAD = new Set(["fragLoadError", "fragLoadTimeOut"]);

/** `url`, to be asked for again past the browser's and Discord's caches: the `n`th time. */
export function freshUrl(url: string, n: number): string {
  const hash = url.indexOf("#");
  const base = hash < 0 ? url : url.slice(0, hash);
  return `${base}${base.includes("?") ? "&" : "?"}fresh=${n}${hash < 0 ? "" : url.slice(hash)}`;
}

/**
 * Whether a fatal hls.js error is a fragment that didn't load, and whether it
 * is the same fragment as the last one that didn't, on the same stream.
 */
export function fragLoadFailure(details: string, sn: unknown, lastSn: number | null): { fragLoad: boolean; failedAgain: boolean } {
  const fragLoad = FRAG_LOAD.has(details);
  return { fragLoad, failedAgain: fragLoad && typeof sn === "number" && sn === lastSn };
}

/**
 * Whether a player out of picture is waiting to play, for the wedge watchdog:
 * playing, or a host paused only while the room waits for its picture.
 */
export function waitsToPlay(paused: boolean, hostHeldForRoom: boolean): boolean {
  return !paused || hostHeldForRoom;
}

/** Whether a fatal error may end the title where it is, near the end: not a fragment that didn't load, while a rebuild is left. */
export function mayEndAtBreak(fragLoad: boolean, rebuildsLeft: boolean): boolean {
  return !fragLoad || !rebuildsLeft;
}
