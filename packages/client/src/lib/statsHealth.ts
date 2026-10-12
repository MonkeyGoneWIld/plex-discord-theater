/**
 * How each line of Stats for nerds is judged, and what its graphs plot: green
 * for as it should be, amber for something converted or worth watching, red
 * for something going wrong, blue for something still loading.
 */
import type { StreamNotes } from "./streamNotes";
import type { StreamTrack } from "./api";
import type { PreviewStatus } from "./previewStatus";
import type { SubtitleLoadStatus, SubtitleShown } from "./subtitleStatus";

export type Health = "ok" | "warn" | "bad" | "info" | "none";

/** Each health's colours: the line or text, a graph's fill, a bar's darker half. */
export const HEALTH_COLORS: Record<Health, { line: string; fill: string; dim: string }> = {
  ok: { line: "#6cc58c", fill: "#1f3a2a", dim: "#2f5e43" },
  warn: { line: "#e5a00d", fill: "#3a2e12", dim: "#6b4d10" },
  bad: { line: "#e5675a", fill: "#3d1f1c", dim: "#6e2e28" },
  info: { line: "#6aa2e8", fill: "#1b2b40", dim: "#2e4a6e" },
  none: { line: "#f0f0f0", fill: "#262626", dim: "#3a3a3a" },
};

/** Seconds ahead above which a buffer is healthy, and below which it is short. */
export const BUFFER_GOOD_S = 30;
export const BUFFER_LOW_S = 10;
/** Times the stream's bitrate a connection should manage, and must. */
export const SPEED_GOOD_RATIO = 1.5;
/** Seconds from the room a follower may be and be in step, and be nearly. */
export const SYNC_GOOD_S = 0.5;
export const SYNC_NEAR_S = 2;
/** Dropped frames, as a share of those shown, past which it is bad. */
export const DROPPED_BAD_SHARE = 0.02;
/** A frame rate this far under the stream's own is falling behind. */
export const FPS_LOW_SHARE = 0.8;

/** Downloaded `aheadS` past the playhead, or all of what is left (`toEnd`). */
export function bufferHealth(aheadS: number | null, toEnd = false): Health {
  if (aheadS === null) return "none";
  if (toEnd || aheadS > BUFFER_GOOD_S) return "ok";
  return aheadS >= BUFFER_LOW_S ? "warn" : "bad";
}

/**
 * A connection's speed against what the stream needs, both bits a second —
 * judged only when the buffer says it matters. With the buffer full, the
 * player asks for no more than it plays, so the speed it reads is about what
 * the stream needs: amber and red there said "your connection is the
 * problem" while nothing was wrong. So a buffer that isn't shrinking, and
 * isn't already nearly empty, makes the connection green whatever it reads;
 * it is judged on its speed only while the buffer is going down, or low.
 */
export function speedHealth(
  speedBps: number | null,
  needBps: number | null,
  buffer?: { health: Health; falling: boolean },
): Health {
  if (!speedBps) return "none";
  if (buffer && !buffer.falling && buffer.health !== "bad") return "ok";
  if (!needBps) return "info";
  const ratio = speedBps / needBps;
  return ratio >= SPEED_GOOD_RATIO ? "ok" : ratio >= 1 ? "warn" : "bad";
}

/**
 * Frames over the last few seconds of playing: any dropped is worth a look,
 * a share of them past DROPPED_BAD_SHARE is bad, and so is a rate well under
 * the stream's own (`nominalFps`, the best it has managed lately).
 */
export function framesHealth(recent: { shown: number; dropped: number }, fps: number | null, nominalFps: number | null): Health {
  if (fps === null) return "none";
  if (recent.dropped > 0 && recent.dropped >= DROPPED_BAD_SHARE * Math.max(1, recent.shown)) return "bad";
  if (nominalFps && fps < FPS_LOW_SHARE * nominalFps) return "bad";
  return recent.dropped > 0 ? "warn" : "ok";
}

/** What the player knows of its place in the room — see Player's statsSync. */
export interface SyncInfo {
  role: "host" | "co-host" | "viewer";
  /** Seconds ahead of the room (negative: behind); null for the host, whose
   *  playhead is the room's clock, and when the room is on another title. */
  driftS: number | null;
  /** The element's playback rate: over 1 while catching up. */
  rate: number;
  /** Stopped on purpose, ahead of the room, until it arrives. */
  waitingForRoom: boolean;
  roomPlaying: boolean;
  /** Stops while playing on this title: how many, and how long in all. */
  stalls: { count: number; totalMs: number };
}

export function stallsHealth(stalls: { count: number; totalMs: number }): Health {
  if (stalls.count === 0) return "ok";
  return stalls.totalMs < 2000 ? "warn" : "bad";
}

/** The Sync line: where this player is against the room, and how that is. */
export function syncSummary(info: SyncInfo | null): { text: string; health: Health } {
  if (!info) return { text: "—", health: "none" };
  if (info.role === "host") return { text: "Host · sets the room clock", health: "ok" };
  if (info.driftS === null) return { text: "Room on another title", health: "none" };
  const d = info.driftS;
  const drift = `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(2)} s`;
  if (info.waitingForRoom) return { text: `${drift} · waiting for the room`, health: "info" };
  if (!info.roomPlaying) return { text: `${drift} · room paused`, health: Math.abs(d) < SYNC_GOOD_S ? "ok" : "warn" };
  const rate = Math.abs(info.rate - 1) >= 0.005
    ? ` · ${info.rate > 1 ? "catching up" : "easing back"} ${info.rate.toFixed(2)}×`
    : "";
  const health = Math.abs(d) < SYNC_GOOD_S ? "ok" : Math.abs(d) < SYNC_NEAR_S ? "warn" : "bad";
  return { text: `${drift} from the room${rate}`, health };
}

/**
 * Why a stream isn't Direct Play, as the Playback row opens to: every
 * reason, a line each, video's first.
 */
export function playbackWhy(notes: StreamNotes | null, mode: string | null): Array<[string, string]> {
  if (!mode || mode === "Direct Play") return [];
  const why: string[] = [];
  if (notes?.video === "transcode") why.push(`Video: ${notes.reason ?? "not said by the server"}`);
  if (notes?.audio === "transcode") why.push(`Audio: ${notes.audioReason ?? "converted"}`);
  else if (!notes?.audio && notes?.video === "copy") why.push("Audio: not reported by the server");
  if (!notes) why.push("Not reported by the server");
  return why.map((line, i) => [i === 0 ? "Why" : "", line]);
}

/** A playback mode's colour: green as it is, amber with audio converted, red re-encoded. */
export function modeHealth(mode: string | null): Health {
  return mode === "Direct Play" ? "ok" : mode === "Direct Stream" ? "warn" : mode === "Transcode" ? "bad" : "none";
}

/** Seconds back a falling buffer is measured over, and by how much it must fall. */
export const BUFFER_TREND_SAMPLES = 10;
export const BUFFER_FALLING_S = 3;

/** Whether the buffer has shrunk over the last few samples, playing. */
export function bufferFalling(samples: Array<number | null>, back = BUFFER_TREND_SAMPLES, byS = BUFFER_FALLING_S): boolean {
  const known = samples.slice(-(back + 1)).filter((v): v is number => v !== null);
  if (known.length < 2) return false;
  return known[0] - known[known.length - 1] >= byS;
}

/** Add a sample, keeping the last `max`. */
export function pushSample<T>(samples: T[], value: T, max = 60): void {
  samples.push(value);
  if (samples.length > max) samples.splice(0, samples.length - max);
}

/**
 * A graph's lines, as SVG polyline point lists: one per unbroken run of
 * samples, a null being a gap (paused, say). `slots` is how many samples the
 * graph's width holds, the newest at its right edge.
 */
export function sparkLines(values: Array<number | null>, max: number, width: number, height: number, slots = 60): string[] {
  const lines: string[] = [];
  let run: string[] = [];
  const step = width / Math.max(1, slots - 1);
  const offset = slots - values.length;
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (run.length) lines.push(run.join(" "));
      run = [];
      return;
    }
    const x = (offset + i) * step;
    const y = height - 1 - Math.max(0, Math.min(1, v / (max || 1))) * (height - 3);
    run.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  if (run.length) lines.push(run.join(" "));
  return lines;
}

/**
 * The subtitle's colour: none when off, amber burned into the picture (it
 * forced a re-encode), blue while it is still coming, red if it couldn't be
 * had, green once it is all in.
 */
export function subtitleHealth(
  shown: SubtitleShown,
  track: StreamTrack | null,
  status: SubtitleLoadStatus | null,
  failed: boolean,
): Health {
  if (shown === "off" || !track) return "none";
  if (shown === "switching") return "info";
  if (shown === "burned") return "warn";
  if (failed || (status?.streamId === track.id && status.state === "failed")) return "bad";
  if (!status || status.streamId !== track.id || status.state !== "complete") return "info";
  return "ok";
}

/** The preview frames' colour: blue still coming, amber only some or none to be had, red failed. */
export function previewHealth(status: PreviewStatus | null, hasFrames: boolean): Health {
  if (!hasFrames || !status) return "none";
  switch (status.state) {
    case "complete": return "ok";
    case "waiting":
    case "downloading": return "info";
    case "failed": return "bad";
    default: return "warn";
  }
}
