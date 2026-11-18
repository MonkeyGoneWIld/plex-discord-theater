import { useEffect, useState } from "react";
import type { HealthPoint, PlayDetail, PlayEvent, ProcessingStep, TrackPoint } from "./types";
import { clock, quality, shortTime, timeOfDay } from "./format";
import { decisionOf, reasonText } from "./parts";
import {
  eventText, finishedAt, jumpsOf, newestFirst, positionAt, positionTicks, streamDiff, streamLabel, switchedText, trackName, unionParts, type EventContext,
} from "./events";
import { Icon } from "./icons";
import { Avatar, bps, SOURCES } from "./viz";
import { clientName, clientsOf, rolesOf, type RoleSpan } from "./clients";
import { deliveryParts, streamAt, type DeliveryPart } from "./session";
import {
  deliveryOf, fits, labelWidth, offsetText, placeLabels, playbackOf, roleSummary, sampleAt, seriesOf, timeTicks, viewerStatusOf,
  type PlaybackSeg, type StatusSeg,
} from "./lanes";
import { processingName } from "./processing";

/**
 * A session over time, for the questions a list of events answers slowly.
 *  - SessionTimeline: every lane on one clock — playback, the position in the
 *    title, each stream, each viewer, then the data delivered by source and
 *    each player's sync and buffer — so a change in one lines up with its
 *    cause in another. One hover line runs across all of them.
 *  - Watched: what of the title each viewer saw, along the title's own clock.
 *  - KeyMoments: the events that explain it, newest first, in a sentence each.
 */

const MIN = 60_000;

/** Each viewer's colour on the timeline's lines and beside their name: three, then a neutral one for the rest. */
const VIEWER_COLORS = ["var(--viewer-1)", "var(--viewer-2)", "var(--viewer-3)"];
export const viewerColor = (i: number) => VIEWER_COLORS[i] ?? "var(--muted)";

/** The session's first and last moment on record. */
const span = (data: PlayDetail): [number, number] => {
  const start = data.play.startedAt;
  const end = Math.max(start + 1000, data.play.endedAt ?? 0, ...data.events.map((e) => e.at), ...data.viewers.map((v) => v.lastSeen),
    ...data.streams.map((s) => s.endedAt ?? 0));
  return [start, end];
};

/** An element's width in pixels, kept up to date: what fits is worked out from it, on a phone as on a desktop. */
export function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  // A callback ref: the element can appear after the first render.
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

/** "+1.2 s ahead", "0.8 s behind", "in sync". */
export function drift(s: number): string {
  if (Math.abs(s) < 0.5) return "in sync";
  return `${Math.abs(s).toFixed(1)} s ${s > 0 ? "ahead" : "behind"}`;
}

type Range = "all" | "30" | "10";
const RANGES: Array<{ key: Range; label: string; ms: number }> = [
  { key: "all", label: "Whole session", ms: Infinity },
  { key: "30", label: "Last 30 min", ms: 30 * MIN },
  { key: "10", label: "Last 10 min", ms: 10 * MIN },
];

/** A lane: its name and a line under it on the left, its track on the right. */
function Row({ name, sub, className, height, children, chip }: {
  name: React.ReactNode;
  sub?: React.ReactNode;
  className?: string;
  height: number;
  children?: React.ReactNode;
  /** A colour beside the name, tying the lane to its lines below. */
  chip?: string;
}) {
  return (
    <div className={`tl-row${className ? ` ${className}` : ""}`}>
      <div className="tl-label">
        <span className="tl-name">{chip && <span className="tl-chip" style={{ background: chip }} />}{name}</span>
        {sub ? <span className="tl-sub">{sub}</span> : null}
      </div>
      <div className="tl-track" style={{ height }}>{children}</div>
    </div>
  );
}

/** What the playback lane says of a state. */
const PLAYBACK_LABEL: Record<PlaybackSeg["state"], string> = { playing: "Playing", paused: "Paused", waiting: "Waiting for host" };
const PLAYBACK_TONE: Record<PlaybackSeg["state"], string> = { playing: "good", paused: "paused", waiting: "warn" };
const STATUS_LABEL: Record<StatusSeg["state"], string> = { buffering: "Buffering", loading: "Loading", away: "Away" };
const ROLE_LABEL: Record<string, string> = { host: "Host", "co-host": "Co-host", viewer: "Viewer" };

/** What a viewer's lane marks: their own changes, and requests for the host role. */
const VIEWER_MARKS = ["stream changed", "quality", "subtitles", "player error", "role", "asked for host", "request declined", "request ended", "switched client"];

/** An SVG path through points, broken where a value is missing. */
function linePath(points: Array<[number, number | null]>, x: (t: number) => number, y: (v: number) => number): string {
  let d = "";
  let gap = true;
  for (const [t, v] of points) {
    if (v === null) { gap = true; continue; }
    d += `${gap ? "M" : "L"}${x(t).toFixed(1)},${y(v).toFixed(1)}`;
    gap = false;
  }
  return d;
}

/** A rounded top for a measure's scale: 1, 2, 2.5 or 5 times a power of ten. */
function niceTop(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((m) => m * p >= v) ?? 10) * p;
}

interface Hover { t: number; x: number; y: number; h: number; touch: boolean }

interface ViewerLane {
  userId: string;
  name: string;
  color: string;
  roles: RoleSpan[];
  status: StatusSeg[];
  marks: PlayEvent[];
  health: HealthPoint[];
  track: TrackPoint[];
  client: string | null;
}

export function SessionTimeline({ data, durationS, ctx, live = false }: {
  data: PlayDetail;
  durationS: number | null;
  ctx: EventContext;
  /** On the Activity page: the session runs to now and opens on its last half hour. */
  live?: boolean;
}) {
  const { viewers, streams, events } = data;
  const [ref, width] = useWidth<HTMLDivElement>();
  const narrow = width > 0 && width < 560;
  const labelW = narrow ? 104 : 184;
  const gapW = narrow ? 8 : 14;
  const trackW = Math.max(1, width - labelW - gapW);
  const [startAll, endRecorded] = span(data);
  const endAll = live && data.play.endedAt === null ? Math.max(endRecorded, Date.now()) : endRecorded;
  const offered = RANGES.filter((r) => r.ms === Infinity || endAll - startAll > r.ms * 1.25);
  const [range, setRange] = useState<Range>(() => (live && endAll - startAll > 30 * MIN * 1.25 ? "30" : "all"));
  const [eachViewer, setEachViewer] = useState(false);
  const [hover, setHover] = useState<Hover | null>(null);
  const win = offered.find((r) => r.key === range) ?? RANGES[0];
  const w0 = win.ms === Infinity ? startAll : Math.max(startAll, endAll - win.ms);
  const w1 = Math.max(w0 + 1000, endAll);
  const x = (t: number) => ((t - w0) / (w1 - w0)) * trackW;
  /** A stretch of time on a track, cut to what is in view: [left, width] in pixels, or null. */
  const place = (from: number, to: number): [number, number] | null => {
    const a = Math.max(from, w0);
    const b = Math.min(to, w1);
    if (b <= a) return null;
    return [x(a), Math.max(2, x(b) - x(a))];
  };
  const inView = (t: number) => t >= w0 && t <= w1;
  const { ticks, stepMs } = timeTicks(w0, w1, trackW, narrow ? 72 : 104);
  const tickText = (t: number) => (stepMs < MIN ? timeOfDay(t) : shortTime(t));
  const nearMs = (10 / trackW) * (w1 - w0);

  // ── Playback and the position in the title ──
  const playback = playbackOf(events, startAll, endAll);
  const track = data.track ?? [];
  const hasTrack = track.some((p) => p[1] >= 0);
  const length = Math.max(durationS ?? 0, ...track.map((p) => p[1]), ...events.map((e) => e.posS ?? 0), 1);
  const jumps = jumpsOf(events);
  const done = finishedAt(events);
  const finished = done ? { at: done.at, posS: done.posS ?? positionAt(track, done.at) ?? length } : null;
  const problems = events.filter((e) => (e.kind === "buffering" || e.kind === "player error") && e.posS !== null);

  // ── Each viewer ──
  const whole = [...(data.lead ?? []), ...events];
  const lanes: ViewerLane[] = viewers.map((v, i) => {
    const roles = rolesOf(whole, v.userId, v.firstSeen, v.lastSeen);
    const clients = clientsOf(whole, v.userId, v.firstSeen, v.lastSeen);
    return {
      userId: v.userId, name: v.username ?? v.userId, color: viewerColor(i),
      roles: roles.length ? roles : [{ role: (v.role ?? "viewer") as RoleSpan["role"], from: v.firstSeen, to: v.lastSeen }],
      status: viewerStatusOf(events, v.userId, v.lastSeen),
      marks: events.filter((e) => e.userId === v.userId && VIEWER_MARKS.includes(e.kind) && !(e.kind === "stream changed" && !e.detail?.from)),
      health: data.health?.[v.userId] ?? [],
      track: data.positions?.[v.userId] ?? [],
      client: clients.length ? clientName(clients[clients.length - 1].device) : null,
    };
  });
  const ownTracks = lanes.filter((l) => l.track.length > 1);

  // ── Delivery and players' health ──
  const delivery = deliveryOf(data.health, data.flow);
  const syncLines = lanes.map((l) => ({ ...l, points: seriesOf(l.health, 1) })).filter((l) => l.points.some((p) => p[1] !== null));
  const bufferLines = lanes.map((l) => ({ ...l, points: seriesOf(l.health, 2) })).filter((l) => l.points.some((p) => p[1] !== null));
  const dropLines = lanes.map((l) => ({ ...l, points: seriesOf(l.health, 9) })).filter((l) => l.points.some((p) => (p[1] ?? 0) > 0));
  const steps = data.processing ?? [];

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const left = box.left + labelW + gapW;
    const f = (e.clientX - left) / trackW;
    if (f < 0 || f > 1) { if (e.pointerType !== "touch") setHover(null); return; }
    setHover({ t: w0 + (w1 - w0) * f, x: e.clientX - left, y: e.clientY - box.top, h: box.height, touch: e.pointerType === "touch" });
  };

  const grid = (h: number) => ticks.map((t) => <line key={t} className="tl-grid" x1={x(t)} x2={x(t)} y1={0} y2={h} />);

  // ── The lanes ──
  const playbackRow = (
    <Row name="Playback" height={26} key="playback">
      {playback.map((s, i) => {
        const p = place(s.from, s.to);
        if (!p) return null;
        const label = PLAYBACK_LABEL[s.state];
        return <span key={i} className={`tl-seg ${PLAYBACK_TONE[s.state]}`} style={{ left: p[0], width: p[1] }}>{fits(label, p[1]) ? label : null}</span>;
      })}
    </Row>
  );

  let positionRow: React.ReactNode = null;
  if (hasTrack) {
    const PLOT = narrow ? 96 : 120;
    const PAD = 4;
    // The seeks and the title finishing, labelled above the line on up to two lines; the rest on hover.
    const notes = [
      ...jumps.filter((j) => inView(j.at)).map((j) => ({ at: j.at, posS: j.toS, text: j.label })),
      ...(finished && inView(finished.at) ? [{ at: finished.at, posS: finished.posS, text: "Finished" }] : []),
    ];
    const spots = placeLabels(notes.map((n) => ({ x: x(n.at), w: labelWidth(n.text) })), trackW);
    const lines = Math.max(0, ...spots.map((s) => (s ? s.line + 1 : 0)));
    const STRIP = lines * 18 + (lines ? 4 : 0);
    const y = (p: number) => STRIP + PAD + (1 - Math.min(p, length) / length) * (PLOT - PAD * 2);
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
    if (last && last[0] < endAll) {
      const p = last[2] ? Math.min(length, last[1] + (endAll - last[0]) / 1000) : last[1];
      const piece = `M${pt(last[0], last[1])}L${pt(endAll, p)}`;
      if (last[2]) played += piece; else paused += piece;
    }
    // The title's start and end, and a round time or two between where they leave room.
    const marksS = [0, ...positionTicks(length).filter((s) => s > length * 0.18 && s < length * 0.8), length];
    const own = (pts: TrackPoint[]) => linePath(pts.map((p) => [p[0], p[1] >= 0 ? p[1] : null]), x, y);
    const hoverPos = hover ? positionAt(track, hover.t) : null;
    positionRow = (
      <Row name="Position" sub={`Title length ${clock(length)}`} height={STRIP + PLOT} className="tl-position" key="position">
        <svg className="tl-svg" width={trackW} height={STRIP + PLOT} aria-hidden="true">
          <rect className="tl-plot-bg" x={0} y={STRIP} width={trackW} height={PLOT} rx={6} />
          {grid(STRIP + PLOT).map((g) => g)}
          {marksS.map((s) => <line key={s} className="tl-hgrid" x1={0} x2={trackW} y1={y(s)} y2={y(s)} />)}
          {eachViewer && ownTracks.map((l) => <path key={l.userId} className="tl-viewer-line" d={own(l.track)} style={{ stroke: l.color }} />)}
          <path className={`tl-position-line paused${eachViewer ? " plain" : ""}`} d={paused} />
          <path className={`tl-position-line${eachViewer ? " plain" : ""}`} d={played} />
          <path className="tl-position-seek" d={seeks} />
          {notes.map((n, i) => {
            const s = spots[i];
            if (!s) return null;
            const lx = x(n.at);
            return <line key={`k${i}`} className="tl-leader" x1={lx} x2={lx} y1={(s.line + 1) * 18} y2={y(n.posS)} />;
          })}
          {jumps.filter((j) => inView(j.at)).map((j, i) => <circle key={`j${i}`} className="tl-seek-dot" cx={x(j.at)} cy={y(j.toS)} r={3.5} />)}
          {problems.filter((e) => inView(e.at)).map((e) => (
            e.kind === "player error"
              ? <rect key={e.id} className="tl-error" x={x(e.at) - 4} y={y(e.posS!) - 4} width={8} height={8} transform={`rotate(45 ${x(e.at)} ${y(e.posS!)})`} />
              : <circle key={e.id} className="tl-stall" cx={x(e.at)} cy={y(e.posS!)} r={4} />
          ))}
          {hover && hoverPos !== null && <circle className="tl-hover-dot" cx={hover.x} cy={y(hoverPos)} r={4} />}
        </svg>
        {notes.map((n, i) => {
          const s = spots[i];
          return s ? <span key={`n${i}`} className="tl-note" style={{ left: s.left, top: s.line * 18 }}>{n.text}</span> : null;
        })}
        {marksS.map((s) => <span key={s} className="tl-ytick" style={{ top: y(s) }}>{clock(s)}</span>)}
      </Row>
    );
  }

  const streamRows = streams.map((s, i) => {
    const d = decisionOf(s);
    const to = s.endedAt ?? endAll;
    const p = place(s.startedAt, to);
    const owner = s.ownerUserId ? viewers.find((v) => v.userId === s.ownerUserId)?.username ?? null : null;
    const restarts = events.filter((e) => e.kind === "stream restarted" && e.detail?.variant === s.variantKey && inView(e.at));
    const mine = steps.filter((x2) => x2.hlsSessionId && x2.hlsSessionId === s.hlsSessionId && inView(x2.at));
    return (
      <Row key={s.id} name={`Stream ${i + 1}`} sub={`${d.label}${owner ? ` · for ${owner}` : ""}`} height={26}>
        {p && <span className={`tl-seg ${d.tone === "warn" ? "warn" : d.tone === "good" ? "good" : "paused"}`} style={{ left: p[0], width: p[1] }}>
          {fits(d.label, p[1]) ? d.label : null}</span>}
        {restarts.map((e) => <span key={e.id} className="tl-dot info" style={{ left: x(e.at) }} />)}
        {mine.map((m) => <span key={m.id} className={`tl-tick${m.ok ? "" : " bad"}`} style={{ left: x(m.at) }} />)}
      </Row>
    );
  });

  const viewerRows = lanes.map((l) => (
    <Row key={l.userId} height={26} chip={l.color} sub={roleSummary(l.roles)}
      name={<><Avatar id={l.userId} name={l.name} size={18} /><span className="tl-person">{l.name}</span></>}>
      {l.roles.map((r, i) => {
        const p = place(r.from, r.to);
        return p ? <span key={`r${i}`} className={`tl-seg role-${r.role === "co-host" ? "cohost" : r.role}`} style={{ left: p[0], width: p[1] }} /> : null;
      })}
      {l.status.map((s, i) => {
        const p = place(s.from, s.to);
        if (!p) return null;
        const label = STATUS_LABEL[s.state];
        return <span key={`s${i}`} className={`tl-seg status ${s.state}`} style={{ left: p[0], width: p[1] }}>{fits(label, p[1]) ? label : null}</span>;
      })}
      {l.marks.filter((e) => inView(e.at)).map((e) => (
        <span key={e.id} className={`tl-dot ${e.kind === "player error" ? "error" : "event"}`} style={{ left: x(e.at) }} />
      ))}
    </Row>
  ));

  const METRIC = narrow ? 56 : 64;
  let dataRow: React.ReactNode = null;
  if (delivery.points.length > 1) {
    // The scale is what is in view: zoomed in, the last ten minutes fill the lane.
    const peak = Math.max(...delivery.points.filter((p) => inView(p[0])).map((p) => p[1] + p[2] + p[3]), 0);
    // The scale ends at the next round figure above the peak (38.4 Mbps on a 40 Mbps scale), not one step past it.
    const top = niceTop(peak);
    const y = (v: number) => METRIC - 2 - (v / top) * (METRIC - 6);
    const areas = [1, 2, 3].map((k) => {
      const lower = (p: number[]) => p.slice(1, k).reduce((s, v) => s + v, 0);
      const upper = (p: number[]) => lower(p) + p[k];
      const pts = delivery.points;
      const topEdge = pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(upper(p)).toFixed(1)}`).join("");
      const bottom = [...pts].reverse().map((p) => `L${x(p[0]).toFixed(1)},${y(lower(p)).toFixed(1)}`).join("");
      return `${topEdge}${bottom}Z`;
    });
    dataRow = (
      <Row name="Data delivered" sub={`Peak ${bps(peak)}${delivery.stepMs === 60_000 ? " · per minute" : ""}`} height={METRIC} key="data" className="tl-metric">
        <svg className="tl-svg" width={trackW} height={METRIC} aria-hidden="true">
          <rect className="tl-plot-bg" x={0} y={0} width={trackW} height={METRIC} rx={6} />
          {grid(METRIC)}
          {areas.map((d, i) => <path key={i} d={d} style={{ fill: SOURCES[i].color }} className="tl-area" />)}
        </svg>
        <span className="tl-scale">{bps(top)}</span>
      </Row>
    );
  }

  const metricRow = (key: string, name: string, sub: string, lines: Array<{ userId: string; color: string; points: Array<[number, number | null]> }>,
    opts: { symmetric?: boolean; band?: number; threshold?: number; floor: number; fmt: (v: number) => string; cap?: number }) => {
    const values = lines.flatMap((l) => l.points.filter((p) => inView(p[0])).map((p) => p[1]).filter((v): v is number => v !== null));
    const most = Math.max(opts.floor, ...values.map((v) => (opts.symmetric ? Math.abs(v) : v)));
    const top = niceTop(Math.min(opts.cap ?? Infinity, most * 1.1));
    const lo = opts.symmetric ? -top : 0;
    const y = (v: number) => {
      const c = Math.max(lo, Math.min(top, v));
      return 3 + (1 - (c - lo) / (top - lo)) * (METRIC - 6);
    };
    return (
      <Row name={name} sub={sub} height={METRIC} key={key} className="tl-metric">
        <svg className="tl-svg" width={trackW} height={METRIC} aria-hidden="true">
          <rect className="tl-plot-bg" x={0} y={0} width={trackW} height={METRIC} rx={6} />
          {grid(METRIC)}
          {opts.band !== undefined && <rect className="tl-band" x={0} width={trackW} y={y(opts.band)} height={Math.max(0, y(-opts.band) - y(opts.band))} />}
          {opts.symmetric && <line className="tl-zero" x1={0} x2={trackW} y1={y(0)} y2={y(0)} />}
          {opts.threshold !== undefined && <line className="tl-threshold" x1={0} x2={trackW} y1={y(opts.threshold)} y2={y(opts.threshold)} />}
          {lines.map((l) => <path key={l.userId} className="tl-line" d={linePath(l.points, x, y)} style={{ stroke: l.color }} />)}
        </svg>
        <span className="tl-scale">{opts.symmetric ? `±${opts.fmt(top)}` : opts.fmt(top)}</span>
      </Row>
    );
  };

  const healthRows = [
    dataRow,
    syncLines.length > 0 && metricRow("sync", "Sync offset", "Tolerance ±2 s", syncLines,
      { symmetric: true, band: 2, floor: 3, cap: 30, fmt: (v) => `${v} s` }),
    bufferLines.length > 0 && metricRow("buffer", "Forward buffer", "Low below 10 s", bufferLines,
      { threshold: 10, floor: 30, cap: 600, fmt: (v) => clock(v) }),
    dropLines.length > 0 && metricRow("frames", "Dropped frames",
      `${dropLines.reduce((s, l) => s + l.points.reduce((a, p) => a + (p[1] ?? 0), 0), 0)} in total`, dropLines,
      { floor: 5, fmt: (v) => `${v}` }),
  ].filter(Boolean);

  // ── The readout at the hover line ──
  const readout = (t: number) => {
    const pb = playback.find((s) => s.from <= t && t <= s.to);
    const pos = positionAt(track, t);
    const near = newestFirst(events.filter((e) => Math.abs(e.at - t) <= Math.max(nearMs, 5_000) && e.kind !== "health")).slice(0, 4);
    const nearSteps = steps.filter((s2) => Math.abs(s2.at - t) <= Math.max(nearMs, 5_000)).slice(0, 3);
    const dp = delivery.points.reduce<(typeof delivery.points)[number] | null>((b, p) => (!b || Math.abs(p[0] - t) < Math.abs(b[0] - t) ? p : b), null);
    const dpNear = dp && Math.abs(dp[0] - t) <= Math.max(delivery.stepMs, 10_000) ? dp : null;
    const running = streams.map((s, i) => ({ s, i })).filter(({ s }) => s.startedAt <= t && (s.endedAt ?? endAll) >= t);
    return (
      <>
        <div className="tl-tip-head">
          <strong>{timeOfDay(t)}</strong>
          {pos !== null && <span className="muted">Position {clock(pos)} of {clock(length)}</span>}
        </div>
        <dl className="tl-tip-grid">
          <dt>Playback</dt>
          <dd>{pb ? `${PLAYBACK_LABEL[pb.state]}${pb.state !== "waiting" && pb.by ? `, ${pb.state === "paused" ? "paused" : "started"} by ${pb.by}` : ""}` : "Stopped"}</dd>
          {running.map(({ s, i }) => (
            <PairRow key={s.id} k={`Stream ${i + 1}`} v={`${decisionOf(s).label}${s.reason && s.decision === "transcode" ? ` · ${reasonText(s.reason)}` : ""}`} />
          ))}
          {dpNear && <PairRow k="Data" v={SOURCES.map((src, i) => `${src.label} ${bps(dpNear[i + 1])}`).join(" · ")} />}
        </dl>
        <table className="tl-tip-viewers">
          <thead><tr><th>Viewer</th><th>Status</th>{streams.length > 1 && <th className="num">Stream</th>}<th className="num">Sync</th><th className="num">Buffer</th>{dropLines.length > 0 && <th className="num">Dropped</th>}</tr></thead>
          <tbody>
            {lanes.map((l) => {
              const role = l.roles.find((r) => r.from <= t && t <= r.to)?.role;
              const st = l.status.find((s2) => s2.from <= t && t <= s2.to);
              const h = sampleAt(l.health, t);
              const s = role ? streamAt(events, streams, l.userId, t) : null;
              const statusText = !role ? "Not in the session" : st ? st.what : pb?.state === "paused" ? "Paused" : pb ? "Watching" : "Idle";
              return (
                <tr key={l.userId} className={role ? "" : "muted"}>
                  <td><span className="tl-chip" style={{ background: l.color }} />{l.name}
                    {role && role !== "viewer" && <span className="muted"> · {ROLE_LABEL[role]}</span>}</td>
                  <td>{statusText}</td>
                  {streams.length > 1 && <td className="num">{s ? streams.indexOf(s) + 1 : "—"}</td>}
                  <td className="num">{h && typeof h[1] === "number" ? offsetText(h[1]) : "—"}</td>
                  <td className="num">{h && typeof h[2] === "number" ? clock(h[2]) : "—"}</td>
                  {dropLines.length > 0 && <td className="num">{h && typeof h[9] === "number" ? h[9] : "—"}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
        {(near.length > 0 || nearSteps.length > 0) && (
          <ul className="tl-tip-events">
            {near.map((e) => <li key={e.id}><span className="mono muted">{shortTime(e.at)}</span> {eventText(e, ctx)}</li>)}
            {nearSteps.map((s2) => <li key={`p${s2.id}`}><span className="mono muted">{shortTime(s2.at)}</span> {stepText(s2)}</li>)}
          </ul>
        )}
      </>
    );
  };

  const TIP_W = 440;
  const tipLeft = hover ? (() => {
    const right = labelW + gapW + hover.x + 14;
    return right + TIP_W <= width ? right : Math.max(0, labelW + gapW + hover.x - 14 - TIP_W);
  })() : 0;
  const below = hover ? hover.y < hover.h / 2 : true;

  // ── The key under the chart: only what it shows ──
  const decisions = new Set(streams.map((s) => decisionOf(s).tone));
  const roleKinds = new Set(lanes.flatMap((l) => l.roles.map((r) => r.role)));
  const statusKinds = new Set(lanes.flatMap((l) => l.status.map((s) => s.state)));
  const anyMarks = lanes.some((l) => l.marks.some((e) => e.kind !== "player error"));
  const anyErrors = events.some((e) => e.kind === "player error");

  return (
    <div className={`tl${narrow ? " narrow" : ""}`} ref={ref} style={{ ["--tl-label" as string]: `${labelW}px`, ["--tl-gap" as string]: `${gapW}px` }}>
      <div className="tl-toolbar">
        {offered.length > 1 && (
          <div className="segmented" role="group" aria-label="Time range">
            {offered.map((r) => (
              <button key={r.key} type="button" className={range === r.key ? "on" : ""} aria-pressed={range === r.key} onClick={() => setRange(r.key)}>{r.label}</button>
            ))}
          </div>
        )}
        <span className="muted small tl-span">{shortTime(w0)} – {live && data.play.endedAt === null ? "now" : shortTime(w1)}</span>
        {ownTracks.length > 0 && hasTrack && (
          <button type="button" className={`chip-toggle${eachViewer ? " on" : ""}`} aria-pressed={eachViewer} onClick={() => setEachViewer((v) => !v)}>
            Per-viewer positions
          </button>
        )}
      </div>
      <div className="tl-body" role="img" aria-label="Session timeline: playback, position in the title, streams, viewers, data delivered, sync and buffer over time"
        onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={(e) => { if (e.pointerType !== "touch") setHover(null); }}>
        {playbackRow}
        {positionRow}
        {streamRows.length > 0 && <div className="tl-section">Streams</div>}
        {streamRows}
        {viewerRows.length > 0 && <div className="tl-section">Viewers</div>}
        {viewerRows}
        {healthRows.length > 0 && <div className="tl-section">Delivery and player health</div>}
        {healthRows}
        {hover && <span className="tl-hover-line" style={{ left: labelW + gapW + hover.x }} />}
        {hover && !narrow && (
          <div className={`tl-tip${below ? "" : " above"}`} style={{ left: tipLeft, top: below ? hover.y + 14 : hover.y - 14, width: TIP_W }}>
            {readout(hover.t)}
          </div>
        )}
      </div>
      <div className="tl-row tl-axis">
        <div className="tl-label" />
        <div className="tl-track" style={{ height: 18 }}>
          {ticks.map((t) => {
            const tx = x(t);
            const w = labelWidth(tickText(t));
            return <span key={t} style={{ left: Math.min(Math.max(0, tx - w / 2), trackW - w), width: w }}>{tickText(t)}</span>;
          })}
        </div>
      </div>
      {hover && narrow && <div className="tl-tip docked">{readout(hover.t)}</div>}
      <div className="tl-legend">
        <KeyGroup name="Playback">
          <Key cls="good" text="Playing" /><Key cls="paused" text="Paused" />
          {playback.some((s) => s.state === "waiting") && <Key cls="warn" text="Waiting for host" />}
          {jumps.length > 0 && <Key cls="seek" text="Seek" />}
        </KeyGroup>
        {streams.length > 0 && (
          <KeyGroup name="Streams">
            {decisions.has("good") && <Key cls="good" text="Direct play / direct stream" />}
            {decisions.has("warn") && <Key cls="warn" text="Transcode" />}
            {steps.some((s) => s.hlsSessionId) && <Key cls="tick" text="Processing step" />}
          </KeyGroup>
        )}
        {lanes.length > 0 && (
          <KeyGroup name="Viewers">
            {roleKinds.has("host") && <Key cls="role-host" text="Host" />}
            {roleKinds.has("co-host") && <Key cls="role-cohost" text="Co-host" />}
            {roleKinds.has("viewer") && <Key cls="role-viewer" text="Viewer" />}
            {statusKinds.has("buffering") && <Key cls="buffering" text="Buffering" />}
            {statusKinds.has("loading") && <Key cls="loading" text="Loading" />}
            {statusKinds.has("away") && <Key cls="away" text="Away from Discord" />}
            {anyMarks && <Key cls="event" text="Change or request" />}
            {anyErrors && <Key cls="error" text="Player error" />}
          </KeyGroup>
        )}
        {delivery.points.length > 1 && (
          <KeyGroup name="Data">
            {SOURCES.map((s) => <li key={s.key}><span className="tl-key" style={{ background: s.color }} />{s.label}</li>)}
          </KeyGroup>
        )}
        {(syncLines.length > 0 || bufferLines.length > 0 || (eachViewer && ownTracks.length > 0)) && (
          <KeyGroup name="Viewer lines">
            {lanes.filter((l) => syncLines.some((s) => s.userId === l.userId) || bufferLines.some((b) => b.userId === l.userId)
              || (eachViewer && ownTracks.includes(l)))
              .map((l) => <li key={l.userId}><span className="tl-key line" style={{ background: l.color }} />{l.name}</li>)}
          </KeyGroup>
        )}
      </div>
    </div>
  );
}

function PairRow({ k, v }: { k: string; v: string }) {
  return <><dt>{k}</dt><dd>{v}</dd></>;
}

function KeyGroup({ name, children }: { name: string; children: React.ReactNode }) {
  return <ul className="tl-key-group"><li className="tl-key-name">{name}</li>{children}</ul>;
}

function Key({ cls, text }: { cls: string; text: string }) {
  return <li><span className={`tl-key ${cls}`} />{text}</li>;
}

/** A processing step in a few words: "Stream setup took 1.4 s", "Subtitle extraction failed after 2.1 s". */
export function stepText(s: ProcessingStep): string {
  const secs = s.ms >= 10_000 ? `${Math.round(s.ms / 1000)} s` : `${(s.ms / 1000).toFixed(1)} s`;
  return s.ok ? `${processingName(s.kind)} took ${secs}` : `${processingName(s.kind)} failed after ${secs}`;
}

/** What of the title each viewer saw, and where they buffered or hit an error, along the title's own clock. */
export function Watched({ data, durationS }: { data: PlayDetail; durationS: number | null }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const narrow = width > 0 && width < 560;
  const labelW = narrow ? 104 : 184;
  const gapW = narrow ? 8 : 14;
  const trackW = Math.max(1, width - labelW - gapW);
  const watched = data.watched ?? {};
  const length = Math.max(durationS ?? 0, ...Object.values(watched).flat().map((p) => p[1]), ...data.events.map((e) => e.posS ?? 0), 1);
  const x = (s: number) => (Math.min(length, Math.max(0, s)) / length) * trackW;
  const all = unionParts(Object.values(watched));
  // Each viewer's coverage by how it reached them, where their own player's positions say: direct or transcoded.
  const delivery = (userId: string): DeliveryPart[] | null => {
    const mine = data.positions?.[userId];
    if (!mine || mine.length < 2) return null;
    const parts = deliveryParts(mine, data.events, data.streams, userId);
    return parts.length ? parts : null;
  };
  const ways = new Set(data.viewers.flatMap((v) => delivery(v.userId)?.map((p) => p.decision) ?? [undefined]));
  const anyDelivery = [...ways].some((w) => w !== undefined);
  const trouble = (userId: string | null) => data.events.filter((e) => (e.kind === "buffering" || e.kind === "player error") && e.posS !== null
    && (!userId || e.userId === userId));
  const row = (key: string, name: React.ReactNode, parts: Array<[number, number]>, marks: PlayEvent[], how: DeliveryPart[] | null = null) => {
    const seen = parts.reduce((s, [a, b]) => s + (b - a), 0);
    const segs = how ? how.map((p) => ({ from: p.from, to: p.to, cls: p.decision === "transcode" ? "warn" : p.decision === "copy" ? "good" : "watched" }))
      : parts.map(([a, b]) => ({ from: a, to: b, cls: "watched" }));
    return (
      <Row key={key} name={name} sub={`${clock(seen)} watched · ${Math.round((seen / length) * 100)}%`} height={22}>
        {segs.map((s, i) => <span key={i} className={`tl-seg ${s.cls}`} style={{ left: x(s.from), width: Math.max(2, x(s.to) - x(s.from)) }} />)}
        {marks.map((e) => <span key={e.id} className={`tl-dot ${e.kind === "player error" ? "error" : "stall"}`} style={{ left: x(e.posS!) }} />)}
      </Row>
    );
  };
  // Each seek as an arc over the title, from where it was to where it landed; labelled above where there is room.
  const jumps = jumpsOf(data.events);
  const done = finishedAt(data.events);
  const notes = [...jumps.map((j) => ({ x: x((j.fromS + j.toS) / 2), text: j.label })), ...(done && done.posS !== null ? [{ x: x(done.posS), text: "Finished" }] : [])];
  const spots = placeLabels(notes.map((n) => ({ x: n.x, w: labelWidth(n.text) })), trackW);
  const lines = Math.max(0, ...spots.map((s) => (s ? s.line + 1 : 0)));
  const STRIP = lines * 18;
  const ARC = 36;
  if (all.length === 0) return <p className="muted">Playback position was not recorded for this session.</p>;
  const ticks = positionTicks(length);
  return (
    <div className={`tl tl-coverage${narrow ? " narrow" : ""}`} ref={ref} style={{ ["--tl-label" as string]: `${labelW}px`, ["--tl-gap" as string]: `${gapW}px` }}>
      <div className="tl-body" role="img" aria-label="Portions of the title each viewer watched">
        {(jumps.length > 0 || done) && (
          <Row name="Seeks" sub={`${jumps.length} ${jumps.length === 1 ? "seek" : "seeks"}`} height={STRIP + ARC} className="tl-seeks">
            <svg className="tl-svg" width={trackW} height={STRIP + ARC} aria-hidden="true">
              {jumps.map((j, i) => {
                const x1 = x(j.fromS);
                const x2 = x(j.toS);
                const rise = Math.min(ARC - 6, 8 + Math.abs(x2 - x1) * 0.12);
                const base = STRIP + ARC - 2;
                return (
                  <g key={i}>
                    <path className="tl-arc" d={`M${x1.toFixed(1)},${base} Q${((x1 + x2) / 2).toFixed(1)},${(base - rise * 2).toFixed(1)} ${x2.toFixed(1)},${base}`} />
                    <circle className="tl-seek-dot" cx={x2} cy={base} r={3.5} />
                  </g>
                );
              })}
              {notes.map((n, i) => spots[i] && <line key={`k${i}`} className="tl-leader" x1={n.x} x2={n.x} y1={(spots[i]!.line + 1) * 18} y2={STRIP + ARC - 10} />)}
              {done && done.posS !== null && <line className="tl-finish" x1={x(done.posS)} x2={x(done.posS)} y1={STRIP} y2={STRIP + ARC} />}
            </svg>
            {notes.map((n, i) => spots[i] && <span key={`n${i}`} className="tl-note" style={{ left: spots[i]!.left, top: spots[i]!.line * 18 }}>{n.text}</span>)}
          </Row>
        )}
        {data.viewers.length > 1 && row("all", "All viewers", all, trouble(null))}
        {data.viewers.map((v) => row(v.userId,
          <><Avatar id={v.userId} name={v.username} size={18} /><span className="tl-person">{v.username ?? v.userId}</span></>,
          watched[v.userId] ?? [], trouble(v.userId), delivery(v.userId)))}
      </div>
      <div className="tl-row tl-axis">
        <div className="tl-label" />
        <div className="tl-track" style={{ height: 18 }}>
          {ticks.map((s) => {
            const w = labelWidth(clock(s));
            return <span key={s} style={{ left: Math.min(Math.max(0, x(s) - w / 2), trackW - w), width: w }}>{clock(s)}</span>;
          })}
        </div>
      </div>
      <div className="tl-legend">
        <KeyGroup name="Watched">
          {(!anyDelivery || ways.has(null) || ways.has(undefined)) && <Key cls="watched" text={anyDelivery ? "Stream not recorded" : "Watched"} />}
          {ways.has("copy") && <Key cls="good" text="Direct play / direct stream" />}
          {ways.has("transcode") && <Key cls="warn" text="Transcode" />}
          {jumps.length > 0 && <Key cls="seek" text="Seek" />}
          <Key cls="stall" text="Buffering" />
          <Key cls="error" text="Player error" />
        </KeyGroup>
      </div>
    </div>
  );
}

interface Moment { id: number; at: number; posS: number | null; tone: string; icon: string; title: string; why?: string }

const listed = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

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
      const why = s?.decision === "transcode" ? `Video is transcoded: ${s.reason ? reasonText(s.reason) : "no reason reported"}`
        : s?.notes.audio === "transcode" ? `Video sent unchanged; audio converted${s.notes.audioReason ? `: ${s.notes.audioReason}` : ""}`
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
          why: "The video ends before the duration Plex reports; playback ended at that point." }
        : { tone: "muted", icon: "check", title: `${who} reached the end of the title` });
    } else if (e.kind === "role") {
      of(e, { tone: "info", icon: "users", title: eventText(e, ctx) });
    } else if (e.kind === "asked for host" || e.kind === "request declined" || e.kind === "request ended") {
      of(e, { tone: "muted", icon: "users", title: eventText(e, ctx) });
    } else if (e.kind === "short sound") {
      of(e, { tone: "warn", icon: "stream", title: "The title's audio is shorter than its video", why: eventText(e, ctx) });
    } else if (e.kind === "stream restarted") {
      of(e, { tone: "info", icon: "history", title: eventText(e, ctx) });
    } else if (e.kind === "buffering" && Number(d.ms) >= 3000) {
      of(e, { tone: "warn", icon: "pulse", title: eventText(e, ctx) });
    } else if (e.kind === "room waited" && Number(d.ms) >= 5000) {
      of(e, { tone: "warn", icon: "clock", title: eventText(e, ctx),
        why: "Playback waits only for the host's video; other viewers resynchronise while playback continues." });
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

