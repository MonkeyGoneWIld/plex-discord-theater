import { useState, type ReactNode } from "react";
import { bytes, clock, timeOfDay } from "./format";

/**
 * The dashboard's small visuals, drawn by hand so the live page needs no
 * chart library: where data came from (server, Discord's cache, other
 * viewers), a room's delivery over the last minutes, and playback progress.
 * The three sources keep one colour each, everywhere.
 */

export const SOURCES = [
  { key: "server", label: "Server", color: "var(--series-1)" },
  { key: "cache", label: "Discord cache", color: "var(--series-2)" },
  { key: "peers", label: "Peers", color: "var(--series-3)" },
] as const;

/** 4.2 Mbps, 850 kbps, 0 kbps: a rate in bits a second. */
export function bps(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} Mbps`;
  return `${Math.round(n / 1e3)} kbps`;
}

export const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/** Where bytes came from, as one bar in three parts, with what each part is underneath. */
export function SplitBar({ server, cache, peers, legend = true, fmt = bytes }: {
  server: number;
  cache: number;
  peers: number;
  legend?: boolean | "compact";
  fmt?: (n: number) => string;
}) {
  const total = server + cache + peers;
  const parts = [server, cache, peers];
  return (
    <div className="split">
      <div className="split-bar" role="img"
        aria-label={total > 0 ? SOURCES.map((s, i) => `${s.label} ${pct(parts[i], total)}%`).join(", ") : "No data yet"}>
        {total > 0 && SOURCES.map((s, i) => parts[i] > 0 && (
          <span key={s.key} style={{ width: `${(parts[i] / total) * 100}%`, background: s.color }}
            title={`${s.label}: ${fmt(parts[i])} (${pct(parts[i], total)}%)`} />
        ))}
      </div>
      {legend && (
        <ul className={`split-legend${legend === "compact" ? " compact" : ""}`}>
          {SOURCES.map((s, i) => (
            <li key={s.key}>
              <span className="swatch" style={{ background: s.color }} />
              <span className="split-name">{s.label}</span>
              <strong>{pct(parts[i], total)}%</strong>
              {legend !== "compact" && <span className="muted">{fmt(parts[i])}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Playback progress: where it is, how long it runs, and what is left. */
export function Progress({ positionS, durationS, state }: { positionS: number; durationS: number | null; state: "playing" | "paused" | "buffering" | "idle" }) {
  const share = durationS && durationS > 0 ? Math.min(100, (positionS / durationS) * 100) : null;
  const left = durationS && durationS > positionS ? durationS - positionS : null;
  return (
    <div className={`progress ${state}`}>
      <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={durationS ?? undefined} aria-valuenow={Math.round(positionS)}
        aria-label="Playback position">
        <span style={{ width: `${share ?? 0}%` }} />
      </div>
      <div className="progress-times">
        <span><strong>{clock(positionS)}</strong>{durationS ? <span className="muted"> / {clock(durationS)}</span> : null}</span>
        {share !== null && <span className="muted">{Math.round(share)}%{left !== null ? ` · ${clock(left)} remaining` : ""}</span>}
      </div>
    </div>
  );
}

/** Somebody, as the first letter of their name on a colour of their own. */
export function Avatar({ name, id, size = 24 }: { name: string | null; id: string; size?: number }) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  const letter = (name ?? "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <span className="avatar" title={name ?? id} aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.46), background: `hsl(${h} 42% 38%)` }}>
      {letter}
    </span>
  );
}

export type FlowPoint = [number, number, number, number];

const W = 600;

/**
 * A room's delivery over the last minutes: what its players received each
 * moment from the server, Discord's cache and each other, stacked, against
 * the bitrate they need to keep playing (the dashed line).
 */
export function FlowChart({ points, requiredBps, height = 150, stepS = 10 }: {
  points: FlowPoint[];
  requiredBps: number | null;
  height?: number;
  stepS?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) {
    return <div className="flow-empty" style={{ height }}>Collecting data. Players report what they received every 10 seconds.</div>;
  }
  const totals = points.map((p) => p[1] + p[2] + p[3]);
  const max = Math.max(1e6, requiredBps ?? 0, ...totals) * 1.15;
  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (v: number) => height - (v / max) * height;
  // Each layer's top edge, then back along the layer under it.
  const area = (upto: number, from: number) => {
    const top = points.map((p, i) => `${x(i).toFixed(1)},${y(p.slice(1, upto + 1).reduce((s, v) => s + v, 0)).toFixed(1)}`);
    const base = points.map((p, i) => `${x(i).toFixed(1)},${y(p.slice(1, from + 1).reduce((s, v) => s + v, 0)).toFixed(1)}`).reverse();
    return `M${top.join(" L")} L${base.join(" L")} Z`;
  };
  const at = hover === null ? null : points[hover];
  const spanS = (points.length - 1) * stepS;
  return (
    <div className="flow">
      <div className="flow-plot" style={{ height }}
        onPointerMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const share = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
          setHover(Math.round(share * (points.length - 1)));
        }}
        onPointerLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" role="img"
          aria-label={`Delivery over the last ${Math.round(spanS / 60)} minutes`}>
          {[0.25, 0.5, 0.75].map((g) => <line key={g} x1="0" x2={W} y1={height * g} y2={height * g} className="flow-grid" />)}
          {SOURCES.map((s, i) => <path key={s.key} d={area(i + 1, i)} fill={s.color} className="flow-area" />)}
          {requiredBps ? <line x1="0" x2={W} y1={y(requiredBps)} y2={y(requiredBps)} className="flow-required" /> : null}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1="0" y2={height} className="flow-cross" />}
        </svg>
        <span className="flow-max">{bps(max)}</span>
        {at && hover !== null && (
          <div className="chart-tip flow-tip" style={hover > points.length / 2 ? { right: `${100 - (hover / (points.length - 1)) * 100 + 2}%` } : { left: `${(hover / (points.length - 1)) * 100 + 2}%` }}>
            <div className="tip-title">{timeOfDay(at[0])}</div>
            {SOURCES.map((s, i) => (
              <div key={s.key} className="tip-row">
                <span className="tip-key" style={{ background: s.color }} />
                <strong>{bps(at[i + 1])}</strong><span className="muted">{s.label}</span>
              </div>
            ))}
            {requiredBps ? <div className="tip-row"><span className="tip-key dashed" /><strong>{bps(requiredBps)}</strong><span className="muted">Required</span></div> : null}
          </div>
        )}
      </div>
      <div className="flow-axis"><span>{spanS < 90 ? `${spanS} s ago` : `${Math.round(spanS / 60)} min ago`}</span><span>Now</span></div>
    </div>
  );
}

/** A line of a few numbers over time, with no axes: a tile's trend. */
export function Spark({ values, color = "var(--series-1)", height = 28 }: { values: number[]; color?: string; height?: number }) {
  if (values.length < 2) return <div className="spark" style={{ height }} />;
  const max = Math.max(1, ...values) * 1.1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(1)},${(height - (v / max) * height).toFixed(1)}`);
  return (
    <svg className="spark" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" style={{ height }} aria-hidden="true">
      <path d={`M0,${height} L${pts.join(" L")} L100,${height} Z`} fill={color} opacity="0.18" />
      <path d={`M${pts.join(" L")}`} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A headline number with its icon, what it means underneath, and room for a small visual. */
export function Stat({ icon, label, value, sub, tone, children }: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "good" | "warn" | "bad";
  children?: ReactNode;
}) {
  return (
    <div className={`stat${tone ? ` ${tone}` : ""}`}>
      <div className="stat-head"><span className="stat-icon">{icon}</span><span className="stat-label">{label}</span></div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
      {children}
    </div>
  );
}
