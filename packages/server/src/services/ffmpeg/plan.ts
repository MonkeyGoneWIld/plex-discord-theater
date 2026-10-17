/**
 * What the ffmpeg engine does with one file, and the ffmpeg arguments for it.
 * Pure: everything it needs comes from Plex's metadata for the file, so it can
 * be tested without ffmpeg or Plex.
 *
 * Copies (planCopy): the video as it is (H.264, or HEVC for a player that
 * decodes it, HDR included), the audio as it is when it is AAC and as AAC
 * otherwise. Re-encodes (planEncode): HEVC Main10 for a player that decodes
 * HEVC, H.264 High for the rest, on Intel's GPU (QSV) or the CPU; an HEVC
 * re-encode of an HDR file stays HDR. What needs tone mapping (HDR to H.264,
 * Dolby Vision 5) is left to Plex until that is built.
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
  colorPrimaries?: string;
  colorSpace?: string;
  colorRange?: string;
  /** "interlaced" or "progressive", when Plex knows. */
  scanType?: string;
  anamorphic?: boolean | string;
  /** "4:3" and the like, on an anamorphic one. */
  pixelAspectRatio?: string;
  frameRate?: number;
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

  const audio = pickAudio(src, req.audioStreamId);
  if (audio === false) return no(`no audio track ${req.audioStreamId}`);
  return {
    ok: true,
    video: video as SourceStream & { index: number },
    audio,
    audioCopy: (audio?.codec ?? "").toLowerCase() === "aac",
    codec,
    hdr,
    width,
    height,
  };
}

/** The track a stream is for (0 or null: the item's choice, as Plex takes it);
 *  null for a file with none, false for a track it hasn't got. */
function pickAudio(src: SourceVersion, audioStreamId: number | null): (SourceStream & { index: number }) | null | false {
  const audios = src.streams.filter((s): s is SourceStream & { index: number } =>
    s.streamType === 2 && s.index != null && !s.key);
  const audio = audioStreamId
    ? audios.find((a) => a.id === audioStreamId)
    : audios.find((a) => a.selected) ?? audios.find((a) => a.default) ?? audios[0];
  if (audioStreamId && !audio) return false;
  return audio ?? null;
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
  return [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    ...(offsetS > 0 ? ["-ss", String(offsetS)] : []),
    "-copyts", "-start_at_zero",
    ...input,
    "-map", `0:${plan.video.index}`,
    ...(plan.audio ? ["-map", `0:${plan.audio.index}`] : []),
    "-c:v", "copy",
    ...audioArgs(plan),
    ...segmentArgs(offsetS, durationS, segmentSeconds),
  ];
}

/** The audio as it is when it is AAC, as AAC stereo otherwise. */
function audioArgs(plan: { audio: SourceStream | null; audioCopy: boolean }): string[] {
  return !plan.audio
    ? []
    : plan.audioCopy
      ? ["-c:a", "copy"]
      : ["-c:a", "aac", "-ac", "2", "-b:a", `${AUDIO_KBPS}k`, "-af", "aresample=async=1"];
}

/** Numbered MPEG-TS segments cut every `segmentSeconds` from the first packet,
 *  on the copy's clock, each announced on stdout once it is complete. */
function segmentArgs(offsetS: number, durationS: number | null, segmentSeconds: number): string[] {
  // Past the last listed cut the segment runs to the end of the file, so the
  // list covers what's left with room to spare; 6 h when Plex has no length.
  const leftS = Math.max(0, (durationS && durationS > 0 ? durationS : 6 * 3600) - offsetS) + 120;
  const cuts = Array.from({ length: Math.ceil(leftS / segmentSeconds) }, (_, i) => (i + 1) * segmentSeconds);
  return [
    "-output_ts_offset", String(COPY_CLOCK_OFFSET_S),
    "-f", "segment",
    "-segment_format", "mpegts",
    "-segment_format_options", "mpegts_copyts=1",
    "-segment_times", cuts.join(","),
    // A keyframe exactly on a cut — every one of a re-encode's — was taken
    // for the next one, making 6 s segments; Plex cuts 1/16 s early too.
    "-segment_time_delta", "0.0625",
    "-reset_timestamps", "0",
    "-segment_list", "pipe:1",
    "-segment_list_type", "csv",
    "%05d.ts",
  ];
}

// ─── Re-encodes ─────────────────────────────────────────────────

/** What re-encodes run on: Intel's GPU through QSV, or the CPU (H.264 only —
 *  software HEVC can't keep up). */
export type Hardware = "qsv" | "software";

/** What Intel's GPU decodes on the 265K (Phase 0). VC-1, MPEG-4 and 10-bit
 *  H.264 aren't: they're decoded on the CPU and handed to it. */
const GPU_DECODES = new Set(["h264", "hevc", "av1", "vp9", "mpeg2video"]);

/** VAAPI on the render node and QSV derived from it, as Jellyfin sets Intel up
 *  on Linux — what Phase 0 ran on the 265K. */
export function qsvInit(device: string): string[] {
  return ["-init_hw_device", `vaapi=va:${device},driver=iHD`, "-init_hw_device", "qsv=qs@va", "-filter_hw_device", "qs"];
}

export interface ColorLabels {
  primaries: string;
  trc: string;
  matrix: string;
  range: "tv" | "pc";
  /** setparams for the labels the file leaves out, ahead of the first GPU
   *  filter; null when it has them all. */
  fill: string | null;
}

const known = (v: string | undefined): v is string =>
  !!v && !["unknown", "unspecified", "reserved"].includes(v.toLowerCase());

/**
 * The color labels a re-encode reads its source by and writes on its output.
 * Intel's scaler refuses video whose matrix isn't recorded ("Function not
 * implemented" two frames in, Phase 0 run 1), so a missing label gets what
 * players assume anyway: BT.709 for HD; BT.601 for SD, PAL's at 25 or 50 fps
 * and NTSC's otherwise; TV range.
 */
export function colorLabels(v: SourceStream, height: number): ColorLabels {
  const fps = Number(v.frameRate) || 24;
  const sd = height > 0 && height <= 576;
  const pal = sd && (Math.abs(fps - 25) < 0.5 || Math.abs(fps - 50) < 0.5);
  const fallback = !sd
    ? { primaries: "bt709", trc: "bt709", matrix: "bt709" }
    : pal
      ? { primaries: "bt470bg", trc: "gamma28", matrix: "bt470bg" }
      : { primaries: "smpte170m", trc: "smpte170m", matrix: "smpte170m" };
  const fill = [
    !known(v.colorPrimaries) && `color_primaries=${fallback.primaries}`,
    !known(v.colorTrc) && `color_trc=${fallback.trc}`,
    !known(v.colorSpace) && `colorspace=${fallback.matrix}`,
    !known(v.colorRange) && "range=tv",
  ].filter((p): p is string => !!p);
  return {
    primaries: known(v.colorPrimaries) ? v.colorPrimaries : fallback.primaries,
    trc: known(v.colorTrc) ? v.colorTrc : fallback.trc,
    matrix: known(v.colorSpace) ? v.colorSpace : fallback.matrix,
    range: v.colorRange?.toLowerCase() === "pc" ? "pc" : "tv",
    fill: fill.length ? `setparams=${fill.join(":")}` : null,
  };
}

/** A re-encode's picture: square pixels, inside maxW × maxH, never larger
 *  than the file's, even sides. */
export function encodeFrame(
  width: number, height: number, pixelAspect: string | undefined, maxW: number, maxH: number,
): [number, number] {
  const [num, den] = String(pixelAspect ?? "").split(":").map(Number);
  const sar = num > 0 && den > 0 ? num / den : 1;
  const displayW = width * sar;
  const scale = Math.min(1, maxW / displayW, maxH / height);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return [even(displayW * scale), even(height * scale)];
}

export interface EncodeRequest {
  audioStreamId: number | null;
  /** HEVC out: the player decodes it, and HEVC_TRANSCODE allows it. */
  hevcOk: boolean;
  hardware: Hardware;
  /** Target and peak, kbps — worked out as for a Plex re-encode. */
  kbps: number;
  peakKbps: number;
  /** The largest picture: transcodeFrame's, or 720p at the lowest level. */
  maxWidth: number;
  maxHeight: number;
  /** FFMPEG_HDR_REENCODE=keep: an HEVC re-encode of an HDR file stays HDR. */
  keepHdr: boolean;
  /** Decode on the GPU where it can; false for the retry after it couldn't. */
  gpuDecode?: boolean;
}

export type EncodePlan =
  | {
      ok: true;
      video: SourceStream & { index: number };
      audio: (SourceStream & { index: number }) | null;
      audioCopy: boolean;
      codec: "h264" | "hevc";
      hdr: string;
      /** The HDR transfer written on the output (smpte2084 or arib-std-b67);
       *  null for SDR. */
      hdrTrc: string | null;
      width: number;
      height: number;
      hardware: Hardware;
      gpuDecode: boolean;
      interlaced: boolean;
      color: ColorLabels;
      kbps: number;
      peakKbps: number;
    }
  | { ok: false; why: string };

/** How ffmpeg re-encodes this version for a player, or why it doesn't. */
export function planEncode(src: SourceVersion, req: EncodeRequest): EncodePlan {
  const no = (why: string): EncodePlan => ({ ok: false, why });
  const video = src.streams.find((s) => s.streamType === 1);
  if (!video || video.index == null) return no("no video stream");
  const width = src.width ?? 0;
  const height = src.height ?? 0;
  if (width <= 0 || height <= 0) return no("picture size unknown");
  const codec = req.hevcOk && req.hardware === "qsv" ? "hevc" : "h264";
  const hdr = hdrClass(video);
  if (hdr !== "SDR") {
    if (hdr === "DV P5" || hdr === "DV P10.0") return no(`Dolby Vision ${hdr.slice(3)} needs tone mapping`);
    if (codec === "h264") return no(`${hdr} to H.264 needs tone mapping`);
    if (!req.keepHdr) return no(`${hdr} needs tone mapping (FFMPEG_HDR_REENCODE=tonemap)`);
  }
  const audio = pickAudio(src, req.audioStreamId);
  if (audio === false) return no(`no audio track ${req.audioStreamId}`);
  const inCodec = (video.codec ?? "").toLowerCase();
  const [w, h] = encodeFrame(
    width, height, video.anamorphic ? video.pixelAspectRatio : undefined, req.maxWidth, req.maxHeight,
  );
  return {
    ok: true,
    video: video as SourceStream & { index: number },
    audio,
    audioCopy: (audio?.codec ?? "").toLowerCase() === "aac",
    codec,
    hdr,
    hdrTrc: hdr === "SDR" ? null : String(video.colorTrc ?? "").toLowerCase() === "arib-std-b67" ? "arib-std-b67" : "smpte2084",
    width: w,
    height: h,
    hardware: req.hardware,
    gpuDecode: req.hardware === "qsv" && req.gpuDecode !== false && GPU_DECODES.has(inCodec) &&
      !(inCodec === "h264" && (video.bitDepth ?? 8) > 8),
    interlaced: /interlaced/i.test(video.scanType ?? ""),
    color: colorLabels(video, height),
    kbps: req.kbps,
    peakKbps: req.peakKbps,
  };
}

/** Re-encodes are cut every 3 s, as Plex's are. */
export const ENCODE_SEGMENT_S = 3;

/**
 * ffmpeg's arguments for a re-encode from `offsetS`, segmented as a copy is
 * (same clock, same announcements). Decode, label fill, deinterlace and scale
 * are Phase 0's chain on the 265K: on the GPU (VAAPI, mapped to QSV) when it
 * decodes the codec, else on the CPU and uploaded. Keyframes are forced on a
 * 3 s grid, which ffmpeg counts from the run's first frame, so every cut
 * lands on one. Rate control is VBR: target, peak, twice the peak's buffer
 * (§8.4). QSV picks CBR, which pads with filler, when the two are equal, so
 * the peak is always at least a little above the target.
 */
export function encodeArgs(
  plan: Extract<EncodePlan, { ok: true }>,
  input: string[],
  offsetS: number,
  durationS: number | null,
  device: string,
): string[] {
  const W = plan.width;
  const H = plan.height;
  const fmt = plan.codec === "hevc" ? "p010" : "nv12";
  const fill = plan.color.fill ? `${plan.color.fill},` : "";
  const deinterlaceCpu = plan.interlaced ? "bwdif=mode=send_frame," : "";
  const vf = plan.hardware === "qsv"
    ? plan.gpuDecode
      ? `${fill}${plan.interlaced ? "deinterlace_vaapi=rate=frame," : ""}scale_vaapi=w=${W}:h=${H}:format=${fmt},hwmap=derive_device=qsv,format=qsv`
      : `${fill}${deinterlaceCpu}scale=${W}:${H},format=${fmt === "p010" ? "p010le" : fmt},hwupload=extra_hw_frames=64,format=qsv`
    : `${fill}${deinterlaceCpu}scale=${W}:${H},format=yuv420p`;
  const peak = Math.max(plan.peakKbps, plan.kbps + 1);
  const encoder = plan.hardware === "qsv"
    ? ["-c:v", `${plan.codec}_qsv`, "-low_power", "1", "-profile:v", plan.codec === "hevc" ? "main10" : "high",
        "-preset", "medium", "-b:v", `${plan.kbps}k`, "-maxrate", `${peak}k`, "-bufsize", `${peak * 2}k`,
        "-forced_idr", "1"]
    : ["-c:v", "libx264", "-preset", "faster", "-tune", "film", "-profile:v", "high", "-crf", "20",
        "-maxrate", `${peak}k`, "-bufsize", `${peak * 2}k`, "-forced-idr", "1"];
  const tags = plan.hdrTrc
    ? ["-color_primaries", "bt2020", "-color_trc", plan.hdrTrc, "-colorspace", "bt2020nc", "-color_range", "tv"]
    : ["-color_primaries", plan.color.primaries, "-color_trc", plan.color.trc, "-colorspace", plan.color.matrix,
        "-color_range", plan.color.range];
  return [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    ...(plan.hardware === "qsv" ? qsvInit(device) : []),
    ...(plan.gpuDecode ? ["-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi", "-hwaccel_device", "va"] : []),
    ...(offsetS > 0 ? ["-ss", String(offsetS)] : []),
    "-copyts", "-start_at_zero",
    ...input,
    "-map", `0:${plan.video.index}`,
    ...(plan.audio ? ["-map", `0:${plan.audio.index}`] : []),
    "-vf", vf,
    ...encoder,
    ...tags,
    "-aspect", `${W}:${H}`,
    "-force_key_frames:v", `expr:gte(t,n_forced*${ENCODE_SEGMENT_S})`,
    ...audioArgs(plan),
    // Audio piles up while the GPU encoder starts; ffmpeg's default queue is
    // too short for that.
    "-max_muxing_queue_size", "4096",
    ...segmentArgs(offsetS, durationS, ENCODE_SEGMENT_S),
  ];
}
