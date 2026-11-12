import { useState } from "react";
import { api } from "./api";
import type { PlayEvent, PlaySummary } from "./types";
import { bytes, clock, dateTime, timeOfDay } from "./format";
import {
  BufferingCell, bufferingTone, DataCell, Downloads, eventText, eventTone, GROUP_LABELS, groupOf, useLoad, Where, Who,
  type EventGroup,
} from "./parts";
import { StreamCard } from "./streams";
import { KeyMoments, SessionChart } from "./timeline";
import { MiniChart } from "./lazy";
import { Icon } from "./icons";
import { Poster, titleLine, useTitles } from "./titles";
import { Avatar, pct, SplitBar } from "./viz";

const PAGE = 50;

/** How a session ended, in a few words. */
function endText(p: { endedAt: number | null; endReason: string | null; endBy: string | null }): string {
  if (p.endedAt === null) return "In progress";
  return p.endReason === "stopped" ? `Stopped${p.endBy ? ` by ${p.endBy}` : ""}`
    : p.endReason === "another title" ? "Next title started"
      : p.endReason === "room closed" ? "Everyone left"
        : p.endReason === "server stopped" ? "Server shut down"
          : p.endReason === "server restarted" ? "Server restarted unexpectedly"
            : p.endReason ?? "Ended";
}

function EndBadge({ p }: { p: { endedAt: number | null; endReason: string | null; endBy: string | null } }) {
  return p.endedAt === null
    ? <span className="badge good"><span className="dot good" />In progress</span>
    : <span className="badge muted">{endText(p)}</span>;
}

/** Every session, newest first; one opens to everything recorded about it. */
export function History({ id, onError }: { id: string | null; onError: (e: unknown) => void }) {
  if (id) return <PlayPage id={Number(id)} onError={onError} />;
  return <PlayList onError={onError} />;
}

function PlayList({ onError }: { onError: (e: unknown) => void }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  // Pages before this one, by the id each started before: to come back.
  const [pages, setPages] = useState<Array<number | undefined>>([undefined]);
  const before = pages[pages.length - 1];
  const { data, busy } = useLoad(() => api.history({ q: query, before, limit: PAGE }), [query, before], onError);
  const plays = data?.plays ?? [];
  const info = useTitles(plays.map((p) => p.ratingKey));
  return (
    <>
      <div className="page-head">
        <h1>History</h1>
        <p className="muted">Every playback session, newest first. Select one for its viewers, streams and full timeline.</p>
      </div>
      <MiniChart kind="plays" onError={onError} />
      <section className="card">
        <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setQuery(q); setPages([undefined]); }}>
          <label className="grow">
            <span>Search by title, viewer name, Discord user ID, or server or channel ID</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search sessions" />
          </label>
          <button type="submit">Search</button>
          {query && <button type="button" className="ghost" onClick={() => { setQ(""); setQuery(""); setPages([undefined]); }}>Clear</button>}
          <Downloads kind="history" q={query} />
        </form>
        {busy && !data ? <p className="empty">Loading…</p> : plays.length === 0 ? (
          <p className="empty">{query ? "No sessions match this search." : "No sessions have been recorded yet."}</p>
        ) : (
          <ol className="plays">
            {plays.map((p) => <PlayRow key={p.id} p={p} sub={titleLine(info(p.ratingKey))} />)}
          </ol>
        )}
        <div className="pager">
          <button className="ghost" disabled={pages.length < 2} onClick={() => setPages(pages.slice(0, -1))}>Previous</button>
          <button className="ghost" disabled={plays.length < PAGE} onClick={() => setPages([...pages, plays[plays.length - 1].id])}>Next</button>
        </div>
      </section>
    </>
  );
}

function PlayRow({ p, sub }: { p: PlaySummary; sub: string | null }) {
  const stallTone = p.stalls === 0 ? "good" : p.stalls > 5 ? "bad" : "warn";
  return (
    <li>
      <a className="play-row" href={`#history/${p.id}`}>
        <Poster ratingKey={p.ratingKey} title={p.title} size="sm" />
        <span className="play-main">
          <span className="play-title">{p.title ?? `Plex item ${p.ratingKey}`}</span>
          <span className="play-sub">
            {sub ? `${sub} · ` : ""}{dateTime(p.startedAt)} · hosted by {p.hostName ?? p.hostUserId ?? "unknown"}
          </span>
          <span className="play-sub"><Where guildId={p.guildId} channelId={p.channelId} /></span>
        </span>
        <span className="play-col viewers-col">
          <span className="avatars">
            {p.names.slice(0, 5).map((n) => <Avatar key={n} id={n} name={n} />)}
            {p.names.length > 5 && <span className="avatar more">+{p.names.length - 5}</span>}
          </span>
          <span className="play-label">{p.viewers} {p.viewers === 1 ? "viewer" : "viewers"}</span>
        </span>
        <span className="play-col">
          <strong>{clock(p.playedS)}</strong>
          <span className="play-label">played</span>
        </span>
        <span className="play-col">
          {p.streams === 0 ? <span className="badge muted">No stream</span>
            : p.reencoded > 0 ? <span className="badge warn">{p.reencoded === p.streams ? "Transcode" : `${p.reencoded} of ${p.streams} transcoded`}</span>
              : <span className="badge good">Direct</span>}
          <span className="play-label">{p.streams} {p.streams === 1 ? "stream" : "streams"}</span>
        </span>
        <span className="play-col data-col">
          <strong>{bytes(p.bytes)}</strong>
          <SplitBar server={p.botBytes} cache={p.cacheBytes} peers={p.p2pBytes} legend={false} />
        </span>
        <span className="play-col">
          <span className={`health ${stallTone}`}><span className={`dot ${stallTone}`} />{p.stalls === 0 ? "Smooth" : `${p.stalls} buffering`}</span>
          <span className="play-label">{endText(p)}</span>
        </span>
        <span className="chev"><Icon name="chevron" size={16} /></span>
      </a>
    </li>
  );
}

function PlayPage({ id, onError }: { id: number; onError: (e: unknown) => void }) {
  const { data, busy, reload } = useLoad(() => api.play(id), [id], onError);
  const info = useTitles([data?.play.ratingKey]);
  if (!data) return <p className="empty">{busy ? "Loading…" : "This session was not found."}</p>;
  const { play, viewers, streams, events } = data;
  const i = info(play.ratingKey);
  const nameOf = (userId: string | null) => viewers.find((v) => v.userId === userId)?.username ?? userId;
  const server = viewers.reduce((s, v) => s + v.botBytes, 0);
  const cache = viewers.reduce((s, v) => s + Math.min(v.edgeHitBytes, v.httpBytes), 0);
  const peers = viewers.reduce((s, v) => s + v.p2pBytes, 0);
  const stalls = viewers.reduce((s, v) => s + v.stalls, 0);
  const stalledMs = viewers.reduce((s, v) => s + v.stalledMs, 0);
  const errors = viewers.reduce((s, v) => s + v.errors, 0);
  const health = bufferingTone({ stalls, stalledMs, errors });
  const transcoded = streams.filter((s) => s.decision === "transcode").length;
  return (
    <>
      <div className="crumbs"><a href="#history"><Icon name="back" size={14} /> History</a></div>
      <section className="card session">
        <div className="session-top">
          <Poster ratingKey={play.ratingKey} title={play.title} size="lg" />
          <div className="session-main">
            <div className="session-title">
              <div>
                <h3>{play.title ?? `Plex item ${play.ratingKey}`}</h3>
                {titleLine(i) && <div className="session-sub">{titleLine(i)}</div>}
              </div>
              <EndBadge p={play} />
            </div>
            <div className="facts">
              <span className="fact"><Icon name="users" size={14} />Host <strong><Who id={play.hostUserId} name={play.hostName} /></strong></span>
              <span className="fact"><Icon name="clock" size={14} />{dateTime(play.startedAt)}{play.endedAt ? ` → ${timeOfDay(play.endedAt)}` : ""}</span>
              <span className="fact" title="Discord server ID"><Icon name="places" size={14} />Server <span className="mono">{play.guildId ?? "—"}</span></span>
              <span className="fact" title="Discord channel ID">Channel <span className="mono">{play.channelId ?? "—"}</span></span>
              <span className="fact">Plex item <span className="mono">{play.ratingKey}</span></span>
              <span className="fact">Room <span className="mono">{play.roomId}</span></span>
              {play.endedAt === null && <button className="link" onClick={reload}>Refresh</button>}
            </div>
            <div className="session-kpis">
              <div className="kpi"><span className="kpi-label">Time played</span><span className="kpi-value">{clock(play.playedS)}</span>
                <span className="kpi-sub">{clock(play.startPosS ?? 0)} → {clock(play.lastPosS ?? 0)}{i?.durationS ? ` of ${clock(i.durationS)}` : ""}</span></div>
              <div className="kpi"><span className="kpi-label">Viewers</span><span className="kpi-value">{viewers.length}</span>
                <span className="kpi-sub">up to {play.peakViewers} at once</span></div>
              <div className="kpi"><span className="kpi-label">Streams</span><span className="kpi-value">{streams.length}</span>
                <span className="kpi-sub">{transcoded ? `${transcoded} transcoded` : "all direct"}</span></div>
              <div className="kpi"><span className="kpi-label">Data delivered</span><span className="kpi-value">{bytes(server + cache + peers)}</span>
                <span className="kpi-sub">{pct(cache + peers, server + cache + peers)}% not from the server</span></div>
              <div className={`kpi ${health}`}><span className="kpi-label">Buffering</span>
                <span className="kpi-value">{stalls === 0 ? "None" : `${stalls} ${stalls === 1 ? "event" : "events"}`}</span>
                <span className="kpi-sub">{stalls ? `${clock(stalledMs / 1000)} in total` : "playback was smooth"}{errors ? ` · ${errors} errors` : ""}</span></div>
            </div>
          </div>
        </div>

        <div className="session-block">
          <h4>Where the data came from</h4>
          <SplitBar server={server} cache={cache} peers={peers} />
        </div>

        <div className="session-block">
          <h4>Viewers ({viewers.length})</h4>
          <div className="table-wrap">
            <table className="table viewers">
              <thead>
                <tr><th>Viewer</th><th>Watched</th><th>Data received</th><th>Buffering</th><th>First seen</th><th>Last seen</th><th>Discord user ID</th></tr>
              </thead>
              <tbody>
                {viewers.map((v) => (
                  <tr key={v.userId}>
                    <td>
                      <span className="person">
                        <Avatar id={v.userId} name={v.username} size={28} />
                        <span>
                          <Who id={v.userId} name={v.username} />
                          <span className={`role ${v.role ?? "viewer"}`}>{v.role === "host" ? "Host" : v.role === "co-host" ? "Co-host" : "Viewer"}</span>
                        </span>
                      </span>
                    </td>
                    <td className="nowrap">{clock(v.watchedS)}</td>
                    <td><DataCell d={v} /></td>
                    <td><BufferingCell d={v} /></td>
                    <td className="nowrap">{timeOfDay(v.firstSeen)}</td>
                    <td className="nowrap">{timeOfDay(v.lastSeen)}</td>
                    <td className="mono">{v.userId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="session-block">
          <h4>Streams ({streams.length})</h4>
          {streams.length === 0 ? <p className="muted">No stream was started.</p>
            : streams.map((s, n) => (
              <StreamCard key={s.id} s={{
                n: n + 1, started: true, decision: s.decision, reason: s.reason, notes: s.notes, kbps: s.kbps, engine: s.engine,
                quality: s.quality, variantKey: s.variantKey, hlsSessionId: s.hlsSessionId, audioStreamId: s.audioStreamId,
                subtitleStreamId: s.subtitleStreamId, ownerName: nameOf(s.ownerUserId), ownerUserId: s.ownerUserId, offsetS: s.offsetS,
                startedAt: s.startedAt, endedAt: s.endedAt, peakViewers: s.peakViewers,
              }} />
            ))}
        </div>
      </section>

      <section className="card">
        <div className="panel-head">
          <h3>Session overview</h3>
          <span className="muted small">Playback, each stream and each viewer over time. Hover any bar or mark for details.</span>
        </div>
        <SessionChart data={data} />
      </section>

      <section className="card">
        <div className="panel-head">
          <h3>Key moments</h3>
          <span className="muted small">What changed during the session, and why.</span>
        </div>
        <KeyMoments data={data} />
      </section>

      <Timeline events={events} />
    </>
  );
}

const ALL_GROUPS: EventGroup[] = ["playback", "people", "streams", "problems", "other"];

function Timeline({ events }: { events: PlayEvent[] }) {
  const [shown, setShown] = useState<Set<EventGroup>>(() => new Set(ALL_GROUPS));
  const [open, setOpen] = useState<number | null>(null);
  const counts = new Map<EventGroup, number>();
  for (const e of events) counts.set(groupOf(e), (counts.get(groupOf(e)) ?? 0) + 1);
  const list = events.filter((e) => shown.has(groupOf(e)));
  const toggle = (g: EventGroup) => {
    const next = new Set(shown);
    if (next.has(g)) next.delete(g); else next.add(g);
    setShown(next);
  };
  return (
    <section className="card">
      <div className="panel-head">
        <h3>All events <span className="muted">({events.length})</span></h3>
        <div className="chips" role="group" aria-label="Filter events">
          {ALL_GROUPS.filter((g) => counts.get(g)).map((g) => (
            <button key={g} className={`chip g-${g} ${shown.has(g) ? "on" : ""}`} aria-pressed={shown.has(g)} onClick={() => toggle(g)}>
              <span className={`marker g-${g}`} />{GROUP_LABELS[g]} <span className="muted">{counts.get(g)}</span>
            </button>
          ))}
        </div>
      </div>
      {list.length === 0 ? <p className="empty">No events match the selected filters.</p> : (
        <ol className="timeline">
          {list.map((e) => (
            <li key={e.id} className={`event ${eventTone(e)}`}>
              <button className="event-head" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>
                <span className={`marker g-${groupOf(e)} ${eventTone(e)}`} />
                <span className="event-time mono">{timeOfDay(e.at)}</span>
                <span className="event-pos mono">{e.posS === null ? "" : clock(e.posS)}</span>
                <span className="event-text">{eventText(e)}</span>
              </button>
              {open === e.id && (
                <dl className="grid event-detail">
                  <dt>Event</dt><dd className="mono">{e.kind}</dd>
                  <dt>Time</dt><dd>{dateTime(e.at)}</dd>
                  <dt>Playback position</dt><dd>{e.posS === null ? "—" : clock(e.posS)}</dd>
                  <dt>Viewer</dt><dd>{e.userId ? <><Who id={e.userId} name={e.username} /> <span className="mono muted">{e.userId}</span></> : "—"}</dd>
                  {Object.entries(e.detail ?? {}).map(([k, v]) => (
                    <span key={k} style={{ display: "contents" }}>
                      <dt>{k}</dt><dd className="mono">{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
                    </span>
                  ))}
                </dl>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
