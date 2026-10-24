import type { StreamTrack } from "./api";
import type { CoveredSpan } from "./subtitleCues";
import { clock } from "./previewStatus";

/**
 * Where a subtitle the player draws has got to, for "Stats for nerds": still
 * loading, being read out of the film by Plex as it plays, or all in.
 *
 * The subtitle layer (SubtitleLayer) keeps one of these up to date as its
 * answers come; the panel reads it each time it redraws.
 */
export interface SubtitleLoadStatus {
  streamId: number;
  state: "loading" | "reading" | "complete" | "failed";
  /** Lines in hand. */
  lines: number;
  /** While Plex reads it: the stretches of the film every line of has come. */
  covered: CoveredSpan[] | null;
  /** When it was first asked for, Date.now(). */
  startedAt: number;
  /** ms from asking to the first lines for where the picture was. */
  firstLinesMs: number | null;
  /** ms from asking to having all of it. */
  completeMs: number | null;
}

/** How the subtitle on screen is shown, as the player has it. */
export type SubtitleShown = "off" | "drawn" | "burned" | "switching";

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const lines = (n: number) => `${n.toLocaleString("en-US")} cues`;

/** This one's status, if the one the layer has is this one's. */
function statusOf(track: StreamTrack, status: SubtitleLoadStatus | null, failed: boolean): SubtitleLoadStatus["state"] {
  if (failed || (status?.streamId === track.id && status.state === "failed")) return "failed";
  if (!status || status.streamId !== track.id) return "loading";
  return status.state;
}

/** The panel's one line for the subtitle. */
export function subtitleSummary(
  track: StreamTrack | null,
  shown: SubtitleShown,
  status: SubtitleLoadStatus | null,
  failed: boolean,
): string {
  if (shown === "off" || !track) return "Off";
  if (shown === "switching") return `${track.title} · switching`;
  if (shown === "burned") return `${track.title} · burned in`;
  const state = statusOf(track, status, failed);
  return `${track.title} · ${state === "complete" ? "loaded" : state === "reading" ? `reading (${status!.lines})` : state}`;
}

/** Its details, one line each. */
export function subtitleDetails(
  track: StreamTrack | null,
  shown: SubtitleShown,
  status: SubtitleLoadStatus | null,
  failed: boolean,
  now = Date.now(),
): Array<[string, string]> {
  if (shown === "off" || !track) return [];
  const rows: Array<[string, string]> = [["Track", track.title]];
  if (shown === "switching") return rows;
  if (shown === "burned") return [...rows, ["Rendering", "Burned in by Plex"]];
  rows.push(["Rendering", `Client · ${track.picture ? "PGS pictures" : track.sidecar ? "sidecar file" : "embedded text"}`]);
  const state = statusOf(track, status, failed);
  if (state === "failed") return [...rows, ["Status", "Failed"]];
  if (state === "loading" || !status) {
    return [...rows, ["Status", status?.streamId === track.id ? `Loading · ${seconds(now - status.startedAt)}` : "Loading"]];
  }
  if (state === "complete") {
    return [...rows, ["Status", `Loaded · ${lines(status.lines)}${status.completeMs !== null ? ` · ${seconds(status.completeMs)}` : ""}`]];
  }
  rows.push(
    ["Status", `Reading · ${lines(status.lines)} · ${seconds(now - status.startedAt)}`],
    ["Coverage", (status.covered ?? []).map(([from, to]) => `${clock(from)}–${to === null ? "end" : clock(to)}`).join(", ") || "none yet"],
  );
  if (status.firstLinesMs !== null) rows.push(["First cues", seconds(status.firstLinesMs)]);
  return rows;
}
