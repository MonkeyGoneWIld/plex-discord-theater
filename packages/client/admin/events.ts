import type { PlayEvent, TrackPoint } from "./types";
import { clock, quality } from "./format";
import { clientName, formatsText } from "./clients";

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
  "reached the end": "playback",
  joined: "people", "came back": "people", "switched client": "people", left: "people", "away from Discord": "people", "back in Discord": "people",
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

/** How the host or a co-host changed (server sync.ts RoleWhy), for an event's details. */
const ROLE_WHY: Record<string, string> = {
  "handed over": "the host handed it over", "request accepted": "requested, and the host accepted",
  "request not answered": "requested, and the host didn't answer in time", "taken back": "taken back by the host it was passed from",
  "host left": "the host left", "host not back": "the host didn't come back in time", "host back": "the host reconnected in time",
  "nobody was host": "nobody else was host", "co-host given": "given by the host", "co-host removed": "removed by the host",
};

/** A change of host or co-host, and how it came about: `by` had the role or gave it, `target` got it. */
function roleText(who: string, d: Record<string, unknown>): string {
  const by = d.by ? String(d.by) : "the host";
  const target = d.target ? String(d.target) : "another viewer";
  const away = d.away ? " (away from the Discord window)" : "";
  const toHost = d.to === "host";
  const now = d.to === "co-host" ? "a co-host" : "a viewer";
  switch (d.why) {
    case "handed over": return toHost ? `${who} became host: ${by} handed it over` : `${who} handed host to ${target} and is now co-host`;
    case "request accepted": return toHost ? `${who} requested host and ${by} accepted` : `${who} accepted ${target}'s request for host and is now co-host`;
    case "request not answered": return toHost ? `${who} requested host and got it: ${by} didn't answer in time${away}`
      : `${who} didn't answer ${target}'s request for host in time${away}, so it passed to them; ${who} is now co-host`;
    case "taken back": return toHost ? `${who} took host back from ${by}` : `${who} is now co-host: ${target} took host back`;
    case "host left": return `${who} became host when ${by} left`;
    case "host not back": return `${who} became host: the host didn't come back in time`;
    case "host back": return toHost ? `${who} is host again` : `${who} is ${now} again: ${target} reconnected in time and is host`;
    case "nobody was host": return `${who} became host: nobody else was`;
    case "co-host given": return `${by} made ${who} a co-host`;
    case "co-host removed": return `${by} removed ${who} as co-host`;
  }
  return `${who} became ${role(d.to)}`;
}

const END_REASONS: Record<string, string> = {
  stopped: "playback was stopped", "another title": "another title was started", "room closed": "all viewers left",
  "server stopped": "the server shut down", "server restarted": "the server restarted unexpectedly",
};

/** The control a seek came from (client lib/commandCause.ts). */
const SEEK_CAUSES: Record<string, string> = {
  "skip intro": "Skip Intro", "skip credits": "Skip Credits", timeline: "the seek bar",
  "jump back": "the jump-back control", "jump forward": "the jump-forward control",
};

/** Where a title was started from (client lib/commandCause.ts; "co-host" from sync.ts). */
const PLAY_CAUSES: Record<string, string> = {
  picked: "the library", "next episode": "Next Episode", "previous episode": "Previous Episode",
  "up next": "the Up Next card", "end screen": "the end screen", queue: "the queue", "co-host": "a co-host's request",
};

/** How a player stopped (client useSync sendStop). */
const STOP_CAUSES: Record<string, string> = { closed: "closed the player", finished: "reached the end of the title" };

/** "alex (host)": who did it, and as what, when the event says. */
function actor(who: string, d: Record<string, unknown>): string {
  return d.role === "host" || d.role === "co-host" ? `${who} (${d.role})` : who;
}

/** How a title was ended by another starting: "alex started the next episode, Verity 2". */
function nextText(d: Record<string, unknown>, by: string | null): string {
  const next = d.next ? String(d.next) : "the next title";
  const who = by ?? "The host";
  switch (d.cause) {
    case "next episode": return `${who} started the next episode, ${next}`;
    case "previous episode": return `${who} started the previous episode, ${next}`;
    case "up next": return `${who} started ${next} from the Up Next card`;
    case "end screen": return `${who} started ${next} from the end screen`;
    case "queue": return `${who} started ${next} from the queue`;
    case "co-host": return `${who} started ${next} at ${d.askedBy ? String(d.askedBy) : "a co-host"}'s request`;
    case "picked": return `${who} started a different title, ${next}`;
    default: return by ? `${by} started ${next}` : `${next} was started`;
  }
}

/** Why a session ended, as said after "Session ended: ". */
function endText(d: Record<string, unknown>, by: string | null): string {
  if (d.reason === "another title") return nextText(d, by);
  if (d.reason === "stopped") {
    if (d.cause === "finished") return "the title finished";
    if (d.cause === "closed") return `${by ?? "the host"} closed the player${d.reachedEnd ? " after the end was reached" : ""}`;
    return `${by ? `${by} stopped playback` : "playback was stopped"}${d.reachedEnd ? " after the end was reached" : ""}`;
  }
  return END_REASONS[String(d.reason)] ?? (d.reason ? String(d.reason) : "no reason was recorded");
}

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
    case "play": {
      if (d.cause === "co-host") return `${actor(who, d)} started this title at ${d.askedBy ? String(d.askedBy) : "a co-host"}'s request`;
      const from = PLAY_CAUSES[String(d.cause)];
      return from ? `${actor(who, d)} started this title from ${from}` : `${actor(who, d)} started playback`;
    }
    case "pause": return `${actor(who, d)} paused playback`;
    case "resume": return `${actor(who, d)} resumed playback`;
    case "seek": {
      const range = `${clock(Number(d.fromS))} to ${clock(Number(d.toS))}`;
      if (d.cause === "skip intro" || d.cause === "skip credits") return `${actor(who, d)} used ${SEEK_CAUSES[d.cause]}: ${range}`;
      if (d.cause === "jump back" || d.cause === "jump forward") {
        const by = Math.abs(Number(d.toS) - Number(d.fromS));
        return `${actor(who, d)} jumped ${d.cause === "jump back" ? "back" : "forward"}${Number.isFinite(by) ? ` ${Math.round(by)} s` : ""}: ${range}`;
      }
      const via = SEEK_CAUSES[String(d.cause)];
      return `${actor(who, d)} moved playback from ${range}${via ? ` using ${via}` : ""}`;
    }
    case "stop": {
      const how = STOP_CAUSES[String(d.cause)];
      return how ? `${actor(who, d)} ${how}; playback stopped` : `${actor(who, d)} stopped playback`;
    }
    case "ended": return `Session ended: ${endText(d, e.username)}`;
    case "reached the end": return d.early
      ? `${who} reached the end of the stream${Number.isFinite(Number(d.breakAtS)) ? ` at ${clock(Number(d.breakAtS))}` : ""}, before the length Plex reports; playback was ended there`
      : `${who} reached the end of the title`;
    case "joined": return `${who} joined as ${role(d.role)}${d.device ? ` on ${clientName(d.device)}` : ""}`
      + `${d.why === "nobody was host" ? ": nobody else was host" : ""}`;
    case "came back": return `${who} reconnected${d.device ? ` on ${clientName(d.device)}` : ""}${d.why === "host back" ? " and is host again" : ""}`;
    case "switched client": return `${who} moved from ${clientName(d.from)} to ${clientName(d.to)}`;
    case "left": return `${who} left`;
    case "away from Discord": return `${who} switched away from the Discord window`;
    case "back in Discord": return `${who} returned to the Discord window`;
    case "role": return roleText(who, d);
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
    case "subtitles": {
      const change = `from ${trackName(ctx, d.from)} to ${trackName(ctx, d.to)}`;
      if (d.byHost) return `${who} (host) changed the subtitles ${change}`;
      if (d.host) return `${who}'s subtitles changed ${change}, following ${String(d.host)} (host)`;
      return `${who} changed the subtitles ${change}`;
    }
    case "quality": return `${who} changed the quality from ${quality(Number(d.from))} to ${quality(Number(d.to))}`;
    case "stream started": return `${d.variant ? streamLabel(ctx, d.variant) : "A stream"} started${e.username ? ` for ${e.username}` : ""}${d.summary ? `: ${d.summary}` : ""}`;
    case "stream restarted": return d.replaced
      ? `${streamLabel(ctx, d.variant)} restarted under a new session${d.summary ? `: ${d.summary}` : ""}`
      : `${streamLabel(ctx, d.variant)} restarted at ${clock(Number(d.toOffsetS))} (previously ${clock(Number(d.fromOffsetS))})`;
    case "stream ended": {
      const label = streamLabel(ctx, d.variant);
      if (d.host) return `${label} ended after ${String(d.host)} ${switchedText(d.switching) ?? "changed tracks"}`;
      if (d.unwatched) return `${label} ended: no viewers remained on it`;
      return `${label} ended`;
    }
    case "room waited": {
      const did = switchedText(d.switching);
      const why = did ? `after the host ${did}` : WAITED_FOR[String(d.why)] ?? (d.why ? `(${String(d.why)})` : "");
      return `Playback waited ${secs(d.ms)} for the host's video${why ? ` ${why}` : ""}`;
    }
    case "buffering": return `${who} was buffering for ${secs(d.ms)}`;
    case "loaded after seek": return `${who}'s player took ${secs(d.ms)} to load after a seek`;
    case "loaded at start": return `${who}'s player took ${secs(d.ms)} to load at the start`;
    case "player error": return `Player error for ${who}: ${d.msg ?? "unknown error"}`;
    default: return `${e.kind}${e.username ? ` (${e.username})` : ""}`;
  }
}

/** A field of an event's detail, named for the dashboard; fields not listed are left out. */
const DETAIL_LABELS: Record<string, string> = {
  role: "Role", cause: "Action", fromS: "From", toS: "To", from: "From", to: "To", reason: "Reason", next: "Next title",
  askedBy: "Requested by", reachedEnd: "End reached", breakAtS: "Stream ended at", ms: "Duration", why: "Reason",
  host: "Host", switching: "Host's change", variant: "Stream", summary: "Delivery", audioStreamId: "Audio",
  subtitleStreamId: "Subtitles", quality: "Quality", engine: "Engine", fromOffsetS: "Previous start", toOffsetS: "New start",
  offsetS: "Starts at", msg: "Message", tag: "Source", session: "Stream session", replaced: "Replaced session",
  device: "Client", caps: "Supported formats", by: "Host before", target: "Host after", away: "Host away from Discord",
};
/** For a change of host or co-host, its details' labels where they differ. */
const ROLE_LABELS: Record<string, string> = { why: "How" };

/** Who acted, for a co-host given or removed; the hosts either side, for the host changing. */
function roleLabel(k: string, d: Record<string, unknown>): string | undefined {
  const cohost = d.why === "co-host given" || d.why === "co-host removed";
  if (k === "by" && cohost) return "By";
  if (k === "target" && cohost) return undefined;
  return ROLE_LABELS[k] ?? DETAIL_LABELS[k];
}

const AS_IS = new Set(["askedBy", "host", "next", "msg", "tag", "session", "replaced", "summary", "engine", "by", "target"]);

/** An event's detail as labelled rows: what the expanded event shows. */
export function eventDetails(e: PlayEvent, ctx?: EventContext): Array<[string, string]> {
  const d = e.detail ?? {};
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(d)) {
    const label = e.kind === "role" ? roleLabel(k, d) : DETAIL_LABELS[k];
    if (!label || v === null || v === undefined || v === "") continue;
    const value = detailValue(e.kind, k, v, ctx);
    // Names and messages as they are; the dashboard's own words start with a capital.
    out.push([label, AS_IS.has(k) ? value : value.charAt(0).toUpperCase() + value.slice(1)]);
  }
  if (d.byHost) out.push(["Changed by", "The host"]);
  if (d.unwatched) out.push(["Reason", "No viewers remained on it"]);
  if (d.early) out.push(["Ended early", "Yes: the stream ended before the length Plex reports"]);
  // The agent as the player gave it, for a client not named above.
  for (const ua of [d.device, e.kind === "switched client" ? d.to : null]) if (typeof ua === "string" && ua) out.push(["User agent", ua]);
  return out;
}

function detailValue(kind: string, k: string, v: unknown, ctx?: EventContext): string {
  switch (k) {
    case "fromS": case "toS": case "breakAtS": case "fromOffsetS": case "toOffsetS": case "offsetS": return clock(Number(v));
    case "ms": return secs(v);
    case "role": return role(v);
    case "reachedEnd": return v ? "Yes" : "No";
    case "cause": return SEEK_CAUSES[String(v)] ?? PLAY_CAUSES[String(v)] ?? STOP_CAUSES[String(v)] ?? (v === "finished" ? "The title finished" : String(v));
    case "reason": return kind === "ended" ? (END_REASONS[String(v)] ?? String(v)) : WAITED_FOR[String(v)] ?? String(v);
    case "why": return ROLE_WHY[String(v)] ?? WAITED_FOR[String(v)] ?? switchedText(v) ?? String(v);
    case "away": return v ? "Yes" : "No";
    case "switching": return switchedText(v) ?? String(v);
    case "variant": return streamLabel(ctx, v);
    case "audioStreamId": return trackName(ctx, v, "default");
    case "subtitleStreamId": return trackName(ctx, v);
    case "quality": return quality(Number(v));
    case "device": return clientName(v);
    case "caps": return formatsText(v);
    case "from": case "to":
      if (kind === "switched client") return clientName(v);
      if (kind === "stream changed") return v ? streamLabel(ctx, v) : "—";
      if (kind === "subtitles") return trackName(ctx, v);
      if (kind === "quality") return quality(Number(v));
      return role(v);
    default: return typeof v === "object" ? JSON.stringify(v) : String(v);
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

const JUMP_LABELS: Record<string, string> = {
  "skip intro": "Skip Intro", "skip credits": "Skip Credits", "jump back": "Jump back", "jump forward": "Jump forward",
};

export interface Jump { at: number; fromS: number; toS: number; label: string; event: PlayEvent }

/** The room's seeks, oldest first: from where, to where, and what made each (Skip Intro, the timeline, …). */
export function jumpsOf(events: PlayEvent[]): Jump[] {
  return events.filter((e) => e.kind === "seek").flatMap((e) => {
    const fromS = Number(e.detail?.fromS);
    const toS = Number(e.detail?.toS);
    if (e.detail?.fromS == null || e.detail?.toS == null || !Number.isFinite(fromS) || !Number.isFinite(toS) || Math.abs(toS - fromS) < 1) return [];
    // One on the seek bar, or from no control known, by how far it went.
    const by = `Seek ${toS > fromS ? "+" : "\u2212"}${clock(Math.abs(toS - fromS))}`;
    return [{ at: e.at, fromS, toS, label: JUMP_LABELS[String(e.detail?.cause)] ?? by, event: e }];
  });
}

/** When, and where in the title, the title finished, if it did. */
/**
 * Where the position lane's lines go, seconds into the title: a round step
 * that leaves at most five spaces over its length, so a short title gets
 * closer lines (every 5 minutes over 24) and a film wider ones (every 30
 * minutes over two hours).
 */
export function positionTicks(durationS: number): number[] {
  const steps = [30, 60, 120, 300, 600, 900, 1200, 1800, 3600, 7200];
  const step = steps.find((s) => durationS / s <= 5) ?? Math.ceil(durationS / 5 / 3600) * 3600;
  const out: number[] = [];
  for (let t = 0; t <= durationS + 0.5; t += step) out.push(t);
  return out;
}

export function finishedAt(events: PlayEvent[]): { at: number; posS: number | null } | null {
  const e = events.find((x) => (x.kind === "ended" || x.kind === "stop") && x.detail?.cause === "finished");
  return e ? { at: e.at, posS: e.posS } : null;
}

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
