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
  return { video, reason: value("reason"), kbps: num("kbps"), quality: num("quality") };
}
