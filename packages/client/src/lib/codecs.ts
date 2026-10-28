/**
 * What this player decodes beyond H.264 and AAC in MPEG-TS, which every one
 * does: HEVC (hevc.ts), and AV1, Opus, FLAC, AC3 and EAC3 in fragmented MP4 as
 * the ffmpeg engine copies them — asked of Media Source Extensions, as hls.js
 * feeds them. AC3 and EAC3 are Edge's and Safari's, and Chromium's where the
 * system decodes them.
 * Told to the room on joining (the server's PlayerCaps): each stream is made
 * for what its driver decodes, and whoever on it can't play that is put on a
 * stream of their own, never the room on a lesser one.
 *
 * The browser's yes is believed until a stream that used the codec fails to
 * decode here; that is remembered on this device (markUnplayable) and the room
 * told (the "caps" message), which moves this player onto a stream it can play.
 *
 * MSE only, as hevc.ts: without it the player falls back to native HLS, and
 * gets what everyone can play.
 */
import { canPlayHevcTranscode, isHevcCodec, markHevcUnplayable } from "./hevc";

export type Cap = "hevc" | "av1" | "opus" | "flac" | "ac3" | "eac3";

export interface Caps {
  hevc: boolean;
  av1: boolean;
  opus: boolean;
  flac: boolean;
  ac3: boolean;
  eac3: boolean;
  /**
   * AV1 decoded by the GPU, so a re-encode may be made in AV1 for this player
   * (not a need: anyone who decodes AV1 at all plays it). Known once the
   * browser has answered (mediaCapabilities, asked at load); no until then.
   */
  av1Encode: boolean;
  /**
   * The screen is showing HDR now, so an HDR film is sent as it is (the
   * server's plan.ts PlayerCaps.hdr). Windows runs an HDR monitor in SDR
   * unless HDR is switched on, and doesn't switch it for a browser as video
   * players do; in SDR, the browser maps HDR down with SDR white at 203 nits,
   * about a stop darker than Plex, and brightening that picture afterwards
   * breaks dark scenes into bands (28 October). The server maps it from the
   * film's 10 bits instead, as Plex does. Taken back when the screen stops
   * showing HDR (useSync).
   */
  hdr: boolean;
}

const failedKey = (cap: Cap) => `pdt:codec-failed:${cap}`;

function failedHere(cap: Cap): boolean {
  try {
    return localStorage.getItem(failedKey(cap)) === "1";
  } catch {
    // Storage can be unavailable inside the Activity iframe.
    return false;
  }
}

function mediaSource(): { isTypeSupported(type: string): boolean } | null {
  const w = window as unknown as {
    MediaSource?: { isTypeSupported(type: string): boolean };
    ManagedMediaSource?: { isTypeSupported(type: string): boolean };
  };
  return w.MediaSource ?? w.ManagedMediaSource ?? null;
}

/** AV1 Main at level 4.1 — 1080p at up to 60 fps, which is all a copy is — in 8 and 10 bits. */
const AV1_CODECS = ["av01.0.09M.08", "av01.0.09M.10"];

function supports(type: string): boolean {
  try {
    return mediaSource()?.isTypeSupported(type) ?? false;
  } catch {
    return false;
  }
}

let av1Smooth = false;
// Asked once, at load: well before the room is joined.
try {
  const mc = (navigator as Navigator & { mediaCapabilities?: MediaCapabilities }).mediaCapabilities;
  void mc?.decodingInfo({
    type: "media-source",
    video: { contentType: `video/mp4; codecs="${AV1_CODECS[0]}"`, width: 1920, height: 1080, bitrate: 6_000_000, framerate: 24 },
  }).then((info) => { av1Smooth = info.supported && info.smooth && info.powerEfficient; }, () => {});
} catch {
  // No mediaCapabilities: no AV1 re-encodes for this player.
}

/** What this player decodes, as the room is told on joining. */
export function playerCaps(): Caps {
  const av1 = !failedHere("av1") && AV1_CODECS.every((c) => supports(`video/mp4; codecs="${c}"`));
  return {
    hevc: canPlayHevcTranscode(),
    av1,
    opus: !failedHere("opus") && supports('audio/mp4; codecs="opus"'),
    flac: !failedHere("flac") && supports('audio/mp4; codecs="flac"'),
    ac3: !failedHere("ac3") && supports('audio/mp4; codecs="ac-3"'),
    eac3: !failedHere("eac3") && supports('audio/mp4; codecs="ec-3"'),
    av1Encode: av1 && av1Smooth,
    hdr: hdrScreen(),
  };
}

/** Whether the screen is showing HDR now — see Caps. */
export function hdrScreen(): boolean {
  return hdrScreenQuery()?.matches ?? false;
}

/** The query that says whether the screen shows HDR; null where there is none. */
export function hdrScreenQuery(): MediaQueryList | null {
  try {
    return window.matchMedia("(dynamic-range: high)");
  } catch {
    return null;
  }
}

/** The frames' own transfer: PQ or HLG for HDR, as the browser decoded them.
 *  Null when it can't be read (no frame yet, or no VideoFrame here). */
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

/** What a stream uses beyond H.264 and AAC, from the codecs hls.js found in it. */
export function capsUsed(video: string | null | undefined, audio: string | null | undefined): Cap[] {
  const used: Cap[] = [];
  if (isHevcCodec(video)) used.push("hevc");
  if (/^av01/i.test(video ?? "")) used.push("av1");
  if (/^opus/i.test(audio ?? "")) used.push("opus");
  if (/^(flac|fLaC)/i.test(audio ?? "")) used.push("flac");
  if (/^(ac-3|mp4a\.a5)/i.test(audio ?? "")) used.push("ac3");
  if (/^(ec-3|mp4a\.a6)/i.test(audio ?? "")) used.push("eac3");
  return used;
}

/** This device said it decodes these and then didn't. Believed from now on. */
export function markUnplayable(caps: readonly Cap[]): void {
  for (const cap of caps) {
    if (cap === "hevc") {
      markHevcUnplayable();
      continue;
    }
    try {
      localStorage.setItem(failedKey(cap), "1");
    } catch {
      // Not remembered past this session; the room is still told.
    }
  }
}
