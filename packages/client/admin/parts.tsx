import { useCallback, useEffect, useState } from "react";
import { exportUrl } from "./api";
import type { Notes, PlayEvent, ViewerData } from "./types";
import { bytes, clock, quality, rate, short } from "./format";
import { Icon } from "./icons";
import { SplitBar } from "./viz";

/** What each property a stream's playlist carries is called (routes/plex.ts, streamNotes). */
export const NOTE_LABELS: Record<string, string> = {
  engine: "Engine",
  encoder: "Encoder",
  fallback: "Handled by Plex because",
  video: "Video",
  reason: "Transcode reason",
  kbps: "Video bitrate (kbps)",
  quality: "Quality",
  allowed: "Bitrate limit (kbps)",
  videoFrom: "Source video",
  range: "Dynamic range",
  perScreen: "Per display",
  audio: "Audio",
  audioFrom: "Source audio",
  audioTo: "Audio output",
  audioKbps: "Audio bitrate (kbps)",
  audioReason: "Audio conversion reason",
};

export function NotesList({ notes }: { notes: Notes }) {
  if (Object.keys(notes).length === 0) return null;
  return (
    <>
      <h4>Stream properties</h4>
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

// ─── A stream, in the words Stats for nerds uses ─────────────────

export type Tone = "good" | "warn" | "bad" | "info" | "muted";

/** Direct play (nothing converted), Direct stream (audio converted) or Transcode (video converted). */
export function decisionOf(s: { decision: string | null; notes: Notes; started?: boolean }): { label: string; tone: Tone } {
  if (s.started === false) return { label: "Not started", tone: "muted" };
  if (s.decision === "transcode") return { label: "Transcode", tone: "warn" };
  if (s.decision === "copy") return s.notes.audio === "transcode" ? { label: "Direct stream", tone: "good" } : { label: "Direct play", tone: "good" };
  return { label: "Starting", tone: "muted" };
}

export function DecisionBadge({ s }: { s: { decision: string | null; notes: Notes; started?: boolean } }) {
  const d = decisionOf(s);
  return <span className={`badge ${d.tone}`}>{d.label}</span>;
}

/** Why a stream is the way it is, in one sentence. */
export function streamWhy(s: { decision: string | null; reason: string | null; notes: Notes; started?: boolean }): string {
  if (s.started === false) return "No viewer has started this stream.";
  if (s.decision === "transcode") return s.reason ? `Video is transcoded: ${s.reason}` : "Video is transcoded. No reason was reported.";
  if (s.decision === "copy") {
    return s.notes.audio === "transcode"
      ? `Video is sent unchanged. Audio is converted${s.notes.audioReason ? `: ${s.notes.audioReason}` : "."}`
      : "Video and audio are sent unchanged from the source file.";
  }
  return "Waiting for the stream's first playlist.";
}

/** A stream's video and audio, source to output. */
export function streamLines(s: { decision: string | null; notes: Notes; kbps?: number | null }): Array<[string, string]> {
  const n = s.notes;
  const out: Array<[string, string]> = [];
  const from = n.videoFrom ? String(n.videoFrom) : null;
  if (from || s.decision) {
    const to = s.decision === "transcode"
      ? [n.encoder ? String(n.encoder).toUpperCase() : "transcoded", n.kbps ? rate(Number(n.kbps)) : null].filter(Boolean).join(" · ")
      : s.decision === "copy" ? "unchanged" : null;
    out.push(["Video", [from, to].filter(Boolean).join(" → ") + (n.range ? ` · ${n.range}` : "")]);
  }
  if (n.audioFrom || n.audio) {
    const to = n.audio === "transcode" ? (n.audioTo ? String(n.audioTo) : "converted") : "unchanged";
    out.push(["Audio", [n.audioFrom ? String(n.audioFrom) : null, to].filter(Boolean).join(" → ")]);
  }
  return out;
}

// ─── A viewer's numbers ───────────────────────────────────────────

/** What a viewer received, and from where: the server, Discord's cache, other viewers. */
export function DataCell({ d }: { d: ViewerData }) {
  const total = d.httpBytes + d.p2pBytes;
  return (
    <div className="data-cell">
      <strong className="nowrap">{bytes(total)}</strong>
      <SplitBar server={d.botBytes} cache={Math.min(d.edgeHitBytes, d.httpBytes)} peers={d.p2pBytes} legend={false} />
    </div>
  );
}

/** How a viewer's playback held up: green with no buffering, amber with some, red with a lot or with errors. */
export function bufferingTone(d: { stalls: number; stalledMs: number; errors: number }): Tone {
  if (d.errors > 0 || d.stalls > 5 || d.stalledMs > 30_000) return "bad";
  return d.stalls > 0 ? "warn" : "good";
}

export function BufferingCell({ d }: { d: ViewerData }) {
  const tone = bufferingTone(d);
  if (d.stalls === 0 && d.errors === 0) return <span className="health good"><span className="dot good" />None</span>;
  return (
    <span className={`health ${tone}`}>
      <span className={`dot ${tone}`} />
      <span>
        {d.stalls > 0 && <span className="nowrap">{d.stalls} {d.stalls === 1 ? "event" : "events"} · {clock(d.stalledMs / 1000)}</span>}
        {d.errors > 0 && <span className="small nowrap"> {d.stalls > 0 ? "· " : ""}{d.errors} player {d.errors === 1 ? "error" : "errors"}</span>}
      </span>
    </span>
  );
}

/** A person, by name, linking to their page. */
export function Who({ id, name }: { id: string | null; name?: string | null }) {
  if (!id) return <>{name ?? "—"}</>;
  return <a href={`#people/${id}`}>{name ?? id}</a>;
}

/** A Discord server and channel, by ID: Discord does not share their names with an Activity. */
export function Where({ guildId, channelId }: { guildId: string | null; channelId: string | null }) {
  if (!guildId && !channelId) return <span className="muted">Unknown</span>;
  return (
    <span className="mono where" title={`Server ${guildId ?? "?"} · channel ${channelId ?? "?"}`}>
      {short(guildId ?? "?", 10)} · {short(channelId ?? "?", 10)}
    </span>
  );
}

/** A list as a file: CSV for a spreadsheet, JSON for a script; the search's results, or everything. */
export function Downloads({ kind, q }: { kind: "history" | "people" | "usage" | "requests"; q?: string }) {
  return (
    <span className="downloads">
      <span className="muted small"><Icon name="download" size={14} /> {q ? "Export results" : "Export"}</span>
      <a className="button ghost small" href={exportUrl(kind, "csv", q)} download>CSV</a>
      <a className="button ghost small" href={exportUrl(kind, "json", q)} download>JSON</a>
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

// ─── A session's timeline, event by event ────────────────────────

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
  playback: "Playback", people: "Viewers", streams: "Streams and tracks", problems: "Buffering and errors", other: "Other",
};

export function groupOf(e: PlayEvent): EventGroup {
  return GROUPS[e.kind] ?? "other";
}

const secs = (ms: unknown) => {
  const n = Number(ms);
  return Number.isFinite(n) ? (n < 10_000 ? `${(n / 1000).toFixed(1)} s` : clock(n / 1000)) : "an unknown time";
};
const sub = (v: unknown) => (Number(v) ? `track ${v}` : "off");
const role = (v: unknown) => (v === "co-host" ? "co-host" : v === "host" ? "host" : "viewer");

const END_REASONS: Record<string, string> = {
  stopped: "playback was stopped", "another title": "the next title started", "room closed": "everyone left",
  "server stopped": "the server shut down", "server restarted": "the server restarted unexpectedly",
};

/** One event of a session, as a sentence. */
export function eventText(e: PlayEvent): string {
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
    case "stream changed": return `${who} switched to stream ${d.to ?? "?"} (audio track ${d.audioStreamId ?? "?"}, subtitles ${sub(d.subtitleStreamId)})`;
    case "subtitles": return `${who} changed subtitles from ${sub(d.from)} to ${sub(d.to)}`;
    case "quality": return `${who} changed quality from ${quality(Number(d.from))} to ${quality(Number(d.to))}`;
    case "stream started": return `Stream started${e.username ? ` for ${e.username}` : ""}${d.summary ? `: ${d.summary}` : ""}`;
    case "stream restarted": return d.replaced
      ? `Stream ${d.variant ?? "?"} restarted under a new session${d.summary ? `: ${d.summary}` : ""}`
      : `Stream ${d.variant ?? "?"} restarted at ${clock(Number(d.toOffsetS))} (previously ${clock(Number(d.fromOffsetS))})`;
    case "stream ended": return `Stream ${d.variant ?? "?"} ended`;
    case "room waited": return `Playback held for ${secs(d.ms)} until every viewer was ready`;
    case "buffering": return `${who} buffered for ${secs(d.ms)}`;
    case "loaded after seek": return `${who} loaded for ${secs(d.ms)} after a seek`;
    case "player error": return `${who}: player error: ${d.msg ?? "unknown"}${d.tag ? ` (${d.tag})` : ""}`;
    default: return `${e.kind}${e.username ? ` — ${e.username}` : ""}`;
  }
}

export function eventTone(e: PlayEvent): string {
  if (e.kind === "player error") return "bad";
  if (e.kind === "buffering" || e.kind === "room waited") return "warn";
  return "";
}
