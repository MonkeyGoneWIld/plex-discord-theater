import { Fragment, useState } from "react";
import { api } from "./api";
import type { PlayEvent, PlayStream, PlaySummary, PlayViewer } from "./types";
import { bytes, clock, dateTime, short, timeOfDay } from "./format";
import {
  BufferingCell, bufferingTone, DataCell, Downloads, eventText, eventTone, GROUP_LABELS, groupOf, PlaceName, useLoad, Where, Who,
  type EventGroup,
} from "./parts";
import { StreamCard } from "./streams";
import { KeyMoments, SessionChart, Watched } from "./timeline";
import { eventDetails, newestFirst, streamLabel, type EventContext } from "./events";
import { clientName, clientsOf, formatsText, rolesOf } from "./clients";
import { MiniChart } from "./lazy";
import { Icon } from "./icons";
import { Poster, titleLine, useTitles } from "./titles";
import { Avatar, FlowChart, pct, ShareList, SplitBar, type FlowPoint } from "./viz";
import { awayOf, loadTimes, pausesByPerson, pausesOf, type LoadStats } from "./session";
import { sessionLogsHref } from "./Logs";

const PAGE = 50;

type Ending = { endedAt: number | null; endReason: string | null; endBy: string | null; endCause?: string | null };

/** How a session ended, in a few words. */
function endText(p: Ending): string {
  if (p.endedAt === null) return "In progress";
  const by = p.endBy ? ` by ${p.endBy}` : "";
  if (p.endReason === "stopped") {
    return p.endCause === "finished" ? "Finished" : p.endCause === "closed" ? `Player closed${by}` : `Stopped${by}`;
  }
  if (p.endReason === "another title") {
    return p.endCause === "next episode" ? `Next episode started${by}`
      : p.endCause === "previous episode" ? `Previous episode started${by}`
        : p.endCause === "co-host" ? "Co-host's request started"
          : p.endCause === "queue" ? `Queued title started${by}`
            : p.endCause === "up next" || p.endCause === "end screen" ? `Next title started${by}`
              : `Another title started${by}`;
  }
  return p.endReason === "room closed" ? "All viewers left"
    : p.endReason === "server stopped" ? "Server shut down"
      : p.endReason === "server restarted" ? "Server restarted unexpectedly"
        : p.endReason ?? "Ended";
}

function EndBadge({ p }: { p: Ending }) {
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
        <p className="muted">All playback sessions, newest first. Select a session to view its viewers, streams and timeline.</p>
      </div>
      <MiniChart kind="plays" onError={onError} />
      <section className="card">
        <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setQuery(q); setPages([undefined]); }}>
          <label className="grow">
            <span>Search by title, viewer, Discord user ID, server or channel</span>
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
            {sub ? `${sub} · ` : ""}{dateTime(p.startedAt)} · Host: {p.hostName ?? p.hostUserId ?? "unknown"}
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
          <span className="play-label">Played</span>
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
          <span className={`health ${stallTone}`}><span className={`dot ${stallTone}`} />{p.stalls === 0 ? "No buffering" : `Buffered ${p.stalls} ${p.stalls === 1 ? "time" : "times"}`}</span>
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
  // Tracks and streams by name in what the page says of them.
  const ctx: EventContext = { tracks: i?.tracks ?? null, streams };
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
              <span className="fact"><Icon name="places" size={14} />Server <strong><PlaceName kind="guild" id={play.guildId} /></strong></span>
              <span className="fact">Channel <strong><PlaceName kind="channel" id={play.channelId} /></strong></span>
              <span className="fact">Room <span className="mono">{short(play.roomId, 14)}</span></span>
              <span className="fact">Plex item <span className="mono">{play.ratingKey}</span></span>
              {sessionLogsHref(play.startedAt, play.endedAt).map((href, n, all) => (
                <a key={href} className="fact" href={href}>{all.length > 1 ? `Logs, ${n === 0 ? "first" : "second"} UTC day →` : "Logs for this session →"}</a>
              ))}
              {play.endedAt === null && <button className="link" onClick={reload}>Refresh</button>}
            </div>
            <div className="session-kpis">
              <div className="kpi"><span className="kpi-label">Time played</span><span className="kpi-value">{clock(play.playedS)}</span>
                <span className="kpi-sub">{clock(play.startPosS ?? 0)} → {clock(play.lastPosS ?? 0)}{i?.durationS ? ` of ${clock(i.durationS)}` : ""}</span></div>
              <div className="kpi"><span className="kpi-label">Viewers</span><span className="kpi-value">{viewers.length}</span>
                <span className="kpi-sub">Peak of {play.peakViewers} at once</span></div>
              <div className="kpi"><span className="kpi-label">Streams</span><span className="kpi-value">{streams.length}</span>
                <span className="kpi-sub">{transcoded ? `${transcoded} transcoded` : "All direct"}</span></div>
              <div className="kpi"><span className="kpi-label">Data delivered</span><span className="kpi-value">{bytes(server + cache + peers)}</span>
                <span className="kpi-sub">{pct(cache + peers, server + cache + peers)}% offloaded from the server</span></div>
              <div className={`kpi ${health}`}><span className="kpi-label">Buffering</span>
                <span className="kpi-value">{stalls === 0 ? "None" : `${stalls} ${stalls === 1 ? "event" : "events"}`}</span>
                <span className="kpi-sub">{stalls ? `${clock(stalledMs / 1000)} in total` : "No interruptions"}{errors ? ` · ${errors} errors` : ""}</span></div>
            </div>
          </div>
        </div>

        <div className="session-block">
          <h4>Data sources</h4>
          <SplitBar server={server} cache={cache} peers={peers} />
          {(data.flow?.length ?? 0) > 1 && <SourcesOverTime flow={data.flow!} />}
        </div>

        <div className="session-block">
          <h4>Viewers ({viewers.length})</h4>
          <SessionViewers viewers={viewers} events={events} lead={data.lead ?? []} streams={streams} ctx={ctx} />
        </div>

        <div className="session-block">
          <h4>Streams ({streams.length})</h4>
          {streams.length === 0 ? <p className="muted">No stream was started.</p>
            : streams.map((s, n) => (
              <StreamCard key={s.id} s={{
                n: n + 1, started: true, decision: s.decision, reason: s.reason, notes: s.notes, kbps: s.kbps, engine: s.engine,
                quality: s.quality, variantKey: s.variantKey, hlsSessionId: s.hlsSessionId, audioStreamId: s.audioStreamId,
                subtitleStreamId: s.subtitleStreamId, ownerName: nameOf(s.ownerUserId), ownerUserId: s.ownerUserId, offsetS: s.offsetS,
                startedAt: s.startedAt, endedAt: s.endedAt, peakViewers: s.peakViewers, tracks: i?.tracks ?? null,
              }} />
            ))}
        </div>
      </section>

      <section className="card">
        <div className="panel-head">
          <h3>Session overview</h3>
          <span className="muted small">Playback position, streams and viewers over time.</span>
        </div>
        <SessionChart data={data} durationS={i?.durationS ?? null} ctx={ctx} />
      </section>

      <section className="card">
        <div className="panel-head">
          <h3>Viewing coverage</h3>
          <span className="muted small">The portions of the title each viewer watched, with buffering and errors marked.</span>
        </div>
        <Watched data={data} durationS={i?.durationS ?? null} />
      </section>

      <div className="cards-2">
        <Pauses events={events} end={play.endedAt ?? Date.now()} />
        <LoadTimes viewers={viewers} events={events} />
      </div>

      {(data.shares?.length ?? 0) > 0 && (
        <section className="card">
          <div className="panel-head">
            <h3>Peer-to-peer sharing</h3>
            <span className="muted small">Video each viewer's player sent another's.</span>
          </div>
          <ShareList shares={data.shares ?? []} nameOf={(id) => nameOf(id) ?? id} />
        </section>
      )}

      <section className="card">
        <div className="panel-head">
          <h3>Key moments</h3>
          <span className="muted small">Significant events and their causes, newest first.</span>
        </div>
        <KeyMoments data={data} ctx={ctx} />
      </section>

      <Timeline events={events} ctx={ctx} />
    </>
  );
}

const ROLE: Record<string, string> = { host: "Host", "co-host": "Co-host", viewer: "Viewer" };

/**
 * A session's viewers as Now Playing shows them: who, on which client, on
 * which streams, what they watched, received and sent, and how it went; each
 * opens for the rest — their roles over it, the clients they moved between,
 * when, and what each played. `lead` is what each did in the room before the
 * session opened, where a host's joining is.
 */
function SessionViewers({ viewers, events, lead, streams: all, ctx }: {
  viewers: PlayViewer[]; events: PlayEvent[]; lead: PlayEvent[]; streams: PlayStream[]; ctx: EventContext;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const whole = [...lead, ...events];
  return (
    <div className="table-wrap">
      <table className="table viewers">
        <thead>
          <tr>
            <th>Viewer</th><th>Streams</th><th>Watched</th><th>Data received</th><th className="num">Sent to viewers</th><th>Buffering</th>
            <th aria-label="Details" />
          </tr>
        </thead>
        <tbody>
          {viewers.map((v) => {
            const mine = events.filter((e) => e.userId === v.userId);
            const clients = clientsOf(whole, v.userId, v.firstSeen, v.lastSeen);
            const roles = rolesOf(whole, v.userId, v.firstSeen, v.lastSeen);
            const loads = loadTimes(events, v.userId);
            const awayMs = awayOf(events, v.userId, v.lastSeen).reduce((s, a) => s + (a.to - a.from), 0);
            // The streams they moved onto; else their own, or the one everyone shared.
            const onto = mine.filter((e) => e.kind === "stream changed" && e.detail?.to).map((e) => e.detail?.to);
            const own = all.filter((s) => s.ownerUserId === v.userId).map((s) => s.variantKey);
            const keys = onto.length ? onto : own.length ? own : all.filter((s) => !s.ownerUserId).slice(0, 1).map((s) => s.variantKey);
            const streams = [...new Set(keys.map((k) => streamLabel(ctx, k)))];
            const shown = open === v.userId;
            return (
              <Fragment key={v.userId}>
                <tr className={`link-row${shown ? " open" : ""}`} onClick={() => setOpen(shown ? null : v.userId)}>
                  <td>
                    <span className="person">
                      <Avatar id={v.userId} name={v.username} size={28} />
                      <span>
                        <span onClick={(e) => e.stopPropagation()}><Who id={v.userId} name={v.username} /></span>
                        <span className={`role ${v.role ?? "viewer"}`}>{ROLE[v.role ?? "viewer"] ?? "Viewer"}</span>
                        {clients.length > 0 && <span className="viewer-client">{clientName(clients.at(-1)!.device)}
                          {clients.length > 1 ? ` (${clients.length} clients)` : ""}</span>}
                      </span>
                    </span>
                  </td>
                  <td className="nowrap">{streams.length ? streams.join(", ") : "—"}</td>
                  <td className="nowrap">{clock(v.watchedS)}</td>
                  <td><DataCell d={v} /></td>
                  <td className="num">{v.upBytes > 0 ? bytes(v.upBytes) : "—"}</td>
                  <td><BufferingCell d={v} /></td>
                  <td className="chev-cell"><span className={`chev${shown ? " open" : ""}`}><Icon name="chevron" size={16} /></span></td>
                </tr>
                {shown && (
                  <tr className="detail-row">
                    <td colSpan={7}>
                      <dl className="grid">
                        <dt>Discord user ID</dt><dd className="mono">{v.userId}</dd>
                        <dt>First seen</dt><dd>{dateTime(v.firstSeen)}</dd>
                        <dt>Last seen</dt><dd>{dateTime(v.lastSeen)}</dd>
                        {roles.length > 0 && <>
                          <dt>{roles.length > 1 ? "Roles" : "Role"}</dt>
                          <dd>{roles.length === 1 ? `${ROLE[roles[0].role]} throughout`
                            : roles.map((r, n) => (
                              <span key={n} className="client-span">{ROLE[r.role]}
                                <span className="muted"> · {timeOfDay(r.from)} – {timeOfDay(r.to)}</span></span>
                            ))}</dd>
                        </>}
                        <dt>{clients.length > 1 ? "Clients" : "Client"}</dt>
                        <dd>{clients.length === 0 ? "Not recorded"
                          : clients.map((c, n) => (
                            <span key={n} className="client-span">{clientName(c.device)}
                              {clients.length > 1 && <span className="muted"> · {timeOfDay(c.from)} – {timeOfDay(c.to)}</span>}
                              <span className="client-formats">Plays {c.caps ? formatsText(c.caps, c.av1Encode) : "formats not recorded"}</span></span>
                          ))}</dd>
                        <dt>Loading at the start</dt><dd>{loadText(loads.start)}</dd>
                        <dt>Loading after seeks</dt><dd>{loadText(loads.seek)}</dd>
                        <dt>Away from the Discord window</dt><dd>{awayMs > 0 ? clock(awayMs / 1000) : "Never"}</dd>
                        <dt>Received from the server</dt><dd>{bytes(v.botBytes)}</dd>
                        <dt>Received from Discord's cache</dt><dd>{bytes(Math.min(v.edgeHitBytes, v.httpBytes))}</dd>
                        <dt>Received from other viewers</dt><dd>{bytes(v.p2pBytes)}</dd>
                        <dt>Sent to other viewers</dt><dd>{bytes(v.upBytes)}</dd>
                      </dl>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** "3 times, 2.1 s on average, 4.0 s at most". */
function loadText(s: LoadStats | null): string {
  if (!s) return "None recorded";
  return s.count === 1 ? `Once, ${(s.avgMs / 1000).toFixed(1)} s` : `${s.count} times, ${(s.avgMs / 1000).toFixed(1)} s on average, ${(s.longestMs / 1000).toFixed(1)} s at most`;
}

/** What the players had from each source over the session, minute by minute (older sessions have only the bar above). */
function SourcesOverTime({ flow }: { flow: Array<[number, number, number, number]> }) {
  // Every minute from the first to the last, a quiet one as nothing: the chart spaces its points evenly.
  const by = new Map(flow.map((m) => [m[0], m] as const));
  const points: FlowPoint[] = [];
  for (let t = flow[0][0]; t <= flow[flow.length - 1][0]; t += 60_000) {
    const m = by.get(t);
    // Bytes in a minute, as bits a second.
    points.push(m ? [t, (m[1] * 8) / 60, (m[2] * 8) / 60, (m[3] * 8) / 60] : [t, 0, 0, 0]);
  }
  return (
    <div className="sources-time">
      <p className="muted small">Over the session, a minute at a time.</p>
      <FlowChart points={points} requiredBps={null} stepS={60} height={130}
        axis={[timeOfDay(points[0][0]), timeOfDay(points[points.length - 1][0])]} label="Data sources over the session" />
    </div>
  );
}

/** Who paused, how often and for how long. */
function Pauses({ events, end }: { events: PlayEvent[]; end: number }) {
  const all = pausesOf(events, end);
  const people = pausesByPerson(all);
  return (
    <section className="card">
      <div className="panel-head">
        <h3>Pauses</h3>
        <span className="muted small">{all.length === 0 ? "Playback was never paused." : `${all.length} in all, ${clock(all.reduce((s, p) => s + p.ms, 0) / 1000)} paused.`}</span>
      </div>
      {people.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Who</th><th className="num">Pauses</th><th className="num">Paused for</th><th className="num">Longest</th><th>When</th></tr></thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.userId ?? ""}>
                  <td>{p.userId ? <Who id={p.userId} name={p.username} /> : "Unknown"}</td>
                  <td className="num">{p.count}</td>
                  <td className="num">{clock(p.totalMs / 1000)}</td>
                  <td className="num">{clock(p.longestMs / 1000)}</td>
                  <td className="small">{p.pauses.map((x, n) => (
                    <span key={n} className="pause-at">{timeOfDay(x.at)}{x.posS !== null ? ` at ${clock(x.posS)}` : ""}, {clock(x.ms / 1000)}{x.open ? " (until the end)" : ""}</span>
                  ))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** How long each viewer's player took to load at the start and after seeks, and the session's average. */
function LoadTimes({ viewers, events }: { viewers: PlayViewer[]; events: PlayEvent[] }) {
  const cell = (s: LoadStats | null) => (s ? <>{(s.avgMs / 1000).toFixed(1)} s<span className="muted"> · {s.count}× · max {(s.longestMs / 1000).toFixed(1)} s</span></> : "—");
  const session = loadTimes(events, null);
  return (
    <section className="card">
      <div className="panel-head">
        <h3>Loading times</h3>
        <span className="muted small">Average time each player took to show the picture.</span>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Viewer</th><th>At the start</th><th>After seeks</th></tr></thead>
          <tbody>
            {viewers.map((v) => {
              const l = loadTimes(events, v.userId);
              return <tr key={v.userId}><td><Who id={v.userId} name={v.username} /></td><td>{cell(l.start)}</td><td>{cell(l.seek)}</td></tr>;
            })}
            <tr className="total-row"><td>Session</td><td>{cell(session.start)}</td><td>{cell(session.seek)}</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

const ALL_GROUPS: EventGroup[] = ["playback", "people", "streams", "problems", "other"];

function Timeline({ events, ctx }: { events: PlayEvent[]; ctx: EventContext }) {
  const [shown, setShown] = useState<Set<EventGroup>>(() => new Set(ALL_GROUPS));
  const [open, setOpen] = useState<number | null>(null);
  const counts = new Map<EventGroup, number>();
  for (const e of events) counts.set(groupOf(e), (counts.get(groupOf(e)) ?? 0) + 1);
  const list = newestFirst(events.filter((e) => shown.has(groupOf(e))));
  const toggle = (g: EventGroup) => {
    const next = new Set(shown);
    if (next.has(g)) next.delete(g); else next.add(g);
    setShown(next);
  };
  return (
    <section className="card">
      <div className="panel-head">
        <h3>All events <span className="muted">({events.length}, newest first)</span></h3>
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
                <span className="event-text">{eventText(e, ctx)}</span>
              </button>
              {open === e.id && (
                <dl className="grid event-detail">
                  <dt>Type</dt><dd>{GROUP_LABELS[groupOf(e)]}</dd>
                  <dt>Time</dt><dd>{dateTime(e.at)}</dd>
                  <dt>Position</dt><dd>{e.posS === null ? "—" : clock(e.posS)}</dd>
                  {e.userId && <><dt>Viewer</dt><dd><Who id={e.userId} name={e.username} /></dd></>}
                  {eventDetails(e, ctx).map(([k, v]) => (
                    <span key={k} style={{ display: "contents" }}>
                      <dt>{k}</dt><dd>{v}</dd>
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
