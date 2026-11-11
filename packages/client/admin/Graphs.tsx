import { useState } from "react";
import { api } from "./api";
import type { GraphDay, Graphs as GraphData } from "./types";
import { bytes, clock } from "./format";
import { useLoad } from "./parts";
import { Bars, byteUnit, ChartCard, COLORS, Columns, count, hours, SeriesTable, type Series } from "./charts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const PERIODS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "A year" },
  { days: 0, label: "All" },
];

interface Bucket extends GraphDay {
  /** On the axis: "10 Nov". */
  label: string;
  /** In the tooltip: "10 Nov 2026", "Week of 3 Nov 2026", "November 2026". */
  title: string;
}

const dayName = (ms: number) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const fullDay = (ms: number) => `${dayName(ms)} ${new Date(ms).getUTCFullYear()}`;

/** Days as they are, up to 120 of them; past that, weeks; past two years, months. */
function bucketed(daily: GraphDay[]): { by: "day" | "week" | "month"; rows: Bucket[] } {
  const by = daily.length <= 120 ? "day" : daily.length <= 730 ? "week" : "month";
  const groups = new Map<string, Bucket>();
  daily.forEach((d, i) => {
    const at = new Date(d.day);
    const key = by === "day" ? String(d.day) : by === "week" ? String(Math.floor(i / 7)) : `${at.getUTCFullYear()}-${at.getUTCMonth()}`;
    let b = groups.get(key);
    if (!b) {
      b = by === "day" ? { ...d, label: dayName(d.day), title: fullDay(d.day) }
        : by === "week" ? { ...d, label: dayName(d.day), title: `Week of ${fullDay(d.day)}` }
          : { ...d, label: `${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`, title: `${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}` };
      groups.set(key, b);
      return;
    }
    for (const k of Object.keys(d) as Array<keyof GraphDay>) {
      if (k === "day") continue;
      b[k] = k === "peakViewers" ? Math.max(b[k], d[k]) : b[k] + d[k];
    }
  });
  return { by, rows: [...groups.values()] };
}

const share = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);
const tipTitle = (r: Record<string, unknown>) => String(r.title);

/** What the history says, over a period: Tautulli's graphs, for the theater. */
export function Graphs({ onError }: { onError: (e: unknown) => void }) {
  const [days, setDays] = useState(30);
  const { data, busy } = useLoad(() => api.graphs(days), [days], onError);
  return (
    <>
      <div className="period" role="group" aria-label="Period">
        {PERIODS.map((p) => (
          <button key={p.days} className={`chip ${days === p.days ? "on" : ""}`} aria-pressed={days === p.days}
            onClick={() => setDays(p.days)}>{p.label}</button>
        ))}
        <span className="muted small">Days are UTC; a play counts on the day it started.</span>
      </div>
      {!data ? <p className="empty">{busy ? "Loading…" : "Couldn't read the history."}</p> : (
        <div className={busy ? "stale" : ""}>
          <GraphsBody g={data} />
        </div>
      )}
    </>
  );
}

function GraphsBody({ g }: { g: GraphData }) {
  const { by, rows } = bucketed(g.daily);
  const per = by === "day" ? "per day" : by === "week" ? "per week" : "per month";
  const t = g.totals;
  const unit = byteUnit(Math.max(0, ...rows.map((r) => r.botBytes + r.edgeHitBytes + r.p2pBytes)));
  const inUnit = (n: number) => `${n >= 100 ? Math.round(n) : n >= 10 ? n.toFixed(1) : n.toFixed(2)} ${unit.label}`;
  const unitAxis = (n: number) => `${count(n)} ${unit.label}`;
  const chartRows = rows.map((r) => ({
    ...r,
    watchedH: r.watchedS / 3600,
    bot: r.botBytes / unit.div,
    hit: r.edgeHitBytes / unit.div,
    p2p: r.p2pBytes / unit.div,
  }));
  const one = (key: string, label: string): Series[] => [{ key, label, color: COLORS[0] }];
  const data: Series[] = [
    { key: "bot", label: "From the bot", color: COLORS[0] },
    { key: "hit", label: "From Discord's cache", color: COLORS[1] },
    { key: "p2p", label: "From other viewers", color: COLORS[2] },
  ];
  const streams: Series[] = [
    { key: "copies", label: "Copied", color: COLORS[0] },
    { key: "reencodes", label: "Re-encoded", color: COLORS[1] },
  ];
  const asks: Series[] = [
    { key: "launches", label: "Launches", color: COLORS[0] },
    { key: "requests", label: "Requests", color: COLORS[1] },
  ];
  const hourRows = g.hours.map((h) => ({ ...h, label: String(h.hour).padStart(2, "0"),
    title: `${String(h.hour).padStart(2, "0")}:00–${String(h.hour).padStart(2, "0")}:59 UTC` }));
  const weekRows = [1, 2, 3, 4, 5, 6, 0].map((w) => ({ ...g.weekdays[w], label: WEEKDAYS[w].slice(0, 3), title: WEEKDAYS[w] }));
  const titleRows = g.titles.map((x) => ({ ...x, name: x.title ?? `Plex item ${x.ratingKey}` }));
  const peopleRows = g.people.map((x) => ({ ...x, name: x.username ?? x.userId }));
  const serverRows = g.servers.map((x) => ({ ...x, name: x.guildId ?? "No server" }));
  const table = (series: Series[], fmt: (n: number) => string, r: Array<Record<string, unknown>> = chartRows, label = by === "day" ? "Day" : by === "week" ? "Week of" : "Month") =>
    <SeriesTable rows={r} label={label} labelKey="label" series={series} fmt={fmt} />;

  return (
    <>
      <div className="tiles">
        <Tile label="Plays" value={count(t.plays)} sub={`${hours(t.playedS)} played`} />
        <Tile label="Time watched" value={hours(t.watchedS)} sub="by everybody, added up" />
        <Tile label="People" value={count(t.people)} sub={`${count(t.launches)} launches, ${count(t.requests)} requests`} />
        <Tile label="Data players got" value={bytes(t.httpBytes + t.p2pBytes)}
          sub={`${share(t.hitShare)} of what they fetched came from Discord's cache`} />
        <Tile label="Re-encoded" value={t.streams ? share(t.reencodes / t.streams) : "—"}
          sub={`${count(t.reencodes)} of ${count(t.streams)} streams`} />
        <Tile label="Buffering" value={`${count(t.stalls)} ${t.stalls === 1 ? "time" : "times"}`}
          sub={`${clock(t.stalledMs / 1000)} in all; ${count(t.errors)} player errors`} />
      </div>

      {t.plays === 0 && t.launches === 0 && t.requests === 0 && (
        <p className="note">Nothing was recorded in this period.</p>
      )}

      <div className="charts">
        <ChartCard title={`Plays ${per}`} series={one("plays", "Plays")} table={table(one("plays", "Plays"), count)}>
          <Columns rows={chartRows} x="label" series={one("plays", "Plays")} fmt={count} tipTitle={tipTitle} />
        </ChartCard>
        <ChartCard title={`Time watched ${per}`} sub="Each viewer's time, added up" series={one("watchedH", "Hours watched")}
          table={table(one("watchedS", "Time watched"), hours)}>
          <Columns rows={chartRows} x="label" series={one("watchedH", "Hours watched")} fmt={(n) => hours(n * 3600)}
            axisFmt={(n) => `${count(n)} h`} decimals tipTitle={tipTitle} />
        </ChartCard>
        <ChartCard title={`Data ${per}, and where it came from`} sub="What players say they got" series={data}
          table={table(data, inUnit)} wide>
          <Columns rows={chartRows} x="label" series={data} fmt={inUnit} axisFmt={unitAxis} decimals stacked tipTitle={tipTitle} height={240} />
        </ChartCard>
        <ChartCard title={`Streams ${per}`} sub="Copied from the file, or re-encoded" series={streams} table={table(streams, count)}>
          <Columns rows={chartRows} x="label" series={streams} fmt={count} stacked tipTitle={tipTitle} />
        </ChartCard>
        <ChartCard title="Why streams were re-encoded" series={one("streams", "Streams")}
          table={<SeriesTable rows={g.reasons} label="Why" labelKey="reason" series={one("streams", "Streams")} fmt={count} />}>
          {g.reasons.length === 0 ? <p className="muted">None was re-encoded.</p>
            : <Bars rows={g.reasons} nameKey="reason" valueKey="streams" label="Streams" fmt={count} />}
        </ChartCard>
        <ChartCard title={`Buffering ${per}`} sub="Times a viewer's picture stopped, waiting for data" series={one("stalls", "Times")}
          table={table([{ key: "stalls", label: "Times", color: COLORS[0] }], count)}>
          <Columns rows={chartRows} x="label" series={one("stalls", "Times")} fmt={count} tipTitle={tipTitle} />
        </ChartCard>
        <ChartCard title={`Launches and requests ${per}`} series={asks} table={table(asks, count)}>
          <Columns rows={chartRows} x="label" series={asks} fmt={count} tipTitle={tipTitle} />
        </ChartCard>
        <ChartCard title="Plays by hour" sub="Hour of the day, UTC" series={one("plays", "Plays")}
          table={table(one("plays", "Plays"), count, hourRows, "Hour (UTC)")}>
          <Columns rows={hourRows} x="label" series={one("plays", "Plays")} fmt={count} tipTitle={tipTitle} />
        </ChartCard>
        <ChartCard title="Plays by weekday" sub="UTC" series={one("plays", "Plays")}
          table={table(one("plays", "Plays"), count, weekRows, "Day")}>
          <Columns rows={weekRows} x="label" series={one("plays", "Plays")} fmt={count} tipTitle={tipTitle} />
        </ChartCard>
        <ChartCard title="Most watched titles" sub="By time watched" series={one("watchedS", "Time watched")}
          table={<TopTable rows={titleRows} cols={[["Plays", "plays", count], ["People", "people", count], ["Time watched", "watchedS", hours]]} />}>
          {titleRows.length === 0 ? <p className="muted">Nothing yet.</p>
            : <Bars rows={titleRows} nameKey="name" valueKey="watchedS" label="Time watched" fmt={hours} />}
        </ChartCard>
        <ChartCard title="Who watched most" sub="By time watched; pick one to open them" series={one("watchedS", "Time watched")}
          table={<TopTable rows={peopleRows} cols={[["Plays", "plays", count], ["Time watched", "watchedS", hours], ["Data", "bytes", bytes]]} />}>
          {peopleRows.length === 0 ? <p className="muted">Nobody yet.</p>
            : <Bars rows={peopleRows} nameKey="name" valueKey="watchedS" label="Time watched" fmt={hours}
              onPick={(r) => { location.hash = `people/${String(r.userId)}`; }} />}
        </ChartCard>
        <ChartCard title="Servers" sub="Discord servers by time watched in them" series={one("watchedS", "Time watched")}
          table={<TopTable rows={serverRows} cols={[["Plays", "plays", count], ["People", "people", count], ["Time watched", "watchedS", hours]]} />}>
          {serverRows.length === 0 ? <p className="muted">None yet.</p>
            : <Bars rows={serverRows} nameKey="name" valueKey="watchedS" label="Time watched" fmt={hours}
              onPick={() => { location.hash = "places"; }} />}
        </ChartCard>
      </div>
    </>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      <div className="tile-sub">{sub}</div>
    </div>
  );
}

function TopTable({ rows, cols }: {
  rows: Array<Record<string, unknown> & { name: string }>;
  cols: Array<[string, string, (n: number) => string]>;
}) {
  return (
    <table className="table">
      <thead><tr><th>Name</th>{cols.map(([l]) => <th key={l} className="num">{l}</th>)}</tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>{r.name}</td>
            {cols.map(([l, k, f]) => <td key={l} className="num nowrap">{f(Number(r[k]) || 0)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A small chart over the last 30 days, at the top of another page. */
export function MiniChart({ kind, onError }: { kind: "plays" | "people" | "data"; onError: (e: unknown) => void }) {
  const { data } = useLoad(() => api.graphs(30), [], onError);
  if (!data) return null;
  const more = <>The last 30 days, UTC · <a href="#graphs">More graphs</a></>;
  const rows = data.daily.map((d) => ({ ...d, label: dayName(d.day), title: fullDay(d.day) }));
  if (kind === "plays") {
    const s: Series[] = [{ key: "plays", label: "Plays", color: COLORS[0] }];
    return (
      <ChartCard title="Plays per day" sub={more} series={s} table={<SeriesTable rows={rows} label="Day" labelKey="label" series={s} fmt={count} />}>
        <Columns rows={rows} x="label" series={s} fmt={count} height={140} tipTitle={tipTitle} />
      </ChartCard>
    );
  }
  if (kind === "people") {
    const top = data.people.slice(0, 5).map((x) => ({ ...x, name: x.username ?? x.userId }));
    return (
      <ChartCard title="Who watched most" sub={more} series={[{ key: "watchedS", label: "Time watched", color: COLORS[0] }]}
        table={<TopTable rows={top} cols={[["Plays", "plays", count], ["Time watched", "watchedS", hours], ["Data", "bytes", bytes]]} />}>
        {top.length === 0 ? <p className="muted">Nobody watched anything.</p>
          : <Bars rows={top} nameKey="name" valueKey="watchedS" label="Time watched" fmt={hours}
            onPick={(r) => { location.hash = `people/${String(r.userId)}`; }} />}
      </ChartCard>
    );
  }
  const unit = byteUnit(Math.max(0, ...rows.map((r) => r.botBytes + r.edgeHitBytes + r.p2pBytes)));
  const inUnit = (n: number) => `${n >= 100 ? Math.round(n) : n >= 10 ? n.toFixed(1) : n.toFixed(2)} ${unit.label}`;
  const unitAxis = (n: number) => `${count(n)} ${unit.label}`;
  const s: Series[] = [
    { key: "bot", label: "From the bot", color: COLORS[0] },
    { key: "hit", label: "From Discord's cache", color: COLORS[1] },
    { key: "p2p", label: "From other viewers", color: COLORS[2] },
  ];
  const dataRows = rows.map((r) => ({ ...r, bot: r.botBytes / unit.div, hit: r.edgeHitBytes / unit.div, p2p: r.p2pBytes / unit.div }));
  return (
    <ChartCard title="Data per day, and where it came from" sub={more} series={s}
      table={<SeriesTable rows={dataRows} label="Day" labelKey="label" series={s} fmt={inUnit} />}>
      <Columns rows={dataRows} x="label" series={s} fmt={inUnit} axisFmt={unitAxis} decimals stacked height={170} tipTitle={tipTitle} />
    </ChartCard>
  );
}
