import type { PlayDetail, PlayEvent, PlayStream } from "./types";
import { clock, quality, timeOfDay } from "./format";
import { decisionOf, eventText } from "./parts";
import { Icon } from "./icons";
import { Avatar } from "./viz";

/**
 * A session at a glance, for the questions a list of events answers slowly:
 * when did it pause, who was there, which stream was each viewer on, and why
 * did a second stream start half way through.
 *  - SessionChart: one row for playback, one for each stream and one for each
 *    viewer, along the session's own clock.
 *  - KeyMoments: the events that explain it — a stream starting and why, a
 *    viewer changing stream, quality or subtitles, long buffering, errors —
 *    in a sentence each.
 */

const span = (data: PlayDetail): [number, number] => {
  const start = data.play.startedAt;
  const end = Math.max(start + 1000, data.play.endedAt ?? 0, ...data.events.map((e) => e.at), ...data.viewers.map((v) => v.lastSeen),
    ...data.streams.map((s) => s.endedAt ?? 0));
  return [start, end];
};

const streamName = (streams: PlayStream[], key: unknown): string => {
  const i = streams.findIndex((s) => s.variantKey === key);
  return i >= 0 ? `Stream ${i + 1}` : "another stream";
};

interface Seg { from: number; to: number; tone: string; title: string; label?: string }

function Lane({ label, sub, segs, marks, start, end }: {
  label: React.ReactNode;
  sub?: string;
  segs: Seg[];
  marks?: Array<{ at: number; tone: string; title: string }>;
  start: number;
  end: number;
}) {
  const pos = (t: number) => Math.min(100, Math.max(0, ((t - start) / (end - start)) * 100));
  return (
    <div className="lane">
      <div className="lane-label">{label}{sub ? <span className="muted small">{sub}</span> : null}</div>
      <div className="lane-track">
        {segs.map((s, i) => (
          <span key={i} className={`lane-seg ${s.tone}`} title={s.title}
            style={{ left: `${pos(s.from)}%`, width: `${Math.max(0.5, pos(s.to) - pos(s.from))}%` }}>
            {s.label ? <span>{s.label}</span> : null}
          </span>
        ))}
        {(marks ?? []).map((m, i) => (
          <span key={`m${i}`} className={`lane-mark ${m.tone}`} title={m.title} style={{ left: `${pos(m.at)}%` }} />
        ))}
      </div>
    </div>
  );
}

export function SessionChart({ data }: { data: PlayDetail }) {
  const { viewers, streams, events } = data;
  const [start, end] = span(data);
  const when = (a: number, b: number) => `${timeOfDay(a)} – ${timeOfDay(b)} (${clock((b - a) / 1000)})`;

  // Playback: playing, paused or held, from its play, pause and resume events.
  const playback: Seg[] = [];
  const marks: Array<{ at: number; tone: string; title: string }> = [];
  let state: "playing" | "paused" | null = null;
  let since = start;
  const close = (at: number) => {
    if (state && at > since) {
      playback.push({ from: since, to: at, tone: state === "playing" ? "good" : "muted", title: `${state === "playing" ? "Playing" : "Paused"} · ${when(since, at)}`,
        label: state === "playing" ? "Playing" : "Paused" });
    }
    since = at;
  };
  for (const e of events) {
    if (e.kind === "play" || e.kind === "resume") { close(e.at); state = "playing"; }
    else if (e.kind === "pause") { close(e.at); state = "paused"; }
    else if (e.kind === "stop" || e.kind === "ended") { close(e.at); state = null; }
    else if (e.kind === "seek") marks.push({ at: e.at, tone: "info", title: `${timeOfDay(e.at)} · ${eventText(e)}` });
  }
  close(end);
  const held: Seg[] = events.filter((e) => e.kind === "room waited").map((e) => {
    const ms = Number(e.detail?.ms) || 0;
    return { from: e.at - ms, to: e.at, tone: "warn", title: `Held for viewers to be ready · ${when(e.at - ms, e.at)}` };
  });

  return (
    <div className="session-chart" role="img" aria-label="Session timeline: playback, streams and viewers over time">
      <Lane label="Playback" segs={[...playback, ...held]} marks={marks} start={start} end={end} />
      {streams.map((s, i) => {
        const d = decisionOf(s);
        const to = s.endedAt ?? end;
        return (
          <Lane key={s.id} start={start} end={end}
            label={<>Stream {i + 1}</>} sub={d.label}
            segs={[{ from: s.startedAt, to, tone: d.tone === "warn" ? "warn" : d.tone === "good" ? "good" : "muted",
              title: `Stream ${i + 1} · ${d.label}${s.reason ? ` · ${s.reason}` : ""} · ${when(s.startedAt, to)}`, label: d.label }]}
            marks={events.filter((e) => e.kind === "stream restarted" && e.detail?.variant === s.variantKey)
              .map((e) => ({ at: e.at, tone: "info", title: `${timeOfDay(e.at)} · ${eventText(e)}` }))} />
        );
      })}
      {viewers.map((v) => {
        const mine = events.filter((e) => e.userId === v.userId);
        const stalls: Seg[] = mine.filter((e) => e.kind === "buffering" || e.kind === "loaded after seek").map((e) => {
          const ms = Number(e.detail?.ms) || 0;
          return { from: e.at - ms, to: e.at, tone: e.kind === "buffering" ? "bad" : "info",
            title: `${e.kind === "buffering" ? "Buffering" : "Loading after a seek"} · ${when(e.at - ms, e.at)}` };
        });
        return (
          <Lane key={v.userId} start={start} end={end}
            label={<span className="lane-person"><Avatar id={v.userId} name={v.username} size={20} />{v.username ?? v.userId}</span>}
            segs={[{ from: v.firstSeen, to: v.lastSeen, tone: "present", title: `${v.username ?? v.userId} · in the room ${when(v.firstSeen, v.lastSeen)}` }, ...stalls]}
            marks={mine.filter((e) => ["stream changed", "quality", "subtitles", "player error", "role"].includes(e.kind) && !(e.kind === "stream changed" && !e.detail?.from))
              .map((e) => ({ at: e.at, tone: e.kind === "player error" ? "bad" : "accent", title: `${timeOfDay(e.at)} · ${eventText(e)}` }))} />
        );
      })}
      <div className="lane lane-axis">
        <div className="lane-label" />
        <div className="lane-track">
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <span key={f} style={{ left: `${f * 100}%` }} className={f === 1 ? "end" : f === 0 ? "start" : ""}>{timeOfDay(start + (end - start) * f)}</span>
          ))}
        </div>
      </div>
      <ul className="legend chart-key">
        <li><span className="swatch" style={{ background: "var(--good)" }} />Playing / direct</li>
        <li><span className="swatch" style={{ background: "var(--warn)" }} />Transcode / held</li>
        <li><span className="swatch" style={{ background: "var(--bad)" }} />Buffering</li>
        <li><span className="swatch" style={{ background: "var(--muted)" }} />Paused</li>
        <li><span className="swatch mark" />Change (hover for details)</li>
      </ul>
    </div>
  );
}

interface Moment { id: number; at: number; posS: number | null; tone: string; icon: string; title: string; why?: string }

/** The events that explain a session, each as a title and the reason behind it. */
export function keyMoments(data: PlayDetail): Moment[] {
  const { streams, events } = data;
  const out: Moment[] = [];
  let started = 0;
  const of = (e: PlayEvent, m: Omit<Moment, "id" | "at" | "posS">) => out.push({ id: e.id, at: e.at, posS: e.posS, ...m });
  for (const e of events) {
    const who = e.username ?? e.userId ?? "A viewer";
    const d = e.detail ?? {};
    if (e.kind === "stream started") {
      started++;
      const s = streams.find((x) => x.variantKey === d.variant) ?? null;
      const dec = s ? decisionOf(s) : null;
      const why = s?.decision === "transcode" ? `Video is transcoded: ${s.reason ?? "no reason reported"}`
        : s?.notes.audio === "transcode" ? `Video unchanged; audio converted${s.notes.audioReason ? `: ${s.notes.audioReason}` : ""}`
          : s?.decision === "copy" ? "Video and audio sent unchanged" : d.summary ? String(d.summary) : undefined;
      of(e, started === 1
        ? { tone: dec?.tone ?? "muted", icon: "now", title: `Playback started on ${streamName(streams, d.variant)}${dec ? ` (${dec.label})` : ""}`, why }
        : { tone: dec?.tone ?? "warn", icon: "split", title: `${streamName(streams, d.variant)} was created${e.username ? ` for ${e.username}` : ""}${dec ? ` (${dec.label})` : ""}`,
          why: why ? `${why}. A viewer gets a stream of their own when the room's stream doesn't suit their player, tracks or quality limit.` : undefined });
    } else if (e.kind === "stream changed" && d.from && d.from !== d.to) {
      of(e, { tone: "info", icon: "stream", title: `${who} moved from ${streamName(streams, d.from)} to ${streamName(streams, d.to)}` });
    } else if (e.kind === "quality") {
      of(e, { tone: "info", icon: "settings", title: `${who} changed their quality limit`, why: `${quality(Number(d.from))} → ${quality(Number(d.to))}` });
    } else if (e.kind === "subtitles") {
      const t = (v: unknown) => (Number(v) ? `track ${v}` : "off");
      if (d.from !== d.to && (Number(d.from) || Number(d.to))) of(e, { tone: "muted", icon: "logs", title: `${who} changed subtitles`, why: `${t(d.from)} → ${t(d.to)}` });
    } else if (e.kind === "role") {
      of(e, { tone: "info", icon: "users", title: eventText(e) });
    } else if (e.kind === "stream restarted") {
      of(e, { tone: "info", icon: "history", title: eventText(e) });
    } else if (e.kind === "buffering" && Number(d.ms) >= 3000) {
      of(e, { tone: "warn", icon: "pulse", title: eventText(e) });
    } else if (e.kind === "room waited" && Number(d.ms) >= 5000) {
      of(e, { tone: "warn", icon: "clock", title: eventText(e) });
    } else if (e.kind === "player error") {
      of(e, { tone: "bad", icon: "alert", title: eventText(e) });
    } else if (e.kind === "ended") {
      of(e, { tone: "muted", icon: "check", title: eventText(e) });
    }
  }
  return out;
}

export function KeyMoments({ data }: { data: PlayDetail }) {
  const moments = keyMoments(data);
  if (moments.length === 0) return <p className="muted">Nothing notable happened in this session.</p>;
  return (
    <ol className="moments">
      {moments.map((m) => (
        <li key={m.id} className={`moment ${m.tone}`}>
          <span className="moment-icon"><Icon name={m.icon} size={15} /></span>
          <span className="moment-body">
            <span className="moment-title">{m.title}</span>
            {m.why && <span className="moment-why">{m.why}</span>}
          </span>
          <span className="moment-time mono">{timeOfDay(m.at)}{m.posS !== null ? <span className="muted"> · at {clock(m.posS)}</span> : null}</span>
        </li>
      ))}
    </ol>
  );
}
