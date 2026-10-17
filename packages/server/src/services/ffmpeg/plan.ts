/**
 * What the ffmpeg engine does with one file, and the ffmpeg arguments for it.
 * Pure: everything it needs comes from Plex's metadata for the file, so it can
 * be tested without ffmpeg or Plex.
 *
 * Phase 1 copies: the video as it is (H.264, or HEVC for a player that decodes
 * it, HDR included), the audio as it is when it is AAC and as AAC otherwise.
 * Anything it can't copy is left to Plex, which re-encodes it as before.
 */

/** A stream of the file, as Plex's /library/metadata describes it. */
export interface SourceStream {
  id: number;
  streamType: number;
  /** Its place among the file's streams: ffmpeg's `-map 0:<index>`. Phase 0
   *  checked Plex's numbering against ffprobe's on the library: they agree. */
  index?: number;
  codec?: string;
  bitDepth?: number;
  channels?: number;
  /** Plex's current choice for the item, and the file's own default. */
  selected?: boolean;
  default?: boolean;
  /** Present on a sidecar: a file of its own, not a stream of this one. */
  key?: string;
  colorTrc?: string;
  DOVIPresent?: boolean;
  DOVIProfile?: number;
  DOVIBLCompatID?: number;
}

/** One version of a title: its file and streams. */
export interface SourceVersion {
  container: string | null;
  width: number | null;
  height: number | null;
  /** Where Plex serves the file, for reading it when it isn't mounted here. */
  partKey: string | null;
  /** The file as Plex sees it. */
  file: string | null;
  /** The title's length, seconds, when Plex knows it. */
  durationS?: number | null;
  streams: SourceStream[];
}

/** HDR as Plex describes a video stream. */
export function hdrClass(v: SourceStream | undefined): string {
  if (!v) return "SDR";
  if (v.DOVIPresent || v.DOVIProfile != null) {
    const p = Number(v.DOVIProfile);
    const bl = Number(v.DOVIBLCompatID);
    if (p === 8) return bl === 1 ? "DV P8.1" : bl === 4 ? "DV P8.4" : bl === 2 ? "DV P8.2" : "DV P8";
    // AV1's Dolby Vision: 10.1 has an HDR10 picture underneath, 10.0 nothing, like 5.
    if (p === 10) return bl === 1 ? "DV P10.1" : bl === 4 ? "DV P10.4" : bl === 2 ? "DV P10.2" : "DV P10.0";
    return Number.isFinite(p) ? `DV P${p}` : "DV";
  }
  const trc = String(v.colorTrc ?? "").toLowerCase();
  if (trc === "smpte2084") return "HDR10";
  if (trc === "arib-std-b67") return "HLG";
  return "SDR";
}

/** Containers whose H.264 and HEVC copy cleanly into MPEG-TS. */
const COPY_CONTAINERS = new Set(["mkv", "mp4", "m4v", "mov", "mpegts", "ts", "m2ts"]);

export type CopyPlan =
  | {
      ok: true;
      video: SourceStream & { index: number };
      audio: (SourceStream & { index: number }) | null;
      /** AAC already: copied as it is. Anything else becomes AAC stereo. */
      audioCopy: boolean;
      codec: "h264" | "hevc";
      hdr: string;
      width: number;
      height: number;
    }
  | { ok: false; why: string };

/**
 * Whether ffmpeg can copy this version for a player, and what with. `audioStreamId`
 * is the track the stream is for (0 or null: the item's choice, as Plex takes
 * it); `hevcOk` whether the player driving it decodes HEVC.
 */
export function planCopy(src: SourceVersion, req: { audioStreamId: number | null; hevcOk: boolean }): CopyPlan {
  const no = (why: string): CopyPlan => ({ ok: false, why });
  const video = src.streams.find((s) => s.streamType === 1);
  if (!video || video.index == null) return no("no video stream");
  const codec = (video.codec ?? "").toLowerCase();
  if (codec !== "h264" && codec !== "hevc") return no(`video is ${codec || "unknown"}`);
  if (codec === "h264" && (video.bitDepth ?? 8) > 8) return no(`${video.bitDepth}-bit H.264`);
  if (codec === "hevc" && (video.bitDepth ?? 8) > 10) return no(`${video.bitDepth}-bit HEVC`);
  if (codec === "hevc" && !req.hevcOk) return no("HEVC, and this player can't decode it");
  const hdr = hdrClass(video);
  // No HDR10 picture under the Dolby Vision: only a tone mapper that applies
  // it draws it right (Phase 2).
  if (hdr === "DV P5" || hdr === "DV P10.0") return no(`Dolby Vision ${hdr.slice(3)} needs tone mapping`);
  const width = src.width ?? 0;
  const height = src.height ?? 0;
  // 4K is shown at 1080p, as Plex does: the activity can't show more.
  if (width > 2048 || height > 1200) return no("above 1080p");
  const container = (src.container ?? "").toLowerCase();
  if (!COPY_CONTAINERS.has(container)) return no(`${container || "unknown"} container`);

  const audios = src.streams.filter((s): s is SourceStream & { index: number } =>
    s.streamType === 2 && s.index != null && !s.key);
  const audio = req.audioStreamId
    ? audios.find((a) => a.id === req.audioStreamId)
    : audios.find((a) => a.selected) ?? audios.find((a) => a.default) ?? audios[0];
  if (req.audioStreamId && !audio) return no(`no audio track ${req.audioStreamId}`);
  return {
    ok: true,
    video: video as SourceStream & { index: number },
    audio: audio ?? null,
    audioCopy: (audio?.codec ?? "").toLowerCase() === "aac",
    codec,
    hdr,
    width,
    height,
  };
}

/** Bitrate of the AAC a converted track becomes, kbps. */
export const AUDIO_KBPS = 256;

/**
 * How far ahead of the film's time a copy's clock runs, as Plex's does
 * (direct-stream.ts PLEX_TS_OFFSET_S). hls.js takes a track that opens less
 * than 1 s past its listed start for a 33-bit clock rollover and leaves it out
 * of its start time: with the film's own clock, the copy's picture (listed
 * where it opens) was set aside and its sound, a few seconds later after a
 * seek, set the start, so the whole copy played that much early — 2 to 4 s
 * ahead of a Plex re-encode at the same bar position on 17 October.
 */
export const COPY_CLOCK_OFFSET_S = 10;

/** Where ffmpeg reads the file from: the mount, or Plex with the token in a header. */
export function inputArgs(source: { local: string } | { url: string; token: string }): string[] {
  return "local" in source
    // Nothing but the file: a playlist or concat file in the library can't send
    // ffmpeg anywhere else.
    ? ["-protocol_whitelist", "file", "-i", source.local]
    : ["-protocol_whitelist", "http,https,tcp,tls", "-headers", `X-Plex-Token: ${source.token}\r\n`, "-i", source.url];
}

/**
 * ffmpeg's arguments for a copy from `offsetS`, into numbered MPEG-TS segments
 * in its working folder, each announced on stdout once it is complete.
 *
 * Timestamps are the film's own (-copyts -start_at_zero, and the muxer's
 * mpegts_copyts so it doesn't add its own 1.4 s) plus COPY_CLOCK_OFFSET_S,
 * which the engine takes off again to lay out the playlist. A copy is cut at the first keyframe past every
 * `segmentSeconds`; a seek starts at the keyframe before `offsetS`, and the
 * audio there.
 *
 * The cuts are listed (-segment_times) rather than left to -segment_time.
 * The segment muxer counts its times from the first packet, and Jellyfin's
 * build adds that start a second time to -segment_time, so after a seek to
 * 300 s its first cut came near 600 s: one 300 s segment the player waited
 * half a minute for, and none at all in time for a seek near the end. Listed
 * times are counted from the first packet once, by every build.
 */
export function copyArgs(
  plan: Extract<CopyPlan, { ok: true }>,
  input: string[],
  offsetS: number,
  durationS: number | null = null,
  segmentSeconds = 4,
): string[] {
  const audio = !plan.audio
    ? []
    : plan.audioCopy
      ? ["-c:a", "copy"]
      : ["-c:a", "aac", "-ac", "2", "-b:a", `${AUDIO_KBPS}k`, "-af", "aresample=async=1"];
  // Past the last listed cut the segment runs to the end of the file, so the
  // list covers what's left with room to spare; 6 h when Plex has no length.
  const leftS = Math.max(0, (durationS && durationS > 0 ? durationS : 6 * 3600) - offsetS) + 120;
  const cuts = Array.from({ length: Math.ceil(leftS / segmentSeconds) }, (_, i) => (i + 1) * segmentSeconds);
  return [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    ...(offsetS > 0 ? ["-ss", String(offsetS)] : []),
    "-copyts", "-start_at_zero",
    ...input,
    "-map", `0:${plan.video.index}`,
    ...(plan.audio ? ["-map", `0:${plan.audio.index}`] : []),
    "-c:v", "copy",
    ...audio,
    "-output_ts_offset", String(COPY_CLOCK_OFFSET_S),
    "-f", "segment",
    "-segment_format", "mpegts",
    "-segment_format_options", "mpegts_copyts=1",
    "-segment_times", cuts.join(","),
    "-reset_timestamps", "0",
    "-segment_list", "pipe:1",
    "-segment_list_type", "csv",
    "%05d.ts",
  ];
}
