import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { LogFile, LogResult } from "./types";
import { bytes, dateTime, timeOfDay, zoneLabel } from "./format";

/** `#logs/file=theater-2026-11-18.log&from=…&to=…`: a session's lines, from its History page. */
export function sessionLogsHref(startedAt: number, endedAt: number | null): string[] {
  const end = endedAt ?? Date.now();
  const day = (t: number) => `theater-${new Date(t).toISOString().slice(0, 10)}.log`;
  // Each file is one UTC day: a session over midnight is in two.
  const files = [...new Set([day(startedAt), day(end)])];
  return files.map((f) => `#logs/${encodeURIComponent(`file=${f}&from=${startedAt}&to=${end}`)}`);
}

function windowOf(route: string | null): { file: string; from: number; to: number } | null {
  if (!route) return null;
  const p = new URLSearchParams(route);
  const from = Number(p.get("from"));
  const to = Number(p.get("to"));
  const file = p.get("file") ?? "";
  return file && from > 0 && to >= from ? { file, from, to } : null;
}

export function Logs({ onError, route = null }: { onError: (e: unknown) => void; route?: string | null }) {
  const [files, setFiles] = useState<LogFile[]>([]);
  const [span, setSpan] = useState(() => windowOf(route));
  const [file, setFile] = useState(span?.file ?? "");
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
      setResult(await api.logs({ file: file || undefined, q, tag, level, limit, from: span?.from, to: span?.to }));
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }, [file, q, tag, level, limit, span, onError]);

  useEffect(() => {
    const w = windowOf(route);
    setSpan(w);
    if (w) setFile(w.file);
  }, [route]);

  useEffect(() => { void load(); }, [file, level, limit, span]); // eslint-disable-line react-hooks/exhaustive-deps

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
        <p className="muted">Times in your local time zone ({zoneLabel()}); each file covers one UTC day.</p>
      </div>
    <section className="card">
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); void load(); }}>
        <label>
          <span>File</span>
          <select value={file} onChange={(e) => { setFile(e.target.value); setSpan(null); }}>
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
      {span && (
        <p className="note log-window">
          Showing only lines written during the session, {dateTime(span.from)} to {timeOfDay(span.to)}.{" "}
          <button type="button" className="link" onClick={() => { setSpan(null); history.replaceState(null, "", "#logs"); }}>Show the whole file</button>
        </p>
      )}
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
            <span className="log-text">{l.client && <span className="log-client">Player {l.client}</span>}{l.text}</span>
          </div>
        ))}
        {result && result.lines.length === 0 && <p className="empty">No log lines match these filters.</p>}
      </div>
    </section>
    </>
  );
}
