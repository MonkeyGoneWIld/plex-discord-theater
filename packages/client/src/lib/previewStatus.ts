/**
 * Where the seek bar's preview frames have got to, for "Stats for nerds": how
 * many are in, and when each pass was asked for and came, so a test can see
 * them arrive against the film.
 *
 * The seek bar (Controls) keeps one of these up to date as it reads; the
 * panel reads it each time it redraws.
 */

/** The passes' names, as the reader calls their tiers. */
const PASS_NAMES = ["coarse", "medium", "fine", "full"];

export interface PreviewPass {
  pass: number;
  /** Seconds after the film started that it was asked for; null for one
   *  fetched on the title's page before Play. */
  askedS: number | null;
  /** Seconds after the film started that its last byte came; null until then. */
  doneS: number | null;
  /** Where the picture was when it came. */
  playheadS: number | null;
  bytes: number;
  /** Frames ready once it had come. */
  readyAfter: number | null;
  fromTitlePage: boolean;
}

export interface PreviewStatus {
  partId: number;
  state: "waiting" | "downloading" | "complete" | "incomplete" | "unavailable" | "unreadable" | "failed";
  /** How the frames come: "progressive-v2" a pass at a time, or all at once. */
  transport: string | null;
  /** Frames in the film, once the index says; 0 before. */
  frames: number;
  ready: number;
  bytes: number;
  passes: PreviewPass[];
  /** Seconds of buffer the next pass waits for, while it waits. */
  waitingForBufferS: number | null;
  /** The answer's status when the server had no frames to send. */
  httpStatus?: number;
}

export function size(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
export function clock(s: number): string {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
// Asked for a pass at a time: four, until the answer says otherwise.
const passCount = (status: PreviewStatus) => (status.transport === "progressive-v2" || status.transport === null ? PASS_NAMES.length : 1);
const count = (status: PreviewStatus) => (status.frames ? `${status.ready}/${status.frames}` : "starting");

/** The panel's one line for the preview frames. `hasFrames` is whether Plex
 *  has frames for this file at all. */
export function previewSummary(status: PreviewStatus | null, hasFrames: boolean): string {
  if (!hasFrames) return "None";
  if (!status) return "Waiting for playback";
  const passes = passCount(status);
  switch (status.state) {
    case "complete": return `${count(status)} · ${size(status.bytes)}`;
    case "incomplete": return `${count(status)} · incomplete`;
    case "unavailable": return `Unavailable (${status.httpStatus ?? "no answer"}) · per frame`;
    case "unreadable": return "Index unreadable · per frame";
    case "failed": return `${count(status)} · failed · per frame`;
    case "waiting":
      return `${count(status)} · pass ${Math.min(status.passes.length + 1, passes)}/${passes} at ${status.waitingForBufferS ?? 0} s buffer`;
    default: return `${count(status)} · pass ${status.passes.length}/${passes}`;
  }
}

/** Its details, one line each: every pass, and when it came. */
export function previewDetails(status: PreviewStatus | null): Array<[string, string]> {
  if (!status) return [];
  const progressive = status.transport === "progressive-v2" || status.transport === null;
  const rows: Array<[string, string]> = [
    ["Transport", status.transport === null ? "Progressive · asked" : progressive ? "Progressive · 4 passes" : "Single index"],
  ];
  for (const p of status.passes) {
    const name = progressive ? `Pass ${p.pass + 1} · ${PASS_NAMES[p.pass] ?? "?"}` : "Index";
    const value = p.doneS === null
      ? `asked ${p.askedS?.toFixed(1) ?? "0.0"} s · ${size(p.bytes)}…`
      : p.fromTitlePage
        ? `${p.readyAfter ?? 0} · title page · ${size(p.bytes)}`
        : `${p.readyAfter ?? 0} · ${(p.askedS ?? 0).toFixed(1)}→${p.doneS.toFixed(1)} s @${clock(p.playheadS ?? 0)} · ${size(p.bytes)}`;
    rows.push([name, value]);
  }
  if (status.state === "waiting" && progressive) {
    const next = status.passes.length;
    rows.push([`Pass ${next + 1} · ${PASS_NAMES[next] ?? "?"}`, `waiting for ${status.waitingForBufferS ?? 0} s buffer`]);
  }
  return rows;
}
