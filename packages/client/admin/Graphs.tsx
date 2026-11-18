import { useState } from "react";
import { api, type GraphPeriod } from "./api";
import type { GraphDay, Graphs as GraphData, PersonPlay, SystemLoad } from "./types";
import { bytes, clock, dayDate, dayTime, duration, hourLabel, zoneLabel } from "./format";
import { reasonText, SectionNav, useLoad } from "./parts";
import { PROCESSING_HELP, PROCESSING_NAMES, PROCESSING_ORDER } from "./processing";
import { usePlaceNames } from "./names";
import { ShareList } from "./viz";
import { clientName } from "./clients";
import { Bars, byteUnit, ChartCard, COLORS, Columns, count, hours, Lines, SeriesTable, type Series } from "./charts";

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
  /** On the axis: "10 Nov", "2 PM". */
  label: string;
  /** In the tooltip: "10 Nov 2026", "Week of 3 Nov 2026", "November 2026", "10 Nov 2026, 2:00–2:59 PM". */
  title: string;
}

const dayName = (ms: number) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const fullDay = (ms: number) => `${dayName(ms)} ${new Date(ms).getUTCFullYear()}`;
/** The hour a bucket starts at, on the clock of the time zone it was counted in. */
const hourOf = (ms: number) => new Date(ms).getUTCHours();
/** "2:00–2:59 PM". */
const hourSpan = (h: number) => { const [n, half] = hourLabel(h).split(" "); return `${n}:00–${n}:59 ${half}`; };

/** A period from one local midnight to another. */
const wholeDays = (from: number, to: number) =>
  [from, to].every((t) => { const d = new Date(t); return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0; });

/** Hours as they are; days up to 120 of them; past that, weeks; past two years, months. */
function bucketed(daily: GraphDay[], bucket: "day" | "hour"): { by: "hour" | "day" | "week" | "month"; rows: Bucket[] } {
  if (bucket === "hour") {
    return { by: "hour", rows: daily.map((d) => ({ ...d, label: hourOf(d.day) === 0 ? dayName(d.day) : hourLabel(hourOf(d.day)),
      title: `${fullDay(d.day)}, ${hourSpan(hourOf(d.day))}` })) };
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
          {wholeDays(data.from, data.to) ? dayDate(data.from) : dayTime(data.from)} – {data.to > Date.now() ? "now"
            : wholeDays(data.from, data.to) ? `end of ${dayDate(data.to - 1)}` : dayTime(data.to)}
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
            : `All data sent by the server, including video, playlists, subtitles and the Activity page, since ${dayTime(u.since)}.`}
        </span>
      </div>
      <div className="tiles four">
        <Tile label="Sent by the server" value={bytes(u.sentBytes)} sub={`${count(u.allMinutes)} minutes with traffic`} />
        <Tile label="Average while playing" value={mbps(u.avgKbps)} sub={`${mibs(u.avgKbps)} · over ${count(u.minutes)} minutes`} />
        <Tile label="95th percentile" value={mbps(u.p95Kbps)} sub={`${mibs(u.p95Kbps)} · 95% of minutes at or below this rate`} />
        <Tile label="Busiest minute" value={mbps(u.peakKbps)} sub={`${mibs(u.peakKbps)}${u.peakAt ? ` · ${dayTime(u.peakAt)}` : ""}`} />
      </div>
      <h4>By number of viewers</h4>
      <div className="table-wrap">
        <table className="table wrap-heads">
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
  const series: Series[] = [...top.map((r, i) => ({ key: `r${i}`, label: reasonText(r), color: COLORS[i] })),
    ...(other ? [{ key: "rOther", label: "Other reasons", color: "var(--muted)" }] : [])];
  return { series, daily };
}

/** The three Discord servers with the most watch time get a colour each; the rest are "Other servers". */
function serverSeries(g: GraphData, guild: (id: string | null) => string): { series: Series[]; extra: Map<number, Record<string, number>> } {
  const total = new Map<string, number>();
  for (const x of g.serverDays ?? []) total.set(String(x.guildId), (total.get(String(x.guildId)) ?? 0) + x.watchedS);
  const top = [...total].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
  const extra = new Map<number, Record<string, number>>();
  let other = false;
  for (const x of g.serverDays ?? []) {
    const i = top.indexOf(String(x.guildId));
    const k = i >= 0 ? `sv${i}` : "svOther";
    if (i < 0) other = true;
    const day = extra.get(x.day) ?? {};
    day[k] = (day[k] ?? 0) + x.watchedS / 3600;
    extra.set(x.day, day);
  }
  const series: Series[] = [...top.map((id, i) => ({ key: `sv${i}`, label: guild(id === "null" ? null : id), color: COLORS[i] })),
    ...(other ? [{ key: "svOther", label: "Other servers", color: "var(--muted)" }] : [])];
  return { series, extra };
}

const REQUEST_SERIES: Series[] = [
  { key: "rqNew", label: "Requested", color: COLORS[0] },
  { key: "rqDup", label: "Already requested", color: COLORS[1] },
  { key: "rqFail", label: "Failed", color: "var(--bad)" },
];
const requestKey = (outcome: string) => (outcome === "requested" ? "rqNew" : outcome === "already requested" ? "rqDup" : "rqFail");

/**
 * Every bucket's extra numbers: the watch time by server, the requests by
 * result, and the time to the first segment (as a sum and a count, so a week
 * or a month of days can be averaged).
 */
function withExtras(g: GraphData, daily: GraphDay[], servers: Map<number, Record<string, number>>): GraphDay[] {
  const by = new Map<number, Record<string, number>>();
  const at = (day: number) => by.get(day) ?? by.set(day, {}).get(day)!;
  for (const x of g.requestDays ?? []) { const d = at(x.day); d[requestKey(x.outcome)] = (d[requestKey(x.outcome)] ?? 0) + x.requests; }
  for (const x of g.processingDays ?? []) {
    const d = at(x.day);
    const k = x.way === "transcode" ? "fsEnc" : "fsCopy";
    d[`${k}Sum`] = (d[`${k}Sum`] ?? 0) + x.p50Ms * x.count;
    d[`${k}N`] = (d[`${k}N`] ?? 0) + x.count;
  }
  const keys = ["rqNew", "rqDup", "rqFail", "fsEncSum", "fsEncN", "fsCopySum", "fsCopyN", "sv0", "sv1", "sv2", "svOther"];
  return daily.map((d) => {
    const x = { ...by.get(d.day), ...servers.get(d.day) };
    return { ...d, ...Object.fromEntries(keys.map((k) => [k, x[k] ?? 0])) };
  }) as GraphDay[];
}

function GraphsBody({ g }: { g: GraphData }) {
  const names = usePlaceNames();
  const guild = (id: string | null) => names.guild(id) ?? id ?? "Direct message";
  const reasonsOver = reasonSeries(g);
  const servers = serverSeries(g, guild);
  const { by, rows } = bucketed(withExtras(g, reasonsOver.daily, servers.extra), g.bucket);
  const per = by === "hour" ? "per hour" : by === "day" ? "per day" : by === "week" ? "per week" : "per month";
  const t = g.totals;
  const unit = byteUnit(Math.max(0, ...rows.map((r) => r.botBytes + r.edgeHitBytes + r.p2pBytes)));
  const inUnit = (n: number) => `${n >= 100 ? Math.round(n) : n >= 10 ? n.toFixed(1) : n.toFixed(2)} ${unit.label}`;
  const unitAxis = (n: number) => `${count(n)} ${unit.label}`;
  const chartRows = rows.map((r) => {
    const x = r as unknown as Record<string, number>;
    return {
      ...r,
      watchedH: r.watchedS / 3600,
      bot: r.botBytes / unit.div,
      hit: r.edgeHitBytes / unit.div,
      p2p: r.p2pBytes / unit.div,
      fsCopy: x.fsCopyN ? x.fsCopySum / x.fsCopyN : null,
      fsEnc: x.fsEncN ? x.fsEncSum / x.fsEncN : null,
    };
  });
  const one = (key: string, label: string): Series[] => [{ key, label, color: COLORS[0] }];
  const data: Series[] = [
    { key: "bot", label: "Server", color: COLORS[0] },
    { key: "hit", label: "Discord cache", color: COLORS[1] },
    { key: "p2p", label: "Peers", color: COLORS[2] },
  ];
  const streams: Series[] = [
    { key: "copies", label: "Direct play / direct stream", color: COLORS[0] },
    { key: "reencodes", label: "Transcode", color: COLORS[1] },
  ];
  const firstSeg: Series[] = [
    { key: "fsCopy", label: "Remux", color: COLORS[0] },
    { key: "fsEnc", label: "Transcode", color: COLORS[1] },
  ];
  const hourRows = g.hours.map((h) => ({ ...h, label: hourLabel(h.hour), title: hourSpan(h.hour) }));
  const weekRows = [1, 2, 3, 4, 5, 6, 0].map((w) => ({ ...g.weekdays[w], label: WEEKDAYS[w].slice(0, 3), title: WEEKDAYS[w] }));
  const titleRows = g.titles.map((x) => ({ ...x, name: x.title ?? `Plex item ${x.ratingKey}` }));
  const peopleRows = g.people.map((x) => ({ ...x, name: x.username ?? x.userId }));
  const sharerRows = (g.sharers ?? []).map((x) => ({ ...x, name: x.username ?? x.userId }));
  const pairRows = (g.pairs ?? []).map((x) => ({ ...x, name: `${x.fromName ?? x.from} → ${x.toName ?? x.to}` }));
  const serverRows = g.servers.map((x) => ({ ...x, name: guild(x.guildId) }));
  const reasonRows = g.reasons.map((x) => ({ ...x, reason: reasonText(x.reason) }));
  const rowLabel = by === "hour" ? "Hour" : by === "day" ? "Day" : by === "week" ? "Week of" : "Month";
  const table = (series: Series[], fmt: (n: number) => string, r: Array<Record<string, unknown>> = chartRows, label = rowLabel) =>
    <SeriesTable rows={r} label={label} labelKey="label" series={series} fmt={fmt} />;
  const anyRequests = (g.requestDays?.length ?? 0) > 0;
  const anyFirst = (g.processingDays?.length ?? 0) > 0;

  return (
    <>
      <div className="tiles six">
        <Tile label="Sessions" value={count(t.plays)} sub={`${hours(t.playedS)} of playback`} />
        <Tile label="Watch time" value={hours(t.watchedS)} sub="Combined across all viewers" />
        <Tile label="Users" value={count(t.people)} sub={`${count(t.launches)} launches · ${count(t.requests)} requests`} />
        <Tile label="Data delivered" value={bytes(t.httpBytes + t.p2pBytes)}
          sub={`${share(t.hitShare)} of HTTP traffic served by Discord's cache`} />
        <Tile label="Transcoded streams" value={t.streams ? share(t.reencodes / t.streams) : "—"}
          sub={`${count(t.reencodes)} of ${count(t.streams)} streams`} />
        <Tile label="Buffering" value={`${count(t.stalls)} ${t.stalls === 1 ? "event" : "events"}`}
          sub={`${duration(t.stalledMs)} in total · ${count(t.errors)} player ${t.errors === 1 ? "error" : "errors"}`} />
      </div>

      {t.plays === 0 && t.launches === 0 && t.requests === 0 && (
        <p className="note">No activity was recorded in this period.</p>
      )}

      <SectionNav sections={[["usage", "Usage"], ["audience", "Users, titles and servers"], ["delivery", "Data delivery"],
        ["streams", "Streams and processing"], ["quality", "Playback quality"], ["requests", "Launches and requests"]]} />

      <StatsGroup id="usage" title="Usage" help="Sessions and watch time over the period, and when sessions take place.">
        <div className="charts">
          <ChartCard title={`Sessions ${per}`} series={one("plays", "Sessions")} table={table(one("plays", "Sessions"), count)}>
            <Columns rows={chartRows} x="label" series={one("plays", "Sessions")} fmt={count} tipTitle={tipTitle} />
          </ChartCard>
          <ChartCard title={`Watch time ${per}`} sub="Combined across all viewers" series={one("watchedH", "Hours watched")}
            table={table(one("watchedS", "Watch time"), hours)}>
            <Columns rows={chartRows} x="label" series={one("watchedH", "Hours watched")} fmt={(n) => hours(n * 3600)}
              axisFmt={(n) => `${count(n)} h`} decimals tipTitle={tipTitle} />
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
            <ChartCard title="Sessions by weekday and hour" sub="Local time; darker cells had more sessions" wide
              table={<TopTable rows={(g.heat ?? []).map((c) => ({ ...c, name: `${WEEKDAYS[c.weekday]}, ${hourSpan(c.hour)}` }))}
                cols={[["Sessions", "plays", count], ["Playback", "playedS", hours]]} />}>
              <Heatmap cells={g.heat ?? []} />
            </ChartCard>
          )}
        </div>
      </StatsGroup>

      <StatsGroup id="audience" title="Users, titles and servers" help="Watch time by user, title and Discord server.">
        <div className="charts">
          <ChartCard title="Most active users" sub="By watch time" series={one("watchedS", "Watch time")}
            table={<TopTable rows={peopleRows} cols={[["Sessions", "plays", count], ["Watch time", "watchedS", hours], ["Data received", "bytes", bytes],
              ["Sent to peers", "upBytes", bytes]]} />}>
            {peopleRows.length === 0 ? <p className="muted">No data for this period.</p>
              : <Bars rows={peopleRows} nameKey="name" valueKey="watchedS" label="Watch time" fmt={hours}
                onPick={(r) => { location.hash = `people/${String(r.userId)}`; }} />}
          </ChartCard>
          <ChartCard title="Most watched titles" sub="By combined watch time" series={one("watchedS", "Watch time")}
            table={<TopTable rows={titleRows} cols={[["Sessions", "plays", count], ["Users", "people", count], ["Watch time", "watchedS", hours]]} />}>
            {titleRows.length === 0 ? <p className="muted">No data for this period.</p>
              : <Bars rows={titleRows} nameKey="name" valueKey="watchedS" label="Watch time" fmt={hours} />}
          </ChartCard>
          <ChartCard title="Most active servers" sub="Discord servers by combined watch time" series={one("watchedS", "Watch time")}
            table={<TopTable rows={serverRows} cols={[["Sessions", "plays", count], ["Users", "people", count], ["Watch time", "watchedS", hours]]} />}>
            {serverRows.length === 0 ? <p className="muted">No data for this period.</p>
              : <Bars rows={serverRows} nameKey="name" valueKey="watchedS" label="Watch time" fmt={hours}
                onPick={() => { location.hash = "places"; }} />}
          </ChartCard>
          {servers.series.length > 0 && (
            <ChartCard title={`Watch time ${per}, by server`} sub="Combined across all viewers" series={servers.series}
              table={table(servers.series, (n) => hours(n * 3600))}>
              <Columns rows={chartRows} x="label" series={servers.series} fmt={(n) => hours(n * 3600)} axisFmt={(n) => `${count(n)} h`}
                decimals stacked tipTitle={tipTitle} />
            </ChartCard>
          )}
        </div>
      </StatsGroup>

      <StatsGroup id="delivery" title="Data delivery" help="Data delivered to players by source, server upload, and peer-to-peer transfers.">
        <div className="charts">
          <ChartCard title={`Data delivered ${per}, by source`} series={data} table={table(data, inUnit)} wide>
            <Columns rows={chartRows} x="label" series={data} fmt={inUnit} axisFmt={unitAxis} decimals stacked tipTitle={tipTitle} height={240} />
          </ChartCard>
        </div>
        <Upload g={g} rows={rows} per={per} label={rowLabel} />
        <div className="charts">
          <ChartCard title="Top peer-to-peer sharers" sub="By data sent to other viewers" series={[{ key: "upBytes", label: "Sent to peers", color: COLORS[2] }]}
            table={<TopTable rows={sharerRows} cols={[["Sessions", "plays", count], ["Sent to peers", "upBytes", bytes], ["Received from peers", "p2pBytes", bytes]]} />}>
            {sharerRows.length === 0 ? <p className="muted">No data was shared between viewers in this period.</p>
              : <Bars rows={sharerRows} nameKey="name" valueKey="upBytes" label="Sent to peers" fmt={bytes} color={COLORS[2]}
                onPick={(r) => { location.hash = `people/${String(r.userId)}`; }} />}
          </ChartCard>
          <ChartCard title="Peer-to-peer transfers" sub="Data sent from one viewer to another" series={one("bytes", "Sent")}
            table={<TopTable rows={pairRows} cols={[["Sent", "bytes", bytes]]} />}>
            <ShareList shares={g.pairs ?? []} empty="No data was shared between viewers in this period." />
          </ChartCard>
        </div>
      </StatsGroup>

      <StatsGroup id="streams" title="Streams and processing" help="Streams by delivery method, why streams were transcoded, how long each processing step took, and titles whose streams were corrected.">
        <div className="charts">
          <ChartCard title={`Streams ${per}`} sub="By delivery method" series={streams} table={table(streams, count)}>
            <Columns rows={chartRows} x="label" series={streams} fmt={count} stacked tipTitle={tipTitle} />
          </ChartCard>
          {reasonsOver.series.length > 0 && (
            <ChartCard title={`Transcode reasons ${per}`} sub="Transcoded streams, by reason" series={reasonsOver.series}
              table={table(reasonsOver.series, count)}>
              <Columns rows={chartRows} x="label" series={reasonsOver.series} fmt={count} stacked tipTitle={tipTitle} />
            </ChartCard>
          )}
          <ChartCard title="Transcode reasons" sub="All transcoded streams in the period" series={one("streams", "Streams")}
            table={<SeriesTable rows={reasonRows} label="Reason" labelKey="reason" series={one("streams", "Streams")} fmt={count} />}>
            {reasonRows.length === 0 ? <p className="muted">No stream was transcoded in this period.</p>
              : <Bars rows={reasonRows} nameKey="reason" valueKey="streams" label="Streams" fmt={count} />}
          </ChartCard>
          {anyFirst && (
            <ChartCard title={`Time to first segment ${per}`} sub="Median time from FFmpeg start to the first playable segment"
              series={firstSeg} table={table(firstSeg, duration)}>
              <Columns rows={chartRows} x="label" series={firstSeg} fmt={duration} axisFmt={(n) => duration(n)} tipTitle={tipTitle} />
            </ChartCard>
          )}
          <ProcessingTimes rows={g.processing ?? []} />
          <ProblemFiles rows={g.problems ?? []} />
        </div>
      </StatsGroup>

      <StatsGroup id="quality" title="Playback quality" help="Interruptions while players waited for data, by period and by client.">
        <div className="charts">
          <ChartCard title={`Buffering ${per}`} sub="Playback interruptions while waiting for data" series={one("stalls", "Events")}
            table={table([{ key: "stalls", label: "Events", color: COLORS[0] }], count)}>
            <Columns rows={chartRows} x="label" series={one("stalls", "Events")} fmt={count} tipTitle={tipTitle} />
          </ChartCard>
          <ChartCard title={`Player errors ${per}`} sub="Errors the players reported" series={one("errors", "Errors")}
            table={table([{ key: "errors", label: "Errors", color: COLORS[0] }], count)}>
            <Columns rows={chartRows} x="label" series={one("errors", "Errors")} fmt={count} tipTitle={tipTitle} />
          </ChartCard>
          <ByClient rows={g.clients ?? []} />
        </div>
      </StatsGroup>

      <StatsGroup id="requests" title="Launches and requests" help="Activity launches in Discord, and title requests sent to Seerr by result.">
        <div className="charts">
          <ChartCard title={`Activity launches ${per}`} series={one("launches", "Launches")} table={table(one("launches", "Launches"), count)}>
            <Columns rows={chartRows} x="label" series={one("launches", "Launches")} fmt={count} tipTitle={tipTitle} />
          </ChartCard>
          <ChartCard title={`Title requests ${per}, by result`} series={REQUEST_SERIES} table={table(REQUEST_SERIES, count)}>
            {anyRequests ? <Columns rows={chartRows} x="label" series={REQUEST_SERIES} fmt={count} stacked tipTitle={tipTitle} />
              : <p className="muted">No title was requested in this period.</p>}
          </ChartCard>
        </div>
      </StatsGroup>
    </>
  );
}

/** A group of the Statistics page's charts under one heading. */
function StatsGroup({ id, title, help, children }: { id: string; title: string; help: string; children: React.ReactNode }) {
  return (
    <section id={`sec-${id}`} className="stats-group">
      <div className="stats-group-head">
        <h2>{title}</h2>
        <p className="muted small">{help}</p>
      </div>
      {children}
    </section>
  );
}

/** How long each processing step took over the period: how often, how many failed, and the median, 95th percentile and longest. */
function ProcessingTimes({ rows }: { rows: NonNullable<GraphData["processing"]> }) {
  const order = (k: string) => { const i = PROCESSING_ORDER.indexOf(k); return i < 0 ? 99 : i; };
  const list = [...rows].sort((a, b) => order(a.kind) - order(b.kind) || Number(a.encode) - Number(b.encode));
  const ms = (v: number | null) => (v === null ? "—" : duration(v));
  return (
    <section className="card chart-card wide">
      <header className="chart-head">
        <div>
          <h3>Processing times</h3>
          <p className="muted small chart-sub">Each step the server took to prepare titles and their streams in this period. Failed steps are not included in the times.</p>
        </div>
      </header>
      {list.length === 0 ? <p className="muted">No processing steps were recorded in this period.</p> : (
        <div className="table-wrap">
          <table className="table wrap-heads">
            <thead><tr><th>Step</th><th>Mode</th><th className="num">Completed</th><th className="num">Failed</th><th className="num">Median</th>
              <th className="num">95th percentile</th><th className="num">Longest</th></tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={`${r.kind}|${r.encode}`}>
                  <td><span title={PROCESSING_HELP[r.kind]}>{PROCESSING_NAMES[r.kind] ?? r.kind}</span></td>
                  <td>{r.encode === null ? "—" : r.encode ? "Transcode" : "Remux"}</td>
                  <td className="num">{count(r.count)}</td>
                  <td className={`num${r.failed ? " bad-text" : ""}`}>{r.failed ? count(r.failed) : "—"}</td>
                  <td className="num nowrap">{ms(r.p50Ms)}</td>
                  <td className="num nowrap">{ms(r.p95Ms)}</td>
                  <td className="num nowrap">{ms(r.maxMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
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
        {Array.from({ length: 24 }, (_, h) => <span key={h} className="heat-hour">{h % 6 === 0 ? hourLabel(h) : ""}</span>)}
        {[1, 2, 3, 4, 5, 6, 0].map((w) => (
          <FragmentRow key={w}>
            <span className="heat-day">{WEEKDAYS[w].slice(0, 3)}</span>
            {Array.from({ length: 24 }, (_, h) => {
              const c = at.get(`${w}:${h}`);
              const share = c ? c.plays / max : 0;
              return (
                <span key={h} className={`heat-cell${c ? "" : " none"}`}
                  style={c ? { background: `color-mix(in oklab, var(--series-1) ${Math.round(20 + share * 80)}%, var(--surface-2))` } : undefined}
                  title={`${WEEKDAYS[w]}, ${hourSpan(h)} · ${c ? `${count(c.plays)} ${c.plays === 1 ? "session" : "sessions"}, ${hours(c.playedS)}` : "no sessions"}`} />
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
          <p className="muted small chart-sub">Each viewer's session, by the client it ended on. Dedicated streams are streams created for a single viewer's player.</p>
        </div>
      </header>
      {list.length === 0 ? <p className="muted">No data for this period.</p> : (
        <div className="table-wrap">
          <table className="table wrap-heads">
            <thead><tr><th>Client</th><th className="num">Sessions</th><th className="num">Watch time</th><th className="num">Buffering</th>
              <th className="num">Buffering per hour</th><th className="num">Dedicated streams</th><th className="num">Transcoded</th></tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.name}>
                  <td>{r.name}</td>
                  <td className="num">{count(r.sessions)}</td>
                  <td className="num nowrap">{hours(r.watchedS)}</td>
                  <td className="num nowrap">{r.stalls ? `${count(r.stalls)} · ${duration(r.stalledMs)}` : "None"}</td>
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

/** Titles whose streams the server corrected in this period, the latest first. */
function ProblemFiles({ rows }: { rows: NonNullable<GraphData["problems"]> }) {
  const n = (v: number) => (v ? count(v) : "—");
  return (
    <section className="card chart-card wide">
      <header className="chart-head">
        <div>
          <h3>Titles with stream corrections</h3>
          <p className="muted small chart-sub">Audio shorter than the video (padded with silence), streams that ended before the duration Plex reports,
            subtitles burned into the video, and HDR tone-mapped to SDR. Counted per stream or session.</p>
        </div>
      </header>
      {rows.length === 0 ? <p className="muted">No stream corrections were recorded in this period.</p> : (
        <div className="table-wrap">
          <table className="table wrap-heads">
            <thead><tr><th>Title</th><th className="num">Audio padded</th><th className="num">Ended before duration</th><th className="num">Subtitles burned in</th>
              <th className="num">HDR tone-mapped</th><th className="num">Sessions</th><th>Last session</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ratingKey}>
                  <td>{r.title ?? `Plex item ${r.ratingKey}`} <span className="mono muted small">{r.ratingKey}</span></td>
                  <td className="num">{n(r.shortSound)}</td>
                  <td className="num">{n(r.earlyEnd)}</td>
                  <td className="num">{n(r.burned)}</td>
                  <td className="num">{n(r.toneMapped)}</td>
                  <td className="num">{count(r.sessions)}</td>
                  <td className="nowrap">{r.lastPlayId ? <a href={`#history/${r.lastPlayId}`}>{dayTime(r.lastAt)}</a> : dayTime(r.lastAt)}</td>
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
export function MiniChart({ kind, onError }: { kind: "plays" | "people" | "data" | "servers" | "requests"; onError: (e: unknown) => void }) {
  const { data } = useLoad(() => api.graphs({ days: 30 }), [], onError);
  const names = usePlaceNames();
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
  if (kind === "servers") {
    const guild = (id: string | null) => names.guild(id) ?? id ?? "Direct message";
    const sv = serverSeries(data, guild);
    const svRows = withExtras(data, data.daily, sv.extra).map((d) => ({ ...d, label: dayName(d.day), title: fullDay(d.day) }));
    return (
      <ChartCard title="Watch time per day, by server" sub={more} series={sv.series}
        table={<SeriesTable rows={svRows} label="Day" labelKey="label" series={sv.series} fmt={(n) => hours(n * 3600)} />}>
        {sv.series.length === 0 ? <p className="muted">No watch time has been recorded.</p>
          : <Columns rows={svRows} x="label" series={sv.series} fmt={(n) => hours(n * 3600)} axisFmt={(n) => `${count(n)} h`} decimals stacked
            height={170} tipTitle={tipTitle} />}
      </ChartCard>
    );
  }
  if (kind === "requests") {
    const rqRows = withExtras(data, data.daily, new Map()).map((d) => ({ ...d, label: dayName(d.day), title: fullDay(d.day) }));
    return (
      <ChartCard title="Title requests per day, by result" sub={more} series={REQUEST_SERIES}
        table={<SeriesTable rows={rqRows} label="Day" labelKey="label" series={REQUEST_SERIES} fmt={count} />}>
        <Columns rows={rqRows} x="label" series={REQUEST_SERIES} fmt={count} stacked height={150} tipTitle={tipTitle} />
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

const LOAD_PERIODS: Array<[string, number]> = [["6 hours", 6], ["24 hours", 24], ["7 days", 168], ["30 days", 720]];
const pctText = (n: number) => `${n.toFixed(n >= 10 ? 0 : 1)}%`;

/**
 * The server's load over a period, a step at a time: the machine's CPU and
 * memory, the bot process's share of both, the load average where the
 * system reports one, the streams, transcodes and viewers at most, and the
 * server's upload. A time the bot was not running is a gap in each line.
 */
export function SystemLoadPanel({ onError }: { onError: (e: unknown) => void }) {
  const [span, setSpan] = useState(24);
  const { data, busy } = useLoad(() => api.systemLoad(span), [span], onError);
  return (
    <section className="card">
      <div className="panel-head">
        <div>
          <h3>Server load</h3>
          <p className="muted small">The machine's CPU and memory, the bot process's share, and the streams and viewers it served, recorded each minute.</p>
        </div>
        <div className="segmented" role="group" aria-label="Period">
          {LOAD_PERIODS.map(([label, h]) => (
            <button key={h} type="button" className={span === h ? "on" : ""} aria-pressed={span === h} onClick={() => setSpan(h)}>{label}</button>
          ))}
        </div>
      </div>
      {!data ? <p className="empty">{busy ? "Loading…" : "The server load could not be loaded."}</p>
        : <div className={busy ? "stale" : ""}><SystemLoadBody d={data} /></div>}
    </section>
  );
}

type LoadPoint = SystemLoad["points"][number];

function SystemLoadBody({ d }: { d: SystemLoad }) {
  if (d.points.length === 0) {
    return <p className="muted">No server load was recorded in this period. Recording starts when this version of the bot starts.</p>;
  }
  // A null row where minutes are missing, so the lines break across them.
  const rows: Array<Record<string, number | null>> = [];
  for (const p of d.points) {
    const prev = rows[rows.length - 1];
    if (prev && p.at - Number(prev.at) > d.stepMs * 2.5) {
      rows.push({ at: Number(prev.at) + d.stepMs, cpu: null, bot: null, mem: null, rss: null, load: null, streams: null, encodes: null, viewers: null, sent: null });
    }
    rows.push({ at: p.at, cpu: p.cpuPct, bot: p.botCpuPct, mem: p.memPct, rss: p.rssMb, load: p.load1, streams: p.streams, encodes: p.encodes,
      viewers: p.viewers, sent: p.sentBps / 1e6 });
  }
  const vals = (k: keyof LoadPoint) => d.points.map((p) => p[k]).filter((v): v is number => typeof v === "number");
  const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  const peakOf = (k: keyof LoadPoint) => {
    let best: LoadPoint | null = null;
    for (const p of d.points) if (typeof p[k] === "number" && (!best || (p[k] as number) > (best[k] as number))) best = p;
    return best ? { v: best[k] as number, at: best.at } : null;
  };
  const cpuPeak = peakOf("cpuMaxPct");
  const botPeak = peakOf("botCpuPct");
  const memPeak = peakOf("memMaxPct");
  const rssPeak = peakOf("rssMb");
  const streamsPeak = peakOf("streams");
  const sentPeak = peakOf("sentBps");
  const cpuAvg = avg(vals("cpuPct"));
  const botAvg = avg(vals("botCpuPct"));
  const memAvg = avg(vals("memPct"));
  const rssNow = vals("rssMb").pop() ?? null;
  const hasLoad = vals("load1").length > 0;
  const one = (key: string, label: string, color: string = COLORS[0]): Series[] => [{ key, label, color }];
  const cpu: Series[] = [{ key: "cpu", label: "Machine", color: COLORS[0] }, { key: "bot", label: "Bot process", color: COLORS[1] }];
  const work: Series[] = [{ key: "viewers", label: "Viewers", color: COLORS[2] }, { key: "streams", label: "Streams", color: COLORS[0] },
    { key: "encodes", label: "Transcodes", color: COLORS[1] }];
  const at = (p: { at: number } | null) => (p ? ` on ${dayTime(p.at)}` : "");
  const tableRows = rows.filter((r) => r.cpu !== null || r.streams !== null).map((r) => ({ ...r, label: dayTime(Number(r.at)) }));
  const table = (s: Series[], fmt: (n: number) => string) => <SeriesTable rows={tableRows} label="Time" labelKey="label" series={s} fmt={fmt} />;
  const mb = (n: number) => `${Math.round(n)} MB`;
  const mbit = (n: number) => `${n >= 10 ? n.toFixed(0) : n.toFixed(1)} Mbps`;
  const whole = (n: number) => count(Math.round(n));
  const memGb = (d.memTotalMb / 1000).toFixed(1);
  return (
    <>
      <div className="tiles six">
        <Tile label="CPU, machine" value={cpuAvg === null ? "—" : pctText(cpuAvg)}
          sub={`Average · peak ${cpuPeak ? pctText(cpuPeak.v) : "—"}${at(cpuPeak)} · ${d.cores} cores`} />
        <Tile label="CPU, bot process" value={botAvg === null ? "—" : pctText(botAvg)} sub={`Average · peak ${botPeak ? pctText(botPeak.v) : "—"}${at(botPeak)}`} />
        <Tile label="Memory, machine" value={memAvg === null ? "—" : pctText(memAvg)}
          sub={`Average of ${memGb} GB · peak ${memPeak ? pctText(memPeak.v) : "—"}${at(memPeak)}`} />
        <Tile label="Memory, bot process" value={rssNow === null ? "—" : mb(rssNow)} sub={`Latest · peak ${rssPeak ? mb(rssPeak.v) : "—"}${at(rssPeak)}`} />
        <Tile label="Most streams at once" value={streamsPeak ? count(streamsPeak.v) : "None"}
          sub={`${count(Math.max(0, ...vals("encodes")))} transcodes · ${count(Math.max(0, ...vals("viewers")))} viewers at most`} />
        <Tile label="Peak upload" value={sentPeak && sentPeak.v > 0 ? mbit(sentPeak.v / 1e6) : "None"}
          sub={sentPeak && sentPeak.v > 0 ? `Averaged over ${Math.round(d.stepMs / 60_000)} min${at(sentPeak)}` : "No upload was recorded in this period"} />
      </div>
      <div className="charts">
        <ChartCard title="CPU usage" sub="Share of all cores, averaged over each step" series={cpu} table={table(cpu, pctText)}>
          <Lines rows={rows} series={cpu} from={d.from} to={d.to} max={100} fmt={pctText} axisFmt={(n) => `${n}%`} />
        </ChartCard>
        <ChartCard title="Memory usage, machine" sub={`Share of ${memGb} GB in use`} series={one("mem", "Machine")}
          table={table(one("mem", "Machine"), pctText)}>
          <Lines rows={rows} series={one("mem", "Machine")} from={d.from} to={d.to} max={100} fmt={pctText} axisFmt={(n) => `${n}%`} />
        </ChartCard>
        <ChartCard title="Memory usage, bot process" sub="Resident memory, at most in each step" series={one("rss", "Bot process", COLORS[1])}
          table={table(one("rss", "Bot process", COLORS[1]), mb)}>
          <Lines rows={rows} series={one("rss", "Bot process", COLORS[1])} from={d.from} to={d.to} fmt={mb} />
        </ChartCard>
        <ChartCard title="Streams and viewers" sub="At most in each step" series={work} table={table(work, whole)}>
          <Lines rows={rows} series={work} from={d.from} to={d.to} fmt={whole} curve="stepAfter" />
        </ChartCard>
        <ChartCard title="Server upload" sub="All data the bot's port sent, averaged over each step" series={one("sent", "Upload")}
          table={table(one("sent", "Upload"), mbit)}>
          <Lines rows={rows} series={one("sent", "Upload")} from={d.from} to={d.to} fmt={mbit} axisFmt={(n) => `${count(n)} Mbps`} />
        </ChartCard>
        {hasLoad && (
          <ChartCard title="Load average" sub={`One-minute load average; the dashed line marks the number of cores (${d.cores})`}
            series={one("load", "Load average")} table={table(one("load", "Load average"), (n) => n.toFixed(2))}>
            <Lines rows={rows} series={one("load", "Load average")} from={d.from} to={d.to} fmt={(n) => n.toFixed(2)} axisFmt={count}
              threshold={{ value: d.cores, label: `${d.cores} cores` }} />
          </ChartCard>
        )}
      </div>
    </>
  );
}

/**
 * A user's last 12 weeks, from their sessions: watch time, sessions and
 * buffering week by week (weeks start on Monday, local time).
 */
export function PersonTrends({ plays }: { plays: PersonPlay[] }) {
  if (plays.length === 0) return null;
  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const starts = Array.from({ length: 12 }, (_, i) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - (11 - i) * 7).getTime());
  const rows = starts.map((s, i) => {
    const e = starts[i + 1] ?? Infinity;
    const ps = plays.filter((p) => p.startedAt >= s && p.startedAt < e);
    const d = new Date(s);
    const sum = (f: (p: PersonPlay) => number) => ps.reduce((a, p) => a + f(p), 0);
    return {
      label: `${d.getDate()} ${MONTHS[d.getMonth()]}`, title: `Week of ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
      sessions: ps.length, watchedH: sum((p) => p.watchedS) / 3600, watchedS: sum((p) => p.watchedS), stalls: sum((p) => p.stalls),
      stalledS: sum((p) => p.stalledMs) / 1000,
    };
  });
  const watch: Series[] = [{ key: "watchedH", label: "Watch time", color: COLORS[0] }];
  const sessions: Series[] = [{ key: "sessions", label: "Sessions", color: COLORS[0] }];
  const buffering: Series[] = [{ key: "stalls", label: "Buffering events", color: COLORS[1] }];
  return (
    <div className="charts three">
      <ChartCard title="Watch time per week" sub="Last 12 weeks" series={watch}
        table={<SeriesTable rows={rows} label="Week of" labelKey="label" series={[{ key: "watchedS", label: "Watch time", color: COLORS[0] }]} fmt={hours} />}>
        <Columns rows={rows} x="label" series={watch} fmt={(n) => hours(n * 3600)} axisFmt={(n) => `${count(n)} h`} decimals height={160} tipTitle={tipTitle} />
      </ChartCard>
      <ChartCard title="Sessions per week" sub="Last 12 weeks" series={sessions}
        table={<SeriesTable rows={rows} label="Week of" labelKey="label" series={sessions} fmt={count} />}>
        <Columns rows={rows} x="label" series={sessions} fmt={count} height={160} tipTitle={tipTitle} />
      </ChartCard>
      <ChartCard title="Buffering per week" sub="Last 12 weeks; playback interruptions while waiting for data" series={buffering}
        table={<SeriesTable rows={rows} label="Week of" labelKey="label" series={buffering} fmt={count} />}>
        <Columns rows={rows} x="label" series={buffering} fmt={count} height={160} tipTitle={tipTitle} />
      </ChartCard>
    </div>
  );
}
