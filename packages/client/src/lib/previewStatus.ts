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

const kb = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`);
const secs = (s: number) => `${s.toFixed(1)} s`;
export function clock(s: number): string {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * The panel's rows for the preview frames: a summary, then one per pass.
 * `hasFrames` is whether Plex has frames for this file at all.
 */
export function describePreview(status: PreviewStatus | null, hasFrames: boolean): Array<[string, string]> {
  if (!hasFrames) return [["Preview thumbnails", "None — Plex has none for this file"]];
  if (!status) return [["Preview thumbnails", "Not asked for yet — they come once the film starts"]];
  const total = status.frames ? ` of ${status.frames}` : "";
  const sizes = status.bytes ? ` · ${kb(status.bytes)}` : "";
  const progressive = status.transport === "progressive-v2";
  const passCount = progressive ? PASS_NAMES.length : 1;
  const current = status.passes.length;
  let summary: string;
  switch (status.state) {
    case "complete": summary = `All ${status.ready} ready${sizes}`; break;
    case "incomplete": summary = `${status.ready}${total} ready, and no more coming${sizes}`; break;
    case "unavailable": summary = `None — the server answered ${status.httpStatus ?? "with nothing"}; asked one at a time instead`; break;
    case "unreadable": summary = `Their index couldn't be read; asked one at a time instead${sizes}`; break;
    case "failed": summary = `${status.ready}${total} ready, then the download failed; the rest asked one at a time${sizes}`; break;
    case "waiting":
      summary = `${status.ready}${total} ready${sizes} · pass ${Math.min(current + 1, passCount)} of ${passCount} waits for ${status.waitingForBufferS ?? 0} s of buffer`;
      break;
    default: summary = `${status.ready}${total} ready${sizes} · downloading pass ${current} of ${passCount}`;
  }
  const rows: Array<[string, string]> = [["Preview thumbnails", summary]];
  for (const p of status.passes) {
    const name = progressive ? `${p.pass + 1} (${PASS_NAMES[p.pass] ?? "?"})` : "(all)";
    const asked = p.fromTitlePage ? "fetched on the title's page" : `asked ${secs(p.askedS ?? 0)} in`;
    const came = p.doneS === null
      ? `coming in, ${kb(p.bytes)} so far`
      : `${p.readyAfter ?? 0} ready ${secs(p.doneS)} in, at ${clock(p.playheadS ?? 0)} · ${kb(p.bytes)}`;
    rows.push([`  Pass ${name}`, `${asked}; ${came}`]);
  }
  return rows;
}
