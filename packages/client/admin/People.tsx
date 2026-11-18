import { useState } from "react";
import { api } from "./api";
import type { PersonSummary } from "./types";
import { bytes, clock, dayTime, hoursMinutes } from "./format";
import { ShareList } from "./viz";
import { BufferingCell, DataCell, Downloads, PlaceName, SectionNav, useLoad, Where } from "./parts";
import { MiniChart, PersonTrends } from "./lazy";
import { RequestRows } from "./Requests";
import { clientName, formatsText } from "./clients";

const PAGE = 50;

/** Hosting, co-hosting and viewing time, as a bar and in words. */
function RoleSplit({ host, coHost, viewer }: { host: number; coHost: number; viewer: number }) {
  const all = host + coHost + viewer;
  const parts = [["Host", host, "var(--host)"], ["Co-host", coHost, "var(--cohost)"], ["Viewer", viewer, "var(--accent)"]] as const;
  return (
    <>
      <div className="role-split" role="img" aria-label={parts.map(([l, s]) => `${l} ${hoursMinutes(s)}`).join(", ")}>
        {parts.map(([l, s, c]) => s > 0 && <span key={l} style={{ width: `${(s / all) * 100}%`, background: c }} title={`${l}: ${hoursMinutes(s)}`} />)}
      </div>
      <span className="muted small">{parts.filter(([, s]) => s > 0).map(([l, s]) => `${l} ${hoursMinutes(s)}`).join(" · ")}</span>
    </>
  );
}

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
        <p className="muted">All users of the Activity, most recently active first. Select a user to view their sessions, requests and servers.</p>
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
          <table className="table rows wrap-heads">
            <thead>
              <tr>
                <th>User</th><th>Last seen</th><th>Sessions</th><th>Hosted</th><th>Launches</th>
                <th>Watch time</th><th>Data received</th><th className="num">Sent to viewers</th><th>Buffering</th><th>Requests</th><th>Last watched</th>
              </tr>
            </thead>
            <tbody>{people.map((p) => <PersonRow key={p.userId} p={p} />)}</tbody>
          </table>
        </div>
      )}
      <div className="pager">
        <button className="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
        <button className="ghost" disabled={people.length < PAGE} onClick={() => setOffset(offset + PAGE)}>Next</button>
      </div>
    </section>
    </>
  );
}

function PersonRow({ p }: { p: PersonSummary }) {
  const open = () => { location.hash = `people/${p.userId}`; };
  return (
    <tr className="link-row" onClick={open} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") open(); }}>
      <td>
        <a href={`#people/${p.userId}`} onClick={(e) => e.stopPropagation()}><strong>{p.username ?? p.userId}</strong></a>
        {p.username && <div className="mono muted small nowrap" title="Discord user ID">{p.userId}</div>}
      </td>
      <td className="nowrap">{dayTime(p.lastSeen)}</td>
      <td>{p.plays}</td>
      <td>{p.hosted || "—"}</td>
      <td>{p.launches || "—"}</td>
      <td className="nowrap">{hoursMinutes(p.watchedS)}</td>
      <td><DataCell d={p} /></td>
      <td className="num">{p.upBytes > 0 ? bytes(p.upBytes) : "—"}</td>
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
  const sentTo = (data.sentTo ?? []).map((s) => ({ from: p.userId, fromName: p.username, to: s.userId, toName: s.username, bytes: s.bytes }));
  const gotFrom = (data.gotFrom ?? []).map((s) => ({ from: s.userId, fromName: s.username, to: p.userId, toName: p.username, bytes: s.bytes }));
  return (
    <>
      <div className="crumbs"><a href="#people">← Users</a></div>
      <section className="card">
        <header className="room-head">
          <div>
            <h3>{p.username ?? p.userId}</h3>
            <div className="room-meta">
              <span>{p.plays} {p.plays === 1 ? "session" : "sessions"}</span>
              <span>Watch time: {hoursMinutes(p.watchedS)}</span>
              {p.hosted > 0 && <span>Hosted: {p.hosted}</span>}
              {p.launches > 0 && <span>Activity launches: {p.launches}</span>}
            </div>
          </div>
          <dl className="room-ids">
            <dt>Discord user ID</dt><dd className="mono">{p.userId}</dd>
            <dt>First seen</dt><dd>{dayTime(p.firstSeen)}</dd>
            <dt>Last seen</dt><dd>{dayTime(p.lastSeen)}</dd>
          </dl>
        </header>
        <div className="tiles person-tiles">
          <div className="tile"><div className="tile-label">Data received</div><DataCell d={p} legend /></div>
          <div className="tile"><div className="tile-label">Sent to other viewers</div><strong>{bytes(p.upBytes)}</strong></div>
          <div className="tile"><div className="tile-label">Buffering</div><BufferingCell d={p} />
            {p.watchedS > 0 && p.stalls > 0 && <div className="muted small">{(p.stalls / (p.watchedS / 3600)).toFixed(1)} per hour watched</div>}</div>
          <div className="tile"><div className="tile-label">Requests</div><strong>{p.requests}</strong></div>
          {data.roleS && (data.roleS.host + data.roleS.coHost + data.roleS.viewer) > 0 && (
            <div className="tile"><div className="tile-label">Time by role</div>
              <RoleSplit host={data.roleS.host} coHost={data.roleS.coHost} viewer={data.roleS.viewer} /></div>
          )}
        </div>
      </section>

      <SectionNav sections={[["trends", "Trends"], ["sessions", "Sessions"], ["clients", "Clients"], ["places", "Servers and channels"],
        ...(sentTo.length > 0 || gotFrom.length > 0 ? [["sharing", "Peer-to-peer sharing"] as [string, string]] : []), ["requests", "Requests"]]} />

      {plays.length > 0 && <div id="sec-trends"><PersonTrends plays={plays} /></div>}

      <section className="card" id="sec-sessions">
        <h3>Sessions ({plays.length})</h3>
        {plays.length === 0 ? <p className="muted">No sessions have been recorded.</p> : (
          <div className="table-wrap">
            <table className="table rows">
              <thead>
                <tr><th>Started</th><th>Title</th><th>Server · channel</th><th>Role</th><th>Watch time</th><th>Data received</th><th className="num">Sent to viewers</th><th>Buffering</th></tr>
              </thead>
              <tbody>
                {plays.map((pl) => {
                  const open = () => { location.hash = `history/${pl.id}`; };
                  return (
                    <tr key={pl.id} className="link-row" onClick={open} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") open(); }}>
                      <td className="nowrap">{dayTime(pl.startedAt)}</td>
                      <td className="title-cell"><a href={`#history/${pl.id}`} onClick={(e) => e.stopPropagation()}><strong>{pl.title ?? pl.ratingKey}</strong></a></td>
                      <td><Where guildId={pl.guildId} channelId={pl.channelId} /></td>
                      <td>{roleName(pl.role)}</td>
                      <td className="nowrap">{clock(pl.watchedS)}</td>
                      <td><DataCell d={pl} /></td>
                      <td className="num">{pl.upBytes > 0 ? bytes(pl.upBytes) : "—"}</td>
                      <td><BufferingCell d={pl} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" id="sec-clients">
        <h3>Clients ({data.clients?.length ?? 0})</h3>
        {(data.clients?.length ?? 0) === 0 ? <p className="muted">No client has been recorded.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Client</th><th>Plays</th><th className="num">Sessions</th><th>First seen</th><th>Last seen</th></tr></thead>
              <tbody>
                {data.clients!.map((c) => (
                  <tr key={c.device}>
                    <td><span title={c.device}>{clientName(c.device)}</span></td>
                    <td className="small">{c.caps ? formatsText(c.caps, c.av1Encode) : "Not recorded"}</td>
                    <td className="num">{c.sessions}</td>
                    <td className="nowrap">{dayTime(c.first)}</td>
                    <td className="nowrap">{dayTime(c.last)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" id="sec-places">
        <h3>Servers and channels ({places.length})</h3>
        {places.length === 0 ? <p className="muted">No server activity has been recorded.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Server</th><th>Channel</th><th>Launches</th><th>Joins</th><th>First active</th><th>Last active</th></tr></thead>
              <tbody>
                {places.map((pl) => (
                  <tr key={`${pl.guildId}/${pl.channelId}`}>
                    <td><PlaceName kind="guild" id={pl.guildId} /></td>
                    <td><PlaceName kind="channel" id={pl.channelId} /></td>
                    <td>{pl.launches || "—"}</td>
                    <td>{pl.joins || "—"}</td>
                    <td className="nowrap">{dayTime(pl.first)}</td>
                    <td className="nowrap">{dayTime(pl.last)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {(sentTo.length > 0 || gotFrom.length > 0) && (
        <section className="card" id="sec-sharing">
          <h3>Peer-to-peer sharing</h3>
            <div className="charts">
              <div>
                <h5>Sent to</h5>
                <ShareList shares={sentTo} empty="No data sent to other viewers." />
              </div>
              <div>
                <h5>Received from</h5>
                <ShareList shares={gotFrom} empty="No data received from other viewers." />
              </div>
            </div>
        </section>
      )}

      <section className="card" id="sec-requests">
        <h3>Requests ({requests.length})</h3>
        {requests.length === 0 ? <p className="muted">No requests have been recorded.</p> : <RequestRows requests={requests} showWho={false} />}
      </section>
    </>
  );
}
