import { useState } from "react";
import type { PlayDetail, PlayEvent, TrackPoint } from "./types";
import { clock, quality, timeOfDay } from "./format";
import { decisionOf } from "./parts";
import {
  eventText, newestFirst, positionAt, streamDiff, streamLabel, switchedText, trackName, unionParts, type EventContext,
} from "./events";
import { Icon } from "./icons";
import { Avatar } from "./viz";

/**
 * A session at a glance, for the questions a list of events answers slowly:
 * when did it pause, who was there, which stream was each viewer on, where in
 * the title was it when something went wrong, and why did a second stream
 * start half way through.
 *  - SessionChart: one row for playback, one for the position in the title,
 *    one for each stream and one for each viewer, along the session's clock.
 *  - Watched: what of the title each viewer saw, along the title's own clock.
 *  - KeyMoments: the events that explain it, newest first, in a sentence each.
 */

const span = (data: PlayDetail): [number, number] => {
  const start = data.play.startedAt;
  const end = Math.max(start + 1000, data.play.endedAt ?? 0, ...data.events.map((e) => e.at), ...data.viewers.map((v) => v.lastSeen),
    ...data.streams.map((s) => s.endedAt ?? 0));
  return [start, end];
};

/** "21:04:10 · at 1:02:03 · …": when, and where in the title. */
const markTitle = (e: PlayEvent, ctx: EventContext) =>
  `${timeOfDay(e.at)}${e.posS !== null ? ` · at ${clock(e.posS)}` : ""} · ${eventText(e, ctx)}`;

const listed = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

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

/** The room's position in the title along the session: a line that climbs as it plays, flat while paused, jumping at a seek. */
function PositionLane({ track, start, end, durationS, marks }: {
  track: TrackPoint[];
  start: number;
  end: number;
  durationS: number;
  marks: Array<{ at: number; posS: number; tone: string; title: string }>;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 1000;
  const H = 60;
  const x = (t: number) => ((t - start) / (end - start)) * W;
  const y = (p: number) => H - 2 - (Math.min(p, durationS) / durationS) * (H - 4);
  let d = "";
  for (let i = 0; i < track.length; i++) {
    const [t, p] = track[i];
    if (p < 0) continue;
    const prev = i > 0 ? track[i - 1] : null;
    if (!prev || prev[1] < 0) { d += `M${x(t).toFixed(1)},${y(p).toFixed(1)}`; continue; }
    // Where it would be by now, from the point before: on, playing; still, paused.
    const expected = prev[2] ? prev[1] + (t - prev[0]) / 1000 : prev[1];
    const jumped = Math.abs(p - expected) > 3;
    d += `L${x(t).toFixed(1)},${y(jumped ? Math.max(0, expected) : p).toFixed(1)}`;
    if (jumped) d += `M${x(t).toFixed(1)},${y(p).toFixed(1)}`;
  }
  const last = [...track].reverse().find((p) => p[1] >= 0);
  if (last && last[0] < end) {
    const p = last[2] ? Math.min(durationS, last[1] + (end - last[0]) / 1000) : last[1];
    if (track.length === 1) d = `M${x(last[0]).toFixed(1)},${y(last[1]).toFixed(1)}`;
    d += `L${x(end).toFixed(1)},${y(p).toFixed(1)}`;
  }
  const at = hover === null ? null : start + (end - start) * hover;
  const posAt = at === null ? null : positionAt(track, at);
  return (
    <div className="lane lane-position">
      <div className="lane-label">Position<span className="muted small">in the title, 0:00 to {clock(durationS)}</span></div>
      <div className="lane-track position-track"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHover(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
        }}
        onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {[0.25, 0.5, 0.75].map((f) => <line key={f} className="position-grid" x1={0} x2={W} y1={y(durationS * f)} y2={y(durationS * f)} />)}
          <path className="position-line" d={d} />
        </svg>
        {marks.map((m, i) => (
          <span key={i} className={`position-mark ${m.tone}`} title={m.title}
            style={{ left: `${(x(m.at) / W) * 100}%`, top: `${(y(m.posS) / H) * 100}%` }} />
        ))}
        {hover !== null && at !== null && (
          <span className={`position-tip${hover > 0.7 ? " left" : ""}`} style={{ left: `${hover * 100}%` }}>
            {timeOfDay(at)}{posAt !== null ? <> · at <strong>{clock(posAt)}</strong></> : " · nothing playing"}
          </span>
        )}
      </div>
    </div>
  );
}

export function SessionChart({ data, durationS, ctx }: { data: PlayDetail; durationS: number | null; ctx: EventContext }) {
  const { viewers, streams, events } = data;
  const [start, end] = span(data);
  const when = (a: number, b: number) => `${timeOfDay(a)} – ${timeOfDay(b)} (${clock((b - a) / 1000)})`;
  const track = data.track ?? [];
  const length = Math.max(durationS ?? 0, ...track.map((p) => p[1]), ...events.map((e) => e.posS ?? 0), 1);

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
    else if (e.kind === "seek") marks.push({ at: e.at, tone: "info", title: markTitle(e, ctx) });
  }
  close(end);
  const held: Seg[] = events.filter((e) => e.kind === "room waited").map((e) => {
    const ms = Number(e.detail?.ms) || 0;
    return { from: e.at - ms, to: e.at, tone: "warn", title: `${eventText(e, ctx)} · ${when(e.at - ms, e.at)}` };
  });
  // Where in the title things went wrong, on the position line.
  const problems = events.filter((e) => (e.kind === "buffering" || e.kind === "player error") && e.posS !== null)
    .map((e) => ({ at: e.at, posS: e.posS!, tone: e.kind === "player error" ? "error" : "bad", title: markTitle(e, ctx) }));

  return (
    <div className="session-chart" role="img" aria-label="Session timeline: playback, position in the title, streams and viewers over time">
      <Lane label="Playback" segs={[...playback, ...held]} marks={marks} start={start} end={end} />
      {track.some((p) => p[1] >= 0) && <PositionLane track={track} start={start} end={end} durationS={length} marks={problems} />}
      {streams.map((s, i) => {
        const d = decisionOf(s);
        const to = s.endedAt ?? end;
        const p = s.variantKey ? s.variantKey.split(":") : [];
        return (
          <Lane key={s.id} start={start} end={end}
            label={<>Stream {i + 1}</>} sub={d.label}
            segs={[{ from: s.startedAt, to, tone: d.tone === "warn" ? "warn" : d.tone === "good" ? "good" : "muted",
              title: `Stream ${i + 1} · ${d.label}${s.reason ? ` · ${s.reason}` : ""} · audio ${trackName(ctx, s.audioStreamId ?? p[0], "default")}`
                + `, subtitles ${trackName(ctx, s.subtitleStreamId)} · ${when(s.startedAt, to)}`, label: d.label }]}
            marks={events.filter((e) => e.kind === "stream restarted" && e.detail?.variant === s.variantKey)
              .map((e) => ({ at: e.at, tone: "info", title: markTitle(e, ctx) }))} />
        );
      })}
      {viewers.map((v) => {
        const mine = events.filter((e) => e.userId === v.userId);
        const stalls: Seg[] = mine.filter((e) => e.kind === "buffering" || e.kind === "loaded after seek" || e.kind === "loaded at start").map((e) => {
          const ms = Number(e.detail?.ms) || 0;
          return { from: e.at - ms, to: e.at, tone: e.kind === "buffering" ? "bad" : "info",
            title: `${e.kind === "buffering" ? "Buffering" : e.kind === "loaded at start" ? "Loading the start" : "Loading after a seek"}`
              + `${e.posS !== null ? ` at ${clock(e.posS)}` : ""} · ${when(e.at - ms, e.at)}` };
        });
        return (
          <Lane key={v.userId} start={start} end={end}
            label={<span className="lane-person"><Avatar id={v.userId} name={v.username} size={20} />{v.username ?? v.userId}</span>}
            segs={[{ from: v.firstSeen, to: v.lastSeen, tone: "present", title: `${v.username ?? v.userId} · in the room ${when(v.firstSeen, v.lastSeen)}` }, ...stalls]}
            marks={mine.filter((e) => ["stream changed", "quality", "subtitles", "player error", "role"].includes(e.kind) && !(e.kind === "stream changed" && !e.detail?.from))
              .map((e) => ({ at: e.at, tone: e.kind === "player error" ? "error" : "accent", title: markTitle(e, ctx) }))} />
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
        <li><span className="swatch" style={{ background: "var(--warn)" }} />Transcode / waiting for the host</li>
        <li><span className="swatch" style={{ background: "var(--bad)" }} />Buffering</li>
        <li><span className="swatch error-key" />Player error</li>
        <li><span className="swatch" style={{ background: "var(--info)" }} />Loading the start or after a seek</li>
        <li><span className="swatch" style={{ background: "var(--muted)" }} />Paused</li>
        <li><span className="swatch mark" />Change (hover for details)</li>
      </ul>
    </div>
  );
}

/** What of the title each viewer saw, and where they buffered or hit an error, along the title's own clock. */
export function Watched({ data, durationS }: { data: PlayDetail; durationS: number | null }) {
  const watched = data.watched ?? {};
  const length = Math.max(durationS ?? 0, ...Object.values(watched).flat().map((p) => p[1]), ...data.events.map((e) => e.posS ?? 0), 1);
  const pos = (s: number) => Math.min(100, Math.max(0, (s / length) * 100));
  const all = unionParts(Object.values(watched));
  const row = (key: string, label: React.ReactNode, parts: Array<[number, number]>, events: PlayEvent[]) => {
    const seen = parts.reduce((s, [a, b]) => s + (b - a), 0);
    return (
      <div className="lane" key={key}>
        <div className="lane-label">{label}<span className="muted small">{clock(seen)} · {Math.round((seen / length) * 100)}% of it</span></div>
        <div className="lane-track watched-track">
          {parts.map(([a, b], i) => (
            <span key={i} className="lane-seg watched" title={`Watched ${clock(a)} – ${clock(b)}`}
              style={{ left: `${pos(a)}%`, width: `${Math.max(0.4, pos(b) - pos(a))}%` }} />
          ))}
          {events.filter((e) => e.posS !== null).map((e) => (
            <span key={e.id} className={`lane-mark ${e.kind === "player error" ? "error" : "bad"}`}
              title={`At ${clock(e.posS!)} · ${timeOfDay(e.at)} · ${eventText(e)}`} style={{ left: `${pos(e.posS!)}%` }} />
          ))}
        </div>
      </div>
    );
  };
  const trouble = (userId: string | null) => data.events.filter((e) => (e.kind === "buffering" || e.kind === "player error") && (!userId || e.userId === userId));
  if (all.length === 0) return <p className="muted">Where in the title it played wasn't recorded for this session.</p>;
  return (
    <div className="session-chart watched-chart" role="img" aria-label="What of the title each viewer watched">
      {data.viewers.length > 1 && row("all", "Anyone", all, trouble(null))}
      {data.viewers.map((v) => row(v.userId,
        <span className="lane-person"><Avatar id={v.userId} name={v.username} size={20} />{v.username ?? v.userId}</span>,
        watched[v.userId] ?? [], trouble(v.userId)))}
      <div className="lane lane-axis">
        <div className="lane-label" />
        <div className="lane-track">
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <span key={f} style={{ left: `${f * 100}%` }} className={f === 1 ? "end" : f === 0 ? "start" : ""}>{clock(length * f)}</span>
          ))}
        </div>
      </div>
      <ul className="legend chart-key">
        <li><span className="swatch" style={{ background: "var(--accent)" }} />Watched</li>
        <li><span className="swatch mark" style={{ background: "var(--bad)" }} />Buffering</li>
        <li><span className="swatch error-key" />Player error</li>
      </ul>
    </div>
  );
}

interface Moment { id: number; at: number; posS: number | null; tone: string; icon: string; title: string; why?: string }

/** The events that explain a session, each as a title and the reason behind it: the newest first. */
export function keyMoments(data: PlayDetail, ctx: EventContext = {}): Moment[] {
  const { streams, events } = data;
  const out: Moment[] = [];
  let started = 0;
  // The host's last change of tracks, and who moved with them.
  let move: { name: string; at: number; moment: Moment; base: string; followers: string[]; to: string } | null = null;
  const of = (e: PlayEvent, m: Omit<Moment, "id" | "at" | "posS">): Moment => {
    const moment = { id: e.id, at: e.at, posS: e.posS, ...m };
    out.push(moment);
    return moment;
  };
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
        ? { tone: dec?.tone ?? "muted", icon: "now", title: `Playback started on ${streamLabel(ctx, d.variant)}${dec ? ` (${dec.label})` : ""}`, why }
        : { tone: dec?.tone ?? "warn", icon: "split", title: `${streamLabel(ctx, d.variant)} was created${e.username ? ` for ${e.username}` : ""}${dec ? ` (${dec.label})` : ""}`,
          why: why ? `${why}. A viewer gets a stream of their own when the room's stream doesn't suit their player, tracks or quality limit.` : undefined });
    } else if (e.kind === "stream changed" && d.from && d.from !== d.to) {
      const to = streamLabel(ctx, d.to);
      const tracks = `audio ${trackName(ctx, d.audioStreamId, "default")}, subtitles ${trackName(ctx, d.subtitleStreamId)}`;
      const did = switchedText(d.why);
      if (d.host && move && move.name === d.host && e.at - move.at <= 15_000) {
        // Everybody the host's change moved, on the host's moment.
        move.followers.push(who);
        move.moment.why = `${move.base}. ${listed(move.followers)} moved with them, to ${to}.`;
      } else if (d.host) {
        of(e, { tone: "info", icon: "stream", title: `${who} moved to ${to} with the host`, why: `${String(d.host)} ${did ?? "changed tracks"}: ${tracks}` });
      } else if (did) {
        const base = `Now on ${to}: ${tracks}`;
        move = { name: who, at: e.at, base, followers: [], to, moment: of(e, { tone: "info", icon: "stream", title: `${who} ${did}`, why: base }) };
      } else {
        const what = streamDiff(d.from, d.to);
        of(e, { tone: "info", icon: "stream", title: `${who} moved from ${streamLabel(ctx, d.from)} to ${to}`,
          why: `${what.length ? `A change of ${what.join(" and ")}: ` : ""}${tracks}` });
      }
    } else if (e.kind === "quality") {
      of(e, { tone: "info", icon: "settings", title: `${who} changed their quality limit`, why: `${quality(Number(d.from))} → ${quality(Number(d.to))}` });
    } else if (e.kind === "subtitles") {
      if (d.from !== d.to && (Number(d.from) || Number(d.to))) {
        of(e, { tone: "muted", icon: "logs", title: `${who} changed subtitles`, why: `${trackName(ctx, d.from)} → ${trackName(ctx, d.to)}` });
      }
    } else if (e.kind === "role") {
      of(e, { tone: "info", icon: "users", title: eventText(e, ctx) });
    } else if (e.kind === "stream restarted") {
      of(e, { tone: "info", icon: "history", title: eventText(e, ctx) });
    } else if (e.kind === "buffering" && Number(d.ms) >= 3000) {
      of(e, { tone: "warn", icon: "pulse", title: eventText(e, ctx) });
    } else if (e.kind === "room waited" && Number(d.ms) >= 5000) {
      of(e, { tone: "warn", icon: "clock", title: eventText(e, ctx),
        why: "The room waits only for the host's picture; anybody not ready yet catches up while it plays." });
    } else if (e.kind === "player error") {
      of(e, { tone: "bad", icon: "alert", title: eventText(e, ctx) });
    } else if (e.kind === "ended") {
      of(e, { tone: "muted", icon: "check", title: eventText(e, ctx) });
    }
  }
  return newestFirst(out);
}

export function KeyMoments({ data, ctx }: { data: PlayDetail; ctx: EventContext }) {
  const moments = keyMoments(data, ctx);
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
