/**
 * What the ffmpeg engine does with one file, and the ffmpeg arguments for it.
 * Pure: everything it needs comes from Plex's metadata for the file, so it can
 * be tested without ffmpeg or Plex.
 *
 * Copies (planCopy): the video as it is (H.264, or HEVC for a player that
 * decodes it, HDR included), the audio as it is when it is AAC — or Opus,
 * FLAC, AC3 or EAC3 for a player that decodes them — and as AAC otherwise,
 * but for PCM, made FLAC, and 7.1, made Opus 7.1, for a player that decodes
 * those (convertedAudio).
 * Re-encodes (planEncode): HEVC Main10 for a player that decodes
 * HEVC, H.264 High for the rest, on a GPU (Intel's QSV, VAAPI, NVIDIA's NVENC)
 * or the CPU, at the quality level's bitrate or what the source needs, if
 * less; an HEVC re-encode of an HDR file stays HDR. The rest of HDR — for an
 * H.264 player, Dolby Vision 5, FFMPEG_HDR_REENCODE=tonemap — is tone-mapped
 * to H.264 SDR. A subtitle burned in — a picture one (PGS, VobSub, DVB) in the
 * file or beside it, or a text one drawn by libass — goes into an H.264 SDR
 * picture.
 */
import { audioName, codecName } from "../stream-audio.js";

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
  /** kbps, when Plex knows: an audio track's is what a copy of it carries. */
  bitrate?: number;
  /** Plex's current choice for the item, and the file's own default. */
  selected?: boolean;
  default?: boolean;
  /** Present on a sidecar: a file of its own, not a stream of this one. */
  key?: string;
  language?: string;
  /** ISO 639-2 ("eng"), and Plex's tag for it ("en"). */
  languageCode?: string;
  languageTag?: string;
  /** A subtitle's flags, and its name ("English (SDH)"): for finding a sidecar. */
  forced?: boolean;
  hearingImpaired?: boolean;
  title?: string;
  displayTitle?: string;
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
  /** The file's bitrate, kbps, when Plex knows it: picture and sound. */
  bitrateKbps?: number | null;
  /** Bytes, as Plex last read the file; and the part's id. */
  fileSize?: number | null;
  partId?: number | null;
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

/**
 * Whether a picture of this class (hdrClass) is HDR as a player shows it: PQ
 * or HLG. Dolby Vision's 8.2 and 10.2 are SDR underneath, and that is all a
 * browser shows of them.
 */
export function hdrPicture(hdr: string): boolean {
  return hdr !== "SDR" && hdr !== "DV P8.2" && hdr !== "DV P10.2";
}

/** Containers whose H.264 and HEVC copy cleanly into MPEG-TS. */
const COPY_CONTAINERS = new Set(["mkv", "mp4", "m4v", "mov", "mpegts", "ts", "m2ts"]);
/** And whose AV1 copies into fragmented MP4: a WebM's too. */
const FMP4_CONTAINERS = new Set([...COPY_CONTAINERS, "webm"]);

/**
 * What a player decodes beyond H.264 and AAC in MPEG-TS, which every one
 * does: each in fragmented MP4, HEVC in either. Asked of the player itself
 * (the client's codecs.ts), and each stream made for what its driver decodes —
 * whoever on it can't play that gets a stream of their own (the sync server's
 * seatOf).
 */
export interface PlayerCaps {
  hevc: boolean;
  av1: boolean;
  opus: boolean;
  flac: boolean;
  /** Dolby Digital, and Digital Plus: Edge and Safari decode them, and
   *  Chromium where the system has a decoder for them. */
  ac3: boolean;
  eac3: boolean;
  /**
   * The screen shows HDR now, so an HDR picture is shown as it is. On a
   * screen in SDR Chrome maps HDR's reference white to half the screen's
   * light, a stop or more darker than Plex's players, and nothing done to
   * the picture after that mends it: the player's lift on the 8-bit picture
   * Chrome drew (28 October) matched the colours of Plex's app for Windows
   * but broke dark scenes into bands and blocks — Avengers: Endgame at 32:00.
   * So a player on such a screen is sent HDR tone-mapped by the server from
   * the film's own 10 bits, as Plex's SDR versions are, which were clean in
   * the same scene.
   */
  hdr: boolean;
}
export type PlayerCap = keyof PlayerCaps;
export const PLAYER_CAPS: readonly PlayerCap[] = ["hevc", "av1", "opus", "flac", "ac3", "eac3", "hdr"];
export const NO_CAPS: PlayerCaps = { hevc: false, av1: false, opus: false, flac: false, ac3: false, eac3: false, hdr: false };
export const ALL_CAPS: PlayerCaps = { hevc: true, av1: true, opus: true, flac: true, ac3: true, eac3: true, hdr: true };

/**
 * Sound copied as it is, in fragmented MP4, for a player that decodes it: by
 * Plex's name for the codec, the cap it needs. AAC every player decodes, in
 * MPEG-TS too. DTS and TrueHD no browser here does: they become AAC.
 */
const AUDIO_CAPS: Record<string, PlayerCap> = { opus: "opus", flac: "flac", ac3: "ac3", eac3: "eac3" };

/** The cap a copy of this sound needs; null for AAC, or sound never copied. */
export function audioCapOf(codec: string | null | undefined): PlayerCap | null {
  return AUDIO_CAPS[(codec ?? "").toLowerCase()] ?? null;
}

/**
 * Whether a track is copied as it is for a player that decodes `caps`, and,
 * when it isn't, why — for Stats for nerds. FLAC only within
 * FLAC_COPY_MAX_KBPS, or stereo when Plex doesn't say.
 */
export function copiedAudio(audio: SourceStream | null, caps: Partial<PlayerCaps>): { copy: boolean; why: string | null } {
  if (!audio) return { copy: false, why: null };
  const codec = (audio.codec ?? "").toLowerCase();
  if (codec === "aac") return { copy: true, why: null };
  const name = codecName(codec) ?? "This sound";
  const cap = AUDIO_CAPS[codec];
  if (!cap) {
    return { copy: false, why: /^(dca|dts|truehd|mlp)/.test(codec) ? `${name}: no browser decoder` : `${name}: not supported for copy` };
  }
  if (!caps[cap]) return { copy: false, why: `${name}: not decoded by this player` };
  if (codec === "flac" && !(audio.bitrate ? audio.bitrate <= FLAC_COPY_MAX_KBPS : (audio.channels ?? 2) <= 2)) {
    return {
      copy: false,
      why: audio.bitrate
        ? `${name} ${audio.bitrate.toLocaleString("en-US")} kbps: above copy limit`
        : `${audioName(codec, audio.channels)}: above copy limit`,
    };
  }
  return { copy: true, why: null };
}

/**
 * FLAC above this, kbps, becomes AAC rather than being copied: 5.1 at 24 bits
 * can be 4 Mbps of sound, sent to every viewer wherever they are. Stereo at
 * 16 bits is about 1 Mbps.
 */
export const FLAC_COPY_MAX_KBPS = 2_000;

export type CopyPlan =
  | {
      ok: true;
      video: SourceStream & { index: number };
      audio: (SourceStream & { index: number }) | null;
      /** Copied as it is: AAC, or Opus, FLAC, AC3 or EAC3 for a player that
       *  decodes it (copiedAudio). Anything else becomes AAC (audioOut). */
      audioCopy: boolean;
      /** Why it became AAC, when it did. */
      audioWhy: string | null;
      /** What a converted track becomes; null when it is copied, or there is none. */
      audioOut: AudioOut | null;
      codec: "h264" | "hevc" | "av1";
      /** In fragmented MP4 rather than MPEG-TS: AV1, Opus and FLAC don't go into MPEG-TS for a browser. */
      fmp4: boolean;
      hdr: string;
      width: number;
      height: number;
    }
  | { ok: false; why: string };

/**
 * Whether ffmpeg can copy this version for a player, and what with. `audioStreamId`
 * is the track the stream is for (0 or null: the item's choice, as Plex takes
 * it); `hevcOk`, `av1Ok`, `opusOk` and `flacOk` what the player driving it
 * decodes, and `hdrOk` whether its screen shows HDR (PlayerCaps);
 * `audioChannels` FFMPEG_AUDIO_CHANNELS (convertedAudio).
 */
export function planCopy(
  src: SourceVersion,
  req: {
    audioStreamId: number | null; hevcOk: boolean; av1Ok?: boolean; opusOk?: boolean; flacOk?: boolean;
    ac3Ok?: boolean; eac3Ok?: boolean; hdrOk?: boolean; audioChannels?: number;
  },
): CopyPlan {
  const no = (why: string): CopyPlan => ({ ok: false, why });
  const video = src.streams.find((s) => s.streamType === 1);
  if (!video || video.index == null) return no("no video stream");
  const codec = (video.codec ?? "").toLowerCase();
  if (codec !== "h264" && codec !== "hevc" && codec !== "av1") return no(`video is ${codec || "unknown"}`);
  if (codec === "h264" && (video.bitDepth ?? 8) > 8) return no(`${video.bitDepth}-bit H.264`);
  // Field by field, as TV is broadcast: Chrome's decoder gave up on the first
  // segment of Cunk on Shakespeare's 1080i copy on 21 October, for both
  // players and every retry, and a picture it did decode would be combed.
  // The re-encode deinterlaces it. HEVC marked interlaced is copied: His Dark
  // Materials' showed no combing that day.
  if (codec === "h264" && /interlaced/i.test(video.scanType ?? "")) return no("Interlaced H.264");
  if (codec === "hevc" && (video.bitDepth ?? 8) > 10) return no(`${video.bitDepth}-bit HEVC`);
  if (codec === "hevc" && !req.hevcOk) return no("HEVC: not decoded by this player");
  if (codec === "av1" && (video.bitDepth ?? 8) > 10) return no(`${video.bitDepth}-bit AV1`);
  if (codec === "av1" && !req.av1Ok) return no("AV1: not decoded by this player");
  const hdr = hdrClass(video);
  // No HDR10 picture under the Dolby Vision: only a tone mapper that applies
  // it draws it right (Phase 2).
  if (hdr === "DV P5" || hdr === "DV P10.0") return no(`Dolby Vision ${hdr.slice(3)}: tone mapping needed`);
  // Tone-mapped by the server for a screen in SDR: see PlayerCaps.hdr.
  if (hdrPicture(hdr) && !req.hdrOk) return no(`${hdr} for a screen in SDR`);
  const width = src.width ?? 0;
  const height = src.height ?? 0;
  // 4K is shown at 1080p, as Plex does: the activity can't show more.
  if (width > 2048 || height > 1200) return no("Above 1080p");
  const container = (src.container ?? "").toLowerCase();
  if (!(codec === "av1" ? FMP4_CONTAINERS : COPY_CONTAINERS).has(container)) return no(`${(container || "unknown").toUpperCase()} container not supported`);

  const audio = pickAudio(src, req.audioStreamId);
  if (audio === false) return no(`no audio track ${req.audioStreamId}`);
  // Opus, FLAC, AC3 and EAC3 as they are, in fMP4, for a player that decodes them.
  const copied = copiedAudio(audio, {
    opus: !!req.opusOk, flac: !!req.flacOk, ac3: !!req.ac3Ok, eac3: !!req.eac3Ok,
  });
  const audioCopy = copied.copy;
  const audioOut = audio && !audioCopy ? convertedAudio(audio, req.audioChannels, {
    opus: !!req.opusOk, flac: !!req.flacOk,
  }) : null;
  const audioFmp4 = audioCopy ? audioCapOf(audio?.codec) !== null : !!audioOut && audioOut.codec !== "aac";
  return {
    ok: true,
    video: video as SourceStream & { index: number },
    audio,
    audioCopy,
    audioWhy: copied.why,
    audioOut,
    codec,
    fmp4: codec === "av1" || audioFmp4,
    hdr,
    width,
    height,
  };
}

/** What a copy needs its player to decode, beyond H.264 and AAC in MPEG-TS. */
export function copyNeeds(plan: Extract<CopyPlan, { ok: true }>): PlayerCap[] {
  const needs: PlayerCap[] = [];
  if (plan.codec === "hevc") needs.push("hevc");
  if (plan.codec === "av1") needs.push("av1");
  const audio = audioCapOf(plan.audio?.codec);
  if (plan.audioCopy && audio) needs.push(audio);
  if (plan.audioOut && plan.audioOut.codec !== "aac") needs.push(plan.audioOut.codec);
  if (hdrPicture(plan.hdr)) needs.push("hdr");
  return needs;
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

/** Bitrate of the AAC a converted track becomes, kbps: stereo, */
export const AUDIO_KBPS = 256;
/** and 5.1 (FFMPEG_AUDIO_CHANNELS, 6 unless 2), as Plex makes 5.1 AAC. */
export const AUDIO_KBPS_SURROUND = 448;
/** Opus 7.1 (and 6.1): 64 kbps a channel. */
export const AUDIO_KBPS_OPUS_71 = 512;
/** FLAC made of PCM is about this much of its size. */
const FLAC_OF_PCM = 0.6;

export interface AudioOut {
  codec: "aac" | "opus" | "flac";
  channels: number;
  kbps: number;
}

/**
 * What a track that isn't copied becomes: AAC 5.1 for one with more than two
 * channels, AAC stereo for the rest — or stereo for all, as Plex makes it for
 * a browser, with FFMPEG_AUDIO_CHANNELS=2. Browsers play 5.1 AAC, and fold it
 * to stereo themselves where that is all there is. For a player that decodes
 * them (`caps`), in a copy:
 *
 *  - PCM becomes FLAC, the same sound at about 60% of the size, within
 *    FLAC_COPY_MAX_KBPS: stereo, as the library's is;
 *  - more than 5.1 — TrueHD and DTS-HD MA 7.1, and EAC3 7.1 for a player
 *    without EAC3 — becomes Opus with all of it, rather than folded into 5.1:
 *    no browser plays TrueHD or DTS, and AAC above 5.1 not every one.
 */
export function convertedAudio(audio: SourceStream, channels: number | undefined, caps: Partial<PlayerCaps> = {}): AudioOut {
  const codec = (audio.codec ?? "").toLowerCase();
  const has = audio.channels ?? 2;
  if (caps.flac && codec.startsWith("pcm") && (audio.bitDepth ?? 16) <= 24 && (channels === 6 || has <= 2)) {
    const pcmKbps = audio.bitrate && audio.bitrate > 0 ? audio.bitrate : has * 48 * (audio.bitDepth ?? 16);
    const kbps = Math.round(pcmKbps * FLAC_OF_PCM);
    if (kbps <= FLAC_COPY_MAX_KBPS) return { codec: "flac", channels: has, kbps };
  }
  if (caps.opus && channels === 6 && has > 6) return { codec: "opus", channels: Math.min(has, 8), kbps: AUDIO_KBPS_OPUS_71 };
  return channels === 6 && has > 2
    ? { codec: "aac", channels: 6, kbps: AUDIO_KBPS_SURROUND }
    : { codec: "aac", channels: 2, kbps: AUDIO_KBPS };
}

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
 *
 * With `toS`, it stops reading the file there: what a run started mid-film
 * skipped, made afterwards (engine.ts, the run's backfill).
 */
export function copyArgs(
  plan: Extract<CopyPlan, { ok: true }>,
  input: string[],
  offsetS: number,
  durationS: number | null = null,
  segmentSeconds = 4,
  toS: number | null = null,
): string[] {
  return [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    // The copied picture starts at the keyframe the seek lands on, and the
    // converted sound with it, not where the player asked: 1917 on 22 October
    // landed a keyframe early, 10.5 s before, and its first segment went out
    // with no sound. A player that took that one first failed on the next.
    ...(offsetS > 0 ? ["-ss", String(offsetS), "-noaccurate_seek"] : []),
    ...untilArgs(toS),
    "-copyts", "-start_at_zero",
    ...input,
    "-map", `0:${plan.video.index}`,
    ...(plan.audio ? ["-map", `0:${plan.audio.index}`] : []),
    "-c:v", "copy",
    // HEVC in MP4 as Chrome's MSE takes it: parameter sets in the init.
    ...(plan.fmp4 && plan.codec === "hevc" ? ["-tag:v", "hvc1"] : []),
    ...audioArgs(plan),
    ...(plan.fmp4 ? fmp4SegmentArgs(segmentSeconds) : segmentArgs(offsetS, toS ?? durationS, segmentSeconds)),
  ];
}

/** Where to stop reading the film, film time: an input option, before its -i. */
function untilArgs(toS: number | null): string[] {
  return toS !== null ? ["-to", toS.toFixed(3)] : [];
}

/** The audio as it is, or as convertedAudio has it. */
function audioArgs(plan: { audio: SourceStream | null; audioCopy: boolean; audioOut: AudioOut | null }): string[] {
  if (!plan.audio) return [];
  if (plan.audioCopy) return ["-c:a", "copy"];
  const out = plan.audioOut ?? { codec: "aac", channels: 2, kbps: AUDIO_KBPS };
  if (out.codec === "flac") return ["-c:a", "flac", "-af", "aresample=async=1"];
  // libopus takes 7.1 and 6.1 in their standard layouts, which -ac makes of
  // the others (7.1 wide); it picks its sample rate, 48 kHz.
  return ["-c:a", out.codec === "opus" ? "libopus" : "aac", "-ac", String(out.channels), "-b:a", `${out.kbps}k`,
    "-af", "aresample=async=1"];
}

/**
 * The longest stretch of cuts listed. The list is one argument, and Linux
 * takes none past 128 KiB: Plex's length can be days past the file's (Grimm
 * S3E7 at 97 hours, a 45-minute file), which ffmpeg then wouldn't start for.
 */
const MAX_LISTED_S = 12 * 3600;

/** Numbered MPEG-TS segments cut every `segmentSeconds` from the first packet,
 *  on the copy's clock, each announced on stdout once it is complete. */
function segmentArgs(offsetS: number, durationS: number | null, segmentSeconds: number): string[] {
  // Past the last listed cut the segment runs to the end of the file, so the
  // list covers what's left with room to spare; 6 h when Plex has no length.
  const leftS = Math.min(MAX_LISTED_S, Math.max(0, (durationS && durationS > 0 ? durationS : 6 * 3600) - offsetS) + 120);
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

/**
 * Numbered fragmented-MP4 segments (00000.m4s…) and the init.mp4 they share,
 * on the copy's clock, cut at the first keyframe past every `segmentSeconds`
 * from the first packet as segmentArgs's are. The HLS muxer, since the
 * segment muxer can't share one init between segments; the playlist it
 * reprints on stdout after each segment is how the engine hears of it.
 *
 * frag_discont keeps each fragment's decode time the copy's clock — the
 * film's own plus COPY_CLOCK_OFFSET_S — as Jellyfin's streams have it, rather
 * than counted from zero; negative composition offsets and no edit list keep
 * each picture at its own time rather than shifted so the first is at zero.
 */
function fmp4SegmentArgs(segmentSeconds: number): string[] {
  return [
    "-output_ts_offset", String(COPY_CLOCK_OFFSET_S),
    "-f", "hls",
    "-hls_segment_type", "fmp4",
    // Its cuts come at the first keyframe at or past each multiple of this,
    // which a re-encode's keyframes may miss by a hair: 1/16 s early, as
    // segmentArgs's delta.
    "-hls_time", String(segmentSeconds - 0.0625),
    "-hls_list_size", "3",
    "-hls_fmp4_init_filename", "init.mp4",
    "-hls_segment_filename", "%05d.m4s",
    "-hls_segment_options", "movflags=+frag_discont+negative_cts_offsets:use_editlist=0",
    "pipe:1",
  ];
}

// ─── Re-encodes ─────────────────────────────────────────────────

/**
 * What re-encodes run on: Intel's GPU through QSV; a GPU through VAAPI (Intel
 * or AMD); NVIDIA's through NVENC; or the CPU (H.264 only — software HEVC
 * can't keep up).
 */
export type Hardware = "qsv" | "vaapi" | "nvenc" | "software";

/** What Intel's GPU decodes on the 265K (Phase 0), and what's asked of the
 *  others too. VC-1, MPEG-4 and 10-bit H.264 aren't: they're decoded on the
 *  CPU and handed to it. A GPU that can't decode one the start says it can
 *  is asked again with the CPU decoding. */
const GPU_DECODES = new Set(["h264", "hevc", "av1", "vp9", "mpeg2video"]);

/** VAAPI on the render node and QSV derived from it, as Jellyfin sets Intel up
 *  on Linux — what Phase 0 ran on the 265K — and OpenCL from it too for
 *  tonemap_opencl. */
export function qsvInit(device: string, opencl = false): string[] {
  return ["-init_hw_device", `vaapi=va:${device},driver=iHD`, "-init_hw_device", "qsv=qs@va",
    ...(opencl ? ["-init_hw_device", "opencl=ocl@va"] : []), "-filter_hw_device", "qs"];
}

/** VAAPI on the render node, whichever driver it has (Intel's or AMD's), and
 *  OpenCL from it for tonemap_opencl where that works (Intel). */
export function vaapiInit(device: string, opencl = false): string[] {
  return ["-init_hw_device", `vaapi=va:${device}`,
    ...(opencl ? ["-init_hw_device", "opencl=ocl@va"] : []), "-filter_hw_device", "va"];
}

/** CUDA on NVIDIA's GPU number `device` ("0" unless said). */
export function cudaInit(device: string): string[] {
  return ["-init_hw_device", `cuda=cu:${/^\d+$/.test(device) ? device : "0"}`, "-filter_hw_device", "cu"];
}

/** FFMPEG_PRESET's names, x264's: QSV takes all but the two fastest, which are
 *  its veryfast; NVENC's p1 to p7 are veryfast to veryslow. */
/** What each re-encodes on, for Stats for nerds. */
export const HARDWARE_NAMES: Record<Hardware, string> = {
  qsv: "Intel QSV", vaapi: "VAAPI", nvenc: "NVIDIA NVENC", software: "CPU (x264)",
};

export const PRESETS = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"];

function presetFor(hardware: Hardware, preset: string | null | undefined): string | null {
  const want = preset && PRESETS.includes(preset) ? preset : null;
  if (hardware === "qsv") return want === "ultrafast" || want === "superfast" ? "veryfast" : want ?? "medium";
  if (hardware === "nvenc") {
    const at = want ? Math.max(0, PRESETS.indexOf(want) - 2) : 3;
    return `p${at + 1}`;
  }
  if (hardware === "software") return want ?? "faster";
  return null;
}

/**
 * What tone-maps HDR to SDR, best first: OpenCL on Intel's GPU, the only one
 * that applies Dolby Vision's own metadata, which profile 5 has no picture
 * without (Phase 0 run 2: the others give it green and purple); QSV's video
 * engine; Jellyfin's tonemapx on the CPU, for what is decoded there.
 */
export type Tonemapper = "opencl" | "vpp" | "software";

/**
 * A curve's setting where the filter's own default isn't the one wanted.
 * Mobius at 0.5 keeps the film's light as it is up to half of HDR's
 * reference white, about 100 nits, then eases the rest into the screen's
 * white: what Plex's app for Windows shows on a screen in SDR. Measured in
 * Chrome on 28 October from PQ grey patches at 1, 10, 50, 100 and 203 nits:
 * the Windows app 23, 63, 134, 183 and 230 of 255; mobius 28, 73, 143, 190
 * and 228; reinhard, the default before, 30, 77, 140, 173 and 206 — its
 * highlights a good deal darker.
 */
const TONEMAP_PARAMS: Record<string, number> = { mobius: 0.5 };

/**
 * The curve and setting a tone mapper is given for `algo` (TONEMAP_PARAMS).
 * Jellyfin's tonemap_opencl keeps a setting only for reinhard and bt2390 and
 * puts 1.0 in place of any other (vf_tonemap_opencl.c, final_param); mobius
 * at 1.0 divides 0 by 0 above HDR's reference white, so in run 29 (29
 * October) the Tesseract in Avengers Assemble and the screens in Project Hail
 * Mary came out black. There, mobius at 0.5 is bt2390 at 0.5: the same at 1,
 * 10 and 50 nits (28, 73 and 142 of 255), 189 and 230 at 100 and 203 against
 * mobius's 190 and 228, and 5 brighter from 300 to 500. tonemapx keeps
 * mobius's own.
 */
export function tonemapCurve(algo: string, via: Tonemapper): { algo: string; param?: number } {
  if (via === "opencl" && algo === "mobius") return { algo: "bt2390", param: 0.5 };
  return { algo, param: TONEMAP_PARAMS[algo] };
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
      ? { primaries: "bt470bg", trc: "bt470bg", matrix: "bt470bg" }
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

/**
 * A transfer as the output's -color_trc names it. The labels are kept in the
 * names ffprobe and Plex use, which setparams takes too; the encoder option
 * knows PAL's and NTSC-M's only as gamma28 and gamma22, and a PAL DVD rip
 * died on "gamma28" in setparams before this (17 Oct).
 */
function trcOption(trc: string): string {
  return trc === "bt470bg" ? "gamma28" : trc === "bt470m" ? "gamma22" : trc;
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

/** Subtitles that are pictures, as Plex and ffprobe name them: burned in, as
 *  nothing else shows them. */
const PICTURE_SUBTITLES = new Set(["pgs", "hdmv_pgs_subtitle", "vobsub", "dvd_subtitle", "dvb_subtitle", "dvbsub"]);

/**
 * How a subtitle is burned in: a picture one in the file, drawn from its own
 * stream; one in a file beside the film (a sidecar), from that file, read as
 * a second input; a text one, by libass from a subtitle file made ready for
 * it (burn-files.ts) — the player draws text itself, so this is for one it
 * couldn't read.
 */
export type BurnKind = "picture" | "picture-sidecar" | "text";

/** Whether a subtitle is a picture one, as Plex and ffprobe name them. */
export function isPictureSubtitle(codec: string | null | undefined): boolean {
  return PICTURE_SUBTITLES.has((codec ?? "").toLowerCase());
}

/** The subtitle a stream burns in, and how. */
export function pickBurn(
  src: SourceVersion, subtitleStreamId: number,
): { ok: true; sub: SourceStream; kind: BurnKind } | { ok: false; why: string } {
  const sub = src.streams.find((s) => s.streamType === 3 && s.id === subtitleStreamId);
  if (!sub) return { ok: false, why: `no subtitle ${subtitleStreamId}` };
  const picture = isPictureSubtitle(sub.codec);
  if (sub.key) return { ok: true, sub, kind: picture ? "picture-sidecar" : "text" };
  if (!picture) return { ok: true, sub, kind: "text" };
  if (sub.index == null) return { ok: false, why: "subtitle not placed in the file" };
  return { ok: true, sub, kind: "picture" };
}

/**
 * The canvas a picture subtitle is drawn on, given to ffmpeg up front
 * (-canvas_size). A Blu-ray's PGS is drawn on 1920×1080, the film cropped or
 * not, and a UHD disc's too. ffmpeg only learns that from the first one, which
 * is minutes in where its look at the file's start doesn't reach, so it draws
 * on the film's own size until then; a 1920×800 film's subtitles below row 800
 * then don't fit, and ffmpeg 7+ rebuilds the whole filter graph mid-stream to
 * the size the first one says — on the CPU, fine (checked on 7.1), but with
 * the GPU's frames going to its encoder, a new frame pool it was never opened
 * with. DVB's is 720×576 by its standard. A DVD's comes with the stream, and
 * a 720p rip's PGS could be either, so those are left to ffmpeg.
 */
function subtitleCanvas(sub: SourceStream, width: number): string | null {
  const codec = (sub.codec ?? "").toLowerCase();
  if ((codec === "pgs" || codec === "hdmv_pgs_subtitle") && width > 1280) return "1920x1080";
  if (codec === "dvb_subtitle" || codec === "dvbsub") return "720x576";
  return null;
}

export interface EncodeRequest {
  audioStreamId: number | null;
  /** The subtitle burned into the stream (pickBurn), if any. */
  burn?: number | null;
  /** What a sidecar or a text subtitle is drawn from: the sidecar's path on
   *  the mount, or the text made ready for libass (burn-files.ts). */
  burnFile?: string | null;
  /** Fonts a text subtitle came with (an mkv's attachments), for libass. */
  burnFonts?: string | null;
  /** A sidecar's own first timestamp, seconds, which -start_at_zero takes off
   *  it: given back with -itsoffset, so its lines stay on the film's clock. */
  burnFileStartS?: number | null;
  /** HEVC out: the player decodes it, and HEVC_TRANSCODE allows it. */
  hevcOk: boolean;
  /**
   * AV1 out, where it isn't HEVC: the player decodes AV1 on its GPU, this GPU
   * encodes it, and the stream isn't one whose copy was held back from others
   * (they'd be on a copy, this one on H.264 — see sync.ts seatOf).
   */
  av1Ok?: boolean;
  /** VAAPI's AV1 encoder is only its low-power one (Intel's). */
  av1LowPower?: boolean;
  hardware: Hardware;
  /** Target and peak, kbps — worked out as for a Plex re-encode: the most a
   *  re-encode is made at (sourceMatchedKbps). */
  kbps: number;
  peakKbps: number;
  /** FFMPEG_AUDIO_CHANNELS: 6 for 5.1 AAC from a surround track (convertedAudio). */
  audioChannels?: number;
  /** The player decodes Opus: a track above 5.1 keeps all its channels as
   *  Opus 7.1, in fMP4, rather than folding to AAC 5.1 (convertedAudio). */
  opusOk?: boolean;
  /** FFMPEG_PRESET (PRESETS): the encoder's own default unless said. */
  preset?: string | null;
  /** VAAPI's low-power encoder, which is all newer Intel GPUs have. */
  lowPower?: boolean;
  /** The largest picture: transcodeFrame's, or 720p at the lowest level. */
  maxWidth: number;
  maxHeight: number;
  /** FFMPEG_HDR_REENCODE=keep: an HEVC re-encode of an HDR file stays HDR,
   *  for a player whose screen shows it. */
  keepHdr: boolean;
  /** The driver's screen shows HDR (PlayerCaps.hdr): HDR is kept only for it. */
  hdrOk?: boolean;
  /** What the GPU tone-maps with, as detectHardware found: OpenCL when it
   *  works there, else QSV's video engine. Unsaid, the video engine. */
  tonemapper?: Tonemapper;
  /** FFMPEG_TONEMAP's curve: mobius unless said (TONEMAP_PARAMS). */
  tonemapAlgo?: string;
  /** Decode on the GPU where it can; false for the retry after it couldn't. */
  gpuDecode?: boolean;
}

export type EncodePlan =
  | {
      ok: true;
      video: SourceStream & { index: number };
      audio: (SourceStream & { index: number }) | null;
      /** AAC is copied; anything else becomes AAC with the picture. */
      audioCopy: boolean;
      audioWhy: string | null;
      audioOut: AudioOut | null;
      codec: "h264" | "hevc" | "av1";
      /** Segments in fragmented MP4: AV1, as an AV1 copy is, and Opus sound,
       *  which MPEG-TS can't carry to hls.js. */
      fmp4: boolean;
      hdr: string;
      /** The HDR transfer written on the output (smpte2084 or arib-std-b67);
       *  null for SDR. */
      hdrTrc: string | null;
      /** HDR made SDR on the way: on what, by which curve, and whether Dolby
       *  Vision's metadata is applied (profile 5, 10.0); null when it isn't. */
      tonemap: { via: Tonemapper; algo: string; dovi: boolean } | null;
      /** The subtitle burned in: the stream, how (BurnKind), the file it is
       *  drawn from when it isn't the film, with its fonts and its first
       *  timestamp; whether a picture one is stretched with the film's
       *  pictures (anamorphic) or fitted, and the canvas it is drawn on, when
       *  ffmpeg can't be left to find it. */
      burn: {
        sub: SourceStream;
        kind: BurnKind;
        file: string | null;
        fonts: string | null;
        fileStartS: number | null;
        stretch: boolean;
        canvas: string | null;
      } | null;
      width: number;
      height: number;
      hardware: Hardware;
      gpuDecode: boolean;
      interlaced: boolean;
      color: ColorLabels;
      kbps: number;
      peakKbps: number;
      /** What the quality level allowed, and the source's own bitrate it was
       *  matched to (sourceMatchedKbps), when that is what set kbps. */
      askedKbps: number;
      sourceKbps: number | null;
      preset: string | null;
      lowPower: boolean;
    }
  | { ok: false; why: string };

/**
 * How many bits a codec needs for a picture, against H.264's: H.264 needs
 * about 1.6 times what HEVC does and twice what AV1 does, and MPEG-2 about
 * twice what H.264 does. HEVC was 2, and Airplane II's 6.8 Mbps HEVC made the
 * H.264 for a Firefox player at 12 Mbps, more than its link carried.
 */
const CODEC_EFFICIENCY: Record<string, number> = {
  h264: 1, hevc: 1.6, av1: 2, vp9: 1.7, vp8: 0.9, vc1: 0.8, wmv3: 0.8, wmv2: 0.6, wmv1: 0.5,
  mpeg2video: 0.5, mpeg1video: 0.4, mpeg4: 0.7, msmpeg4v3: 0.6, msmpeg4v2: 0.6, msmpeg4: 0.6, h263: 0.5,
};

/** The least a re-encode is made at, by its height: so a bitrate Plex has
 *  wrong, or a starved source, doesn't take the picture below watchable. */
function floorKbps(height: number): number {
  return height <= 576 ? 1500 : height <= 720 ? 2500 : 4000;
}

/**
 * A re-encode's target: what the quality level allows, but no more than the
 * source's own picture needs in the codec it is made in — its bitrate, by how
 * much more or less that codec needs than the source's (CODEC_EFFICIENCY),
 * and less again for a smaller picture — with a floor. On 18 October
 * everything re-encoded was made at 12 Mbps: Steins;Gate's 3 Mbps HEVC, Hell's
 * Kitchen's 673 kbps 320×240 AVI. Bits a source never had are only bigger
 * downloads: those are about 6 Mbps and 1.5 Mbps now.
 */
export function sourceMatchedKbps(o: {
  askedKbps: number;
  sourceKbps: number | null | undefined;
  sourceCodec: string | null | undefined;
  outCodec: "h264" | "hevc" | "av1";
  sourcePixels: number;
  outPixels: number;
  outHeight: number;
}): number {
  if (!o.sourceKbps || o.sourceKbps <= 0) return o.askedKbps;
  const from = CODEC_EFFICIENCY[(o.sourceCodec ?? "").toLowerCase()] ?? 1;
  const to = CODEC_EFFICIENCY[o.outCodec];
  // Bits needed don't fall as fast as pixels: 4K to 1080p needs about a third.
  const scale = o.sourcePixels > 0 && o.outPixels < o.sourcePixels ? Math.pow(o.outPixels / o.sourcePixels, 0.75) : 1;
  const matched = Math.round((o.sourceKbps * from / to) * scale);
  return Math.min(o.askedKbps, Math.max(floorKbps(o.outHeight), matched));
}

/** How ffmpeg re-encodes this version for a player, or why it doesn't. */
export function planEncode(src: SourceVersion, req: EncodeRequest): EncodePlan {
  const no = (why: string): EncodePlan => ({ ok: false, why });
  const video = src.streams.find((s) => s.streamType === 1);
  if (!video || video.index == null) return no("no video stream");
  const width = src.width ?? 0;
  const height = src.height ?? 0;
  if (width <= 0 || height <= 0) return no("picture size unknown");
  const inCodec = (video.codec ?? "").toLowerCase();
  const gpuDecode = req.hardware !== "software" && req.gpuDecode !== false && GPU_DECODES.has(inCodec) &&
    !(inCodec === "h264" && (video.bitDepth ?? 8) > 8);
  let burn: Extract<EncodePlan, { ok: true }>["burn"] = null;
  if (req.burn) {
    const picked = pickBurn(src, req.burn);
    if (!picked.ok) return no(picked.why);
    if (picked.kind !== "picture" && !req.burnFile) {
      return no(picked.kind === "text"
        ? `a ${(picked.sub.codec ?? "text").toLowerCase()} subtitle burned in, with no text of it to draw from`
        : "a picture subtitle beside the film, not found on the mount");
    }
    burn = {
      sub: picked.sub,
      kind: picked.kind,
      file: picked.kind === "picture" ? null : req.burnFile ?? null,
      fonts: picked.kind === "text" ? req.burnFonts ?? null : null,
      fileStartS: picked.kind === "picture-sidecar" ? req.burnFileStartS ?? null : null,
      stretch: !!video.anamorphic,
      canvas: picked.kind === "text" ? null : subtitleCanvas(picked.sub, width),
    };
  }
  // A burned subtitle's picture is drawn in H.264, 8 bits, on the CPU (see
  // encodeArgs): every player has it, and a subtitle's whites in SDR.
  const hevcOut = req.hevcOk && req.hardware !== "software" && !burn;
  const av1Out = !!req.av1Ok && req.hardware !== "software" && !burn;
  const hdr = hdrClass(video);
  const hdrIn = hdrPicture(hdr);
  const doviOnly = hdr === "DV P5" || hdr === "DV P10.0";
  // HDR stays HDR (FFMPEG_HDR_REENCODE=keep) in HEVC Main10, for a player
  // that decodes HEVC on a screen that shows HDR. Otherwise it is mapped to
  // SDR here, from the film's 10 bits (PlayerCaps.hdr) — on the GPU when it
  // decodes the file, else on the CPU. A subtitle burned onto HDR would
  // glare at full PQ brightness: that picture is tone-mapped too.
  const keepHdr = hdrIn && !doviOnly && hevcOut && req.keepHdr && !!req.hdrOk;
  let tonemap: { via: Tonemapper; algo: string; dovi: boolean } | null = null;
  if (hdrIn && !keepHdr) {
    // QSV's video engine is QSV's own; VAAPI's GPU has OpenCL or nothing;
    // NVIDIA's frames are brought down and tone-mapped on the CPU.
    const via: Tonemapper = !gpuDecode || req.hardware === "nvenc" ? "software"
      : req.tonemapper === "opencl" ? "opencl"
      : req.hardware === "qsv" ? "vpp" : "software";
    if (doviOnly && via !== "opencl") return no(`Dolby Vision ${hdr.slice(3)} needs OpenCL tone mapping`);
    tonemap = { via, algo: req.tonemapAlgo ?? "mobius", dovi: doviOnly };
  }
  // AV1 for a player that decodes it on its GPU, from an SDR film: about half
  // H.264's bits for the same picture, and 20% fewer than HEVC's. Never from
  // HDR, kept or mapped: Project Hail Mary and The Avengers, mapped to SDR in
  // AV1 at 12 and 7 Mbps on 28 October, broke up into blocks in every dark
  // scene, where Plex's H.264 of the same scenes was clean. Those were 8 bits
  // into the encoder: mapped on the GPU for a player that decodes HEVC, the
  // picture stays 10 bits, SDR in HEVC Main10, so a dark scene's few steps
  // aren't left to an 8-bit encoder to block up. H.264 where the CPU maps it
  // (tonemapx), and for everyone else.
  const codec = av1Out && hdr === "SDR" ? "av1"
    : hevcOut && (!tonemap || tonemap.via !== "software") ? "hevc" : "h264";
  const audio = pickAudio(src, req.audioStreamId);
  if (audio === false) return no(`no audio track ${req.audioStreamId}`);
  const [w, h] = encodeFrame(
    width, height, video.anamorphic ? video.pixelAspectRatio : undefined, req.maxWidth, req.maxHeight,
  );
  const sourceKbps = video.bitrate && video.bitrate > 0 ? video.bitrate : src.bitrateKbps ?? null;
  const kbps = sourceMatchedKbps({
    askedKbps: req.kbps, sourceKbps, sourceCodec: inCodec, outCodec: codec,
    sourcePixels: width * height, outPixels: w * h, outHeight: h,
  });
  // The peak as far above the target as it was asked to be.
  const peakKbps = kbps === req.kbps ? req.peakKbps : Math.max(kbps + 1, Math.round(kbps * req.peakKbps / Math.max(req.kbps, 1)));
  const audioCopy = (audio?.codec ?? "").toLowerCase() === "aac";
  // A re-encode's sound is AAC, or Opus 7.1 from a track above 5.1 for a
  // player that decodes Opus: TrueHD 7.1 had become AAC 5.1 (23 Oct, Project
  // Hail Mary). Why it isn't the file's own: what no player takes (TrueHD,
  // DTS), or else that a re-encode carries only these two.
  const audioOut = audio && !audioCopy ? convertedAudio(audio, req.audioChannels, { opus: !!req.opusOk }) : null;
  return {
    ok: true,
    video: video as SourceStream & { index: number },
    audio,
    audioCopy,
    audioWhy: audio && !audioCopy ? copiedAudio(audio, ALL_CAPS).why ?? "Re-encodes carry AAC or Opus only" : null,
    audioOut,
    codec,
    fmp4: codec === "av1" || audioOut?.codec === "opus",
    hdr,
    hdrTrc: !hdrIn || tonemap ? null
      : String(video.colorTrc ?? "").toLowerCase() === "arib-std-b67" ? "arib-std-b67" : "smpte2084",
    tonemap,
    burn,
    width: w,
    height: h,
    hardware: req.hardware,
    gpuDecode,
    interlaced: /interlaced/i.test(video.scanType ?? ""),
    color: colorLabels(video, height),
    kbps,
    peakKbps,
    askedKbps: req.kbps,
    sourceKbps: kbps < req.kbps ? sourceKbps : null,
    preset: presetFor(req.hardware, req.preset),
    lowPower: req.hardware === "vaapi" && !!(codec === "av1" ? req.av1LowPower : req.lowPower),
  };
}

/**
 * What one viewer downloads of a re-encode as planned, kbps: the picture's
 * target and the sound — what a converted track becomes (convertedAudio), a
 * copied one at what Plex says it is, or AUDIO_KBPS when Plex doesn't say.
 * Stands in for the upload budget's measure until there is one (engine.ts
 * ffmpegBandwidth).
 */
export function encodeTargetKbps(plan: Extract<EncodePlan, { ok: true }>): number {
  if (!plan.audio) return plan.kbps;
  const audio = plan.audioCopy
    ? plan.audio.bitrate && plan.audio.bitrate > 0 ? plan.audio.bitrate : AUDIO_KBPS
    : plan.audioOut?.kbps ?? AUDIO_KBPS;
  return plan.kbps + audio;
}

/** Re-encodes are cut every 3 s, as Plex's are. */
export const ENCODE_SEGMENT_S = 3;

/**
 * A path as a filter's option inside a filter graph: escaped for the option
 * (\ : ') and then quoted for the graph, so a film called "Mission: Impossible"
 * or "Schindler's List" is one value, not three.
 */
export function filterPath(file: string): string {
  const option = file.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
  return `'${option.replace(/'/g, "'\\''")}'`;
}

/**
 * ffmpeg's arguments for a re-encode from `offsetS`, segmented as a copy is
 * (same clock, same announcements). Decode, label fill, deinterlace and scale
 * are Phase 0's chain on the 265K: on the GPU when it decodes the codec (VAAPI,
 * mapped to QSV for QSV's encoder; CUDA for NVENC), else on the CPU and
 * uploaded. Keyframes are forced on a 3 s grid, which ffmpeg counts from the
 * run's first frame, so every cut lands on one. Rate control is VBR: target,
 * peak, twice the peak's buffer (§8.4). QSV picks CBR, which pads with filler,
 * when the two are equal, so the peak is always at least a little above the
 * target.
 *
 * Tone mapping is Phase 0's too, the picture kept in 10 bits up to it:
 * OpenCL mapped from VAAPI and back, QSV's video engine, or tonemapx on the
 * CPU — on frames the CPU decoded, or brought down from a GPU without either
 * (NVIDIA's); the output labelled BT.709.
 *
 * A burned subtitle is drawn on the CPU, as Plex draws it: the film's picture
 * brought down from the GPU once it is scaled (and tone-mapped), and handed
 * back to the GPU's encoder after. A picture one's own pictures (ffmpeg's
 * sub2video, which keeps each one up until the next, on subtitleCanvas) are
 * scaled to the frame — stretched with an anamorphic film, else fitted inside
 * it and centred, so a 1080p subtitle over a 1920×800 film is all there — and
 * overlaid; from a sidecar they are a second input, put back on the film's
 * clock (burnFileStartS). A text one is drawn by libass (the subtitles
 * filter) from the file made ready for it, with the fonts it came with. Overlay
 * on the GPU (overlay_qsv) was never tried on the 265K; one 1080p frame each
 * way is little next to the encode.
 *
 * With `toS`, it stops reading the film there, as a copy does.
 */
export function encodeArgs(
  plan: Extract<EncodePlan, { ok: true }>,
  input: string[],
  offsetS: number,
  durationS: number | null,
  device: string,
  toS: number | null = null,
): string[] {
  const W = plan.width;
  const H = plan.height;
  const hw = plan.hardware;
  const fmt = plan.codec === "hevc" ? "p010" : "nv12";
  const fill = plan.color.fill ? `${plan.color.fill},` : "";
  const tm = plan.tonemap;
  // peak=100 is the film's peak taken as 1,000 nits, whatever it says; SDR
  // white is HDR's reference white, 203 nits (jellyfin-ffmpeg's tone mappers).
  const tc = tm ? tonemapCurve(tm.algo, tm.via) : null;
  const curve = tc
    ? `tonemap=${tc.algo}${tc.param === undefined ? "" : `:param=${tc.param}`}:desat=0:peak=100:t=bt709:m=bt709:p=bt709:format=${fmt}`
    : "";
  // On frames the GPU decoded: labels, deinterlace and scale, still there.
  const gpuIn = hw === "nvenc"
    ? `${fill}${plan.interlaced ? "bwdif_cuda=mode=send_frame," : ""}scale_cuda=w=${W}:h=${H}:format=${tm ? "p010" : fmt}`
    : `${fill}${plan.interlaced ? "deinterlace_vaapi=rate=frame," : ""}scale_vaapi=w=${W}:h=${H}:format=${tm ? "p010" : fmt}`;
  // On frames the CPU decoded.
  const cpuIn = `${fill}${plan.interlaced ? "bwdif=mode=send_frame," : ""}scale=${W}:${H},`;
  const opencl = tm?.via === "opencl"
    ? `hwmap=derive_device=opencl:mode=read,tonemap_opencl=${curve}${tm.dovi ? ":apply_dovi=1" : ""}`
    : "";
  // The picture as the CPU's frames: for a subtitle drawn over it, or for
  // tonemapx, or because the CPU decoded it.
  const cpuPicture = plan.gpuDecode
    ? tm?.via === "opencl"
      ? `${gpuIn},${opencl},hwdownload,format=${fmt === "p010" ? "p010le" : "nv12"}`
      : tm?.via === "vpp"
        ? `${gpuIn},hwmap=derive_device=qsv,format=qsv,vpp_qsv=tonemap=1:format=${fmt},hwdownload,format=${fmt === "p010" ? "p010le" : "nv12"}`
        : tm
          ? `${gpuIn},hwdownload,format=p010le,tonemapx=${curve}`
          : `${gpuIn},hwdownload,format=${fmt === "p010" ? "p010le" : "nv12"}`
    : tm
      ? `${cpuIn}format=yuv420p10le,tonemapx=${curve}${hw === "software" ? ",format=yuv420p" : ""}`
      : `${cpuIn}format=${hw === "software" ? "yuv420p" : fmt === "p010" ? "p010le" : "nv12"}`;
  // From the CPU's frames to the encoder.
  const upload = hw === "qsv" ? "hwupload=extra_hw_frames=64,format=qsv"
    : hw === "vaapi" ? "hwupload,format=vaapi"
    : "";
  // And from the GPU's, when the picture stays there throughout.
  const onGpu = plan.gpuDecode && (!tm || tm.via === "opencl" || tm.via === "vpp")
    ? hw === "qsv"
      ? tm?.via === "opencl"
        ? `${gpuIn},${opencl},hwmap=derive_device=vaapi:mode=write:reverse=1,format=vaapi,hwmap=derive_device=qsv,format=qsv`
        : `${gpuIn},hwmap=derive_device=qsv,format=qsv${tm ? `,vpp_qsv=tonemap=1:format=${fmt}` : ""}`
      : tm?.via === "opencl"
        ? `${gpuIn},${opencl},hwmap=derive_device=vaapi:mode=write:reverse=1,format=vaapi`
        : gpuIn
    : null;
  const vf = onGpu ?? (upload ? `${cpuPicture},${upload}` : cpuPicture);

  const burn = plan.burn;
  const fromCpu = hw === "software" ? "format=yuv420p" : hw === "nvenc" ? "format=nv12" : upload;
  const subScale = burn?.stretch ? `scale=${W}:${H}` : `scale=${W}:${H}:force_original_aspect_ratio=decrease`;
  const overlay = "overlay=x=(main_w-overlay_w)/2:y=(main_h-overlay_h)/2:eof_action=pass";
  const graph = !burn
    ? null
    : burn.kind === "text"
      ? `[0:${plan.video.index}]${cpuPicture},subtitles=filename=${filterPath(burn.file!)}:charenc=UTF-8` +
        `${burn.fonts ? `:fontsdir=${filterPath(burn.fonts)}` : ""},${fromCpu}[v]`
      : `[0:${plan.video.index}]${cpuPicture}[pic];[${burn.kind === "picture" ? `0:${burn.sub.index}` : "1:s:0"}]${subScale}[sub];` +
        `[pic][sub]${overlay},${fromCpu}[v]`;
  // A sidecar's pictures: a second input, on the film's clock.
  const sidecar = burn?.kind === "picture-sidecar"
    ? [
        ...(burn.canvas ? ["-canvas_size", burn.canvas] : []),
        ...(burn.fileStartS ? ["-itsoffset", String(burn.fileStartS)] : []),
        "-protocol_whitelist", "file", "-i", burn.file!,
      ]
    : [];

  const peak = Math.max(plan.peakKbps, plan.kbps + 1);
  const rate = ["-b:v", `${plan.kbps}k`, "-maxrate", `${peak}k`, "-bufsize", `${peak * 2}k`];
  // AV1 is Main, which its encoders choose for 8 bits; NVENC's has no profile to name.
  const profile = plan.codec === "av1" ? [] : ["-profile:v", plan.codec === "hevc" ? "main10" : "high"];
  const encoder = hw === "qsv"
    ? ["-c:v", `${plan.codec}_qsv`, "-low_power", "1", ...profile, "-preset", plan.preset ?? "medium", ...rate, "-forced_idr", "1"]
    : hw === "vaapi"
      // A forced keyframe is an IDR on VAAPI's encoders of itself.
      ? ["-c:v", `${plan.codec}_vaapi`, ...(plan.lowPower ? ["-low_power", "1"] : []), ...profile, "-rc_mode", "VBR", ...rate]
      : hw === "nvenc"
        ? ["-c:v", `${plan.codec}_nvenc`, "-preset", plan.preset ?? "p4", "-tune", "hq", ...profile, "-rc", "vbr", ...rate,
            "-forced-idr", "1"]
        : ["-c:v", "libx264", "-preset", plan.preset ?? "faster", "-tune", "film", "-profile:v", "high", "-crf", "20",
            "-maxrate", `${peak}k`, "-bufsize", `${peak * 2}k`, "-forced-idr", "1"];
  const tags = plan.hdrTrc
    ? ["-color_primaries", "bt2020", "-color_trc", plan.hdrTrc, "-colorspace", "bt2020nc", "-color_range", "tv"]
    : tm
      ? ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"]
      : ["-color_primaries", plan.color.primaries, "-color_trc", trcOption(plan.color.trc), "-colorspace", plan.color.matrix,
        "-color_range", plan.color.range];
  const init = hw === "qsv" ? qsvInit(device, tm?.via === "opencl")
    : hw === "vaapi" ? vaapiInit(device, tm?.via === "opencl")
    : hw === "nvenc" ? cudaInit(device)
    : [];
  const decode = !plan.gpuDecode ? []
    : hw === "nvenc"
      ? ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda", "-hwaccel_device", "cu"]
      : ["-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi", "-hwaccel_device", "va"];
  return [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    ...init,
    ...decode,
    ...(offsetS > 0 ? ["-ss", String(offsetS)] : []),
    ...untilArgs(toS),
    "-copyts", "-start_at_zero",
    ...(burn?.kind === "picture" && burn.canvas ? ["-canvas_size", burn.canvas] : []),
    ...input,
    ...sidecar,
    ...(graph
      ? ["-filter_complex", graph, "-map", "[v]"]
      : ["-map", `0:${plan.video.index}`]),
    ...(plan.audio ? ["-map", `0:${plan.audio.index}`] : []),
    ...(graph ? [] : ["-vf", vf]),
    ...encoder,
    ...tags,
    ...(plan.fmp4 && plan.codec === "hevc" ? ["-tag:v", "hvc1"] : []),
    "-aspect", `${W}:${H}`,
    "-force_key_frames:v", `expr:gte(t,n_forced*${ENCODE_SEGMENT_S})`,
    ...audioArgs(plan),
    // Audio piles up while the GPU encoder starts; ffmpeg's default queue is
    // too short for that.
    "-max_muxing_queue_size", "4096",
    ...(plan.fmp4
      ? fmp4SegmentArgs(ENCODE_SEGMENT_S)
      : segmentArgs(offsetS, toS ?? durationS, ENCODE_SEGMENT_S)),
  ];
}
