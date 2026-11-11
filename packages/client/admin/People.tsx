import { useState } from "react";
import { api } from "./api";
import type { PersonSummary } from "./types";
import { clock, utc } from "./format";
import { BufferingCell, DataCell, Downloads, useLoad, Where } from "./parts";
import { MiniChart } from "./lazy";
import { RequestRows } from "./Requests";

const PAGE = 50;

const roleName = (r: string | null) => (r === "host" ? "Host" : r === "co-host" ? "Co-host" : "Viewer");

/** Everybody the bot has seen, and one person's whole story. */
export function People({ id, onError }: { id: string | null; onError: (e: unknown) => void }) {
  if (id) return <PersonPage id={id} onError={onError} />;
  return <PeopleList onError={onError} />;
}

function PeopleList({ onError }: { onError: (e: unknown) => void }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const { data, busy } = useLoad(() => api.people({ q: query, offset, limit: PAGE }), [query, offset], onError);
  const people = data?.people ?? [];
  return (
    <>
      <div className="page-head">
        <h1>Users</h1>
        <p className="muted">Everyone who has used the Activity, most recently active first. Select a user for their sessions, requests and servers.</p>
      </div>
    <MiniChart kind="people" onError={onError} />
    <section className="card">
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setQuery(q); setOffset(0); }}>
        <label className="grow">
          <span>Search by name or Discord user ID</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search users" />
        </label>
        <button type="submit">Search</button>
        {query && <button type="button" className="ghost" onClick={() => { setQ(""); setQuery(""); setOffset(0); }}>Clear</button>}
        <Downloads kind="people" q={query} />
      </form>
      {busy && !data ? <p className="empty">Loading…</p> : people.length === 0 ? (
        <p className="empty">{query ? "No users match this search." : "No users have been recorded yet."}</p>
      ) : (
        <div className="table-wrap">
          <table className="table rows">
            <thead>
              <tr>
                <th>User</th><th>Discord user ID</th><th>Last seen</th><th>Sessions</th><th>Hosted</th><th>Launches</th>
                <th>Watch time</th><th>Data received</th><th>Buffering</th><th>Requests</th><th>Last watched</th>
              </tr>
            </thead>
            <tbody>{people.map((p) => <PersonRow key={p.userId} p={p} />)}</tbody>
          </table>
        </div>
      )}
      <div className="pager">
        <button className="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Newer</button>
        <button className="ghost" disabled={people.length < PAGE} onClick={() => setOffset(offset + PAGE)}>Older</button>
      </div>
    </section>
    </>
  );
}

function PersonRow({ p }: { p: PersonSummary }) {
  const open = () => { location.hash = `people/${p.userId}`; };
  return (
    <tr className="link-row" onClick={open} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") open(); }}>
      <td><a href={`#people/${p.userId}`} onClick={(e) => e.stopPropagation()}><strong>{p.username ?? p.userId}</strong></a></td>
      <td className="mono">{p.userId}</td>
      <td className="nowrap">{utc(p.lastSeen)}</td>
      <td>{p.plays}</td>
      <td>{p.hosted || "—"}</td>
      <td>{p.launches || "—"}</td>
      <td className="nowrap">{clock(p.watchedS)}</td>
      <td><DataCell d={p} /></td>
      <td><BufferingCell d={p} /></td>
      <td>{p.requests || "—"}</td>
      <td>{p.lastTitle ?? "—"}</td>
    </tr>
  );
}

function PersonPage({ id, onError }: { id: string; onError: (e: unknown) => void }) {
  const { data, busy } = useLoad(() => api.person(id), [id], onError);
  if (!data) return <p className="empty">{busy ? "Loading…" : "This user was not found."}</p>;
  const { person: p, plays, requests, places } = data;
  return (
    <>
      <div className="crumbs"><a href="#people">← Users</a></div>
      <section className="card">
        <header className="room-head">
          <div>
            <h3>{p.username ?? p.userId}</h3>
            <div className="room-meta">
              <span>{p.plays} {p.plays === 1 ? "session" : "sessions"}</span>
              <span>Watch time {clock(p.watchedS)}</span>
              {p.hosted > 0 && <span>Hosted {p.hosted}</span>}
              {p.launches > 0 && <span>Launched the Activity {p.launches} {p.launches === 1 ? "time" : "times"}</span>}
            </div>
          </div>
          <dl className="room-ids">
            <dt>Discord user ID</dt><dd className="mono">{p.userId}</dd>
            <dt>First seen</dt><dd>{utc(p.firstSeen)}</dd>
            <dt>Last seen</dt><dd>{utc(p.lastSeen)}</dd>
          </dl>
        </header>
        <div className="tiles person-tiles">
          <div className="tile"><div className="tile-label">Data received</div><DataCell d={p} /></div>
          <div className="tile"><div className="tile-label">Buffering</div><BufferingCell d={p} /></div>
          <div className="tile"><div className="tile-label">Requests</div><strong>{p.requests}</strong></div>
        </div>

        <h4>Servers and channels ({places.length})</h4>
        {places.length === 0 ? <p className="muted">No server activity recorded.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Server ID</th><th>Channel ID</th><th>Launches</th><th>Joins</th><th>First active</th><th>Last active</th></tr></thead>
              <tbody>
                {places.map((pl) => (
                  <tr key={`${pl.guildId}/${pl.channelId}`}>
                    <td className="mono">{pl.guildId ?? "—"}</td>
                    <td className="mono">{pl.channelId ?? "—"}</td>
                    <td>{pl.launches || "—"}</td>
                    <td>{pl.joins || "—"}</td>
                    <td className="nowrap">{utc(pl.first)}</td>
                    <td className="nowrap">{utc(pl.last)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h3>Sessions ({plays.length})</h3>
        {plays.length === 0 ? <p className="muted">None recorded.</p> : (
          <div className="table-wrap">
            <table className="table rows">
              <thead>
                <tr><th>Started</th><th>Title</th><th>Server · channel</th><th>Role</th><th>Watch time</th><th>Data received</th><th>Buffering</th></tr>
              </thead>
              <tbody>
                {plays.map((pl) => {
                  const open = () => { location.hash = `history/${pl.id}`; };
                  return (
                    <tr key={pl.id} className="link-row" onClick={open} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") open(); }}>
                      <td className="nowrap">{utc(pl.startedAt)}</td>
                      <td className="title-cell"><a href={`#history/${pl.id}`} onClick={(e) => e.stopPropagation()}><strong>{pl.title ?? pl.ratingKey}</strong></a></td>
                      <td><Where guildId={pl.guildId} channelId={pl.channelId} /></td>
                      <td>{roleName(pl.role)}</td>
                      <td className="nowrap">{clock(pl.watchedS)}</td>
                      <td><DataCell d={pl} /></td>
                      <td><BufferingCell d={pl} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h3>Requests ({requests.length})</h3>
        {requests.length === 0 ? <p className="muted">None recorded.</p> : <RequestRows requests={requests} showWho={false} />}
      </section>
    </>
  );
}
