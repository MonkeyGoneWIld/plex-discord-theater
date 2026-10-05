const STORAGE_KEY = "pdt:hevc-failed";

/**
 * Whether this player can decode HEVC as the room might send it: 8-bit, which
 * is what Plex encodes, and 10-bit, which is what most HEVC files are and what a
 * copied stream (DIRECT_STREAM) hands over untouched — 1080p either way, through
 * Media Source Extensions as hls.js feeds it.
 *
 * Reported to the room on joining. The server only offers Plex HEVC when every
 * client in a room has said yes here, so a wrong yes costs that client its
 * picture until the room moves back to H.264 — which is why a stream that has
 * actually failed to decode is remembered (see markHevcUnplayable) and outranks
 * whatever the browser claims from then on.
 *
 * MSE only: without it the player falls back to native HLS, and Apple's native
 * player wants HEVC in fMP4, which is not what Plex sends.
 */
export function canPlayHevcTranscode(): boolean {
  try {
    if (localStorage.getItem(STORAGE_KEY) === "1") return false;
  } catch {
    // Storage can be unavailable inside the Activity iframe; the browser's own
    // answer below is still worth having.
  }
  try {
    const w = window as unknown as {
      MediaSource?: { isTypeSupported(type: string): boolean };
      ManagedMediaSource?: { isTypeSupported(type: string): boolean };
    };
    const ms = w.MediaSource ?? w.ManagedMediaSource;
    if (!ms) return false;
    const supports = (codec: string) => ms.isTypeSupported(`video/mp4; codecs="${codec}"`);
    return (
      ["hvc1.1.6.L123.B0", "hev1.1.6.L123.B0"].some(supports) &&
      ["hvc1.2.4.L123.B0", "hev1.2.4.L123.B0"].some(supports)
    );
  } catch {
    return false;
  }
}

/** This device claimed HEVC and then couldn't play it. Believed from now on. */
export function markHevcUnplayable(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // Not remembered past this session; the room is still told.
  }
}

/** Whether a codec string from hls.js names HEVC. */
export function isHevcCodec(codec: string | undefined | null): boolean {
  return /^(hvc1|hev1)/i.test(codec ?? "");
}
