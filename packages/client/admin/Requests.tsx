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

/** A request's state now, as Seerr has it: [label, tone]. Null when Seerr wasn't reached. */
function current(r: TitleRequest): [string, string] | null {
  const c = r.current;
  if (!c) return null;
  if (c.requestStatus === 3) return ["Declined", "bad"];
  if (c.requestStatus === 4) return ["Failed in Seerr", "bad"];
  if (c.mediaStatus === 5) return ["Available", "good"];
  if (c.mediaStatus === 4) return ["Partially available", "good"];
  if (c.mediaStatus === 3) return ["Processing", "info"];
  if (c.requestStatus === 2) return ["Approved", "info"];
  if (c.requestStatus === 1 || c.mediaStatus === 2) return ["Pending approval", "warn"];
  if (c.mediaStatus === 6) return ["Blocklisted", "bad"];
  return ["No longer requested", "muted"];
}

function said(r: TitleRequest) {
  const now = current(r);
  if (r.outcome === "requested" || r.outcome === "already requested") {
    const then = r.status !== null && r.outcome === "requested" ? MEDIA_STATUS[r.status] ?? `Status ${r.status}` : null;
    if (now) return <span className={`badge ${now[1]}`} title={then ? `When requested: ${then}` : undefined}>{now[0]}</span>;
    return then ? <span className="muted" title="Seerr could not be reached for the current status">{then} (when requested)</span> : "—";
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
            <th>Seasons</th><th>TMDB ID</th><th>Result</th><th>Status now</th>
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
        <button className="ghost" disabled={pages.length < 2} onClick={() => setPages(pages.slice(0, -1))}>Previous</button>
        <button className="ghost" disabled={requests.length < PAGE} onClick={() => setPages([...pages, requests[requests.length - 1].id])}>Next</button>
      </div>
    </section>
    </>
  );
}
