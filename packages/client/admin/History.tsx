import { Fragment, useState } from "react";
import { api } from "./api";
import type { HealthPoint, PlayEvent, PlayStream, PlaySummary, PlayViewer, ProcessingStep } from "./types";
import { bytes, clock, dateTime, dayTime, duration, short, shortTime, timeOfDay } from "./format";
import {
  BlockHead, BufferingCell, bufferingTone, DataCell, Downloads, eventText, eventTone, GROUP_LABELS, groupOf, PlaceName, SectionNav, useLoad, Where, Who,
  type EventGroup,
} from "./parts";
import { StreamCard } from "./streams";
import { KeyMoments, SessionTimeline, Watched } from "./timeline";
import { eventDetails, newestFirst, streamLabel, type EventContext } from "./events";
import { clientName, clientsOf, formatsText, rolesOf } from "./clients";
import { MiniChart } from "./lazy";
import { Icon } from "./icons";
import { Poster, titleLine, useTitles } from "./titles";
import { Avatar, pct, ShareList, SplitBar } from "./viz";
import { awayOf, loadTimes, pausesByPerson, pausesOf, type LoadStats } from "./session";
import { PROCESSING_HELP, processingName, stepDetail } from "./processing";
import { healthSummary, type HealthSummary } from "./lanes";
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
        : p.endCause === "co-host" ? "Title started at a co-host's request"
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
            {sub ? `${sub} · ` : ""}{dayTime(p.startedAt)} · Host: {p.hostName ?? p.hostUserId ?? "unknown"}
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
              : <span className="badge good">Direct play / stream</span>}
          <span className="play-label">{p.streams} {p.streams === 1 ? "stream" : "streams"}</span>
        </span>
        <span className="play-col data-col">
          <strong>{bytes(p.bytes)}</strong>
          <SplitBar server={p.botBytes} cache={p.cacheBytes} peers={p.p2pBytes} legend={false} />
        </span>
        <span className="play-col">
          <span className={`health ${stallTone}`}><span className={`dot ${stallTone}`} />{p.stalls === 0 ? "No buffering" : `${p.stalls} buffering ${p.stalls === 1 ? "event" : "events"}`}</span>
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
  const pauses = pausesOf(events, play.endedAt ?? Date.now());
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
              <span className="fact"><Icon name="clock" size={14} />{dayTime(play.startedAt)}{play.endedAt ? ` – ${new Date(play.endedAt).toDateString() === new Date(play.startedAt).toDateString() ? shortTime(play.endedAt) : dayTime(play.endedAt)}` : " – now"}</span>
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
                <span className="kpi-sub">{transcoded ? `${transcoded} transcoded` : "Direct play / stream"}</span></div>
              <div className="kpi"><span className="kpi-label">Data delivered</span><span className="kpi-value">{bytes(server + cache + peers)}</span>
                <SplitBar server={server} cache={cache} peers={peers} legend="compact" /></div>
              <div className={`kpi ${health}`}><span className="kpi-label">Buffering</span>
                <span className="kpi-value">{stalls === 0 ? "None" : `${stalls} ${stalls === 1 ? "event" : "events"}`}</span>
                <span className="kpi-sub">{stalls ? `${duration(stalledMs)} in total` : "No interruptions"}{errors ? ` · ${errors} errors` : ""}</span></div>
              <div className="kpi"><span className="kpi-label">Pauses</span>
                <span className="kpi-value">{pauses.length === 0 ? "None" : pauses.length}</span>
                <span className="kpi-sub">{pauses.length ? `${duration(pauses.reduce((s, p) => s + p.ms, 0))} paused in total` : "Played without pausing"}</span></div>
            </div>
          </div>
        </div>

      </section>

      <SectionNav sections={[
        ["timeline", "Timeline"], ["viewers", "Viewers"], ["moments", "Key moments"], ["coverage", "Viewing coverage"],
        ["streams", "Streams"], ["processing", "Media processing"], ...((data.shares?.length ?? 0) > 0 ? [["sharing", "Peer-to-peer sharing"] as [string, string]] : []),
        ["events", "Event log"],
      ]} />

      <section className="card" id="sec-timeline">
        <BlockHead title="Session timeline"
          help="Playback, position in the title, streams, viewers, data delivered and player health on one time axis. Hover over or tap the chart for the values at that moment." />
        <SessionTimeline data={data} durationS={i?.durationS ?? null} ctx={ctx} />
      </section>

      <section className="card" id="sec-viewers">
        <BlockHead title={`Viewers (${viewers.length})`}
          help="What each viewer watched and received, their buffering, pauses, loading times and time away from Discord. Select a viewer for their roles, clients and each pause." />
        <SessionViewers viewers={viewers} events={events} lead={data.lead ?? []} streams={streams} ctx={ctx} end={play.endedAt ?? Date.now()}
          health={data.health ?? {}} />
      </section>

      <section className="card" id="sec-moments">
        <BlockHead title="Key moments" help="Significant events and their causes, newest first." />
        <KeyMoments data={data} ctx={ctx} />
      </section>

      <section className="card" id="sec-coverage">
        <BlockHead title="Viewing coverage"
          help="Portions of the title watched by each viewer, on the title's runtime, with seeks, buffering and player errors marked." />
        <Watched data={data} durationS={i?.durationS ?? null} />
      </section>

      <section className="card" id="sec-streams">
        <BlockHead title={`Streams (${streams.length})`}
          help="Each stream the server sent: whether it was played directly or transcoded and why, its tracks and its viewers." />
        {streams.length === 0 ? <p className="muted">No stream was started.</p>
          : streams.map((s, n) => (
            <StreamCard key={s.id} s={{
              n: n + 1, started: true, decision: s.decision, reason: s.reason, notes: s.notes, kbps: s.kbps, engine: s.engine,
              quality: s.quality, variantKey: s.variantKey, hlsSessionId: s.hlsSessionId, audioStreamId: s.audioStreamId,
              subtitleStreamId: s.subtitleStreamId, ownerName: nameOf(s.ownerUserId), ownerUserId: s.ownerUserId, offsetS: s.offsetS,
              startedAt: s.startedAt, endedAt: s.endedAt, peakViewers: s.peakViewers, tracks: i?.tracks ?? null,
            }} />
          ))}
      </section>

      <section className="card" id="sec-processing">
        <BlockHead title="Media processing"
          help="How long the server took to analyse the file, set up each stream, produce its first segment, extract subtitles and generate seek previews." />
        <ProcessingTable steps={data.processing ?? []} streams={streams} />
      </section>

      {(data.shares?.length ?? 0) > 0 && (
        <section className="card" id="sec-sharing">
          <BlockHead title="Peer-to-peer sharing" help="Video data relayed from one viewer's player to another." />
          <ShareList shares={data.shares ?? []} nameOf={(id) => nameOf(id) ?? id} />
        </section>
      )}

      <Timeline events={events} ctx={ctx} />
    </>
  );
}

/** Links to each section of a session's page; the address keeps the session, so each scrolls rather than navigates. */
/** Each step of preparing the title and its streams, oldest first, with how long it took. */
function ProcessingTable({ steps, streams }: { steps: ProcessingStep[]; streams: PlayStream[] }) {
  if (steps.length === 0) {
    return <p className="muted">No processing steps were recorded for this session. Sessions recorded before this version have none.</p>;
  }
  const streamOf = (id: string | null) => {
    const n = id ? streams.findIndex((s) => s.hlsSessionId === id) : -1;
    return n >= 0 ? `Stream ${n + 1}` : "Title";
  };
  // From reading the file to the first stream's first segment: what the first viewer waited for.
  const first = streams[0]?.hlsSessionId ?? null;
  const startup = ["probe", "stream setup", "first segment"].map((k) => steps.find((s) => s.kind === k && s.ok && (k === "probe" || s.hlsSessionId === first)));
  const startupMs = startup.every(Boolean) ? startup.reduce((sum, s) => sum + s!.ms, 0) : null;
  const sorted = [...steps].sort((a, b) => a.at - b.at || a.id - b.id);
  return (
    <>
      {startupMs !== null && (
        <div className="tiles processing-tiles">
          <div className="kpi"><span className="kpi-label">Startup</span><span className="kpi-value">{duration(startupMs)}</span>
            <span className="kpi-sub">File analysis, stream setup and first segment</span></div>
          {startup.map((s) => (
            <div key={s!.id} className="kpi"><span className="kpi-label">{processingName(s!.kind)}</span><span className="kpi-value">{duration(s!.ms)}</span>
              <span className="kpi-sub">{PROCESSING_HELP[s!.kind]}</span></div>
          ))}
        </div>
      )}
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Time</th><th>Step</th><th>Applies to</th><th className="num">Duration</th><th>Result</th><th>Details</th></tr></thead>
          <tbody>
            {sorted.map((s) => (
              <tr key={s.id}>
                <td className="nowrap mono">{timeOfDay(s.at)}</td>
                <td className="nowrap">{processingName(s.kind, typeof s.detail?.encode === "boolean" ? s.detail.encode : null)}</td>
                <td className="nowrap">{streamOf(s.hlsSessionId)}</td>
                <td className="num nowrap">{duration(s.ms)}</td>
                <td>{s.ok ? <span className="badge good">Completed</span> : <span className="badge bad">Failed</span>}</td>
                <td className="small">{stepDetail(s) || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

const ROLE: Record<string, string> = { host: "Host", "co-host": "Co-host", viewer: "Viewer" };

/**
 * A session's viewers as Activity shows them: who, on which client, on
 * which streams, what they watched, received and sent, and how it went; each
 * opens for the rest — their roles over it, the clients they moved between,
 * when, and what each played. `lead` is what each did in the room before the
 * session opened, where a host's joining is.
 */
function SessionViewers({ viewers, events, lead, streams: all, ctx, end, health }: {
  viewers: PlayViewer[]; events: PlayEvent[]; lead: PlayEvent[]; streams: PlayStream[]; ctx: EventContext; end: number;
  health: Record<string, HealthPoint[]>;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const whole = [...lead, ...events];
  const pausers = new Map(pausesByPerson(pausesOf(events, end)).map((p) => [p.userId ?? "", p]));
  return (
    <div className="table-wrap">
      <table className="table viewers">
        <thead>
          <tr>
            <th>Viewer</th><th>Streams</th><th>Watched</th><th>Data received</th><th className="num">Sent to peers</th><th>Buffering</th>
            <th>Pauses</th><th>Loading</th><th className="num">Away</th>
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
            const paused = pausers.get(v.userId);
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
                  <td className="nowrap">{paused ? <>{paused.count}<span className="muted"> · {duration(paused.totalMs)}</span></> : <span className="muted">None</span>}</td>
                  <td className="nowrap small">{loads.start || loads.seek ? <>
                    {loads.start && <span className="pause-at">Start {duration(loads.start.avgMs)}</span>}
                    {loads.seek && <span className="pause-at">Seeks {duration(loads.seek.avgMs)} avg · {loads.seek.count}×</span>}
                  </> : <span className="muted">—</span>}</td>
                  <td className="num nowrap">{awayMs > 0 ? duration(awayMs) : <span className="muted">—</span>}</td>
                  <td className="chev-cell"><span className={`chev${shown ? " open" : ""}`}><Icon name="chevron" size={16} /></span></td>
                </tr>
                {shown && (
                  <tr className="detail-row">
                    <td colSpan={10}>
                      <div className="detail-groups quad">
                      <section className="detail-group">
                      <h5>User and client</h5>
                      <dl className="grid">
                        <dt>Discord user ID</dt><dd className="mono">{v.userId}</dd>
                        <dt>First seen</dt><dd>{dayTime(v.firstSeen)}</dd>
                        <dt>Last seen</dt><dd>{dayTime(v.lastSeen)}</dd>
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
                      </dl>
                      </section>
                      <section className="detail-group">
                      <h5>Playback</h5>
                      <dl className="grid">
                        <dt>Loading at the start</dt><dd>{loadText(loads.start)}</dd>
                        <dt>Loading after seeks</dt><dd>{loadText(loads.seek)}</dd>
                        <dt>Away from Discord</dt><dd>{awayMs > 0 ? duration(awayMs) : "Never"}</dd>
                        <dt>Pauses</dt>
                        <dd>{!paused ? "None" : paused.pauses.map((x, n) => (
                          <span key={n} className="client-span">{timeOfDay(x.at)}{x.posS !== null ? <span className="muted"> · at {clock(x.posS)}</span> : null}
                            <span className="muted"> · {duration(x.ms)}{x.open ? " (until the end)" : ""}</span></span>
                        ))}</dd>
                      </dl>
                      </section>
                      <section className="detail-group">
                      <h5>Player health</h5>
                      <dl className="grid">
                        <PlayerHealth h={healthSummary(health[v.userId] ?? [])} />
                      </dl>
                      </section>
                      <section className="detail-group">
                      <h5>Data</h5>
                      <dl className="grid">
                        <dt>Received from the server</dt><dd>{bytes(v.botBytes)}</dd>
                        <dt>Received from Discord's cache</dt><dd>{bytes(Math.min(v.edgeHitBytes, v.httpBytes))}</dd>
                        <dt>Received from other viewers</dt><dd>{bytes(v.p2pBytes)}</dd>
                        <dt>Sent to other viewers</dt><dd>{bytes(v.upBytes)}</dd>
                      </dl>
                      </section>
                      </div>
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

/** "3 times, 2.1 s on average, 4 s at most". */
function loadText(s: LoadStats | null): string {
  if (!s) return "None recorded";
  return s.count === 1 ? `Once, ${duration(s.avgMs)}` : `${s.count} times, ${duration(s.avgMs)} on average, ${duration(s.longestMs)} at most`;
}

/** A viewer's player over the session, from its samples every 10 seconds: sync, buffers, frames, rate, peers, memory. */
function PlayerHealth({ h }: { h: HealthSummary }) {
  if (h.samples === 0) return <><dt>Player health</dt><dd className="muted">Not recorded for this session</dd></>;
  const secs = (s: number) => duration(s * 1000);
  const range = (avg: number | null, low: number | null) => (avg === null || low === null ? "Not reported" : `${secs(avg)} on average, ${secs(low)} at lowest`);
  const frames = h.framesShown === null && h.framesDropped === null ? null : (h.framesShown ?? 0) + (h.framesDropped ?? 0);
  const rate = (x: number) => `${Number(x.toFixed(2))}×`;
  return (
    <>
      <dt>Sync offset</dt>
      <dd>{h.syncAvgS === null || h.syncMaxS === null ? "None: the session's position follows this player (host)"
        : `${h.syncAvgS.toFixed(1)} s on average, ${h.syncMaxS.toFixed(1)} s at most`}</dd>
      <dt>Forward buffer</dt><dd>{range(h.aheadAvgS, h.aheadMinS)}</dd>
      <dt>Media element buffer</dt><dd>{range(h.bufferAvgS, h.bufferMinS)}</dd>
      <dt>Frames dropped</dt>
      <dd>{frames === null ? "Not reported by this client"
        : `${(h.framesDropped ?? 0).toLocaleString("en")} of ${frames.toLocaleString("en")}${frames > 0 ? ` (${(((h.framesDropped ?? 0) / frames) * 100).toFixed(1)}%)` : ""}`}</dd>
      <dt>Playback rate</dt>
      <dd>{h.rateMin === null || h.rateMax === null ? "Not reported"
        : h.rateMin === 1 && h.rateMax === 1 ? "1× throughout" : `${rate(h.rateMin)} – ${rate(h.rateMax)} while correcting sync`}</dd>
      <dt>Peers</dt><dd>{h.peersMax === null ? "Not reported" : h.peersMax === 0 ? "None" : `Up to ${h.peersMax}`}</dd>
      <dt>Player memory</dt><dd>{h.memoryMaxMb === null ? "Not reported" : `${Math.round(h.memoryMaxMb)} MB at most (JavaScript heap)`}</dd>
    </>
  );
}

const ALL_GROUPS: EventGroup[] = ["playback", "people", "streams", "problems", "other"];

function Timeline({ events, ctx }: { events: PlayEvent[]; ctx: EventContext }) {
  const [shown, setShown] = useState<Set<EventGroup>>(() => new Set());
  const [open, setOpen] = useState<number | null>(null);
  const counts = new Map<EventGroup, number>();
  for (const e of events) counts.set(groupOf(e), (counts.get(groupOf(e)) ?? 0) + 1);
  const list = newestFirst(shown.size === 0 ? events : events.filter((e) => shown.has(groupOf(e))));
  const toggle = (g: EventGroup) => {
    const next = new Set(shown);
    if (next.has(g)) next.delete(g); else next.add(g);
    setShown(next);
  };
  return (
    <section className="card" id="sec-events">
      <BlockHead title={`Event log (${shown.size ? `${list.length} of ${events.length}` : events.length})`}
        help="Every recorded event, newest first. Select one or more types to show only those; with none selected, every event is shown." />
      <div className="panel-head">
        <div className="chips" role="group" aria-label="Show only these event types">
          {ALL_GROUPS.filter((g) => counts.get(g)).map((g) => (
            <button key={g} className={`chip g-${g} ${shown.has(g) ? "on" : ""}`} aria-pressed={shown.has(g)} onClick={() => toggle(g)}>
              <span className={`marker g-${g}`} />{GROUP_LABELS[g]} <span className="muted">{counts.get(g)}</span>
            </button>
          ))}
          {shown.size > 0 && <button type="button" className="link" onClick={() => setShown(new Set())}>Show all</button>}
        </div>
      </div>
      {list.length === 0 ? <p className="empty">No events match the selected types.</p> : (
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
