/**
 * HDR on a screen in SDR, lit as Plex's app for Windows shows it.
 *
 * Chrome shows HDR on a screen in SDR by putting HDR's reference white,
 * 203 nits, at half the screen's light, and keeping the other half for the
 * highlights up to the film's peak. Measured in Chrome 152 on 28 October with
 * grey patches in HEVC Main 10: PQ at 1, 10, 50, 100 and 203 nits came out
 * at 8, 42, 98, 135 and 187 of 255 — the screen's light in step with the
 * film's, a quarter of it at 100 nits — the same with the file's MaxCLL at
 * 1000, at 4000 or not given (only the highlights above 203 nits moved with
 * it), and HLG's reference white at 186. So every HDR film played here,
 * copied or re-encoded keeping its HDR, looked a stop or more darker than in
 * Plex's own players.
 *
 * Plex's app for Windows, on the same screen, shows twice Chrome's light up
 * to about 100 nits, written for the screen as a plain 2.2 power, and eases
 * the highlights above that into the top of the screen. Lined up pixel by
 * pixel with screenshots of the same frames here (The Avengers and Project
 * Hail Mary, 28 October), it is brighter in the darkest parts of a scene and
 * darker above them than the player's first lift, three times the light to
 * 75 nits: where that showed 12, 20, 36, 100 and 180 of 255, the Windows app
 * showed 20, 26, 36, 86 and 146. Plex's SDR version, in Firefox, is brighter
 * than both throughout.
 *
 * The player lights it the Windows app's way: twice the light up to a quarter
 * of the screen's, then a shoulder that starts at that slope and ends at
 * white. Near black it rises at most 4 of 255 a step, so the film's darkest
 * steps, where its grain and noise are, aren't lifted into view, and black
 * stays black. 1 nit comes out at 23 of 255, 10 nits at 63, 50 nits at 134,
 * 100 nits at 183, 203 nits at 230: within 3 of the Windows app's on The
 * Avengers from 12 to 220. Project Hail Mary's dark parts match as closely;
 * its middle tones were darker still in the Windows app, which measures each
 * scene's peak. A static table can't follow that, so it keeps The Avengers'.
 *
 * The curve is applied per channel to the picture as Chrome has drawn it: an
 * SVG feComponentTransfer table on the video element, which Chrome runs on the
 * GPU, so the stream itself, its decoding and its timing are untouched. It
 * works on the screen's own 8-bit values, not in linear light: Chrome makes
 * the table 256 steps of its input, which in linear light would leave a dark
 * scene a dozen steps. Its steepest step is 4 of 255, right above black.
 *
 * Only where that measurement holds: Chrome (Discord's app is Chrome) on a
 * computer, with the screen in SDR, and a stream whose frames say PQ or HLG.
 * A screen showing HDR shows it as it is; Firefox and Safari draw HDR their
 * own way; a phone's picture may be its system's, not Chrome's.
 */

/** The SVG filter the video, and frames copied from it, are drawn through. */
export const HDR_LIFT_ID = "pdt-hdr-lift";

/** The light below the knee, as the Windows app shows it: twice Chrome's. */
const GAIN = 2;
/** Where the shoulder takes over, in Chrome's linear light: about 100 nits. */
const KNEE = 0.25;
/** The screen's decoding, which the table is written for: a plain power. */
const SCREEN_GAMMA = 2.2;
/** The most the table rises a step from black, of 255. */
const TOE_STEP = 4;

const decode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

const KNEE_OUT = GAIN * KNEE;
/** The shoulder's slope at its start, matching the gain's; it ends at white. */
const SHOULDER = (GAIN * (1 - KNEE)) / (1 - KNEE_OUT);

/** The lift in linear light: out for Chrome's in, both 0–1. */
export function liftLight(c: number): number {
  if (c <= KNEE) return GAIN * c;
  const t = (c - KNEE) / (1 - KNEE);
  return KNEE_OUT + (1 - KNEE_OUT) * ((SHOULDER * t) / ((SHOULDER - 1) * t + 1));
}

/**
 * The filter's table: what each of the screen's 256 values becomes. Chrome
 * builds its own 256-step table from this, truncating, so each entry sits a
 * quarter step above the value it is meant to give.
 */
export const HDR_LIFT_TABLE = Array.from({ length: 256 }, (_, i) => {
  const code = Math.round(Math.min(255, liftLight(decode(i / 255)) ** (1 / SCREEN_GAMMA) * 255, TOE_STEP * i));
  return Math.min(1, (code + 0.25) / 255).toFixed(5);
}).join(" ");

/** The frames' own transfer: what Chrome maps by. Null when it can't be read
 *  (no frame yet, or no VideoFrame here). */
export function frameTransfer(video: HTMLVideoElement): "pq" | "hlg" | "sdr" | null {
  if (typeof VideoFrame === "undefined" || video.readyState < 2) return null;
  try {
    const frame = new VideoFrame(video);
    // "pq" and "hlg" are newer than TypeScript's list of them.
    const transfer: string | null = frame.colorSpace.transfer;
    frame.close();
    if (!transfer) return null;
    return transfer === "pq" || transfer === "hlg" ? transfer : "sdr";
  } catch {
    return null;
  }
}

/** HDR by the server's word on the stream: "HDR10", "HLG (kept)", "Dolby
 *  Vision P8.1 / HDR10"; "SDR", "SDR (tone-mapped from HDR10)". */
export function rangeIsHdr(range: string | null | undefined): boolean | null {
  if (!range) return null;
  return !range.startsWith("SDR");
}

/** Whether this browser draws HDR as measured above; null when it does, else
 *  why not. */
export function notChromeOnComputer(): string | null {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (!/\bChrome\/\d/.test(ua)) return "not Chrome";
  if (/Android|Mobile|iPhone|iPad/i.test(ua)) return "a phone";
  return null;
}
