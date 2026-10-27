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
  /** Drawn by libass as its script has it (StyledSubtitleLayer), rather than as plain lines. */
  styled?: boolean;
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
  return `${track.title} · ${state === "complete" ? "loaded" : state}`;
}

/** How a subtitle drawn by the player is drawn. */
function renderer(track: StreamTrack, styled: boolean): string {
  if (track.picture) return "PGS bitmaps";
  if (styled) return "libass (full ASS styling)";
  return track.sidecar ? "Text · external file" : "Text · embedded";
}

/** Stretches that touch or overlap, as one: pieces read side by side overlap. */
export function mergedSpans(spans: readonly CoveredSpan[]): CoveredSpan[] {
  const out: CoveredSpan[] = [];
  for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && (last[1] === null || from <= last[1] + 0.5)) {
      last[1] = last[1] === null || to === null ? null : Math.max(last[1], to);
    } else out.push([from, to]);
  }
  return out;
}

/**
 * Coverage in one line: the read stretch the picture is in, or that it is in
 * none, and how much of the film is read — not every stretch, which ran past
 * the panel's edge and hid the one that mattered.
 */
export function coverageText(covered: CoveredSpan[] | null, atS: number, runtimeS: number | null): string {
  const spans = mergedSpans(covered ?? []);
  if (!spans.length) return "None yet";
  const here = spans.find(([from, to]) => from <= atS && (to === null || atS < to));
  const share = runtimeS
    ? ` · ${Math.min(100, Math.round(spans.reduce((sum, [from, to]) => sum + (to === null ? runtimeS : Math.min(to, runtimeS)) - from, 0) / runtimeS * 100))}%`
    : "";
  return here
    ? `${clock(here[0])}–${here[1] === null ? "end" : clock(here[1])}${share}`
    : `Not at ${clock(atS)}${share}`;
}

/** Its details, one line each. */
export function subtitleDetails(
  track: StreamTrack | null,
  shown: SubtitleShown,
  status: SubtitleLoadStatus | null,
  failed: boolean,
  now = Date.now(),
  atS = 0,
  runtimeS: number | null = null,
): Array<[string, string]> {
  if (shown === "off" || !track) return [];
  const rows: Array<[string, string]> = [["Track", track.title]];
  if (shown === "switching") return rows;
  if (shown === "burned") return [...rows, ["Renderer", "Burned into the video"]];
  const styled = status?.streamId === track.id && status.styled === true;
  rows.push(["Renderer", renderer(track, styled)]);
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
    ["Coverage", coverageText(status.covered, atS, runtimeS)],
  );
  if (status.firstLinesMs !== null) rows.push(["First cues", seconds(status.firstLinesMs)]);
  return rows;
}
