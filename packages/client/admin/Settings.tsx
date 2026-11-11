import { useCallback, useEffect, useState } from "react";
import { api, SignedOut } from "./api";
import type { HistorySummary, SettingsView, TrimCounts } from "./types";
import { ago, bytes, utc } from "./format";

const SYSTEM_LABELS: Record<string, string> = {
  version: "Version",
  node: "Node.js",
  platform: "Platform",
  pid: "Process ID",
  startedAt: "Started",
  uptimeS: "Uptime",
  rssMB: "Memory usage (MB)",
  heapUsedMB: "JavaScript heap (MB)",
  logDir: "Log directory",
};

export function Settings({ onError }: { onError: (e: unknown) => void }) {
  const [data, setData] = useState<SettingsView | null>(null);
  const [filter, setFilter] = useState("");
  const [unset, setUnset] = useState(false);

  useEffect(() => { api.settings().then(setData).catch(onError); }, [onError]);
  if (!data) return <p className="empty">Loading…</p>;

  const f = filter.trim().toUpperCase();
  const rows = data.settings.filter((s) => (unset || s.set) && (!f || s.name.includes(f)));
  const shown = (k: string, v: string | number | null) =>
    v === null ? "—" : k === "uptimeS" ? ago(Number(v)) : k === "startedAt" ? utc(String(v)) : String(v);

  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
        <p className="muted">Server status, the history database, and every environment setting the server reads.</p>
      </div>
      <section className="card">
        <h3>System</h3>
        <dl className="grid">
          {Object.entries(data.system).map(([k, v]) => (
            <Pair key={k} label={SYSTEM_LABELS[k] ?? k} value={shown(k, v)} />
          ))}
        </dl>
      </section>
      <HistoryFile onError={onError} />
      <section className="card">
        <div className="toolbar">
          <label className="grow">
            <span>Filter settings</span>
            <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="e.g. FFMPEG" />
          </label>
          <label className="check">
            <input type="checkbox" checked={unset} onChange={(e) => setUnset(e.target.checked)} /> Show settings left unset
          </label>
        </div>
        <p className="muted small">
          Read from the server's environment. Passwords, keys and tokens show only whether they are set.
        </p>
        <table className="table">
          <thead><tr><th>Setting</th><th>Value</th></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.name}>
                <td className="mono">{s.name}</td>
                <td className={s.set ? (s.secret ? "muted" : "mono") : "muted"}>
                  {s.set ? s.value : "Not set (default applies)"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
        <dt>Period covered</dt><dd>{summary.first ? `${utc(summary.first)} to ${utc(summary.last)}` : "No data yet"}</dd>
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
          <span>Keep the most recent (days)</span>
          <input type="number" min={1} max={MAX_DAYS} step={1} value={days} onChange={(e) => { setDays(e.target.value); setPreview(null); }} />
        </label>
        <button type="submit" className="ghost" disabled={!valid || busy}>Preview deletion</button>
      </form>
      {!valid && <p className="error small">A whole number of days, 1 to {MAX_DAYS}.</p>}
      {preview && (
        <div className="confirm" role="alert">
          {nothing ? <p>There is nothing older than {utc(preview.before)} to delete.</p> : (
            <>
              <p>
                This deletes everything recorded before {utc(preview.before)}: <strong>{preview.plays} sessions</strong> with
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
                      + `and ${r.people} people. The file went from ${bytes(r.bytesBefore)} to ${bytes(r.bytesAfter)}.`);
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
