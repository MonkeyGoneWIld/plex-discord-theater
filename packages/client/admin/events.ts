import type { PlayEvent, TrackPoint } from "./types";
import { clock, quality } from "./format";

/**
 * A session's events as sentences, and what the pages draw of where in the
 * title it was. No React here, so the tests can read it as it is.
 */

/** What the sentences need to name a stream and a track. */
export interface EventContext {
  /** The title's audio and subtitle tracks' names, by Plex stream id. */
  tracks?: Record<string, string> | null;
  /** The session's streams in order, for "Stream 2". */
  streams?: Array<{ variantKey: string | null }>;
}

export type EventGroup = "playback" | "people" | "streams" | "problems" | "other";

const GROUPS: Record<string, EventGroup> = {
  play: "playback", pause: "playback", resume: "playback", seek: "playback", stop: "playback", ended: "playback",
  joined: "people", "came back": "people", left: "people", "away from Discord": "people", "back in Discord": "people",
  role: "people",
  "stream started": "streams", "stream restarted": "streams", "stream ended": "streams", "stream changed": "streams",
  subtitles: "streams", quality: "streams",
  buffering: "problems", "loaded after seek": "problems", "loaded at start": "problems", "player error": "problems",
  "room waited": "problems",
};

export const GROUP_LABELS: Record<EventGroup, string> = {
  playback: "Playback", people: "Viewers", streams: "Streams and tracks", problems: "Loading, buffering and errors", other: "Other",
};

export function groupOf(e: PlayEvent): EventGroup {
  return GROUPS[e.kind] ?? "other";
}

const secs = (ms: unknown) => {
  const n = Number(ms);
  return Number.isFinite(n) ? (n < 10_000 ? `${(n / 1000).toFixed(1)} s` : clock(n / 1000)) : "an unknown time";
};
const role = (v: unknown) => (v === "co-host" ? "co-host" : v === "host" ? "host" : "viewer");

const END_REASONS: Record<string, string> = {
  stopped: "playback was stopped", "another title": "the next title started", "room closed": "everyone left",
  "server stopped": "the server shut down", "server restarted": "the server restarted unexpectedly",
};

/** A track by its name where the title's are known — "Japanese (AC3 5.1)" — else by number. 0 is `none`. */
export function trackName(ctx: EventContext | undefined, id: unknown, none = "off"): string {
  const n = Number(id);
  if (!Number.isFinite(n) || n <= 0) return none;
  return ctx?.tracks?.[String(n)] ?? `track ${n}`;
}

/** A stream's key in parts: "135836:0@8000/h264" is audio 135836, no subtitles, at most 8 Mbps, the bot's own H.264. */
export function variantParts(key: unknown): { audio: number; subtitle: number; quality: number; format: string } | null {
  const m = /^(\d+):(\d+)(?:@(\d+))?(.*)$/.exec(String(key ?? ""));
  return m ? { audio: Number(m[1]), subtitle: Number(m[2]), quality: Number(m[3] ?? 0), format: m[4] } : null;
}

/** What differs between two streams of a title, as said: ["audio", "subtitles"]. */
export function streamDiff(from: unknown, to: unknown): string[] {
  const a = variantParts(from);
  const b = variantParts(to);
  if (!a || !b) return [];
  const out: string[] = [];
  if (a.audio !== b.audio) out.push("audio");
  if (a.subtitle !== b.subtitle) out.push("subtitles");
  if (a.quality !== b.quality) out.push("quality");
  if (a.format !== b.format) out.push("picture format");
  return out;
}

/** "Stream 2", by its place among the session's. */
export function streamLabel(ctx: EventContext | undefined, key: unknown): string {
  const i = ctx?.streams?.findIndex((s) => s.variantKey === key) ?? -1;
  return i >= 0 ? `Stream ${i + 1}` : "a stream";
}

/** "audio Japanese (AC3 5.1), subtitles off". */
function tracksOf(ctx: EventContext | undefined, key: unknown, d: Record<string, unknown>): string {
  const p = variantParts(key);
  const audio = d.audioStreamId ?? p?.audio;
  const subtitle = d.subtitleStreamId ?? p?.subtitle;
  return `audio ${trackName(ctx, audio, "default")}, subtitles ${trackName(ctx, subtitle)}`;
}

/** What the host's stream was rebuilt for (RoomState.hostSwitching), as what they did. */
const SWITCHED: Record<string, string> = {
  audio: "changed the audio", subtitle: "changed the subtitles", quality: "changed the quality", reload: "reloaded the stream",
};
export const switchedText = (v: unknown): string | null => SWITCHED[String(v)] ?? null;

/** What the room waited for the host's picture after (sync.ts, updateWaiting). */
const WAITED_FOR: Record<string, string> = {
  "a stream is starting": "as the host's stream started",
  "the host's stream is being rebuilt": "while the host's stream was rebuilt",
  "the host is waiting for its stream": "while the host's player loaded",
  resumed: "after playback resumed",
  "a seek": "after a seek",
  "new host": "for the new host",
  "everybody left": "after everyone left",
  "a player left": "after a player left",
};

/** One event of a session, as a sentence. */
export function eventText(e: PlayEvent, ctx?: EventContext): string {
  const who = e.username ?? e.userId ?? "A viewer";
  const d = e.detail ?? {};
  switch (e.kind) {
    case "play": return `${who} started playback`;
    case "pause": return `${who} paused playback`;
    case "resume": return `${who} resumed playback`;
    case "seek": return `${who} seeked from ${clock(Number(d.fromS))} to ${clock(Number(d.toS))}`;
    case "stop": return `${who} stopped playback`;
    case "ended": return `Session ended: ${END_REASONS[String(d.reason)] ?? d.reason ?? "no reason recorded"}${e.username ? ` (${e.username})` : ""}`;
    case "joined": return `${who} joined as ${role(d.role)}`;
    case "came back": return `${who} reconnected`;
    case "left": return `${who} left`;
    case "away from Discord": return `${who} switched away from Discord`;
    case "back in Discord": return `${who} returned to Discord`;
    case "role": return `${who} became ${role(d.to)}`;
    case "stream changed": {
      const on = `${streamLabel(ctx, d.to)} (${tracksOf(ctx, d.to, d)})`;
      // Joining, or a new title: the stream they start on.
      if (!d.from) return `${who} started on ${on}`;
      const did = switchedText(d.why);
      if (d.host) return `${who} moved to ${on} because ${String(d.host)} ${did ?? "changed tracks"}`;
      if (did) return `${who} ${did}: now on ${on}`;
      const what = streamDiff(d.from, d.to);
      return `${who} moved from ${streamLabel(ctx, d.from)} to ${on}${what.length ? `: a change of ${what.join(" and ")}` : ""}`;
    }
    case "subtitles": return `${who} changed subtitles from ${trackName(ctx, d.from)} to ${trackName(ctx, d.to)}`;
    case "quality": return `${who} changed quality from ${quality(Number(d.from))} to ${quality(Number(d.to))}`;
    case "stream started": return `${d.variant ? streamLabel(ctx, d.variant) : "A stream"} started${e.username ? ` for ${e.username}` : ""}${d.summary ? `: ${d.summary}` : ""}`;
    case "stream restarted": return d.replaced
      ? `${streamLabel(ctx, d.variant)} restarted under a new session${d.summary ? `: ${d.summary}` : ""}`
      : `${streamLabel(ctx, d.variant)} restarted at ${clock(Number(d.toOffsetS))} (previously ${clock(Number(d.fromOffsetS))})`;
    case "stream ended": return `${streamLabel(ctx, d.variant)} ended`;
    case "room waited": {
      const did = switchedText(d.switching);
      const why = did ? `after the host ${did}` : WAITED_FOR[String(d.why)] ?? (d.why ? `(${String(d.why)})` : "");
      return `Playback waited ${secs(d.ms)} for the host's picture${why ? ` ${why}` : ""}`;
    }
    case "buffering": return `${who} buffered for ${secs(d.ms)}`;
    case "loaded after seek": return `${who} loaded for ${secs(d.ms)} after a seek`;
    case "loaded at start": return `${who} loaded for ${secs(d.ms)} as they started`;
    case "player error": return `${who}: player error: ${d.msg ?? "unknown"}${d.tag ? ` (${d.tag})` : ""}`;
    default: return `${e.kind}${e.username ? ` — ${e.username}` : ""}`;
  }
}

export function eventTone(e: PlayEvent): string {
  if (e.kind === "player error") return "bad";
  if (e.kind === "buffering" || e.kind === "room waited") return "warn";
  return "";
}

/** The newest first: lists people read from the top. */
export const newestFirst = <T extends { at: number; id: number }>(list: T[]): T[] =>
  [...list].sort((a, b) => b.at - a.at || b.id - a.id);

/** Where in the title the room was at a time, from its track; null in a break or outside it. */
export function positionAt(track: TrackPoint[], t: number): number | null {
  let before: TrackPoint | null = null;
  for (const p of track) {
    if (p[0] > t) {
      if (!before || before[1] < 0 || p[1] < 0) return before && before[1] >= 0 ? before[1] : null;
      // Playing, it moved on with the clock, as far as the next point says.
      return before[2] ? Math.min(p[1] >= before[1] ? p[1] : Infinity, before[1] + (t - before[0]) / 1000) : before[1];
    }
    before = p;
  }
  return before && before[1] >= 0 ? before[1] : null;
}

/** Parts of a title put together where they meet or overlap. */
export function unionParts(lists: Array<Array<[number, number]>>): Array<[number, number]> {
  const all = lists.flat().filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of all) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
