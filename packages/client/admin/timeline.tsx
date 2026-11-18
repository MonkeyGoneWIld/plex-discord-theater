import { Fragment, useEffect, useState } from "react";
import type { PlayDetail, PlayEvent, TrackPoint } from "./types";
import { clock, quality, timeOfDay } from "./format";
import { decisionOf } from "./parts";
import {
  eventText, finishedAt, jumpsOf, newestFirst, positionAt, positionTicks, streamDiff, streamLabel, switchedText, trackName, unionParts, type EventContext,
} from "./events";
import { Icon } from "./icons";
import { Avatar } from "./viz";
import { rolesOf } from "./clients";
import { awayOf, deliveryParts, streamAt, type DeliveryPart } from "./session";

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

/** Which labels to show along a line, left to right: one that would run into the last shown is left to its mark's hover. */
function spaced(xs: number[], gap: number): boolean[] {
  const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const show = xs.map(() => false);
  let last = -Infinity;
  for (const [x, i] of order) if (x - last >= gap) { show[i] = true; last = x; }
  return show;
}

/** An element's width in pixels, kept up to date: labels are spaced by what fits, on a phone as on a desktop. */
function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  // A callback ref: the element can appear after the first render (a lane drawn once there is something in it).
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    watch.observe(el);
    return () => watch.disconnect();
  }, [el]);
  return [setEl, width];
}

/** The room a label needs, as a share of a track's width. */
const labelGap = (width: number) => (width > 0 ? (76 / width) * 100 : 12);

/** A label beside a point, kept inside the track: above it or below, and anchored away from the edges. */
const labelAt = (left: number, top: number, above: boolean) => {
  const up = top < 22 ? false : top > 78 ? true : above;
  return { left: `${left}%`, top: `${top}%`,
    transform: `translate(${left > 88 ? "-100%" : left < 6 ? "0" : "-50%"}, ${up ? "calc(-100% - 5px)" : "5px"})` };
};

/**
 * The room's position in the title along the session: a line that climbs as
 * it plays and runs flat, dashed, while paused; each seek a step, named by
 * what made it.
 */
function PositionLane({ track, start, end, durationS, marks, jumps, finished, viewers, hoverAt, toggle }: {
  track: TrackPoint[];
  start: number;
  end: number;
  durationS: number;
  marks: Array<{ at: number; posS: number; tone: string; title: string }>;
  jumps: Array<{ at: number; posS: number; label: string; title: string; forward: boolean }>;
  finished: { at: number; posS: number } | null;
  /** Each viewer's own player's position, drawn with the room's when asked for. */
  viewers: Array<{ userId: string; name: string; track: TrackPoint[]; color: string }>;
  /** The time the chart's hover line is at. */
  hoverAt: number | null;
  toggle: React.ReactNode;
}) {
  const [trackRef, trackWidth] = useWidth<HTMLDivElement>();
  const W = 1000;
  const H = 120;
  const x = (t: number) => ((t - start) / (end - start)) * W;
  // Room at the top for the lane's name beside it, and for labels.
  const y = (p: number) => H - 6 - (Math.min(p, durationS) / durationS) * (H - 28);
  const pt = (t: number, p: number) => `${x(t).toFixed(1)},${y(p).toFixed(1)}`;
  let played = "";
  let paused = "";
  let seeks = "";
  let prev: TrackPoint | null = null;
  for (const cur of track) {
    if (cur[1] < 0) { prev = null; continue; }
    if (prev) {
      // Where it would be by now, from the point before: on, playing; still, paused.
      const expected = prev[2] ? prev[1] + (cur[0] - prev[0]) / 1000 : prev[1];
      const jumped = Math.abs(cur[1] - expected) > 3;
      const reached = jumped ? Math.max(0, expected) : cur[1];
      const piece = `M${pt(prev[0], prev[1])}L${pt(cur[0], reached)}`;
      if (prev[2]) played += piece; else paused += piece;
      if (jumped) seeks += `M${pt(cur[0], reached)}L${pt(cur[0], cur[1])}`;
    }
    prev = cur;
  }
  const last = [...track].reverse().find((p) => p[1] >= 0);
  if (last && last[0] < end) {
    const p = last[2] ? Math.min(durationS, last[1] + (end - last[0]) / 1000) : last[1];
    const piece = `M${pt(last[0], last[1])}L${pt(end, p)}`;
    if (last[2]) played += piece; else paused += piece;
  }
  const left = (t: number) => (x(t) / W) * 100;
  const top = (p: number) => (y(p) / H) * 100;
  // The title finishing is labelled too, so it takes its turn among the seeks.
  const shown = spaced([...jumps.map((j) => left(j.at)), finished ? left(finished.at) : -Infinity], labelGap(trackWidth));
  const ticks = positionTicks(durationS);
  // A viewer's line: their samples joined, broken where they were gone a while.
  const lineOf = (pts: TrackPoint[]) => {
    let d = "";
    let prevAt: number | null = null;
    for (const p of pts) {
      if (p[1] < 0) { prevAt = null; continue; }
      d += `${prevAt !== null && p[0] - prevAt <= 30_000 ? "L" : "M"}${pt(p[0], p[1])}`;
      prevAt = p[0];
    }
    return d;
  };
  const hoverLeft = hoverAt === null ? null : left(hoverAt);
  return (
    <div className="lane lane-position">
      <div className="lane-label">Position{toggle}</div>
      <div className={`lane-track position-track${viewers.length ? " with-viewers" : ""}`} ref={trackRef}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {ticks.map((t) => <line key={t} className="position-grid" x1={0} x2={W} y1={y(t)} y2={y(t)} />)}
          {viewers.map((v) => <path key={v.userId} className="position-viewer" d={lineOf(v.track)} style={{ stroke: v.color }} />)}
          <path className="position-line paused" d={paused} />
          <path className="position-line" d={played} />
          <path className="position-seek" d={seeks} />
        </svg>
        {ticks.map((t) => <span key={t} className="position-tick" style={{ top: `${top(t)}%` }}>{clock(t)}</span>)}
        {jumps.map((j, i) => (
          <span key={`j${i}`} className="position-mark seek" title={j.title} style={{ left: `${left(j.at)}%`, top: `${top(j.posS)}%` }} />
        ))}
        {jumps.map((j, i) => shown[i] && (
          <span key={`l${i}`} className="position-label" style={labelAt(left(j.at), top(j.posS), j.forward)}>{j.label}</span>
        ))}
        {finished && shown[jumps.length] && (
          <span className="position-label" style={labelAt(left(finished.at), top(finished.posS), true)}>Finished</span>
        )}
        {marks.map((m, i) => (
          <span key={i} className={`position-mark ${m.tone}`} title={m.title}
            style={{ left: `${(x(m.at) / W) * 100}%`, top: `${(y(m.posS) / H) * 100}%` }} />
        ))}
        {hoverAt !== null && hoverLeft !== null && (() => {
          const p = positionAt(track, hoverAt);
          return p === null ? null : <span className="position-dot" style={{ left: `${hoverLeft}%`, top: `${top(p)}%` }} />;
        })()}
      </div>
    </div>
  );
}

/** Up to three viewers' own position lines get a colour each; the rest share one. */
const VIEWER_LINES = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];
const OTHER_LINE = "var(--muted)";

interface Row {
  key: string;
  /** What the hover readout calls it. */
  name: string;
  /** What it was doing at a moment, for the hover readout; null says nothing. */
  at: (t: number) => string | null;
}

export function SessionChart({ data, durationS, ctx, compact = false }: { data: PlayDetail; durationS: number | null; ctx: EventContext; compact?: boolean }) {
  const { viewers, streams, events } = data;
  const [start, end] = span(data);
  const when = (a: number, b: number) => `${timeOfDay(a)} – ${timeOfDay(b)} (${clock((b - a) / 1000)})`;
  const track = data.track ?? [];
  const length = Math.max(durationS ?? 0, ...track.map((p) => p[1]), ...events.map((e) => e.posS ?? 0), 1);
  const [hover, setHover] = useState<{ f: number; x: number } | null>(null);
  const [eachViewer, setEachViewer] = useState(false);
  const at = hover === null ? null : start + (end - start) * hover.f;
  const covering = (segs: Seg[], t: number) => segs.filter((s) => s.from <= t && t <= s.to);

  // Playback: playing, paused or held, from its play, pause and resume events.
  const playback: Seg[] = [];
  const marks: Array<{ at: number; tone: string; title: string }> = [];
  let state: "playing" | "paused" | null = null;
  let since = start;
  const close = (t: number) => {
    if (state && t > since) {
      playback.push({ from: since, to: t, tone: state === "playing" ? "good" : "muted", title: `${state === "playing" ? "Playing" : "Paused"} · ${when(since, t)}`,
        label: state === "playing" ? "Playing" : "Paused" });
    }
    since = t;
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
    return { from: e.at - ms, to: e.at, tone: "warn", title: `${eventText(e, ctx)} · ${when(e.at - ms, e.at)}`, label: "Waiting" };
  });
  // Where in the title things went wrong, on the position line.
  const problems = events.filter((e) => (e.kind === "buffering" || e.kind === "player error") && e.posS !== null)
    .map((e) => ({ at: e.at, posS: e.posS!, tone: e.kind === "player error" ? "error" : "bad", title: markTitle(e, ctx) }));
  // Each seek on the position line, named by what made it; and the title finishing.
  const jumps = jumpsOf(events).map((j) => ({ at: j.at, posS: j.toS, label: j.label, title: markTitle(j.event, ctx), forward: j.toS > j.fromS }));
  const done = finishedAt(events);
  const finished = done ? { at: done.at, posS: done.posS ?? positionAt(track, done.at) ?? length } : null;
  // Each viewer's own player, where it was in the title (from its samples every 10 s).
  const own = viewers.map((v, i) => ({ userId: v.userId, name: v.username ?? v.userId, track: data.positions?.[v.userId] ?? [],
    color: VIEWER_LINES[i] ?? OTHER_LINE })).filter((v) => v.track.length > 1);

  const rows: Row[] = [];
  rows.push({ key: "playback", name: "Playback", at: (t) => covering([...held, ...playback], t)[0]?.label ?? "Stopped" });
  if (track.some((p) => p[1] >= 0)) {
    rows.push({ key: "position", name: "Position", at: (t) => { const p = positionAt(track, t); return p === null ? null : clock(p); } });
  }
  const streamLanes = streams.map((s, i) => {
    const d = decisionOf(s);
    const to = s.endedAt ?? end;
    const p = s.variantKey ? s.variantKey.split(":") : [];
    rows.push({ key: `s${s.id}`, name: `Stream ${i + 1}`, at: (t) => (s.startedAt <= t && t <= to ? d.label : null) });
    return (
      <Lane key={s.id} start={start} end={end}
        label={<>Stream {i + 1}</>} sub={d.label}
        segs={[{ from: s.startedAt, to, tone: d.tone === "warn" ? "warn" : d.tone === "good" ? "good" : "muted",
          title: `Stream ${i + 1} · ${d.label}${s.reason ? ` · ${s.reason}` : ""} · audio ${trackName(ctx, s.audioStreamId ?? p[0], "default")}`
            + `, subtitles ${trackName(ctx, s.subtitleStreamId)} · ${when(s.startedAt, to)}`, label: d.label }]}
        marks={events.filter((e) => e.kind === "stream restarted" && e.detail?.variant === s.variantKey)
          .map((e) => ({ at: e.at, tone: "info", title: markTitle(e, ctx) }))} />
    );
  });
  const viewerLanes = viewers.map((v) => {
    const who = v.username ?? v.userId;
    const mine = events.filter((e) => e.userId === v.userId);
    const stalls: Seg[] = mine.filter((e) => e.kind === "buffering" || e.kind === "loaded after seek" || e.kind === "loaded at start").map((e) => {
      const ms = Number(e.detail?.ms) || 0;
      const what = e.kind === "buffering" ? "Buffering" : e.kind === "loaded at start" ? "Loading at start" : "Loading after seek";
      return { from: e.at - ms, to: e.at, tone: e.kind === "buffering" ? "bad" : "info", label: what,
        title: `${what}${e.posS !== null ? ` at ${clock(e.posS)}` : ""} · ${when(e.at - ms, e.at)}` };
    });
    // While they were host or co-host: from what they came in as (some before the session opened), and each change.
    const roleSpans = rolesOf([...(data.lead ?? []), ...events], v.userId, v.firstSeen, v.lastSeen);
    const roles: Seg[] = roleSpans.filter((r) => r.role !== "viewer")
      .map((r) => ({ from: r.from, to: r.to, tone: r.role === "host" ? "role-host" : "role-cohost",
        title: `${who} · ${r.role === "host" ? "host" : "co-host"} ${when(r.from, r.to)}` }));
    // While they had switched away from the Discord window.
    const away: Seg[] = awayOf(events, v.userId, v.lastSeen).map((s) => ({ ...s, tone: "away", label: "Away",
      title: `${who} · away from the Discord window ${when(s.from, s.to)}` }));
    const mineTrack = data.positions?.[v.userId] ?? [];
    rows.push({ key: v.userId, name: who, at: (t) => {
      if (t < v.firstSeen || t > v.lastSeen) return "Not in the room";
      const role = roleSpans.find((r) => r.from <= t && t <= r.to)?.role;
      const parts = [role === "host" ? "Host" : role === "co-host" ? "Co-host" : "Viewer"];
      const s = streamAt(events, streams, v.userId, t);
      if (s) parts.push(`Stream ${streams.indexOf(s) + 1}`);
      const stall = covering(stalls, t)[0];
      if (stall) parts.push(stall.label!.toLowerCase());
      if (covering(away, t).length) parts.push("away from Discord");
      const p = mineTrack.length > 1 ? positionAt(mineTrack, t) : null;
      const room = positionAt(track, t);
      if (p !== null) parts.push(`at ${clock(p)}${room !== null && role !== "host" ? ` (${drift(p - room)})` : ""}`);
      return parts.join(" · ");
    } });
    return (
      <Lane key={v.userId} start={start} end={end}
        label={<span className="lane-person"><Avatar id={v.userId} name={v.username} size={20} />{who}</span>}
        segs={[{ from: v.firstSeen, to: v.lastSeen, tone: "present", title: `${who} · in the room ${when(v.firstSeen, v.lastSeen)}` }, ...away, ...roles, ...stalls]}
        marks={mine.filter((e) => VIEWER_MARKS.includes(e.kind) && !(e.kind === "stream changed" && !e.detail?.from))
          .map((e) => ({ at: e.at, tone: e.kind === "player error" ? "error" : "accent", title: markTitle(e, ctx) }))} />
    );
  });

  // The hover line: across every row, with what each was doing then.
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const lane = e.currentTarget.querySelector(".lane-track");
    if (!lane) return;
    const r = lane.getBoundingClientRect();
    const box = e.currentTarget.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right) { setHover(null); return; }
    setHover({ f: (e.clientX - r.left) / r.width, x: e.clientX - box.left });
  };

  return (
    <div className={`session-chart${compact ? " compact" : ""}`} role="img"
      aria-label="Session timeline: playback, position in the title, streams and viewers over time"
      onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
      <Lane label="Playback" segs={[...playback, ...held]} marks={marks} start={start} end={end} />
      {track.some((p) => p[1] >= 0) && <PositionLane track={track} start={start} end={end} durationS={length} marks={problems}
        jumps={jumps} finished={finished} viewers={eachViewer ? own : []} hoverAt={at}
        toggle={own.length > 0 && !compact ? (
          <button type="button" className={`chip-toggle${eachViewer ? " on" : ""}`} aria-pressed={eachViewer}
            onClick={() => setEachViewer((x) => !x)}>Each viewer</button>
        ) : null} />}
      {streamLanes}
      {viewerLanes}
      <AxisLane start={start} end={end} />
      {hover !== null && at !== null && (
        <>
          <span className="chart-hover-line" style={{ left: hover.x }} />
          <div className={`chart-hover-tip${hover.f > 0.55 ? " left" : ""}`} style={{ left: hover.x }}>
            <strong>{timeOfDay(at)}</strong>
            <dl>
              {rows.map((r) => {
                const said = r.at(at);
                return said === null ? null : <Fragment key={r.key}><dt>{r.name}</dt><dd>{said}</dd></Fragment>;
              })}
            </dl>
          </div>
        </>
      )}
      {eachViewer && own.length > 0 && (
        <ul className="legend chart-key">
          <li><span className="swatch line" style={{ background: "var(--text)" }} />Room</li>
          {own.map((v) => <li key={v.userId}><span className="swatch line" style={{ background: v.color }} />{v.name}</li>)}
        </ul>
      )}
      {!compact && (
        <ul className="legend chart-key">
          <li><span className="swatch" style={{ background: "var(--good)" }} />Playing / direct</li>
          <li><span className="swatch" style={{ background: "var(--warn)" }} />Transcode / waiting for the host</li>
          <li><span className="swatch" style={{ background: "var(--bad)" }} />Buffering</li>
          <li><span className="swatch error-key" />Player error</li>
          <li><span className="swatch" style={{ background: "var(--info)" }} />Loading (start or after seek)</li>
          <li><span className="swatch" style={{ background: "var(--muted)" }} />Paused</li>
          <li><span className="swatch away-key" />Away from Discord</li>
          <li><span className="swatch stripe" style={{ background: "var(--host)" }} />Host</li>
          <li><span className="swatch stripe" style={{ background: "var(--cohost)" }} />Co-host</li>
          <li><span className="swatch mark" />Event</li>
        </ul>
      )}
    </div>
  );
}

/** What a viewer's lane marks: their own changes, and requests for the host role. */
const VIEWER_MARKS = ["stream changed", "quality", "subtitles", "player error", "role", "asked for host", "request declined", "request ended"];

/** "+1.2 s ahead", "0.8 s behind", "in sync". */
export function drift(s: number): string {
  if (Math.abs(s) < 0.5) return "in sync";
  return `${Math.abs(s).toFixed(1)} s ${s > 0 ? "ahead" : "behind"}`;
}

/** The session's clock along the foot of the chart: as many times as fit without running into each other. */
function AxisLane({ start, end, fmt = timeOfDay }: { start: number; end: number; fmt?: (t: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  // A time is about 64 px wide: five on a desktop, three on a phone.
  const all = width > 0 && width < 340 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
  // A span too short for its times to differ says each once.
  const steps = all.filter((f, i) => i === 0 || fmt(start + (end - start) * f) !== fmt(start + (end - start) * all[i - 1]));
  return (
    <div className="lane lane-axis">
      <div className="lane-label" />
      <div className="lane-track" ref={ref}>
        {steps.map((f) => (
          <span key={f} style={{ left: `${f * 100}%` }} className={f === 1 ? "end" : f === 0 ? "start" : ""}>{fmt(start + (end - start) * f)}</span>
        ))}
      </div>
    </div>
  );
}

/** What of the title each viewer saw, and where they buffered or hit an error, along the title's own clock. */
export function Watched({ data, durationS }: { data: PlayDetail; durationS: number | null }) {
  const [trackRef, trackWidth] = useWidth<HTMLDivElement>();
  const watched = data.watched ?? {};
  const length = Math.max(durationS ?? 0, ...Object.values(watched).flat().map((p) => p[1]), ...data.events.map((e) => e.posS ?? 0), 1);
  const pos = (s: number) => Math.min(100, Math.max(0, (s / length) * 100));
  const all = unionParts(Object.values(watched));
  // Each viewer's coverage by how it reached them, where their own player's positions say: direct or transcoded.
  const delivery = (userId: string): DeliveryPart[] | null => {
    const mine = data.positions?.[userId];
    if (!mine || mine.length < 2) return null;
    const parts = deliveryParts(mine, data.events, data.streams, userId);
    return parts.length ? parts : null;
  };
  // Which ways the coverage was coloured: the key names only those.
  const ways = new Set(data.viewers.flatMap((v) => delivery(v.userId)?.map((p) => p.decision) ?? [undefined]));
  const anyDelivery = [...ways].some((w) => w !== undefined);
  const row = (key: string, label: React.ReactNode, parts: Array<[number, number]>, events: PlayEvent[], how: DeliveryPart[] | null = null) => {
    const seen = parts.reduce((s, [a, b]) => s + (b - a), 0);
    return (
      <div className="lane" key={key}>
        <div className="lane-label">{label}<span className="muted small">{clock(seen)} · {Math.round((seen / length) * 100)}% of it</span></div>
        <div className="lane-track watched-track">
          {how ? how.map((p, i) => (
            <span key={i} className={`lane-seg watched ${p.decision === "transcode" ? "transcoded" : p.decision === "copy" ? "direct" : ""}`}
              title={`Watched ${clock(p.from)} – ${clock(p.to)} · ${p.decision === "transcode" ? "transcoded" : p.decision === "copy" ? "direct" : "stream not recorded"}`}
              style={{ left: `${pos(p.from)}%`, width: `${Math.max(0.4, pos(p.to) - pos(p.from))}%` }} />
          )) : parts.map(([a, b], i) => (
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
  // Each seek as an arc over the title, from where it was to where it landed.
  const jumps = jumpsOf(data.events);
  const done = finishedAt(data.events);
  const arcs = jumps.map((j) => {
    const x1 = pos(j.fromS) * 10;
    const x2 = pos(j.toS) * 10;
    const apex = 44 - Math.min(38, 10 + Math.abs(x2 - x1) * 0.08);
    return { j, x1, x2, apex, mid: (x1 + x2) / 20, d: `M${x1.toFixed(1)},44 Q${((x1 + x2) / 2).toFixed(1)},${(2 * apex - 44).toFixed(1)} ${x2.toFixed(1)},44` };
  });
  const endAt = done && done.posS !== null ? pos(done.posS) : null;
  const shown = spaced([...arcs.map((a) => a.mid), endAt ?? -Infinity], labelGap(trackWidth));
  if (all.length === 0) return <p className="muted">Playback position was not recorded for this session.</p>;
  return (
    <div className="session-chart watched-chart" role="img" aria-label="Portions of the title each viewer watched">
      {(arcs.length > 0 || endAt !== null) && (
        <div className="lane lane-jumps">
          <div className="lane-label">Seeks<span className="muted small">{arcs.length} {arcs.length === 1 ? "seek" : "seeks"}</span></div>
          <div className="lane-track jumps-track" ref={trackRef}>
            <svg viewBox="0 0 1000 44" preserveAspectRatio="none">
              {arcs.map((a, i) => (
                <g key={i}>
                  <path className="jump-arc" d={a.d} />
                  <path className="jump-hit" d={a.d}><title>{`${timeOfDay(a.j.at)} · ${eventText(a.j.event)}`}</title></path>
                </g>
              ))}
            </svg>
            {arcs.map((a, i) => <span key={`d${i}`} className="jump-land" style={{ left: `${pos(a.j.toS)}%` }} />)}
            {arcs.map((a, i) => shown[i] && (
              <span key={`l${i}`} className="jump-label" style={{ left: `${a.mid}%`, top: `${(a.apex / 44) * 100}%`,
                transform: `translate(${a.mid > 88 ? "-100%" : a.mid < 6 ? "0" : "-50%"}, calc(-100% - 2px))` }}>{a.j.label}</span>
            ))}
            {endAt !== null && (
              <>
                <span className="jump-end" title={`Finished at ${clock(done!.posS!)} · ${timeOfDay(done!.at)}`} style={{ left: `${endAt}%` }} />
                {shown[arcs.length] && (
                  <span className="jump-label" style={{ left: `${endAt}%`, top: "20%",
                    transform: `translate(${endAt > 88 ? "-100%" : "-50%"}, -50%)` }}>Finished</span>
                )}
              </>
            )}
          </div>
        </div>
      )}
      {data.viewers.length > 1 && row("all", "All viewers", all, trouble(null))}
      {data.viewers.map((v) => row(v.userId,
        <span className="lane-person"><Avatar id={v.userId} name={v.username} size={20} />{v.username ?? v.userId}</span>,
        watched[v.userId] ?? [], trouble(v.userId), delivery(v.userId)))}
      <AxisLane start={0} end={length} fmt={(s) => clock(s)} />
      <ul className="legend chart-key">
        {(!anyDelivery || ways.has(null) || ways.has(undefined)) && (
          <li><span className="swatch" style={{ background: "var(--accent)" }} />Watched{anyDelivery ? " (stream not recorded)" : ""}</li>
        )}
        {ways.has("copy") && <li><span className="swatch" style={{ background: "var(--good)" }} />Watched direct</li>}
        {ways.has("transcode") && <li><span className="swatch" style={{ background: "var(--warn)" }} />Watched transcoded</li>}
        {arcs.length > 0 && <li><span className="swatch" style={{ background: "var(--info)" }} />Seek</li>}
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
  // The host's last change of subtitles, and whose followed it.
  let subs: { name: string; at: number; moment: Moment; base: string; followers: string[] } | null = null;
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
          why: why ? `${why}. A separate stream is created when a viewer's player, tracks or quality limit differ from the room's stream.` : undefined });
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
        const change = `${trackName(ctx, d.from)} → ${trackName(ctx, d.to)}`;
        if (d.host && subs && subs.name === d.host && e.at - subs.at <= 15_000) {
          // Whose subtitles followed the host's, on the host's moment.
          subs.followers.push(who);
          subs.moment.why = `${subs.base}. Also changed for ${listed(subs.followers)}.`;
        } else if (d.byHost) {
          subs = { name: who, at: e.at, base: change, followers: [], moment: of(e, { tone: "info", icon: "logs", title: `${who} (host) changed the subtitles`, why: change }) };
        } else {
          of(e, { tone: "muted", icon: "logs", title: d.host ? `${who}'s subtitles changed with the host's` : `${who} changed the subtitles`, why: change });
        }
      }
    } else if (e.kind === "seek" && (d.cause === "skip intro" || d.cause === "skip credits")) {
      of(e, { tone: "muted", icon: "chevron", title: eventText(e, ctx).replace(/: .*$/, ""), why: `${clock(Number(d.fromS))} → ${clock(Number(d.toS))}` });
    } else if (e.kind === "reached the end") {
      of(e, d.early
        ? { tone: "warn", icon: "check", title: `The stream ended${Number.isFinite(Number(d.breakAtS)) ? ` at ${clock(Number(d.breakAtS))}` : ""}, before the length Plex reports`,
          why: "The file's video ends earlier than its reported length, so playback was ended at that point." }
        : { tone: "muted", icon: "check", title: `${who} reached the end of the title` });
    } else if (e.kind === "role") {
      of(e, { tone: "info", icon: "users", title: eventText(e, ctx) });
    } else if (e.kind === "asked for host" || e.kind === "request declined" || e.kind === "request ended") {
      of(e, { tone: "muted", icon: "users", title: eventText(e, ctx) });
    } else if (e.kind === "short sound") {
      of(e, { tone: "warn", icon: "stream", title: "The title's sound is shorter than its picture",
        why: eventText(e, ctx) });
    } else if (e.kind === "stream restarted") {
      of(e, { tone: "info", icon: "history", title: eventText(e, ctx) });
    } else if (e.kind === "buffering" && Number(d.ms) >= 3000) {
      of(e, { tone: "warn", icon: "pulse", title: eventText(e, ctx) });
    } else if (e.kind === "room waited" && Number(d.ms) >= 5000) {
      of(e, { tone: "warn", icon: "clock", title: eventText(e, ctx),
        why: "Only the host's video is waited for; other viewers catch up while playback continues." });
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
  if (moments.length === 0) return <p className="muted">No notable events were recorded for this session.</p>;
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
