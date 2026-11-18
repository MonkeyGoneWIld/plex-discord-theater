import { useRef, useState, type ReactNode } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { dayTime, shortTime } from "./format";
import { niceTicks, timeTicks } from "./lanes";
import { useWidth } from "./timeline";

/**
 * The admin page's charts: columns over time, drawn with Recharts, and bars
 * for a top ten, in plain HTML so each name is there in full. Colours are the page's --series-N tokens, light and dark; a
 * chart of two series or more has a legend; every chart can show its numbers
 * as a table instead.
 */

export const COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)"] as const;

export interface Series {
  key: string;
  label: string;
  color: string;
}

type Row = Record<string, unknown>;

const AXIS_TICK = { fill: "var(--muted)", fontSize: 12 };

/** A chart's card: what it shows, its legend, and a table of the same numbers. */
export function ChartCard({ title, sub, series, table, children, wide }: {
  title: string;
  sub?: ReactNode;
  series?: Series[];
  table: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className={`card chart-card${wide ? " wide" : ""}`}>
      <header className="chart-head">
        <div>
          <h3>{title}</h3>
          {sub && <p className="muted small chart-sub">{sub}</p>}
        </div>
        <button className="link small" onClick={() => setAsTable(!asTable)} aria-pressed={asTable}>
          {asTable ? "Show chart" : "Show table"}
        </button>
      </header>
      {!asTable && series && series.length > 1 && (
        <ul className="legend">
          {series.map((s) => <li key={s.key}><span className="swatch" style={{ background: s.color }} />{s.label}</li>)}
        </ul>
      )}
      {asTable ? <div className="table-wrap chart-table">{table}</div> : children}
    </section>
  );
}

/** The same numbers, as a table: a column for the label, one for each series. */
export function SeriesTable({ rows, label, labelKey, series, fmt }: {
  rows: Row[];
  label: string;
  labelKey: string;
  series: Series[];
  fmt: (n: number) => string;
}) {
  return (
    <table className="table">
      <thead><tr><th>{label}</th>{series.map((s) => <th key={s.key} className="num">{s.label}</th>)}</tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td className="nowrap">{String(r[labelKey])}</td>
            {series.map((s) => <td key={s.key} className="num nowrap">{fmt(Number(r[s.key]) || 0)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface TipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: unknown }>;
  label?: unknown;
}

/** One tooltip, every series: the value first, then what it is. */
function Tip({ active, payload, label, series, fmt, title }: TipProps & {
  series: Series[];
  fmt: (n: number) => string;
  title?: (row: Row) => string;
}) {
  const row = payload?.[0]?.payload as Row | undefined;
  if (!active || !row) return null;
  return (
    <div className="chart-tip">
      <div className="tip-title">{title ? title(row) : String(label ?? "")}</div>
      {[...series].reverse().map((s) => (
        <div key={s.key} className="tip-row">
          <span className="tip-key" style={{ background: s.color }} />
          <strong>{row[s.key] === null || row[s.key] === undefined ? "—" : fmt(Number(row[s.key]) || 0)}</strong>
          <span className="muted">{s.label}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Columns along a time or a scale (days, hours, weekdays): one series, or
 * several stacked. Its axis ticks are whole numbers unless `decimals`.
 */
export function Columns({ rows, x, series, fmt, axisFmt = fmt, height = 220, stacked = false, decimals = false, tipTitle }: {
  rows: Row[];
  x: string;
  series: Series[];
  fmt: (n: number) => string;
  axisFmt?: (n: number) => string;
  height?: number;
  stacked?: boolean;
  decimals?: boolean;
  tipTitle?: (row: Row) => string;
}) {
  const top = series.length - 1;
  return (
    <div className="chart" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} barCategoryGap="18%" barGap={2}>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey={x} tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: "var(--axis)" }}
            minTickGap={14} interval="preserveStartEnd" />
          <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={60} allowDecimals={decimals}
            tickFormatter={(v) => axisFmt(Number(v))} />
          <Tooltip cursor={{ fill: "var(--surface-2)" }} isAnimationActive={false}
            content={(p) => <Tip active={p.active} payload={p.payload} label={p.label} series={series} fmt={fmt} title={tipTitle} />} />
          {series.map((s, i) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} stackId={stacked ? "all" : undefined}
              maxBarSize={24} radius={!stacked || i === top ? [4, 4, 0, 0] : 0}
              stroke={stacked ? "var(--surface)" : undefined} strokeWidth={stacked ? 2 : 0} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

/**
 * Lines over a time axis in local 12-hour time: one series or several (each
 * with a light fill below it, or stacked), one tooltip for every series at
 * the time under the pointer, and a gap where nothing was recorded (null).
 * Rows carry their time as `at`.
 */
export function Lines({ rows, series, fmt, axisFmt = fmt, height = 200, from, to, max, stacked = false, threshold, curve = "linear", onZoom }: {
  rows: Row[];
  series: Series[];
  fmt: (n: number) => string;
  axisFmt?: (n: number) => string;
  height?: number;
  from: number;
  to: number;
  /** The axis's top, as for a percentage; else from the data. */
  max?: number;
  stacked?: boolean;
  /** A dashed line across at a value, with what it marks. */
  threshold?: { value: number; label: string };
  /** Steps, for counts that hold until they change. */
  curve?: "linear" | "stepAfter";
  /** Dragging across the chart picks a stretch of time to zoom into. */
  onZoom?: (from: number, to: number) => void;
}) {
  const [setWidthEl, width] = useWidth<HTMLDivElement>();
  const box = useRef<HTMLDivElement | null>(null);
  const ref = (el: HTMLDivElement | null) => { box.current = el; setWidthEl(el); };
  // The stretch being dragged across, kept in a ref as well so a quick drag reads where it started.
  const [pick, setPickState] = useState<{ a: number; b: number } | null>(null);
  const pickRef = useRef<{ a: number; b: number } | null>(null);
  const setPick = (p: { a: number; b: number } | null) => { pickRef.current = p; setPickState(p); };
  // The time under the pointer, from where it is across the plot.
  const timeAt = (clientX: number) => {
    const plot = box.current?.querySelector(".recharts-cartesian-grid")?.getBoundingClientRect();
    if (!plot || plot.width <= 0) return null;
    return from + Math.min(1, Math.max(0, (clientX - plot.left) / plot.width)) * (to - from);
  };
  const zoomEvents = onZoom ? {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === "touch" || e.button !== 0) return;
      const t = timeAt(e.clientX);
      if (t !== null) setPick({ a: t, b: t });
    },
    onPointerMove: (e: React.PointerEvent) => {
      const p = pickRef.current;
      const t = p && timeAt(e.clientX);
      if (p && t !== null) setPick({ ...p, b: t });
    },
    onPointerUp: (e: React.PointerEvent) => {
      const p = pickRef.current;
      const b = timeAt(e.clientX) ?? p?.b;
      setPick(null);
      // A stretch of at least 1% of the width; a click is not a zoom.
      if (p && b != null && Math.abs(b - p.a) >= (to - from) / 100) onZoom(Math.min(p.a, b), Math.max(p.a, b));
    },
    onPointerLeave: () => setPick(null),
  } : {};
  const { ticks, stepMs } = timeTicks(from, to, Math.max(0, width - 70), width < 560 ? 76 : 110);
  // The value axis: a fixed top (a percentage), or round steps over the data and any threshold line.
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const dataTop = Math.max(0, threshold?.value ?? 0, ...rows.map((r) => (stacked
    ? series.reduce((s, x) => s + num(r[x.key]), 0)
    : Math.max(0, ...series.map((x) => num(r[x.key]))))));
  const yTicks = max === undefined ? niceTicks(dataTop) : undefined;
  const many = to - from > DAY_MS;
  const tick = (t: number) => {
    const d = new Date(t);
    const midnight = d.getHours() === 0 && d.getMinutes() === 0;
    return stepMs >= DAY_MS || (many && midnight) ? `${d.getDate()} ${MONTHS[d.getMonth()]}` : shortTime(t).replace(":00 ", " ");
  };
  return (
    <div className={`chart${onZoom ? " zoomable" : ""}`} style={{ height }} ref={ref} {...zoomEvents}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 8, right: 10, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey="at" type="number" scale="time" domain={[from, to]} ticks={ticks} tickFormatter={(v) => tick(Number(v))}
            tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: "var(--axis)" }} />
          <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={60} domain={[0, max ?? yTicks![yTicks!.length - 1]]} allowDecimals
            ticks={yTicks} tickFormatter={(v) => axisFmt(Number(v))} />
          <Tooltip isAnimationActive={false} cursor={{ stroke: "var(--axis)", strokeDasharray: "3 3" }}
            content={(p) => <Tip active={p.active} payload={p.payload} label={p.label} series={series} fmt={fmt} title={(r) => dayTime(Number(r.at))} />} />
          {pick && pick.a !== pick.b && <ReferenceArea x1={Math.min(pick.a, pick.b)} x2={Math.max(pick.a, pick.b)} fill="var(--accent)" fillOpacity={0.12}
            stroke="var(--accent)" strokeOpacity={0.5} ifOverflow="hidden" />}
          {threshold && <ReferenceLine y={threshold.value} stroke="var(--muted)" strokeDasharray="4 4"
            label={{ value: threshold.label, position: "insideTopRight", fill: "var(--muted)", fontSize: 11 }} />}
          {series.map((s) => (
            <Area key={s.key} type={curve} dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} fill={s.color}
              fillOpacity={stacked ? 0.55 : 0.08} stackId={stacked ? "all" : undefined} isAnimationActive={false} dot={false}
              connectNulls={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * A top ten: one bar each, longest first, its name in full beside it and its
 * value at its tip. Picking one can open it.
 */
export function Bars({ rows, nameKey, valueKey, label, fmt, color = COLORS[0], onPick }: {
  rows: Row[];
  nameKey: string;
  valueKey: string;
  label: string;
  fmt: (n: number) => string;
  color?: string;
  onPick?: (row: Row) => void;
}) {
  const max = Math.max(0, ...rows.map((r) => Number(r[valueKey]) || 0));
  return (
    <ol className="bars" aria-label={label}>
      {rows.map((r, i) => {
        const v = Number(r[valueKey]) || 0;
        const name = String(r[nameKey]);
        const body = (
          <>
            <span className="bar-name">{name}</span>
            <span className="bar-track">
              <span className="bar-fill" style={{ width: `${max > 0 ? (v / max) * 100 : 0}%`, background: color }} />
            </span>
            <span className="bar-value">{fmt(v)}</span>
          </>
        );
        const title = `${name}: ${fmt(v)}`;
        return (
          <li key={i}>
            {onPick
              ? <button type="button" className="bar-row" title={title} onClick={() => onPick(r)}>{body}</button>
              : <div className="bar-row" title={title}>{body}</div>}
          </li>
        );
      })}
    </ol>
  );
}

/** The unit an axis of bytes reads in, from its largest value: ticks in round numbers of it. */
export function byteUnit(max: number): { div: number; label: string } {
  if (max >= 1e12) return { div: 1e12, label: "TB" };
  if (max >= 1e9) return { div: 1e9, label: "GB" };
  if (max >= 1e6) return { div: 1e6, label: "MB" };
  if (max >= 1e3) return { div: 1e3, label: "KB" };
  return { div: 1, label: "B" };
}

/** A count: in full under 10,000, then compact. */
export function count(n: number): string {
  if (Math.abs(n) >= 10_000) return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
  return new Intl.NumberFormat("en").format(Math.round(n * 10) / 10);
}

/** Hours, from seconds: "45 min" under an hour, then "12.5 h". */
export function hours(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const h = seconds / 3600;
  return `${h >= 100 ? count(Math.round(h)) : h.toFixed(1).replace(/\.0$/, "")} h`;
}
