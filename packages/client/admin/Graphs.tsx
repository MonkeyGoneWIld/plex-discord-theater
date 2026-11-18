import { useState } from "react";
import { api, type GraphPeriod } from "./api";
import type { GraphDay, Graphs as GraphData } from "./types";
import { bytes, clock, dateTime, zoneLabel } from "./format";
import { useLoad } from "./parts";
import { usePlaceNames } from "./names";
import { ShareList } from "./viz";
import { clientName } from "./clients";
import { Bars, byteUnit, ChartCard, COLORS, Columns, count, hours, SeriesTable, type Series } from "./charts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const PERIODS: Array<{ label: string; p: GraphPeriod }> = [
  { label: "24 hours", p: { hours: 24 } },
  { label: "7 days", p: { days: 7 } },
  { label: "30 days", p: { days: 30 } },
  { label: "90 days", p: { days: 90 } },
  { label: "1 year", p: { days: 365 } },
  { label: "All time", p: { days: 0 } },
];
const samePeriod = (a: GraphPeriod, b: GraphPeriod) => JSON.stringify(a) === JSON.stringify(b);

interface Bucket extends GraphDay {
  /** On the axis: "10 Nov", "14:00". */
  label: string;
  /** In the tooltip: "10 Nov 2026", "Week of 3 Nov 2026", "November 2026", "10 Nov 2026, 14:00–14:59". */
  title: string;
}

const dayName = (ms: number) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const fullDay = (ms: number) => `${dayName(ms)} ${new Date(ms).getUTCFullYear()}`;
const hh = (ms: number) => String(new Date(ms).getUTCHours()).padStart(2, "0");

/** A period from one local midnight to another. */
const wholeDays = (from: number, to: number) =>
  [from, to].every((t) => { const d = new Date(t); return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0; });

/** Hours as they are; days up to 120 of them; past that, weeks; past two years, months. */
function bucketed(daily: GraphDay[], bucket: "day" | "hour"): { by: "hour" | "day" | "week" | "month"; rows: Bucket[] } {
  if (bucket === "hour") {
    return { by: "hour", rows: daily.map((d) => ({ ...d, label: hh(d.day) === "00" ? `${dayName(d.day)} 00:00` : `${hh(d.day)}:00`,
      title: `${fullDay(d.day)}, ${hh(d.day)}:00–${hh(d.day)}:59` })) };
  }
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
      b[k] = k === "peakViewers" || k === "peakKbps" ? Math.max(b[k], d[k]) : b[k] + d[k];
    }
  });
  return { by, rows: [...groups.values()] };
}

const share = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);
const tipTitle = (r: Record<string, unknown>) => String(r.title);

/** A rate as the dashboard and Plex say it, and as qBittorrent and its manager do. */
const mbps = (kbps: number | null) => (kbps === null ? "—" : `${(kbps / 1000).toFixed(kbps >= 100_000 ? 0 : 1)} Mbps`);
const mibs = (kbps: number | null) => (kbps === null ? "—" : `${((kbps * 1000) / 8 / 1_048_576).toFixed(2)} MiB/s`);

/** "2026-11-17T14:05", for a date-and-time field, on this browser's clock. */
const fieldTime = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** A period of one's own: the last so many hours or days, from one date to another, or from one time to another. */
function CustomPeriod({ onPick }: { onPick: (p: GraphPeriod) => void }) {
  const [mode, setMode] = useState<"last" | "dates" | "times">("last");
  const [n, setN] = useState("12");
  const [unit, setUnit] = useState<"hours" | "days">("hours");
  const [from, setFrom] = useState(() => fieldTime(Date.now() - 7 * 86_400_000));
  const [to, setTo] = useState(() => fieldTime(Date.now()));
  const [error, setError] = useState<string | null>(null);
  const apply = () => {
    if (mode === "last") {
      const k = Math.floor(Number(n));
      if (!(k > 0)) return setError("Enter a number greater than 0.");
      setError(null);
      return onPick(unit === "hours" ? { hours: k } : { days: k });
    }
    // A date's field is its day, from midnight; to the end of the last day.
    const start = new Date(mode === "dates" ? `${from.slice(0, 10)}T00:00` : from).getTime();
    let end = new Date(mode === "dates" ? `${to.slice(0, 10)}T00:00` : to).getTime();
    if (mode === "dates") end = new Date(new Date(end).setDate(new Date(end).getDate() + 1)).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return setError("Enter a start and an end.");
    if (end <= start) return setError("The end must be after the start.");
    setError(null);
    onPick({ from: start, to: end });
  };
  return (
    <form className="custom-period" onSubmit={(e) => { e.preventDefault(); apply(); }}>
      <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} aria-label="Kind of period">
        <option value="last">Last…</option>
        <option value="dates">Date range</option>
        <option value="times">Time range</option>
      </select>
      {mode === "last" ? (
        <>
          <input type="number" min={1} max={unit === "hours" ? 87_600 : 3_650} value={n} onChange={(e) => setN(e.target.value)}
            aria-label="How many" className="short" />
          <select value={unit} onChange={(e) => setUnit(e.target.value as typeof unit)} aria-label="Hours or days">
            <option value="hours">hours</option>
            <option value="days">days</option>
          </select>
        </>
      ) : (
        <>
          <label>From <input type={mode === "dates" ? "date" : "datetime-local"} value={mode === "dates" ? from.slice(0, 10) : from}
            onChange={(e) => setFrom(mode === "dates" ? `${e.target.value}T00:00` : e.target.value)} /></label>
          <label>To <input type={mode === "dates" ? "date" : "datetime-local"} value={mode === "dates" ? to.slice(0, 10) : to}
            onChange={(e) => setTo(mode === "dates" ? `${e.target.value}T00:00` : e.target.value)} /></label>
        </>
      )}
      <button type="submit">Show</button>
      {error && <span className="bad-text small">{error}</span>}
    </form>
  );
}

/** What the history says, over a period: Tautulli's graphs, for the theater. */
export function Graphs({ onError }: { onError: (e: unknown) => void }) {
  const [period, setPeriod] = useState<GraphPeriod>({ days: 30 });
  const [custom, setCustom] = useState(false);
  const key = JSON.stringify(period);
  const { data, busy } = useLoad(() => api.graphs(period), [key], onError);
  const preset = PERIODS.some((p) => samePeriod(p.p, period));
  return (
    <>
      <div className="page-head">
        <h1>Statistics</h1>
        <p className="muted">Usage over the selected period. Times are shown in your local time zone ({zoneLabel()}); sessions are counted on the day they started.</p>
      </div>
      <div className="period" role="group" aria-label="Period">
        {PERIODS.map((p) => (
          <button key={p.label} className={`chip ${!custom && samePeriod(p.p, period) ? "on" : ""}`} aria-pressed={!custom && samePeriod(p.p, period)}
            onClick={() => { setCustom(false); setPeriod(p.p); }}>{p.label}</button>
        ))}
        <button className={`chip ${custom || !preset ? "on" : ""}`} aria-pressed={custom || !preset} onClick={() => setCustom(!custom)}>Custom…</button>
      </div>
      {custom && <CustomPeriod onPick={(p) => setPeriod(p)} />}
      {data && (
        <p className="muted small period-shown">
          {/* Whole days, as "21 September to 1 October" was asked: the end day by its date. */}
          {wholeDays(data.from, data.to) ? dateTime(data.from).slice(0, 10) : dateTime(data.from)} to {data.to > Date.now() ? "now"
            : wholeDays(data.from, data.to) ? `the end of ${dateTime(data.to - 1).slice(0, 10)}` : dateTime(data.to)}
          {data.bucket === "hour" ? " · Hourly" : ""}
        </p>
      )}
      {!data ? <p className="empty">{busy ? "Loading…" : "The history could not be loaded."}</p> : (
        <div className={busy ? "stale" : ""}>
          <GraphsBody g={data} />
        </div>
      )}
    </>
  );
}

/**
 * What the bot's port sent: the upload the qBittorrent manager shares the
 * line with, as it measured it, minute by minute.
 */
function Upload({ g, rows, per, label }: { g: GraphData; rows: Bucket[]; per: string; label: string }) {
  const u = g.upload;
  const unit = byteUnit(Math.max(0, ...rows.map((r) => r.sentBytes)));
  const inUnit = (n: number) => `${n >= 100 ? Math.round(n) : n >= 10 ? n.toFixed(1) : n.toFixed(2)} ${unit.label}`;
  const sentRows = rows.map((r) => ({ ...r, sent: r.sentBytes / unit.div, peak: r.peakKbps / 1000 }));
  const sent: Series[] = [{ key: "sent", label: "Sent by the server", color: COLORS[0] }];
  const peak: Series[] = [{ key: "peak", label: "Busiest minute", color: COLORS[0] }];
  return (
    <section className="card upload-card">
      <div className="panel-head">
        <h3>Server upload</h3>
        <span className="muted small">
          {u.since === null ? "No upload data has been recorded yet."
            : `All data sent by the server, including video, playlists, subtitles and the Activity page, since ${dateTime(u.since)}.`}
        </span>
      </div>
      <div className="tiles">
        <Tile label="Sent by the server" value={bytes(u.sentBytes)} sub={`${count(u.allMinutes)} minutes with traffic`} />
        <Tile label="Average while playing" value={mbps(u.avgKbps)} sub={`${mibs(u.avgKbps)} · over ${count(u.minutes)} minutes`} />
        <Tile label="95th percentile" value={mbps(u.p95Kbps)} sub={`${mibs(u.p95Kbps)} · 95% of minutes at or below this rate`} />
        <Tile label="Busiest minute" value={mbps(u.peakKbps)} sub={`${mibs(u.peakKbps)}${u.peakAt ? ` · ${dateTime(u.peakAt)}` : ""}`} />
      </div>
      <h4>By number of viewers</h4>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr><th>Viewers</th><th className="num">Minutes</th><th className="num">Average</th><th className="num">95th pct.</th>
              <th className="num">Busiest</th><th className="num">Relative to bitrate</th></tr>
          </thead>
          <tbody>
            {u.byViewers.map((r) => (
              <tr key={r.viewers}>
                <td>{r.viewers === 4 ? "4 or more" : r.viewers}</td>
                <td className="num">{count(r.minutes)}</td>
                {[r.avgKbps, r.p95Kbps, r.peakKbps].map((k, i) => (
                  <td key={i} className="num nowrap">{mbps(k)}{k !== null && <div className="muted small">{mibs(k)}</div>}</td>
                ))}
                <td className="num nowrap">{r.perStream === null ? "—" : <>{r.perStream.toFixed(2)}×<div className="muted small">over {count(r.perStreamMinutes)} min</div></>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="charts">
        <ChartCard title={`Sent by the server ${per}`} series={sent}
          table={<SeriesTable rows={sentRows} label={label} labelKey="label" series={sent} fmt={inUnit} />}>
          <Columns rows={sentRows} x="label" series={sent} fmt={inUnit} axisFmt={(n) => `${count(n)} ${unit.label}`} decimals tipTitle={tipTitle} />
        </ChartCard>
        <ChartCard title={`Busiest minute ${per}`} sub="Peak one-minute upload rate" series={peak}
          table={<SeriesTable rows={sentRows} label={label} labelKey="label" series={peak} fmt={(n) => mbps(n * 1000)} />}>
          <Columns rows={sentRows} x="label" series={peak} fmt={(n) => mbps(n * 1000)} axisFmt={(n) => `${count(n)} Mbps`} decimals tipTitle={tipTitle} />
        </ChartCard>
      </div>
    </section>
  );
}

/** The three commonest transcode reasons get a colour each; the rest are "Other reasons". */
function reasonSeries(g: GraphData): { series: Series[]; daily: GraphDay[] } {
  const top = g.reasons.slice(0, 3).map((r) => r.reason);
  const key = (reason: string) => { const i = top.indexOf(reason); return i >= 0 ? `r${i}` : "rOther"; };
  const by = new Map<number, Record<string, number>>();
  for (const x of g.reasonDays ?? []) {
    const k = key(x.reason);
    const day = by.get(x.day) ?? {};
    day[k] = (day[k] ?? 0) + x.streams;
    by.set(x.day, day);
  }
  const other = (g.reasonDays ?? []).some((x) => key(x.reason) === "rOther");
  const keys = [...top.map((_, i) => `r${i}`), ...(other ? ["rOther"] : [])];
  const daily = g.daily.map((d) => ({ ...d, ...Object.fromEntries(keys.map((k) => [k, by.get(d.day)?.[k] ?? 0])) })) as GraphDay[];
  const series: Series[] = [...top.map((r, i) => ({ key: `r${i}`, label: r, color: COLORS[i] })),
    ...(other ? [{ key: "rOther", label: "Other reasons", color: "var(--muted)" }] : [])];
  return { series, daily };
}

function GraphsBody({ g }: { g: GraphData }) {
  const reasonsOver = reasonSeries(g);
  const { by, rows } = bucketed(reasonsOver.daily, g.bucket);
  const per = by === "hour" ? "per hour" : by === "day" ? "per day" : by === "week" ? "per week" : "per month";
  const names = usePlaceNames();
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
    { key: "bot", label: "Server", color: COLORS[0] },
    { key: "hit", label: "Discord cache", color: COLORS[1] },
    { key: "p2p", label: "Peers", color: COLORS[2] },
  ];
  const streams: Series[] = [
    { key: "copies", label: "Direct", color: COLORS[0] },
    { key: "reencodes", label: "Transcoded", color: COLORS[1] },
  ];
  const asks: Series[] = [
    { key: "launches", label: "Launches", color: COLORS[0] },
    { key: "requests", label: "Requests", color: COLORS[1] },
  ];
  const hourRows = g.hours.map((h) => ({ ...h, label: String(h.hour).padStart(2, "0"),
    title: `${String(h.hour).padStart(2, "0")}:00–${String(h.hour).padStart(2, "0")}:59` }));
  const weekRows = [1, 2, 3, 4, 5, 6, 0].map((w) => ({ ...g.weekdays[w], label: WEEKDAYS[w].slice(0, 3), title: WEEKDAYS[w] }));
  const titleRows = g.titles.map((x) => ({ ...x, name: x.title ?? `Plex item ${x.ratingKey}` }));
  const peopleRows = g.people.map((x) => ({ ...x, name: x.username ?? x.userId }));
  const sharerRows = (g.sharers ?? []).map((x) => ({ ...x, name: x.username ?? x.userId }));
  const pairRows = (g.pairs ?? []).map((x) => ({ ...x, name: `${x.fromName ?? x.from} → ${x.toName ?? x.to}` }));
  const serverRows = g.servers.map((x) => ({ ...x, name: names.guild(x.guildId) ?? x.guildId ?? "Direct message" }));
  const rowLabel = by === "hour" ? "Hour" : by === "day" ? "Day" : by === "week" ? "Week of" : "Month";
  const table = (series: Series[], fmt: (n: number) => string, r: Array<Record<string, unknown>> = chartRows, label = rowLabel) =>
    <SeriesTable rows={r} label={label} labelKey="label" series={series} fmt={fmt} />;

  return (
    <>
      <div className="tiles">
        <Tile label="Sessions" value={count(t.plays)} sub={`${hours(t.playedS)} of playback`} />
        <Tile label="Watch time" value={hours(t.watchedS)} sub="Combined across all viewers" />
        <Tile label="Users" value={count(t.people)} sub={`${count(t.launches)} launches · ${count(t.requests)} requests`} />
        <Tile label="Data delivered" value={bytes(t.httpBytes + t.p2pBytes)}
          sub={`${share(t.hitShare)} of HTTP traffic served by Discord's cache`} />
        <Tile label="Transcoded streams" value={t.streams ? share(t.reencodes / t.streams) : "—"}
          sub={`${count(t.reencodes)} of ${count(t.streams)} streams`} />
        <Tile label="Buffering" value={`${count(t.stalls)} ${t.stalls === 1 ? "event" : "events"}`}
          sub={`${clock(t.stalledMs / 1000)} in total · ${count(t.errors)} player errors`} />
      </div>

      {t.plays === 0 && t.launches === 0 && t.requests === 0 && (
        <p className="note">No activity was recorded in this period.</p>
      )}

      <Upload g={g} rows={rows} per={per} label={rowLabel} />

      <div className="charts">
        <ChartCard title={`Sessions ${per}`} series={one("plays", "Sessions")} table={table(one("plays", "Sessions"), count)}>
          <Columns rows={chartRows} x="label" series={one("plays", "Sessions")} fmt={count} tipTitle={tipTitle} />
        </ChartCard>
        <ChartCard title={`Watch time ${per}`} sub="Combined across all viewers" series={one("watchedH", "Hours watched")}
          table={table(one("watchedS", "Watch time"), hours)}>
          <Columns rows={chartRows} x="label" series={one("watchedH", "Hours watched")} fmt={(n) => hours(n * 3600)}
            axisFmt={(n) => `${count(n)} h`} decimals tipTitle={tipTitle} />
        </ChartCard>
        <ChartCard title={`Data delivered ${per}, by source`} series={data}
          table={table(data, inUnit)} wide>
          <Columns rows={chartRows} x="label" series={data} fmt={inUnit} axisFmt={unitAxis} decimals stacked tipTitle={tipTitle} height={240} />
        </ChartCard>
        <ChartCard title={`Streams ${per}`} sub="Sent unchanged (direct) or transcoded" series={streams} table={table(streams, count)}>
          <Columns rows={chartRows} x="label" series={streams} fmt={count} stacked tipTitle={tipTitle} />
        </ChartCard>
        {reasonsOver.series.length > 0 && (
          <ChartCard title={`Transcode reasons ${per}`} sub="Streams transcoded, by why" series={reasonsOver.series}
            table={table(reasonsOver.series, count)}>
            <Columns rows={chartRows} x="label" series={reasonsOver.series} fmt={count} stacked tipTitle={tipTitle} />
          </ChartCard>
        )}
        <ChartCard title="Transcode reasons" series={one("streams", "Streams")}
          table={<SeriesTable rows={g.reasons} label="Reason" labelKey="reason" series={one("streams", "Streams")} fmt={count} />}>
          {g.reasons.length === 0 ? <p className="muted">No stream was transcoded in this period.</p>
            : <Bars rows={g.reasons} nameKey="reason" valueKey="streams" label="Streams" fmt={count} />}
        </ChartCard>
        <ChartCard title={`Buffering ${per}`} sub="Playback interruptions while waiting for data" series={one("stalls", "Events")}
          table={table([{ key: "stalls", label: "Events", color: COLORS[0] }], count)}>
          <Columns rows={chartRows} x="label" series={one("stalls", "Events")} fmt={count} tipTitle={tipTitle} />
        </ChartCard>
        <ChartCard title={`Launches and requests ${per}`} series={asks} table={table(asks, count)}>
          <Columns rows={chartRows} x="label" series={asks} fmt={count} tipTitle={tipTitle} />
        </ChartCard>
        <ChartCard title="Sessions by hour" sub="Hour of the day, local time" series={one("plays", "Sessions")}
          table={table(one("plays", "Sessions"), count, hourRows, "Hour")}>
          <Columns rows={hourRows} x="label" series={one("plays", "Sessions")} fmt={count} tipTitle={tipTitle} />
        </ChartCard>
        <ChartCard title="Sessions by weekday" sub="Local time" series={one("plays", "Sessions")}
          table={table(one("plays", "Sessions"), count, weekRows, "Day")}>
          <Columns rows={weekRows} x="label" series={one("plays", "Sessions")} fmt={count} tipTitle={tipTitle} />
        </ChartCard>
        {(g.heat?.length ?? 0) > 0 && (
          <ChartCard title="Sessions by weekday and hour" sub="Local time; darker is busier" wide
            table={<TopTable rows={(g.heat ?? []).map((c) => ({ ...c, name: `${WEEKDAYS[c.weekday]}, ${String(c.hour).padStart(2, "0")}:00` }))}
              cols={[["Sessions", "plays", count], ["Playback", "playedS", hours]]} />}>
            <Heatmap cells={g.heat ?? []} />
          </ChartCard>
        )}
        <ChartCard title="Most watched titles" sub="By combined watch time" series={one("watchedS", "Watch time")}
          table={<TopTable rows={titleRows} cols={[["Sessions", "plays", count], ["Users", "people", count], ["Watch time", "watchedS", hours]]} />}>
          {titleRows.length === 0 ? <p className="muted">No data for this period.</p>
            : <Bars rows={titleRows} nameKey="name" valueKey="watchedS" label="Watch time" fmt={hours} />}
        </ChartCard>
        <ChartCard title="Most active users" sub="By watch time" series={one("watchedS", "Watch time")}
          table={<TopTable rows={peopleRows} cols={[["Sessions", "plays", count], ["Watch time", "watchedS", hours], ["Data received", "bytes", bytes],
            ["Sent to viewers", "upBytes", bytes]]} />}>
          {peopleRows.length === 0 ? <p className="muted">No data for this period.</p>
            : <Bars rows={peopleRows} nameKey="name" valueKey="watchedS" label="Watch time" fmt={hours}
              onPick={(r) => { location.hash = `people/${String(r.userId)}`; }} />}
        </ChartCard>
        <ChartCard title="Top peer-to-peer sharers" sub="By data sent to other viewers" series={[{ key: "upBytes", label: "Sent to viewers", color: COLORS[2] }]}
          table={<TopTable rows={sharerRows} cols={[["Sessions", "plays", count], ["Sent to viewers", "upBytes", bytes], ["Received from viewers", "p2pBytes", bytes]]} />}>
          {sharerRows.length === 0 ? <p className="muted">No data was shared between viewers in this period.</p>
            : <Bars rows={sharerRows} nameKey="name" valueKey="upBytes" label="Sent to viewers" fmt={bytes} color={COLORS[2]}
              onPick={(r) => { location.hash = `people/${String(r.userId)}`; }} />}
        </ChartCard>
        <ChartCard title="Peer-to-peer transfers" sub="Data sent from one viewer to another" series={one("bytes", "Sent")}
          table={<TopTable rows={pairRows} cols={[["Sent", "bytes", bytes]]} />}>
          <ShareList shares={g.pairs ?? []} empty="No data was shared between viewers in this period." />
        </ChartCard>
        <ByClient rows={g.clients ?? []} />
        <ProblemFiles rows={g.problems ?? []} />
        <ChartCard title="Most active servers" sub="Discord servers by combined watch time" series={one("watchedS", "Watch time")}
          table={<TopTable rows={serverRows} cols={[["Sessions", "plays", count], ["Users", "people", count], ["Watch time", "watchedS", hours]]} />}>
          {serverRows.length === 0 ? <p className="muted">No data for this period.</p>
            : <Bars rows={serverRows} nameKey="name" valueKey="watchedS" label="Watch time" fmt={hours}
              onPick={() => { location.hash = "places"; }} />}
        </ChartCard>
      </div>
    </>
  );
}

/** Sessions by weekday (Monday first) and hour: a cell each, shaded by how many. */
function Heatmap({ cells }: { cells: NonNullable<GraphData["heat"]> }) {
  const max = Math.max(1, ...cells.map((c) => c.plays));
  const at = new Map(cells.map((c) => [`${c.weekday}:${c.hour}`, c] as const));
  return (
    <div className="heatmap" role="img" aria-label="Sessions by weekday and hour">
      <div className="heat-grid">
        <span />
        {Array.from({ length: 24 }, (_, h) => <span key={h} className="heat-hour">{h % 3 === 0 ? String(h).padStart(2, "0") : ""}</span>)}
        {[1, 2, 3, 4, 5, 6, 0].map((w) => (
          <FragmentRow key={w}>
            <span className="heat-day">{WEEKDAYS[w].slice(0, 3)}</span>
            {Array.from({ length: 24 }, (_, h) => {
              const c = at.get(`${w}:${h}`);
              const share = c ? c.plays / max : 0;
              return (
                <span key={h} className={`heat-cell${c ? "" : " none"}`}
                  style={c ? { background: `color-mix(in oklab, var(--series-1) ${Math.round(20 + share * 80)}%, var(--surface-2))` } : undefined}
                  title={`${WEEKDAYS[w]}, ${String(h).padStart(2, "0")}:00–${String(h).padStart(2, "0")}:59 · ${c ? `${count(c.plays)} ${c.plays === 1 ? "session" : "sessions"}, ${hours(c.playedS)}` : "no sessions"}`} />
              );
            })}
          </FragmentRow>
        ))}
      </div>
      <div className="heat-key"><span>Fewer</span><span className="heat-ramp" /><span>More ({count(max)})</span></div>
    </div>
  );
}

function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

/** Buffering and the streams that had to be transcoded, by the client each viewer finished their session on. */
function ByClient({ rows }: { rows: NonNullable<GraphData["clients"]> }) {
  // Clients by name: one Discord app on two versions is one row.
  const by = new Map<string, { name: string; sessions: number; watchedS: number; stalls: number; stalledMs: number; ownStreams: number; transcoded: number }>();
  for (const r of rows) {
    const name = r.device ? clientName(r.device) : "Not recorded";
    const t = by.get(name) ?? { name, sessions: 0, watchedS: 0, stalls: 0, stalledMs: 0, ownStreams: 0, transcoded: 0 };
    t.sessions += r.sessions;
    t.watchedS += r.watchedS;
    t.stalls += r.stalls;
    t.stalledMs += r.stalledMs;
    t.ownStreams += r.ownStreams;
    t.transcoded += r.transcoded;
    by.set(name, t);
  }
  const list = [...by.values()].sort((a, b) => b.sessions - a.sessions);
  return (
    <section className="card chart-card wide">
      <header className="chart-head">
        <div>
          <h3>Buffering and transcodes by client</h3>
          <p className="muted small chart-sub">Each viewer's session, by the client they finished it on. Own streams are those made for one viewer's player.</p>
        </div>
      </header>
      {list.length === 0 ? <p className="muted">No data for this period.</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Client</th><th className="num">Sessions</th><th className="num">Watch time</th><th className="num">Buffering</th>
              <th className="num">Per hour watched</th><th className="num">Own streams</th><th className="num">Transcoded</th></tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.name}>
                  <td>{r.name}</td>
                  <td className="num">{count(r.sessions)}</td>
                  <td className="num nowrap">{hours(r.watchedS)}</td>
                  <td className="num nowrap">{r.stalls ? `${count(r.stalls)} · ${clock(r.stalledMs / 1000)}` : "None"}</td>
                  <td className="num">{r.watchedS > 0 ? (r.stalls / (r.watchedS / 3600)).toFixed(1) : "—"}</td>
                  <td className="num">{count(r.ownStreams)}</td>
                  <td className={`num${r.transcoded ? " warn-text" : ""}`}>{r.ownStreams ? `${count(r.transcoded)} (${Math.round((r.transcoded / r.ownStreams) * 100)}%)` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Titles whose streams needed a workaround in this period, the latest first. */
function ProblemFiles({ rows }: { rows: NonNullable<GraphData["problems"]> }) {
  const n = (v: number) => (v ? count(v) : "—");
  return (
    <section className="card chart-card wide">
      <header className="chart-head">
        <div>
          <h3>Titles that needed a workaround</h3>
          <p className="muted small chart-sub">Sound that stops before the picture (filled with silence), a stream that ends before the length Plex reports,
            subtitles burned into the picture, and HDR tone-mapped to SDR. Counted by stream or session.</p>
        </div>
      </header>
      {rows.length === 0 ? <p className="muted">No title needed a workaround in this period.</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Title</th><th className="num">Short sound</th><th className="num">Ended early</th><th className="num">Subtitles burned in</th>
              <th className="num">Tone-mapped</th><th className="num">Sessions</th><th>Last</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ratingKey}>
                  <td>{r.title ?? `Plex item ${r.ratingKey}`} <span className="mono muted small">{r.ratingKey}</span></td>
                  <td className="num">{n(r.shortSound)}</td>
                  <td className="num">{n(r.earlyEnd)}</td>
                  <td className="num">{n(r.burned)}</td>
                  <td className="num">{n(r.toneMapped)}</td>
                  <td className="num">{count(r.sessions)}</td>
                  <td className="nowrap">{r.lastPlayId ? <a href={`#history/${r.lastPlayId}`}>{dateTime(r.lastAt)}</a> : dateTime(r.lastAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
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
  const { data } = useLoad(() => api.graphs({ days: 30 }), [], onError);
  if (!data) return null;
  const more = <>Last 30 days · <a href="#graphs">All statistics</a></>;
  const rows = data.daily.map((d) => ({ ...d, label: dayName(d.day), title: fullDay(d.day) }));
  if (kind === "plays") {
    const s: Series[] = [{ key: "plays", label: "Sessions", color: COLORS[0] }];
    return (
      <ChartCard title="Sessions per day" sub={more} series={s} table={<SeriesTable rows={rows} label="Day" labelKey="label" series={s} fmt={count} />}>
        <Columns rows={rows} x="label" series={s} fmt={count} height={140} tipTitle={tipTitle} />
      </ChartCard>
    );
  }
  if (kind === "people") {
    const top = data.people.slice(0, 5).map((x) => ({ ...x, name: x.username ?? x.userId }));
    return (
      <ChartCard title="Most active users" sub={more} series={[{ key: "watchedS", label: "Watch time", color: COLORS[0] }]}
        table={<TopTable rows={top} cols={[["Sessions", "plays", count], ["Watch time", "watchedS", hours], ["Data received", "bytes", bytes]]} />}>
        {top.length === 0 ? <p className="muted">No watch time has been recorded.</p>
          : <Bars rows={top} nameKey="name" valueKey="watchedS" label="Watch time" fmt={hours}
            onPick={(r) => { location.hash = `people/${String(r.userId)}`; }} />}
      </ChartCard>
    );
  }
  const unit = byteUnit(Math.max(0, ...rows.map((r) => r.botBytes + r.edgeHitBytes + r.p2pBytes)));
  const inUnit = (n: number) => `${n >= 100 ? Math.round(n) : n >= 10 ? n.toFixed(1) : n.toFixed(2)} ${unit.label}`;
  const unitAxis = (n: number) => `${count(n)} ${unit.label}`;
  const s: Series[] = [
    { key: "bot", label: "Server", color: COLORS[0] },
    { key: "hit", label: "Discord cache", color: COLORS[1] },
    { key: "p2p", label: "Peers", color: COLORS[2] },
  ];
  const dataRows = rows.map((r) => ({ ...r, bot: r.botBytes / unit.div, hit: r.edgeHitBytes / unit.div, p2p: r.p2pBytes / unit.div }));
  return (
    <ChartCard title="Data delivered per day, by source" sub={more} series={s}
      table={<SeriesTable rows={dataRows} label="Day" labelKey="label" series={s} fmt={inUnit} />}>
      <Columns rows={dataRows} x="label" series={s} fmt={inUnit} axisFmt={unitAxis} decimals stacked height={170} tipTitle={tipTitle} />
    </ChartCard>
  );
}
