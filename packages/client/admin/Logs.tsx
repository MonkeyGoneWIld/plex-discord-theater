import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { LogFile, LogResult } from "./types";
import { bytes, timeOfDay, zoneLabel } from "./format";

export function Logs({ onError }: { onError: (e: unknown) => void }) {
  const [files, setFiles] = useState<LogFile[]>([]);
  const [file, setFile] = useState("");
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [level, setLevel] = useState("");
  const [limit, setLimit] = useState(500);
  const [follow, setFollow] = useState(false);
  const [result, setResult] = useState<LogResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.logFiles().then((r) => {
      setFiles(r.files);
      setFile((f) => f || r.files[0]?.name || "");
    }).catch(onError);
  }, [onError]);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setResult(await api.logs({ file: file || undefined, q, tag, level, limit }));
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }, [file, q, tag, level, limit, onError]);

  useEffect(() => { void load(); }, [file, level, limit]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!follow) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [follow, load]);

  const tags = [...new Set((result?.lines ?? []).map((l) => l.tag).filter((t): t is string => !!t))].sort();

  return (
    <>
      <div className="page-head">
        <h1>Logs</h1>
        <p className="muted">The server's log files, newest first, including lines reported by viewers' players. Times are in your local time ({zoneLabel()}); each file holds one day in UTC.</p>
      </div>
    <section className="card">
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); void load(); }}>
        <label>
          <span>File</span>
          <select value={file} onChange={(e) => setFile(e.target.value)}>
            {files.map((f) => <option key={f.name} value={f.name}>{f.name} · {bytes(f.bytes)}</option>)}
          </select>
        </label>
        <label>
          <span>Level</span>
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="">All levels</option>
            <option value="warn">Warnings and errors</option>
            <option value="error">Errors only</option>
          </select>
        </label>
        <label>
          <span>Tag</span>
          <input list="log-tags" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="e.g. FFmpeg" size={12} />
          <datalist id="log-tags">{tags.map((t) => <option key={t} value={t} />)}</datalist>
        </label>
        <label className="grow">
          <span>Search</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Session ID, user, title…" />
        </label>
        <label>
          <span>Lines</span>
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {[200, 500, 1000, 2000, 5000].map((n) => <option key={n} value={n}>Last {n}</option>)}
          </select>
        </label>
        <button type="submit" disabled={busy}>{busy ? "Loading…" : "Search"}</button>
        <label className="check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
        </label>
      </form>
      {result && (
        <p className="muted small">
          {result.matched.toLocaleString()} of {result.scanned.toLocaleString()} lines match
          {result.matched > result.lines.length ? `; the last ${result.lines.length} shown` : ""}.
        </p>
      )}
      <div className="log">
        {result?.lines.map((l) => (
          <div key={l.n} className={`log-line ${l.level}`}>
            <span className="log-time">{timeOfDay(l.at)}</span>
            <span className="log-tag">{l.tag ?? ""}</span>
            <span className="log-text">{l.client && <span className="log-client" title="Reported by a viewer's player">player {l.client}</span>}{l.text}</span>
          </div>
        ))}
        {result && result.lines.length === 0 && <p className="empty">No log lines match these filters.</p>}
      </div>
    </section>
    </>
  );
}
