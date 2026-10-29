/**
 * What the server said about the stream when it started it: copied or
 * re-encoded, why, and at what bitrate. Carried in the master playlist as
 * EXT-X-SESSION-DATA (com.pdt.*), so a viewer who joined later has the same
 * answer as whoever started it.
 */
export interface StreamNotes {
  video: "copy" | "transcode" | null;
  /** Why it was re-encoded, in a sentence; null for a copy. */
  reason: string | null;
  /** A re-encode's target, or a copy's own bitrate when known. */
  kbps: number | null;
  /** The viewer quality ceiling it was started under, if any. */
  quality: number | null;
  /** What Plex does with the audio: copies it as it is, or converts it. Null
   *  from a server that doesn't say. */
  audio: "copy" | "transcode" | null;
  /** The file's audio — "EAC3 Stereo" — and, converted, what it became. */
  audioFrom: string | null;
  audioTo: string | null;
  audioKbps: number | null;
  /** Why it was converted, in a sentence. */
  audioReason: string | null;
  /** What made the stream: Plex's transcoder, or this server's own ffmpeg
   *  (PLAYBACK_ENGINE=ffmpeg). A server that doesn't say is Plex's. */
  engine: "plex" | "ffmpeg";
  /** What ffmpeg re-encoded on — "NVIDIA NVENC, GPU decode" — and, for a
   *  stream the ffmpeg engine left to Plex, why. */
  encoder: string | null;
  fallback: string | null;
  /** The file's picture — "HEVC Main 10 · 10-bit · HDR10 · 3840×2160 ·
   *  23.976 fps" — and the stream's dynamic range: "HDR10", "SDR (tone-mapped
   *  from HDR10)". Null from a server that doesn't say. */
  videoFrom: string | null;
  range: string | null;
  /** HDR labelled for each screen: the init this player has is its screen's
   *  own, and another screen needs it asked for again. */
  perScreen: boolean;
}

/** StreamNotes from hls.js's parsed session data, or null when the server sent
 *  none (an older one). */
export function readStreamNotes(
  sessionData: Record<string, object> | null | undefined,
): StreamNotes | null {
  if (!sessionData) return null;
  const value = (id: string) => {
    const v = (sessionData[`com.pdt.${id}`] as { VALUE?: unknown } | undefined)?.VALUE;
    return typeof v === "string" ? v : null;
  };
  const num = (id: string) => {
    const n = Number(value(id));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const video = value("video");
  if (video !== "copy" && video !== "transcode") return null;
  const audio = value("audio");
  return {
    video, reason: value("reason"), kbps: num("kbps"), quality: num("quality"),
    audio: audio === "copy" || audio === "transcode" ? audio : null,
    audioFrom: value("audioFrom"), audioTo: value("audioTo"), audioKbps: num("audioKbps"),
    audioReason: value("audioReason"),
    videoFrom: value("videoFrom"), range: value("range"),
    encoder: value("encoder"), fallback: value("fallback"),
    engine: value("engine") === "ffmpeg" ? "ffmpeg" : "plex",
    perScreen: value("perScreen") === "1",
  };
}

/** The Engine line: who made the stream, and on what. Why ffmpeg handed it
 *  to Plex is a line of its own (notes.fallback). */
export function engineText(notes: StreamNotes): string {
  if (notes.engine === "ffmpeg") return notes.encoder ? `ffmpeg · ${notes.encoder}` : "ffmpeg";
  return notes.fallback ? "Plex (ffmpeg fallback)" : "Plex";
}

/**
 * The stream in Plex's words. Direct Play: the film's video and audio both
 * as they are in the file. Direct Stream: its video as it is, its audio
 * converted. Transcode: the video re-encoded. Both of the first are carried
 * to the player in HLS segments rather than as the file itself, which Plex
 * would call a Direct Stream too; what matters here is that nothing in it
 * was converted.
 */
export function playbackMode(notes: StreamNotes | null): string | null {
  if (!notes?.video) return null;
  if (notes.video === "transcode") return "Transcode";
  return notes.audio === "copy" ? "Direct Play" : "Direct Stream";
}

/** The panel's one line for the audio: what the file has, and what plays. */
export function audioSummary(notes: StreamNotes | null): string {
  if (notes?.audio === "copy") return `${notes.audioFrom ?? "Original"} · direct`;
  if (notes?.audio === "transcode") return `${notes.audioFrom ?? "?"} → ${notes.audioTo ?? "?"}`;
  return "—";
}

/** What the audio row opens to, one line each: nothing for audio played as
 *  it is, which the row says all of. Why it was converted is under Playback. */
export function audioDetails(notes: StreamNotes | null): Array<[string, string]> {
  if (notes?.audio !== "transcode") return [];
  return [
    ["Source", notes.audioFrom ?? "—"],
    ["Output", `${notes.audioTo ?? "—"}${notes.audioKbps ? ` · ${notes.audioKbps} kbps` : ""}`],
  ];
}

/** The file's picture as two short lines: its format, then its frame —
 *  "HEVC Main 10 · DV P8.1 / HDR10" and "3840×2160 · 23.976 fps". */
export function fileLines(videoFrom: string | null): Array<[string, string]> {
  if (!videoFrom) return [];
  // "Main 10" says the bit depth already; "DV" is Dolby Vision's own short name.
  const parts = videoFrom.replace(/Dolby Vision/g, "DV").split(" · ")
    .filter((p, _, all) => !(p === "10-bit" && all.some((q) => / Main 10$/.test(q))));
  const frame = parts.filter((p) => /^\d+×\d+$|fps$|^interlaced$/.test(p));
  const format = parts.filter((p) => !frame.includes(p));
  return [
    ...(format.length ? [["File", format.join(" · ")] as [string, string]] : []),
    ...(frame.length ? [["Frame", frame.join(" · ")] as [string, string]] : []),
  ];
}
