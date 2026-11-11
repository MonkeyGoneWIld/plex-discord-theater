import { useState } from "react";
import { api } from "./api";
import type { TitleRequest } from "./types";
import { utc } from "./format";
import { Downloads, useLoad, Who } from "./parts";

const PAGE = 50;

function seasons(s: TitleRequest["seasons"]): string {
  if (s === "all") return "All seasons";
  if (!s || s.length === 0) return "—";
  return `${s.length === 1 ? "Season" : "Seasons"} ${s.join(", ")}`;
}

/** Seerr's media status, which a request made answers with. */
const MEDIA_STATUS: Record<number, string> = {
  1: "Unknown", 2: "Pending", 3: "Processing", 4: "Partly available", 5: "Available", 6: "Blocklisted", 7: "Deleted",
};

function said(r: TitleRequest) {
  if (r.outcome === "requested") {
    return r.status === null ? "—" : <span title={`Seerr media status ${r.status}`}>{MEDIA_STATUS[r.status] ?? `Status ${r.status}`}</span>;
  }
  return (
    <>
      {r.status !== null && <span className="mono">HTTP {r.status}</span>}
      {r.error && <div className="muted">{r.error}</div>}
      {r.status === null && !r.error && "—"}
    </>
  );
}

function outcome(r: TitleRequest) {
  if (r.outcome === "requested") return <span className="badge good">Requested</span>;
  if (r.outcome === "already requested") return <span className="badge info">Already requested</span>;
  return <span className="badge bad" title={r.error ?? undefined}>Failed</span>;
}

/** Requests sent to Seerr, in a table; a failure says what Seerr answered. */
export function RequestRows({ requests, showWho = true }: { requests: TitleRequest[]; showWho?: boolean }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Time</th>{showWho && <th>User</th>}{showWho && <th>Discord user ID</th>}<th>Title</th><th>Type</th>
            <th>Seasons</th><th>TMDB ID</th><th>Result</th><th>Seerr status</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((r) => (
            <tr key={r.id}>
              <td className="nowrap">{utc(r.at)}</td>
              {showWho && <td><Who id={r.userId} name={r.username} /></td>}
              {showWho && <td className="mono">{r.userId ?? "—"}</td>}
              <td><strong>{r.title ?? "Unknown title"}</strong></td>
              <td>{r.mediaType === "tv" ? "Series" : r.mediaType === "movie" ? "Movie" : r.mediaType}</td>
              <td>{seasons(r.seasons)}</td>
              <td className="mono">{r.tmdbId}</td>
              <td>{outcome(r)}</td>
              <td className="small">{said(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Requests({ onError }: { onError: (e: unknown) => void }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [pages, setPages] = useState<Array<number | undefined>>([undefined]);
  const before = pages[pages.length - 1];
  const { data, busy } = useLoad(() => api.requests({ q: query, before, limit: PAGE }), [query, before], onError);
  const requests = data?.requests ?? [];
  return (
    <>
      <div className="page-head">
        <h1>Requests</h1>
        <p className="muted">Every title requested through Seerr from the Activity, newest first.</p>
      </div>
    <section className="card">
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setQuery(q); setPages([undefined]); }}>
        <label className="grow">
          <span>Search by title, user name, Discord user ID or TMDB ID</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search requests" />
        </label>
        <button type="submit">Search</button>
        {query && <button type="button" className="ghost" onClick={() => { setQ(""); setQuery(""); setPages([undefined]); }}>Clear</button>}
        <Downloads kind="requests" q={query} />
      </form>
      {busy && !data ? <p className="empty">Loading…</p> : requests.length === 0 ? (
        <p className="empty">{query ? "No requests match this search." : "No requests have been recorded yet."}</p>
      ) : <RequestRows requests={requests} />}
      <div className="pager">
        <button className="ghost" disabled={pages.length < 2} onClick={() => setPages(pages.slice(0, -1))}>Newer</button>
        <button className="ghost" disabled={requests.length < PAGE} onClick={() => setPages([...pages, requests[requests.length - 1].id])}>Older</button>
      </div>
    </section>
    </>
  );
}
