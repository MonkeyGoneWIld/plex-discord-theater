/**
 * HDR on a screen in SDR, lit as the film's SDR grade would be.
 *
 * Chrome shows HDR on a screen in SDR by putting HDR's reference white,
 * 203 nits, at half the screen's light, and keeping the other half for the
 * highlights up to the film's peak. Measured in Chrome 152 on 28 October with
 * grey patches in HEVC Main 10: PQ at 1, 10, 50, 100 and 203 nits came out
 * at 8, 42, 98, 135 and 187 of 255, the same with the file's MaxCLL at 1000,
 * at 4000 or not given (only the highlights above 203 nits moved with it),
 * and HLG's reference white at 186. A film's SDR grade puts its 100 nits near
 * the top of the screen instead, so every HDR film played here, copied or
 * re-encoded keeping its HDR, looked a stop or more darker than its SDR
 * version: The Avengers and Project Hail Mary on 28 October, next to Plex's
 * own SDR of them in Firefox.
 *
 * The player lifts the picture back: three times the light up to about
 * 75 nits, where a film's faces, rooms and night scenes are, which leaves
 * their colours as they were, then a shoulder that eases what Chrome kept of
 * the highlights into the top of the screen. It starts gentler right at black,
 * so black stays black. 50 nits comes out at 162 of 255, 100 nits at 216,
 * 203 nits at 243.
 *
 * The curve is applied per channel to the picture as Chrome has drawn it: an
 * SVG feComponentTransfer table on the video element, which Chrome runs on the
 * GPU, so the stream itself, its decoding and its timing are untouched. It
 * works on the screen's own 8-bit values, not in linear light: Chrome makes
 * the table 256 steps of its input, which in linear light would leave a dark
 * scene a dozen steps. Its steepest step is 3 of 255, right above black.
 *
 * Only where that measurement holds: Chrome (Discord's app is Chrome) on a
 * computer, with the screen in SDR, and a stream whose frames say PQ or HLG.
 * A screen showing HDR shows it as it is; Firefox and Safari draw HDR their
 * own way; a phone's picture may be its system's, not Chrome's.
 */

/** The SVG filter the video, and frames copied from it, are drawn through. */
export const HDR_LIFT_ID = "pdt-hdr-lift";

/** Linear light added below the knee. */
const GAIN = 3;
/** Where the shoulder takes over, in the screen's linear light. */
const KNEE = 0.55;
/** The gentler start at black: GAIN × TOE_FROM / TOE_TO there, GAIN by about
 *  10 of 255. */
const TOE_FROM = 0.0008;
const TOE_TO = 0.0016;

const decode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const encode = (l: number) => (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055);

const lift = (c: number) => GAIN * c * (c + TOE_FROM) / (c + TOE_TO);
/** Where the lift reaches the knee, and how steep it is there: the shoulder
 *  starts at that slope and ends at white. */
const KNEE_IN = (() => {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (lift(mid) < KNEE) lo = mid;
    else hi = mid;
  }
  return lo;
})();
const SHOULDER = ((lift(KNEE_IN + 1e-6) - lift(KNEE_IN - 1e-6)) / 2e-6) * (1 - KNEE_IN) / (1 - KNEE);

/** The lift in linear light: out for Chrome's in, both 0–1. */
export function liftLight(c: number): number {
  if (c <= KNEE_IN) return lift(c);
  const t = (c - KNEE_IN) / (1 - KNEE_IN);
  return KNEE + (1 - KNEE) * ((SHOULDER * t) / ((SHOULDER - 1) * t + 1));
}

/**
 * The filter's table: what each of the screen's 256 values becomes. Chrome
 * builds its own 256-step table from this, truncating, so each entry sits a
 * quarter step above the value it is meant to give.
 */
export const HDR_LIFT_TABLE = Array.from({ length: 256 }, (_, i) => {
  const code = Math.round(encode(liftLight(decode(i / 255))) * 255);
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
