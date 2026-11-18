import type { ProcessingStep } from "./types";

/**
 * The steps the server takes to prepare a title and its streams
 * (server services/admin-hooks.ts ProcessingKind), by the names the
 * Theater Dashboard gives them, and in the order they happen.
 */
export const PROCESSING_NAMES: Record<string, string> = {
  probe: "File analysis",
  "stream setup": "Stream setup",
  "first segment": "First segment",
  "whole file": "Full-file processing",
  "stream failed": "Stream failure",
  subtitle: "Subtitle extraction",
  "subtitle window": "Partial subtitle extraction",
  "picture subtitle": "Image subtitle conversion",
  sidecar: "External subtitle load",
  previews: "Seek preview generation",
};

export const PROCESSING_ORDER = Object.keys(PROCESSING_NAMES);

/** What each step does, for the Media processing table's help line and the Statistics page. */
export const PROCESSING_HELP: Record<string, string> = {
  probe: "Reading the file's video, audio and subtitle tracks before the first stream starts.",
  "stream setup": "From the stream request to FFmpeg running.",
  "first segment": "From FFmpeg start to the first playable segment.",
  "whole file": "Remuxing or transcoding through to the end of the file.",
  "stream failed": "A stream that stopped with an error.",
  subtitle: "Extracting a text subtitle track from the file.",
  "subtitle window": "Extracting the subtitle lines around the current position.",
  "picture subtitle": "Converting an image-based subtitle track (PGS) for the players.",
  sidecar: "Loading a subtitle file stored next to the title.",
  previews: "Generating the thumbnails shown while seeking.",
};

/** A step's name; a remux or a transcode where the whole file is said. */
export function processingName(kind: string, encode?: boolean | null): string {
  if (kind === "whole file" && encode !== undefined && encode !== null) return encode ? "Full-file transcode" : "Full-file remux";
  if (kind === "first segment" && encode !== undefined && encode !== null) return encode ? "First segment (transcode)" : "First segment (remux)";
  return PROCESSING_NAMES[kind] ?? kind;
}

export { duration } from "./format";

/** The detail a step recorded, in words: "4 tracks", "From 1:10:10", "Converted at 39× real time". */
export function stepDetail(s: ProcessingStep): string {
  const d = (s.detail ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  if (typeof d.streams === "number") out.push(`${d.streams} tracks`);
  if (typeof d.fromS === "number" && d.fromS > 0) {
    const t = Math.round(d.fromS);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    out.push(`From ${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(t % 60).padStart(2, "0")}`);
  }
  if (typeof d.speedX === "number") out.push(`${d.speedX}× real time`);
  if (typeof d.format === "string") out.push(String(d.format).toUpperCase());
  if (typeof d.cues === "number") out.push(`${d.cues} lines`);
  if (typeof d.frames === "number") out.push(`${d.frames} thumbnails`);
  if (typeof d.pieces === "number") out.push(`${d.pieces} parts`);
  if (typeof d.why === "string") out.push(d.why);
  return out.join(" · ");
}
