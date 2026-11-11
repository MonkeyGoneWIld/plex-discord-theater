import { useState } from "react";
import { api } from "./api";
import type { PersonSummary } from "./types";
import { clock, utc } from "./format";
import { BufferingCell, DataCell, useLoad, Where } from "./parts";
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
    <section className="card">
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setQuery(q); setOffset(0); }}>
        <label className="grow">
          <span>Find a name or a Discord ID</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="crispymage, 1234…" />
        </label>
        <button type="submit">Find</button>
        {query && <button type="button" className="ghost" onClick={() => { setQ(""); setQuery(""); setOffset(0); }}>Show all</button>}
      </form>
      {busy && !data ? <p className="empty">Loading…</p> : people.length === 0 ? (
        <p className="empty">{query ? "Nobody matches." : "Nobody has been seen since the admin page was turned on."}</p>
      ) : (
        <div className="table-wrap">
          <table className="table rows">
            <thead>
              <tr>
                <th>Person</th><th>Discord ID</th><th>Last seen</th><th>Plays</th><th>Hosted</th><th>Launched</th>
                <th>Watched</th><th>Data</th><th>Buffering</th><th>Requests</th><th>Last watched</th>
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
  if (!data) return <p className="empty">{busy ? "Loading…" : "Nobody by that ID."}</p>;
  const { person: p, plays, requests, places } = data;
  return (
    <>
      <div className="crumbs"><a href="#people">← People</a></div>
      <section className="card">
        <header className="room-head">
          <div>
            <h3>{p.username ?? p.userId}</h3>
            <div className="room-meta">
              <span>{p.plays} {p.plays === 1 ? "play" : "plays"}</span>
              <span>Watched {clock(p.watchedS)}</span>
              {p.hosted > 0 && <span>Hosted {p.hosted}</span>}
              {p.launches > 0 && <span>Launched the bot {p.launches} {p.launches === 1 ? "time" : "times"}</span>}
            </div>
          </div>
          <dl className="room-ids">
            <dt>Discord ID</dt><dd className="mono">{p.userId}</dd>
            <dt>First seen</dt><dd>{utc(p.firstSeen)}</dd>
            <dt>Last seen</dt><dd>{utc(p.lastSeen)}</dd>
          </dl>
        </header>
        <div className="tiles person-tiles">
          <div className="tile"><div className="tile-label">Data they had</div><DataCell d={p} /></div>
          <div className="tile"><div className="tile-label">Buffering</div><BufferingCell d={p} /></div>
          <div className="tile"><div className="tile-label">Requests</div><strong>{p.requests}</strong></div>
        </div>

        <h4>Where they used the bot ({places.length})</h4>
        {places.length === 0 ? <p className="muted">Nowhere recorded.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Server</th><th>Channel</th><th>Launched</th><th>Joined</th><th>First</th><th>Last</th></tr></thead>
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
        <h3>What they watched ({plays.length})</h3>
        {plays.length === 0 ? <p className="muted">Nothing yet.</p> : (
          <div className="table-wrap">
            <table className="table rows">
              <thead>
                <tr><th>Started</th><th>Title</th><th>Where</th><th>As</th><th>Watched</th><th>Data</th><th>Buffering</th></tr>
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
        <h3>What they asked for ({requests.length})</h3>
        {requests.length === 0 ? <p className="muted">Nothing yet.</p> : <RequestRows requests={requests} showWho={false} />}
      </section>
    </>
  );
}
