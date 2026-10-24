/**
 * What Plex does with a stream's audio, for "Stats for nerds": copies it as
 * it is in the file, or converts it — from what, to what, and why.
 *
 * Plex's decision says copy or transcode for the audio stream and what comes
 * out (codec, channels, bitrate), but not why. The why follows from what the
 * player is offered: AAC only (see X-Plex-Client-Profile-Extra in
 * routes/plex.ts), so audio in any other codec is converted, and AAC is
 * copied. Rear Window's EAC3 Stereo came out as AAC Stereo at 256 kbps.
 */

/** The audio stream in Plex's decision: what it does and what comes out. */
export interface AudioDecision {
  id: number | null;
  decision: string | null;
  codec: string | null;
  channels: number | null;
  bitrate: number | null;
}

/** An audio track as the file has it. */
export interface SourceAudio {
  id: number;
  codec: string | null;
  channels: number | null;
}

export interface AudioNotes {
  audio: "copy" | "transcode" | null;
  audioFrom: string | null;
  audioTo: string | null;
  audioKbps: number | null;
  audioReason: string | null;
}

const CODEC_NAMES: Record<string, string> = {
  aac: "AAC", ac3: "AC3", eac3: "EAC3", truehd: "TrueHD", dca: "DTS", "dca-ma": "DTS-HD MA", dts: "DTS",
  flac: "FLAC", mp3: "MP3", mp2: "MP2", opus: "Opus", vorbis: "Vorbis", pcm: "PCM", alac: "ALAC",
};
const CHANNEL_NAMES: Record<number, string> = { 1: "Mono", 2: "Stereo", 6: "5.1", 7: "6.1", 8: "7.1" };

export function codecName(codec: string | null | undefined): string | null {
  if (!codec) return null;
  return CODEC_NAMES[codec.toLowerCase()] ?? codec.toUpperCase();
}

/** "EAC3 Stereo", "TrueHD 7.1"; as much of it as is known. */
export function audioName(codec: string | null | undefined, channels: number | null | undefined): string | null {
  const parts = [codecName(codec), channels ? CHANNEL_NAMES[channels] ?? `${channels} channels` : null].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

/**
 * The notes for a stream's audio, from Plex's decision and the file's tracks.
 * `why` is the ffmpeg engine's own reason for converting it, which it knows.
 */
export function audioNotes(decided: AudioDecision | null, tracks: readonly SourceAudio[], why?: string | null): AudioNotes {
  const none: AudioNotes = { audio: null, audioFrom: null, audioTo: null, audioKbps: null, audioReason: null };
  const decision = decided?.decision;
  if (decision !== "copy" && decision !== "transcode") return none;
  const source = tracks.find((t) => t.id === decided!.id) ?? null;
  const from = audioName(source?.codec, source?.channels);
  if (decision === "copy") {
    return { ...none, audio: "copy", audioFrom: from ?? audioName(decided!.codec, decided!.channels) };
  }
  const sourceCodec = source?.codec?.toLowerCase() ?? null;
  let reason: string;
  if (why) {
    reason = why;
  } else if (sourceCodec && sourceCodec !== "aac") {
    reason = `Unsupported codec (${codecName(sourceCodec)})`;
  } else if (sourceCodec === "aac" && source?.channels && decided!.channels && decided!.channels < source.channels) {
    reason = `Downmixed from ${audioName(null, source.channels)} to ${audioName(null, decided!.channels)}`;
  } else {
    reason = "Not stated by Plex";
  }
  return {
    audio: "transcode",
    audioFrom: from,
    audioTo: audioName(decided!.codec, decided!.channels),
    audioKbps: decided!.bitrate && decided!.bitrate > 0 ? decided!.bitrate : null,
    audioReason: reason,
  };
}
