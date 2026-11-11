import { useCallback, useEffect, useState } from "react";
import type { Notes, PlayEvent, ViewerData } from "./types";
import { bytes, clock, quality, short } from "./format";

/** What each note a stream's playlist carries is, in words (routes/plex.ts, streamNotes). */
export const NOTE_LABELS: Record<string, string> = {
  engine: "Engine",
  encoder: "Encoder",
  fallback: "Why Plex makes it",
  video: "Video",
  reason: "Why the video is re-encoded",
  kbps: "Video bitrate (kbps)",
  quality: "Quality",
  allowed: "Bitrate allowed (kbps)",
  videoFrom: "Source video",
  range: "Dynamic range",
  perScreen: "Per screen",
  audio: "Audio",
  audioFrom: "Source audio",
  audioTo: "Audio sent",
  audioKbps: "Audio bitrate (kbps)",
  audioReason: "Why the audio is converted",
};

export function NotesList({ notes }: { notes: Notes }) {
  if (Object.keys(notes).length === 0) return null;
  return (
    <>
      <h4>What the playlist told its players</h4>
      <dl className="grid">
        {Object.entries(notes).map(([k, v]) => (
          <span key={k} style={{ display: "contents" }}>
            <dt title={`com.pdt.${k}`}>{NOTE_LABELS[k] ?? k}</dt>
            <dd>{String(v)}</dd>
          </span>
        ))}
      </dl>
    </>
  );
}

/** What a viewer got, and from where: the bot, Discord's cache, other viewers. */
export function DataCell({ d }: { d: ViewerData }) {
  const total = d.httpBytes + d.p2pBytes;
  return (
    <>
      <strong className="nowrap">{bytes(total)}</strong>
      <div className="muted small nowrap">From the bot {bytes(d.botBytes)}</div>
      <div className="muted small nowrap">Discord's cache {bytes(d.edgeHitBytes)}</div>
      <div className="muted small nowrap">Other viewers {bytes(d.p2pBytes)}</div>
    </>
  );
}

export function BufferingCell({ d }: { d: ViewerData }) {
  if (d.stalls === 0 && d.errors === 0) return <>None</>;
  return (
    <>
      {d.stalls > 0 && <div className="nowrap">{d.stalls} {d.stalls === 1 ? "time" : "times"}, {clock(d.stalledMs / 1000)}</div>}
      {d.errors > 0 && <div className="muted small">{d.errors} player {d.errors === 1 ? "error" : "errors"}</div>}
    </>
  );
}

/** A person, by name, linking to their page. */
export function Who({ id, name }: { id: string | null; name?: string | null }) {
  if (!id) return <>{name ?? "—"}</>;
  return <a href={`#people/${id}`}>{name ?? id}</a>;
}

/** A Discord server and channel, by ID: Discord doesn't tell the bot their names. */
export function Where({ guildId, channelId }: { guildId: string | null; channelId: string | null }) {
  if (!guildId && !channelId) return <span className="muted">Unknown</span>;
  return (
    <span className="mono where" title={`Server ${guildId ?? "?"} · channel ${channelId ?? "?"}`}>
      {short(guildId ?? "?", 10)} · {short(channelId ?? "?", 10)}
    </span>
  );
}

/** Load once, and again on `deps`; signed-out and other errors go to onError. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], onError: (e: unknown) => void) {
  const [data, setData] = useState<T | null>(null);
  const [busy, setBusy] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, deps);
  const reload = useCallback(() => {
    setBusy(true);
    run().then(setData).catch(onError).finally(() => setBusy(false));
  }, [run, onError]);
  useEffect(() => { reload(); }, [reload]);
  return { data, busy, reload, setData };
}

// ─── A play's history, line by line ─────────────────────────────

export type EventGroup = "playback" | "people" | "streams" | "problems" | "other";

const GROUPS: Record<string, EventGroup> = {
  play: "playback", pause: "playback", resume: "playback", seek: "playback", stop: "playback", ended: "playback",
  joined: "people", "came back": "people", left: "people", "away from Discord": "people", "back in Discord": "people",
  role: "people",
  "stream started": "streams", "stream restarted": "streams", "stream ended": "streams", "stream changed": "streams",
  subtitles: "streams", quality: "streams",
  buffering: "problems", "loaded after seek": "problems", "player error": "problems", "room waited": "problems",
};

export const GROUP_LABELS: Record<EventGroup, string> = {
  playback: "Playback", people: "People", streams: "Streams and tracks", problems: "Buffering and errors", other: "Other",
};

export function groupOf(e: PlayEvent): EventGroup {
  return GROUPS[e.kind] ?? "other";
}

const secs = (ms: unknown) => {
  const n = Number(ms);
  return Number.isFinite(n) ? (n < 10_000 ? `${(n / 1000).toFixed(1)} s` : clock(n / 1000)) : "a while";
};
const sub = (v: unknown) => (Number(v) ? `track ${v}` : "off");
const role = (v: unknown) => (v === "co-host" ? "co-host" : v === "host" ? "host" : "viewer");

/** One line of a play's history, in words. */
export function eventText(e: PlayEvent): string {
  const who = e.username ?? e.userId ?? "Somebody";
  const d = e.detail ?? {};
  switch (e.kind) {
    case "play": return `${who} played it`;
    case "pause": return `${who} paused`;
    case "resume": return `${who} resumed`;
    case "seek": return `${who} skipped from ${clock(Number(d.fromS))} to ${clock(Number(d.toS))}`;
    case "stop": return `${who} stopped it`;
    case "ended": return `The play ended: ${d.reason ?? "—"}${e.username ? `, by ${e.username}` : ""}`;
    case "joined": return `${who} joined, as ${role(d.role)}`;
    case "came back": return `${who} came back`;
    case "left": return `${who} left`;
    case "away from Discord": return `${who} went away from Discord`;
    case "back in Discord": return `${who} came back to Discord`;
    case "role": return `${who} became ${role(d.to)}`;
    case "stream changed": return `${who} moved to stream ${d.to ?? "?"} (audio track ${d.audioStreamId ?? "?"}, subtitles ${sub(d.subtitleStreamId)})`;
    case "subtitles": return `${who} changed subtitles from ${sub(d.from)} to ${sub(d.to)}`;
    case "quality": return `${who} changed quality from ${quality(Number(d.from))} to ${quality(Number(d.to))}`;
    case "stream started": return `A stream started${e.username ? ` for ${e.username}` : ""}: ${d.summary ?? "no details yet"}`;
    case "stream restarted": return d.replaced
      ? `Stream ${d.variant ?? "?"} started again under a new session${d.summary ? `: ${d.summary}` : ""}`
      : `Stream ${d.variant ?? "?"} started again at ${clock(Number(d.toOffsetS))}, from ${clock(Number(d.fromOffsetS))}`;
    case "stream ended": return `Stream ${d.variant ?? "?"} ended`;
    case "room waited": return `The room waited ${secs(d.ms)} for everybody to be ready`;
    case "buffering": return `${who}'s picture stopped for ${secs(d.ms)}, waiting for data`;
    case "loaded after seek": return `${who}'s player loaded for ${secs(d.ms)} after a skip`;
    case "player error": return `${who}'s player: ${d.msg ?? "an error"}${d.tag ? ` (${d.tag})` : ""}`;
    default: return `${e.kind}${e.username ? ` — ${e.username}` : ""}`;
  }
}

export function eventTone(e: PlayEvent): string {
  if (e.kind === "player error") return "bad";
  if (e.kind === "buffering" || e.kind === "room waited") return "warn";
  return "";
}
