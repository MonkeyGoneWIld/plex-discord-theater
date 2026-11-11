import { useCallback, useEffect, useState } from "react";
import { api, SignedOut } from "./api";
import type { HistorySummary, SettingsView, TrimCounts } from "./types";
import { ago, bytes, utc } from "./format";

const SYSTEM_LABELS: Record<string, string> = {
  version: "Version",
  node: "Node.js",
  platform: "Platform",
  pid: "Process id",
  startedAt: "Started",
  uptimeS: "Up for",
  rssMB: "Memory in use (MB)",
  heapUsedMB: "JavaScript heap (MB)",
  logDir: "Log folder",
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
            <span>Find a setting</span>
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
                  {s.set ? s.value : "Not set (default)"}
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
        <h3>History</h3>
        <p className="muted">{none}. The history needs ADMIN_PASSWORD set and a data folder the bot can write to.</p>
      </section>
    );
  }
  if (!summary) return null;
  const n = Number(days);
  const valid = Number.isInteger(n) && n >= 1 && n <= MAX_DAYS;
  const nothing = preview && preview.plays + preview.events + preview.usage + preview.requests + preview.people === 0;
  return (
    <section className="card">
      <h3>History</h3>
      <dl className="grid">
        <dt>File</dt><dd className="mono">{summary.path}</dd>
        <dt>Size</dt><dd>{bytes(summary.bytes)}</dd>
        <dt>Holds</dt>
        <dd>
          {summary.plays} plays ({summary.open} playing now), {summary.events} lines of what happened,
          {" "}{summary.usage} launches and joins, {summary.requests} requests, {summary.people} people
        </dd>
        <dt>From</dt><dd>{summary.first ? `${utc(summary.first)} to ${utc(summary.last)}` : "Nothing yet"}</dd>
      </dl>

      <h4>Download</h4>
      <p className="history-actions">
        <a className="button ghost" href="/api/export/admin.sqlite" download>A copy of the history (admin.sqlite)</a>
        <span className="muted small">
          Taken as you click, for a backup or your own queries. Each list downloads as CSV or JSON from its own page.
        </span>
      </p>

      <h4>Remove old history</h4>
      <form className="toolbar" onSubmit={(e) => {
        e.preventDefault();
        setDone(null);
        setBusy(true);
        api.historyFile(n).then((f) => { setSummary(f.summary); setPreview(f.trim); }).catch(fail).finally(() => setBusy(false));
      }}>
        <label>
          <span>Keep the last (days)</span>
          <input type="number" min={1} max={MAX_DAYS} step={1} value={days} onChange={(e) => { setDays(e.target.value); setPreview(null); }} />
        </label>
        <button type="submit" className="ghost" disabled={!valid || busy}>See what would go</button>
      </form>
      {!valid && <p className="error small">A whole number of days, 1 to {MAX_DAYS}.</p>}
      {preview && (
        <div className="confirm" role="alert">
          {nothing ? <p>Nothing is older than {utc(preview.before)}.</p> : (
            <>
              <p>
                From before {utc(preview.before)}: <strong>{preview.plays} plays</strong>, with their viewers, streams and
                {" "}{preview.events} lines of what happened; {preview.usage} launches and joins; {preview.requests} requests; and
                {" "}{preview.people} people seen only then. A play still going stays.
              </p>
              <p><strong>This can't be undone.</strong> Download a copy first to keep it.</p>
              <div className="confirm-actions">
                <button className="danger" disabled={busy} onClick={() => {
                  setBusy(true);
                  api.trim(n).then((r) => {
                    setPreview(null);
                    setDone(`Removed ${r.plays} plays, ${r.events} lines, ${r.usage} launches and joins, ${r.requests} requests `
                      + `and ${r.people} people. The file went from ${bytes(r.bytesBefore)} to ${bytes(r.bytesAfter)}.`);
                    return load();
                  }).catch(fail).finally(() => setBusy(false));
                }}>{busy ? "Removing…" : "Remove them"}</button>
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
