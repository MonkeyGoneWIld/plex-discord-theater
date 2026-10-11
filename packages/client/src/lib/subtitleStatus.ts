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

function stretches(spans: readonly CoveredSpan[]): string {
  if (!spans.length) return "none yet";
  return spans.map(([from, to]) => `${clock(from)}–${to === null ? "end" : clock(to)}`).join(", ");
}

/** The panel's rows for the subtitle. */
export function describeSubtitle(
  track: StreamTrack | null,
  shown: SubtitleShown,
  status: SubtitleLoadStatus | null,
  failed: boolean,
  now = Date.now(),
): Array<[string, string]> {
  if (shown === "off" || !track) return [["Subtitles", "Off"]];
  if (shown === "switching") return [["Subtitles", `${track.title} · switching to it`]];
  if (shown === "burned") {
    return [
      ["Subtitles", `${track.title} · burned into the picture by Plex`],
      ["Subtitle loading", "Comes with the video, segment by segment"],
    ];
  }
  const from = track.sidecar ? "from the file beside the film" : "read out of the film's own file";
  const rows: Array<[string, string]> = [["Subtitles", `${track.title} · drawn by the player, ${from}`]];
  const ms = (n: number) => `${(n / 1000).toFixed(1)} s`;
  if (failed || status?.state === "failed") {
    rows.push(["Subtitle loading", "Couldn't be loaded"]);
  } else if (!status || status.streamId !== track.id || status.state === "loading") {
    rows.push(["Subtitle loading", `Loading… ${status && status.streamId === track.id ? ms(now - status.startedAt) : ""}`.trim()]);
  } else if (status.state === "complete") {
    rows.push(["Subtitle loading", `Fully loaded · ${status.lines.toLocaleString("en-US")} lines${status.completeMs !== null ? ` in ${ms(status.completeMs)}` : ""}`]);
  } else {
    rows.push(
      ["Subtitle loading", `Plex still reading it · ${status.lines.toLocaleString("en-US")} lines so far · ${ms(now - status.startedAt)} in`],
      ["  Every line in", stretches(status.covered ?? [])],
    );
    if (status.firstLinesMs !== null) rows.push(["  Lines for here", `in ${ms(status.firstLinesMs)}`]);
  }
  return rows;
}
