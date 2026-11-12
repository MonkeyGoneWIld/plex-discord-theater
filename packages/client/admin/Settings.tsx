import { useCallback, useEffect, useState } from "react";
import { api, SignedOut } from "./api";
import type { HistorySummary, SettingsView, TrimCounts } from "./types";
import { ago, bytes, dateTime } from "./format";
import { Icon } from "./icons";

/** Each setting's group, by its name: the first that matches. */
const GROUPS: Array<[string, RegExp, string]> = [
  ["Plex", /^PLEX_/, "The Plex server and account the Activity plays from."],
  ["Discord", /^(DISCORD_|REDIRECT_URI|ALLOWED_ORIGINS|HOST_REQUESTS|PRESENCE)/, "The Discord application, its sign-in, and room behaviour."],
  ["FFmpeg engine", /^(FFMPEG_|PLAYBACK_ENGINE)/, "The server's own FFmpeg: hardware, presets, subtitles and previews."],
  ["Playback and quality", /^(DIRECT_STREAM|VIDEO_|AUDIO_|QUALITY|.*BITRATE)/, "What is sent unchanged, and the bitrates used when transcoding."],
  ["Caches and storage", /^(THUMB_|WARM_|.*CACHE|DATA_|PREVIEW)/, "Where data is kept, how much, and for how long."],
  ["Integrations", /^(SEERR_|TMDB_|TVDB_|QBT_|TRAKT_)/, "Seerr requests, TMDB and TVDB metadata, and the qBittorrent manager."],
  ["Dashboard", /^ADMIN_/, "This dashboard, its port and its password."],
  ["Logging", /^(LOG_|DEBUG)/, "Log files and their detail."],
  ["Server", /^(PORT|NODE_ENV|SESSION_|HOST|TRUST_|TZ)/, "The Activity's own web server."],
];
const groupOf = (name: string) => GROUPS.find(([, re]) => re.test(name))?.[0] ?? "Other";

function Fact({ icon, label, value, sub }: { icon: string; label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="stat-head"><span className="stat-icon"><Icon name={icon} /></span><span className="stat-label">{label}</span></div>
      <div className="stat-value small-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

/** The server's status, its history database, and its configuration, read-only. */
export function Settings({ onError }: { onError: (e: unknown) => void }) {
  const [data, setData] = useState<SettingsView | null>(null);
  const [filter, setFilter] = useState("");
  const [unset, setUnset] = useState(false);

  useEffect(() => { api.settings().then(setData).catch(onError); }, [onError]);
  if (!data) return <p className="empty">Loading…</p>;

  const sys = data.system;
  const f = filter.trim().toUpperCase();
  const rows = data.settings.filter((s) => (unset || s.set) && (!f || s.name.includes(f)));
  const names = [...GROUPS.map(([g]) => g), "Other"];
  const total = data.settings.filter((s) => s.set).length;

  return (
    <>
      <div className="page-head">
        <h1>System</h1>
        <p className="muted">The server's status, its history database, and its configuration.</p>
      </div>

      <div className="stats">
        <Fact icon="check" label="Version" value={String(sys.version ?? "—")} sub={`Node.js ${String(sys.node ?? "—")}`} />
        <Fact icon="clock" label="Uptime" value={sys.uptimeS === null || sys.uptimeS === undefined ? "—" : ago(Number(sys.uptimeS))}
          sub={sys.startedAt ? `Started ${dateTime(String(sys.startedAt))}` : undefined} />
        <Fact icon="pulse" label="Memory" value={sys.rssMB === null || sys.rssMB === undefined ? "—" : `${sys.rssMB} MB`}
          sub={sys.heapUsedMB !== null && sys.heapUsedMB !== undefined ? `JavaScript heap ${sys.heapUsedMB} MB` : undefined} />
        <Fact icon="caches" label="Platform" value={String(sys.platform ?? "—")} sub={`Process ${String(sys.pid ?? "—")}`} />
      </div>
      <section className="card">
        <h3>Paths</h3>
        <dl className="grid">
          <dt>Log directory</dt><dd className="mono">{String(sys.logDir ?? "—")}</dd>
          {Object.entries(sys).filter(([k]) => !["version", "node", "uptimeS", "startedAt", "rssMB", "heapUsedMB", "platform", "pid", "logDir"].includes(k))
            .map(([k, v]) => <span key={k} style={{ display: "contents" }}><dt>{k}</dt><dd className="mono">{v === null ? "—" : String(v)}</dd></span>)}
        </dl>
      </section>

      <HistoryFile onError={onError} />

      <section className="card">
        <div className="panel-head">
          <h3>Configuration</h3>
          <span className="muted small">{total} of {data.settings.length} settings are set</span>
        </div>
        <p className="note">
          These are the environment settings the server reads, shown for reference. To change one, edit it in your Docker Compose
          file or <span className="mono">.env</span> and restart the container. Passwords, keys and tokens only show whether they are set.
        </p>
        <div className="toolbar config-tools">
          <label className="grow">
            <span>Filter by name</span>
            <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="For example FFMPEG" />
          </label>
          <label className="check">
            <input type="checkbox" checked={unset} onChange={(e) => setUnset(e.target.checked)} /> Include settings left at their default
          </label>
        </div>
        {rows.length === 0 && <p className="empty">No settings match.</p>}
        {names.map((g) => {
          const mine = rows.filter((s) => groupOf(s.name) === g);
          if (mine.length === 0) return null;
          const about = GROUPS.find(([name]) => name === g)?.[2];
          return (
            <details key={g} className="config-group" open={!!f || mine.some((s) => s.set)}>
              <summary>
                <span className="config-name">{g}</span>
                <span className="muted small">{about}</span>
                <span className="badge muted">{mine.filter((s) => s.set).length} set{unset ? ` of ${mine.length}` : ""}</span>
              </summary>
              <table className="table config">
                <tbody>
                  {mine.map((s) => (
                    <tr key={s.name}>
                      <td className="mono">{s.name}</td>
                      <td className={s.set ? (s.secret ? "muted" : "mono") : "muted"}>
                        {s.set ? (s.secret ? <span className="badge good">Set</span> : s.value) : "Default"}
                        {s.set && s.secret && s.value ? <span className="muted small"> {String(s.value).replace(/^set · /, "")}</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          );
        })}
      </section>
    </>
  );
}


const MAX_DAYS = 3650;

/** The history file: what it holds, a copy to download, and removing what is old. */
function HistoryFile({ onError }: { onError: (e: unknown) => void }) {
  const [summary, setSummary] = useState<HistorySummary | null>(null);
  const [none, setNone] = useState<string | null>(null);
  const [days, setDays] = useState("365");
  const [preview, setPreview] = useState<TrimCounts | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fail = useCallback((e: unknown) => {
    if (e instanceof SignedOut) onError(e);
    else setNone(e instanceof Error ? e.message : String(e));
  }, [onError]);
  const load = useCallback(() => api.historyFile().then((f) => setSummary(f.summary)).catch(fail), [fail]);
  useEffect(() => { load(); }, [load]);

  if (none) {
    return (
      <section className="card">
        <h3>History database</h3>
        <p className="muted">{none}. History recording needs ADMIN_PASSWORD set and a writable data folder.</p>
      </section>
    );
  }
  if (!summary) return null;
  const n = Number(days);
  const valid = Number.isInteger(n) && n >= 1 && n <= MAX_DAYS;
  const nothing = preview && preview.plays + preview.events + preview.usage + preview.requests + preview.people === 0;
  return (
    <section className="card">
      <h3>History database</h3>
      <dl className="grid">
        <dt>File</dt><dd className="mono">{summary.path}</dd>
        <dt>Size</dt><dd>{bytes(summary.bytes)}</dd>
        <dt>Contents</dt>
        <dd>
          {summary.plays} sessions ({summary.open} in progress), {summary.events} timeline events,
          {" "}{summary.usage} launches and joins, {summary.requests} requests, {summary.people} users
        </dd>
        <dt>Period covered</dt><dd>{summary.first ? `${dateTime(summary.first)} to ${dateTime(summary.last)}` : "No data yet"}</dd>
      </dl>

      <h4>Backup</h4>
      <p className="history-actions">
        <a className="button ghost" href="/api/export/admin.sqlite" download>Download database (admin.sqlite)</a>
        <span className="muted small">
          A snapshot taken when you click, for backup or your own queries. Each list can also be exported as CSV or JSON from its page.
        </span>
      </p>

      <h4>Delete old history</h4>
      <form className="toolbar" onSubmit={(e) => {
        e.preventDefault();
        setDone(null);
        setBusy(true);
        api.historyFile(n).then((f) => { setSummary(f.summary); setPreview(f.trim); }).catch(fail).finally(() => setBusy(false));
      }}>
        <label>
          <span>Delete history older than (days)</span>
          <input type="number" min={1} max={MAX_DAYS} step={1} value={days} onChange={(e) => { setDays(e.target.value); setPreview(null); }} />
        </label>
        <button type="submit" className="ghost" disabled={!valid || busy}>Preview deletion</button>
      </form>
      {!valid && <p className="error small">A whole number of days, 1 to {MAX_DAYS}.</p>}
      {preview && (
        <div className="confirm" role="alert">
          {nothing ? <p>No history is older than {n} {n === 1 ? "day" : "days"} ({dateTime(preview.before)}). Nothing would be deleted.</p> : (
            <>
              <p>
                This deletes everything older than {n} {n === 1 ? "day" : "days"}, recorded before {dateTime(preview.before)}: <strong>{preview.plays} sessions</strong> with
                their viewers, streams and {preview.events} timeline events; {preview.usage} launches and joins;
                {" "}{preview.requests} requests; and {preview.people} users not seen since. Sessions in progress are kept.
              </p>
              <p><strong>This cannot be undone.</strong> Download the database first if you want to keep a copy.</p>
              <div className="confirm-actions">
                <button className="danger" disabled={busy} onClick={() => {
                  setBusy(true);
                  api.trim(n).then((r) => {
                    setPreview(null);
                    setDone(`Deleted ${r.plays} sessions, ${r.events} timeline events, ${r.usage} launches and joins, ${r.requests} requests `
                      + `and ${r.people} users. The file went from ${bytes(r.bytesBefore)} to ${bytes(r.bytesAfter)}.`);
                    return load();
                  }).catch(fail).finally(() => setBusy(false));
                }}>{busy ? "Deleting…" : "Delete permanently"}</button>
                <button className="ghost" disabled={busy} onClick={() => setPreview(null)}>Cancel</button>
              </div>
            </>
          )}
        </div>
      )}
      {done && <p className="note" role="status">{done}</p>}
    </section>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return <><dt>{label}</dt><dd className="mono">{value}</dd></>;
}
