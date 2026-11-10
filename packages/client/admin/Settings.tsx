import { useEffect, useState } from "react";
import { api } from "./api";
import type { SettingsView } from "./types";
import { ago, utc } from "./format";

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

function Pair({ label, value }: { label: string; value: string }) {
  return <><dt>{label}</dt><dd className="mono">{value}</dd></>;
}
