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
  };
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
 *  it is, which the row says all of. */
export function audioDetails(notes: StreamNotes | null): Array<[string, string]> {
  if (notes?.audio !== "transcode") return [];
  return [
    ["Source", notes.audioFrom ?? "—"],
    ["Output", `${notes.audioTo ?? "—"}${notes.audioKbps ? ` · ${notes.audioKbps} kbps` : ""}`],
    ...(notes.audioReason ? [["Reason", notes.audioReason] as [string, string]] : []),
  ];
}
