/**
 * What this player decodes beyond H.264 and AAC in MPEG-TS, which every one
 * does: HEVC (hevc.ts), and AV1, Opus and FLAC in fragmented MP4 as the ffmpeg
 * engine copies them — asked of Media Source Extensions, as hls.js feeds them.
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

export type Cap = "hevc" | "av1" | "opus" | "flac";

export interface Caps {
  hevc: boolean;
  av1: boolean;
  opus: boolean;
  flac: boolean;
  /**
   * AV1 decoded by the GPU, so a re-encode may be made in AV1 for this player
   * (not a need: anyone who decodes AV1 at all plays it). Known once the
   * browser has answered (mediaCapabilities, asked at load); no until then.
   */
  av1Encode: boolean;
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
    av1Encode: av1 && av1Smooth,
  };
}

/** What a stream uses beyond H.264 and AAC, from the codecs hls.js found in it. */
export function capsUsed(video: string | null | undefined, audio: string | null | undefined): Cap[] {
  const used: Cap[] = [];
  if (isHevcCodec(video)) used.push("hevc");
  if (/^av01/i.test(video ?? "")) used.push("av1");
  if (/^opus/i.test(audio ?? "")) used.push("opus");
  if (/^(flac|fLaC)/i.test(audio ?? "")) used.push("flac");
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
