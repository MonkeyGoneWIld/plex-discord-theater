import { useCallback, useEffect, useState } from "react";
import { exportUrl } from "./api";
import type { Notes, ViewerData } from "./types";
import { bytes, clock, duration, rate, short } from "./format";
import { Icon } from "./icons";
import { usePlaceNames } from "./names";
import { SplitBar } from "./viz";

/** What each property a stream's playlist carries is called (routes/plex.ts, streamNotes). */
export const NOTE_LABELS: Record<string, string> = {
  engine: "Engine",
  encoder: "Encoder",
  fallback: "Plex fallback reason",
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
            <dt>{NOTE_LABELS[k] ?? k}</dt>
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
  if (s.decision === "transcode") return s.reason ? `Video is transcoded: ${reasonText(s.reason)}` : "Video is transcoded. No reason was reported.";
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
export function DataCell({ d, legend = false }: { d: ViewerData; legend?: boolean | "compact" }) {
  const total = d.httpBytes + d.p2pBytes;
  return (
    <div className="data-cell">
      <strong className="nowrap">{bytes(total)}</strong>
      <SplitBar server={d.botBytes} cache={Math.min(d.edgeHitBytes, d.httpBytes)} peers={d.p2pBytes} legend={legend} />
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
        {d.stalls > 0 && <span className="nowrap">{d.stalls} {d.stalls === 1 ? "event" : "events"} · {duration(d.stalledMs)}</span>}
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

/**
 * A Discord server or channel by its name, its ID on hover; by ID where its
 * name isn't known yet — it is once somebody opens the Activity there.
 */
export function PlaceName({ kind, id }: { kind: "guild" | "channel"; id: string | null | undefined }) {
  const names = usePlaceNames();
  if (!id) return <span className="muted">{kind === "guild" ? "Direct message" : "—"}</span>;
  const name = kind === "guild" ? names.guild(id) : names.channel(id);
  const what = kind === "guild" ? "Discord server" : "Discord channel";
  return name
    ? <span className="place-name" title={`${what} ID ${id}`}>{name}</span>
    : <span className="mono" title={`${what} ID ${id}`}>{short(id, 10)}</span>;
}

/** Where a session or a launch was: "Movie Night · Film Club", by name where known. */
export function Where({ guildId, channelId }: { guildId: string | null; channelId: string | null }) {
  if (!guildId && !channelId) return <span className="muted">Unknown</span>;
  return (
    <span className="where">
      <PlaceName kind="channel" id={channelId} /> · <PlaceName kind="guild" id={guildId} />
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

// ─── A session's timeline, event by event: events.ts ─────────────

export { eventText, eventTone, GROUP_LABELS, groupOf, type EventContext, type EventGroup } from "./events";

/** A section's heading, with a line on what it shows and anything that acts on it beside it. */
export function BlockHead({ title, help, children }: { title: React.ReactNode; help?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="block-head">
      <div className="block-title">
        <h4>{title}</h4>
        {help && <p className="block-help">{help}</p>}
      </div>
      {children}
    </div>
  );
}

/** Links to a page's sections, in a bar that stays at the top while the page scrolls. */
export function SectionNav({ sections }: { sections: Array<[string, string]> }) {
  return (
    <nav className="section-nav" aria-label="Sections">
      {sections.map(([id, label]) => (
        <button key={id} type="button" className="link" onClick={() => document.getElementById(`sec-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
          {label}
        </button>
      ))}
    </nav>
  );
}

/** A transcode reason as the server recorded it (services/ffmpeg/plan.ts), in the dashboard's terms; older sessions' reasons too. */
const REASON_WORDS: Array<[RegExp, string]> = [
  [/(\d+)-bit picture: frames dropped on this player/, "$1-bit video: frames dropped by the client"],
  [/: not decoded by this player/, ": not supported by the client"],
  [/: not decoded by Discord's player/, ": not supported by Discord's player"],
  [/^Above 1080p: this player can't decode it smoothly$/, "Above 1080p: not decoded smoothly by the client"],
  [/ for a screen in SDR$/, " on an SDR display"],
  [/^video is (.+)$/, "Video codec $1 not supported"],
  [/^no video stream$/, "No video stream"],
  [/^picture size unknown$/, "Video resolution unknown"],
  [/^no audio track (\d+)$/, "Audio track $1 not found"],
  [/^Over the room's bandwidth: /, "Exceeds the session bandwidth limit: "],
];
export function reasonText(reason: string): string {
  let out = reason;
  for (const [re, to] of REASON_WORDS) out = out.replace(re, to);
  return out.charAt(0).toUpperCase() + out.slice(1);
}
