import { useState, type ReactNode } from "react";
import type { Notes } from "./types";
import { ago, clock, quality, rate, dateTime, timeOfDay } from "./format";
import { decisionOf, NOTE_LABELS } from "./parts";
import { Icon } from "./icons";
import { Avatar } from "./viz";

/**
 * One stream, the same on Now Playing and in History. Closed, it reads at a
 * glance: what it is, the video and the audio from source to output (green
 * when unchanged, amber when converted), its bitrate, and why. Open, the
 * rest is in four groups: video, audio, delivery and identifiers.
 */
export interface StreamInfo {
  n: number;
  started: boolean;
  decision: string | null;
  reason: string | null;
  notes: Notes;
  kbps: number | null;
  kbpsSource?: string | null;
  engine: string | null;
  quality: number | null;
  variantKey: string | null;
  hlsSessionId: string | null;
  audioStreamId: number | null;
  subtitleStreamId: number | null;
  ownerName: string | null;
  ownerUserId: string | null;
  offsetS: number | null;
  isHostStream?: boolean;
  /** Now Playing: who is on it, and how long since anybody was. */
  viewers?: Array<{ id: string; name: string | null }>;
  idleS?: number | null;
  plexTranscodeKey?: string | null;
  plexClientId?: string | null;
  notesAt?: number | null;
  /** History: when it ran, and the most on it at once. */
  startedAt?: number;
  endedAt?: number | null;
  peakViewers?: number;
}

/** "4K", "1080p": a picture's size as people say it, from "3840×2160". */
export function sizeName(text: string | null): string | null {
  const m = text ? /(\d{3,5})\s*[×x]\s*(\d{3,5})/.exec(text) : null;
  if (!m) return null;
  const w = Number(m[1]), h = Number(m[2]);
  if (w >= 3800 || h >= 2000) return "4K";
  if (w >= 2500 || h >= 1400) return "1440p";
  if (w >= 1800 || h >= 1000) return "1080p";
  if (w >= 1200 || h >= 700) return "720p";
  return "SD";
}

/** The parts of "HEVC Main 10 · 10-bit · HDR10 · 3840×2160 · 23.976 fps": the codec first, then the rest. */
function parts(text: string | null): { codec: string | null; rest: string[] } {
  if (!text) return { codec: null, rest: [] };
  const [codec, ...rest] = text.split(" · ");
  return { codec, rest };
}

function Chip({ tone, label, sub }: { tone: "plain" | "good" | "warn"; label: ReactNode; sub?: ReactNode }) {
  return <span className={`pipe-chip ${tone}`}><strong>{label}</strong>{sub ? <span>{sub}</span> : null}</span>;
}

/** Source → output for the video or the audio. */
function Pipe({ kind, from, to, changed }: { kind: string; from: ReactNode; to: ReactNode; changed: boolean }) {
  return (
    <span className="pipe">
      <span className="pipe-kind">{kind}</span>
      {from}
      <span className={`pipe-arrow ${changed ? "warn" : "good"}`} aria-label="to"><Icon name="chevron" size={14} /></span>
      {to}
    </span>
  );
}

function Group({ icon, title, children }: { icon: string; title: string; children: ReactNode }) {
  return (
    <section className="detail-group">
      <h5><Icon name={icon} size={14} />{title}</h5>
      <dl className="grid">{children}</dl>
    </section>
  );
}

const row = (label: string, value: ReactNode, mono = false) => (
  <span style={{ display: "contents" }} key={label}><dt>{label}</dt><dd className={mono ? "mono" : undefined}>{value}</dd></span>
);

export function StreamCard({ s }: { s: StreamInfo }) {
  const [open, setOpen] = useState(false);
  const d = decisionOf(s);
  const n = s.notes;
  const transcoded = s.decision === "transcode";
  const audioConverted = n.audio === "transcode";
  const source = parts(n.videoFrom ? String(n.videoFrom) : null);
  const out = parts(n.videoTo ? String(n.videoTo) : null);
  const size = sizeName(n.videoFrom ? String(n.videoFrom) : null);
  const outSize = sizeName(n.videoTo ? String(n.videoTo) : null) ?? size;
  const known = s.started && !!s.decision;
  const used = new Set(["engine", "encoder", "fallback", "video", "reason", "kbps", "quality", "allowed", "videoFrom", "videoTo", "range",
    "perScreen", "audio", "audioFrom", "audioTo", "audioKbps", "audioReason"]);
  const other = Object.entries(n).filter(([k]) => !used.has(k));
  return (
    <div className={`stream tone-${d.tone}${open ? " open" : ""}`}>
      <button className="stream-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="stream-main">
          <span className="stream-line">
            <span className="stream-n">Stream {s.n}</span>
            <span className={`badge ${d.tone}`}>{d.label}</span>
            {s.isHostStream && <span className="badge outline">Host stream</span>}
            <span className="stream-rate">{rate(s.kbps)}</span>
            {s.quality ? <span className="badge muted">Limit {rate(s.quality)}</span> : null}
          </span>
          {known ? (
            <span className="pipes">
              <Pipe kind="Video" changed={transcoded}
                from={<Chip tone="plain" label={source.codec ?? "Source"} sub={[size, ...source.rest.filter((p) => /HDR|SDR|Vision|HLG/i.test(p))].filter(Boolean).join(" · ") || undefined} />}
                to={transcoded
                  ? <Chip tone="warn" label={out.codec ?? "Transcoded"} sub={[outSize, n.kbps ? rate(Number(n.kbps)) : null].filter(Boolean).join(" · ") || undefined} />
                  : <Chip tone="good" label="Unchanged" />} />
              {(n.audioFrom || n.audio) && (
                <Pipe kind="Audio" changed={audioConverted}
                  from={<Chip tone="plain" label={n.audioFrom ? String(n.audioFrom) : "Source"} />}
                  to={audioConverted
                    ? <Chip tone="warn" label={n.audioTo ? String(n.audioTo) : "Converted"} sub={n.audioKbps ? `${n.audioKbps} kbps` : undefined} />
                    : <Chip tone="good" label="Unchanged" />} />
              )}
            </span>
          ) : (
            <span className="stream-why muted">{s.started ? "Waiting for the stream's first playlist." : "No viewer has started this stream."}</span>
          )}
          {transcoded && <span className="stream-reason warn"><Icon name="alert" size={14} />Video transcoded: {s.reason ?? "no reason was reported"}</span>}
          {!transcoded && audioConverted && n.audioReason
            ? <span className="stream-reason"><Icon name="alert" size={14} />Audio converted: {String(n.audioReason)}</span> : null}
        </span>
        <span className="stream-viewers">
          {s.viewers
            ? <>{s.viewers.map((v) => <Avatar key={v.id} id={v.id} name={v.name} />)}<span className="muted small">{s.viewers.length} watching</span></>
            : <span className="muted small">For {s.ownerName ?? "the room"}{s.peakViewers !== undefined ? ` · peak ${s.peakViewers}` : ""}</span>}
          <span className={`chev${open ? " open" : ""}`}><Icon name="chevron" size={16} /></span>
        </span>
      </button>
      {open && (
        <div className="stream-detail">
          <Group icon="film" title="Video">
            {row("Source", n.videoFrom ? String(n.videoFrom) : "—")}
            {row("Output", transcoded ? (n.videoTo ? String(n.videoTo) : "Transcoded") : s.decision === "copy" ? "Unchanged (sent as it is in the file)" : "—")}
            {row("Dynamic range", n.range ? String(n.range) : "—")}
            {transcoded && row("Reason", s.reason ?? "Not reported")}
            {transcoded && row("Encoder", n.encoder ? String(n.encoder) : "—")}
            {row("Video bitrate", n.kbps ? rate(Number(n.kbps)) : "—")}
            {n.allowed ? row("Bitrate limit", rate(Number(n.allowed))) : null}
            {n.fallback ? row("Handled by Plex because", String(n.fallback)) : null}
          </Group>
          <Group icon="pulse" title="Audio">
            {row("Source", n.audioFrom ? String(n.audioFrom) : "—")}
            {row("Output", audioConverted ? `${n.audioTo ?? "Converted"}${n.audioKbps ? ` · ${n.audioKbps} kbps` : ""}` : n.audio === "copy" ? "Unchanged" : "—")}
            {audioConverted && row("Reason", n.audioReason ? String(n.audioReason) : "Not reported")}
            {row("Audio track", s.audioStreamId ?? "—", true)}
            {row("Burned-in subtitle track", s.subtitleStreamId || "None", true)}
          </Group>
          <Group icon="upload" title="Delivery">
            {row("Engine", s.engine === "ffmpeg" ? "FFmpeg" : s.engine === "plex" ? "Plex" : "—")}
            {row("Stream bitrate", `${rate(s.kbps)}${s.kbpsSource ? ` (${s.kbpsSource})` : ""}`)}
            {row("Quality limit", quality(s.quality ?? 0))}
            {row("Requested by", <>{s.ownerName ?? "The room"} <span className="mono muted">{s.ownerUserId ?? ""}</span></>)}
            {row("Start offset", clock(s.offsetS ?? 0))}
            {s.idleS !== undefined && row("Last watched", s.idleS === null ? "Being watched now" : `${ago(s.idleS)} ago`)}
            {s.startedAt !== undefined && row("Active", `${timeOfDay(s.startedAt)} – ${s.endedAt ? timeOfDay(s.endedAt) : "now"}`)}
            {s.peakViewers !== undefined && row("Peak viewers", s.peakViewers)}
          </Group>
          <Group icon="logs" title="Identifiers">
            {row("Stream key", s.variantKey ?? "—", true)}
            {row("HLS session", s.hlsSessionId ?? "—", true)}
            {s.plexTranscodeKey !== undefined && row("Plex transcode key", s.plexTranscodeKey ?? "—", true)}
            {s.plexClientId !== undefined && row("Plex player ID", s.plexClientId ?? "—", true)}
            {s.notesAt !== undefined && row("Playlist created", dateTime(s.notesAt))}
            {other.map(([k, v]) => row(NOTE_LABELS[k] ?? k, String(v)))}
          </Group>
        </div>
      )}
    </div>
  );
}
