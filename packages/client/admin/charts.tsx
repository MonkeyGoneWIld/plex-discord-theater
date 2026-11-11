import { useState, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

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
          <strong>{fmt(Number(row[s.key]) || 0)}</strong>
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
  return `${h >= 100 ? count(Math.round(h)) : h.toFixed(1)} h`;
}
