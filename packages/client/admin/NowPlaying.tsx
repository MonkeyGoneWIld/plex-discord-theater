import { useEffect, useState } from "react";
import type { Client, Overview, PlayDetail, Room, Stream } from "./types";
import { api } from "./api";
import { drift, SessionTimeline } from "./timeline";
import { ago, bytes, clock, dayTime, duration, quality, rate, seconds, zoneLabel } from "./format";
import { BlockHead, BufferingCell, bufferingTone, DataCell, DecisionBadge, decisionOf, PlaceName } from "./parts";
import { switchedText, trackName } from "./events";
import { clientName, formatsText } from "./clients";
import { StreamCard, type StreamInfo } from "./streams";
import { Icon } from "./icons";
import { Poster, titleLine, useTitles } from "./titles";
import { Avatar, bps, pct, Progress, ShareList, Spark, SplitBar, Stat, type FlowPoint } from "./viz";


type State = "playing" | "paused" | "waiting" | "idle";

const stateOf = (room: Room): State => (!room.ratingKey ? "idle" : room.waiting ? "waiting" : room.playing ? "playing" : "paused");
const STATE: Record<State, { label: string; tone: string }> = {
  playing: { label: "Playing", tone: "good" },
  paused: { label: "Paused", tone: "muted" },
  waiting: { label: "Waiting for the host", tone: "warn" },
  idle: { label: "Idle", tone: "muted" },
};

/**
 * What a room waiting for the host's picture is waiting through: the room
 * holds only for the host, and everybody else catches up while it plays.
 */
const WAITING: Record<string, string> = {
  "a stream is starting": "Starting", "a seek": "Loading after a seek", resumed: "Resuming",
  "the host's stream is being rebuilt": "Host's stream restarting", "the host is waiting for its stream": "Host loading",
  "new host": "New host loading", "everybody left": "Waiting for the host",
};
function stateLabel(room: Room, state: State): string {
  if (state !== "waiting") return STATE[state].label;
  const did = switchedText(room.switching);
  if (did) return `Host ${did}`;
  return WAITING[room.waitingWhy ?? ""] ?? STATE.waiting.label;
}

/** A person's name where it is known: from the room, or from the history for somebody who has left. */
const known = (room: Room, userId: string | null | undefined) =>
  (userId ? room.clients.find((c) => c.userId === userId)?.username ?? room.names?.[userId] ?? null : null);
const nameOf = (room: Room, userId: string | null) => (userId ? known(room, userId) ?? userId : "—");

const listed = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** A room everybody has left, in a sentence: who it is kept for. */
function heldNote(room: Room): string {
  const host = known(room, room.heldFor?.hostUserId ?? room.discord.hostUserId);
  return `All viewers have left. The session is retained briefly so that ${host ?? "the host"} can resume from the same position.`;
}

/** Viewers who left a stream of their own a moment ago: by name, or by how many when a name isn't known. */
function awayNote(room: Room): string {
  const n = room.away.length;
  const names = room.away.map((a) => known(room, a.userId)).filter((name): name is string => !!name);
  const who = names.length === n ? listed(names) : n === 1 ? "A viewer" : `${n} viewers`;
  return `${who} disconnected recently. ${n === 1 ? "Their stream is" : "Their streams are"} retained briefly in case they reconnect.`;
}

/** What a room's players need each second to keep playing: each watched stream's bitrate, once a viewer. Nothing while paused. */
const requiredBps = (room: Room) => (room.playing ? room.streams.reduce((sum, s) => sum + (s.kbps ?? 0) * 1000 * s.viewers.length, 0) : 0);

/** What a room's viewers have received this session, by source. */
function sessionTotals(room: Room) {
  let server = 0, cache = 0, peers = 0, stalls = 0, stalledMs = 0, errors = 0;
  for (const c of room.clients) {
    if (!c.data) continue;
    server += c.data.botBytes;
    cache += Math.min(c.data.edgeHitBytes, c.data.httpBytes);
    peers += c.data.p2pBytes;
    stalls += c.data.stalls;
    stalledMs += c.data.stalledMs;
    errors += c.data.errors;
  }
  return { server, cache, peers, total: server + cache + peers, stalls, stalledMs, errors };
}

/** A room's stream, as the shared card takes it. */
function infoOf(room: Room, stream: Stream, n: number, tracks: Record<string, string> | null): StreamInfo {
  return {
    n, started: !!stream.hlsSessionId, decision: stream.decision, reason: stream.reason, notes: stream.notes, kbps: stream.kbps,
    kbpsSource: stream.kbpsSource, engine: stream.engine, quality: stream.quality, variantKey: stream.variantKey,
    hlsSessionId: stream.hlsSessionId, audioStreamId: stream.audioStreamId, subtitleStreamId: stream.subtitleStreamId,
    ownerName: stream.ownerUserId ? nameOf(room, stream.ownerUserId) : null, ownerUserId: stream.ownerUserId, offsetS: stream.sessionOffset,
    isHostStream: stream.isHostStream, viewers: stream.viewers.map((id) => ({ id, name: nameOf(room, id) })), idleS: stream.idleS,
    plexTranscodeKey: stream.plexTranscodeKey, plexClientId: stream.plexClientId, notesAt: stream.notesAt, tracks,
    progress: stream.progress ?? null,
  };
}

const forS = (ms: number | null | undefined) => (ms ? ` · ${Math.round(ms / 1000)} s` : "");

/**
 * What a viewer is doing, from their player's own log when the history is
 * recorded: "Buffering" only while it has stopped for data mid-play. Loading
 * the start or after a seek is not buffering, and neither is a player with
 * under 15 seconds in hand that is still playing (the room's "loading").
 */
function status(c: Client, idle = false): { text: string; tone: string } {
  if (!c.connected) return { text: "Disconnected", tone: "bad" };
  // No title selected: nothing to watch, whatever the player says.
  if (idle) return { text: c.away ? "Away" : "Browsing the library", tone: "muted" };
  if (c.away) return { text: "Away", tone: "muted" };
  const p = c.player;
  if (p?.stall === "buffering") return { text: `Buffering${forS(p.sinceMs)}`, tone: "warn" };
  if (p?.stall === "start") return { text: `Loading at start${forS(p.sinceMs)}`, tone: "muted" };
  if (p?.stall === "seek") return { text: `Loading after seek${forS(p.sinceMs)}`, tone: "muted" };
  // Not recorded: only the room's word, that they have under 15 s in hand.
  if (p === undefined && c.loading) return { text: "Loading", tone: "muted" };
  if (c.watching && c.role !== "host" && typeof p?.driftS === "number" && Math.abs(p.driftS) > OUT_OF_SYNC_S) {
    return { text: "Out of sync", tone: "warn" };
  }
  if (c.watching) return { text: "Watching", tone: "good" };
  return { text: "Browsing the library", tone: "muted" };
}

/** Past this far from the room a player corrects itself (client Player.tsx DRIFT_THRESHOLD_S): out of sync. */
const OUT_OF_SYNC_S = 2;

function SyncCell({ c }: { c: Client }) {
  const p = c.player;
  if (c.role === "host") return <span className="muted">Host</span>;
  if (typeof p?.driftS !== "number") return <span className="muted">—</span>;
  const off = Math.abs(p.driftS) > OUT_OF_SYNC_S;
  return <span className={off ? "warn-text" : ""}>{drift(p.driftS)}</span>;
}

function AheadCell({ c }: { c: Client }) {
  const p = c.player;
  if (typeof p?.aheadS !== "number") return <span className="muted">—</span>;
  const values = (p.health ?? []).map((h) => h[2]).filter((v): v is number => typeof v === "number");
  return (
    <span className="ahead-cell">
      <span className={p.aheadS < 10 ? "warn-text" : ""}>{seconds(p.aheadS)}</span>
      {values.length > 1 && <Spark values={values} height={18} />}
    </span>
  );
}

/**
 * The session's timeline, as History draws it, fetched again every 10
 * seconds: playback, position, streams, viewers, the data delivered and each
 * player's sync and buffer on one time axis, opening on the last half hour.
 */
function LiveTimeline({ room, tracks, durationS }: { room: Room; tracks: Record<string, string> | null; durationS: number | null }) {
  const [data, setData] = useState<PlayDetail | null>(null);
  const playId = room.playId ?? null;
  useEffect(() => {
    if (!playId) return;
    let gone = false;
    const load = () => api.play(playId).then((d) => { if (!gone) setData(d); }).catch(() => {});
    void load();
    const t = setInterval(load, 10_000);
    return () => { gone = true; clearInterval(t); };
  }, [playId]);
  if (!playId) return null;
  return (
    <div className="session-block">
      <BlockHead title="Session timeline">
        <a className="small" href={`#history/${playId}`}>Open in History →</a>
      </BlockHead>
      {data && data.play.id === playId
        ? <SessionTimeline data={data} durationS={durationS} ctx={{ tracks, streams: data.streams }} live />
        : <p className="muted">Loading the session timeline…</p>}
    </div>
  );
}

const ROLE: Record<string, string> = { host: "Host", "co-host": "Co-host", viewer: "Viewer" };

function Viewers({ room, tracks }: { room: Room; tracks: Record<string, string> | null }) {
  const [open, setOpen] = useState<string | null>(null);
  const streamOf = new Map(room.streams.map((s, i) => [s.variantKey, { n: i + 1, s }]));
  const recorded = room.clients.some((c) => c.data);
  const sampled = room.clients.some((c) => typeof c.player?.aheadS === "number");
  return (
    <div className="table-wrap">
      <table className="table viewers">
        <thead>
          <tr>
            <th>Viewer</th><th>Status</th><th>Stream</th>
            {sampled && <><th>Sync offset</th><th>Buffer</th></>}
            {recorded && <><th>Watched</th><th>Data received</th><th className="num">Sent to peers</th><th>Buffering</th></>}
            <th aria-label="Details" />
          </tr>
        </thead>
        <tbody>
          {room.clients.map((c) => {
            const st = status(c, !room.ratingKey);
            const on = c.variantKey ? streamOf.get(c.variantKey) : undefined;
            const shown = open === c.userId;
            return (
              <FragmentRows key={c.userId}>
                <tr className={`link-row${shown ? " open" : ""}`} onClick={() => setOpen(shown ? null : c.userId)}>
                  <td>
                    <span className="person">
                      <Avatar id={c.userId} name={c.username} size={28} />
                      <span>
                        <a href={`#people/${c.userId}`} onClick={(e) => e.stopPropagation()}>{c.username ?? c.userId}</a>
                        <span className={`role ${c.role}`}>{ROLE[c.role]}</span>
                        {c.device && <span className="viewer-client">{clientName(c.device)}</span>}
                      </span>
                    </span>
                  </td>
                  <td><span className={`health ${st.tone}`}><span className={`dot ${st.tone}`} />{st.text}</span></td>
                  <td>{on ? <span className="nowrap">Stream {on.n} <DecisionBadge s={{ ...on.s, started: !!on.s.hlsSessionId }} /></span> : "—"}</td>
                  {sampled && <><td className="nowrap"><SyncCell c={c} /></td><td><AheadCell c={c} /></td></>}
                  {recorded && (c.data
                    ? <><td className="nowrap">{clock(c.data.watchedS)}</td><td><DataCell d={c.data} /></td>
                      <td className="num">{c.data.upBytes > 0 ? bytes(c.data.upBytes) : "—"}</td><td><BufferingCell d={c.data} /></td></>
                    : <><td>—</td><td>—</td><td>—</td><td>—</td></>)}
                  <td className="chev-cell"><span className={`chev${shown ? " open" : ""}`}><Icon name="chevron" size={16} /></span></td>
                </tr>
                {shown && (
                  <tr className="detail-row">
                    <td colSpan={(recorded ? 8 : 4) + (sampled ? 2 : 0)}>
                      <div className="detail-groups">
                        <section className="detail-group">
                          <h5>User and client</h5>
                          <dl className="grid">
                            <dt>Discord user ID</dt><dd className="mono">{c.userId}</dd>
                            <dt>Joined</dt><dd>{dayTime(c.joinedAt)} ({ago((Date.now() - c.joinedAt) / 1000)} ago)</dd>
                            <dt>Client</dt><dd>{clientName(c.device)}</dd>
                            <dt>Supported formats</dt><dd>{formatsText(c.caps, c.av1Encode)}</dd>
                            {c.device && <><dt>User agent</dt><dd className="mono small">{c.device}</dd></>}
                          </dl>
                        </section>
                        <section className="detail-group">
                          <h5>Playback</h5>
                          <dl className="grid">
                            <dt>Stream key</dt><dd className="mono">{c.variantKey ?? "—"}</dd>
                            <dt>Quality limit</dt><dd>{quality(c.quality)}</dd>
                            <dt>Subtitle track</dt>
                            <dd>{trackName({ tracks }, c.subtitleStreamId, "Off")}{c.subtitleStreamId ? <> <span className="mono muted">{c.subtitleStreamId}</span></> : null}</dd>
                            {c.data && <>
                              <dt>Buffering</dt><dd>{c.data.stalls ? `${c.data.stalls} ${c.data.stalls === 1 ? "event" : "events"}, ${duration(c.data.stalledMs)} in total` : "None"}</dd>
                              <dt>Player errors</dt><dd>{c.data.errors || "None"}</dd>
                            </>}
                          </dl>
                        </section>
                        {c.data && (
                          <section className="detail-group">
                            <h5>Data</h5>
                            <dl className="grid">
                              <dt>Received from the server</dt><dd>{bytes(c.data.botBytes)}</dd>
                              <dt>Received from Discord's cache</dt><dd>{bytes(Math.min(c.data.edgeHitBytes, c.data.httpBytes))}</dd>
                              <dt>Received from other viewers</dt><dd>{bytes(c.data.p2pBytes)}</dd>
                              <dt>Sent to other viewers</dt><dd>{bytes(c.data.upBytes)}</dd>
                            </dl>
                          </section>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </FragmentRows>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FragmentRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function Session({ room, durationS, sub, tracks }: { room: Room; durationS: number | null; sub: string | null; tracks: Record<string, string> | null }) {
  const state = stateOf(room);
  const watching = room.clients.filter((c) => c.connected && c.watching).length;
  const totals = sessionTotals(room);
  const recorded = room.clients.some((c) => c.data);
  const required = requiredBps(room);
  const health = bufferingTone(totals);
  if (state === "idle") {
    return (
      <section className="card session idle">
        <div className="idle-head">
          <span className="idle-icon"><Icon name="film" size={22} /></span>
          <div>
            <h3>No title selected</h3>
            <div className="session-sub">
              {room.held ? heldNote(room) : `${room.clients.length} ${room.clients.length === 1 ? "person is" : "people are"} browsing the library.`}
            </div>
          </div>
          <span className="badge muted">Idle</span>
        </div>
        <Facts room={room} watching={watching} />
        {room.clients.length > 0 && <Viewers room={room} tracks={tracks} />}
      </section>
    );
  }
  return (
    <section className={`card session ${state}`}>
      <div className="session-top">
        <Poster ratingKey={room.ratingKey} title={room.title} size="lg" />
        <div className="session-main">
          <div className="session-title">
            <div>
              <h3>{room.title ?? `Plex item ${room.ratingKey}`}</h3>
              {sub && <div className="session-sub">{sub}</div>}
            </div>
            <span className={`badge big ${STATE[state].tone}`}>
              <span className={`dot ${STATE[state].tone}`} />{stateLabel(room, state)}
            </span>
          </div>
          <Progress positionS={room.positionS} durationS={durationS} state={state} />
          <Facts room={room} watching={watching} />
          <div className={`session-kpis${recorded ? " four" : ""}`}>
            <div className="kpi"><span className="kpi-label">Streams</span><span className="kpi-value">{room.streams.length}</span>
              <span className="kpi-sub"><DeliveryCounts streams={room.streams} /></span></div>
            <div className="kpi"><span className="kpi-label">Required bitrate</span><span className="kpi-value">{required ? bps(required) : "—"}</span>
              <span className="kpi-sub">{room.playing ? "All viewers combined" : "Paused"}</span></div>
            {recorded && (
              <>
                <div className="kpi"><span className="kpi-label">Data delivered</span><span className="kpi-value">{bytes(totals.total)}</span>
                  <SplitBar server={totals.server} cache={totals.cache} peers={totals.peers} legend="compact" /></div>
                <div className={`kpi ${health}`}><span className="kpi-label">Buffering</span>
                  <span className="kpi-value">{totals.stalls === 0 ? "None" : `${totals.stalls} ${totals.stalls === 1 ? "event" : "events"}`}</span>
                  <span className="kpi-sub">{totals.stalls ? `${duration(totals.stalledMs)} in total` : "No interruptions"}{totals.errors ? ` · ${totals.errors} errors` : ""}</span></div>
              </>
            )}
          </div>
        </div>
      </div>

      {(room.held || room.away.length > 0) && (
        <div className="session-block alerts">
          {room.held && <p className="note">{heldNote(room)}</p>}
          {!room.held && room.away.length > 0 && <p className="note">{awayNote(room)}</p>}
        </div>
      )}

      <div className="session-block">
        <BlockHead title={`Viewers (${room.clients.length})`} />
        <Viewers room={room} tracks={tracks} />
      </div>

      {room.streams.length > 0 && (
        <div className="session-block">
          <BlockHead title={`Streams (${room.streams.length})`} />
          {room.streams.map((s, i) => <StreamCard key={s.variantKey} s={infoOf(room, s, i + 1, tracks)} />)}
        </div>
      )}

      <LiveTimeline room={room} tracks={tracks} durationS={durationS} />

      {recorded && (room.shares?.length ?? 0) > 0 && (
        <div className="session-block">
          <BlockHead title="Peer-to-peer sharing" />
          <ShareList shares={room.shares ?? []} nameOf={(id) => nameOf(room, id)} />
        </div>
      )}

      {room.queue.length > 0 && (
        <div className="session-block">
          <BlockHead title={`Queue (${room.queue.length})`} />
          <ol className="queue-list">{room.queue.map((q, i) => <li key={`${q.ratingKey}-${i}`}>{q.title} <span className="muted">{q.type}</span></li>)}</ol>
        </div>
      )}
    </section>
  );
}

function Facts({ room, watching }: { room: Room; watching: number }) {
  return (
    <div className="facts">
      <span className="fact"><Icon name="users" size={14} />Host <strong>{nameOf(room, room.discord.hostUserId)}</strong></span>
      <span className="fact"><Icon name="people" size={14} />{room.ratingKey
        ? <><strong>{watching}</strong> of {room.clients.length} watching</>
        : <><strong>{room.clients.filter((c) => c.connected).length}</strong> connected</>}</span>
      <span className="fact"><Icon name="places" size={14} />Server <strong><PlaceName kind="guild" id={room.discord.guildId} /></strong></span>
      <span className="fact">Channel <strong><PlaceName kind="channel" id={room.discord.channelId} /></strong></span>
      <span className="fact"><Icon name="clock" size={14} />Opened {dayTime(room.discord.startedAt)}</span>
    </div>
  );
}

/** Every room's delivery, added up moment by moment. */
function allFlow(rooms: Room[]): FlowPoint[] {
  const at = new Map<number, FlowPoint>();
  for (const r of rooms) {
    for (const p of r.flow?.points ?? []) {
      const sum = at.get(p[0]) ?? [p[0], 0, 0, 0];
      at.set(p[0], [p[0], sum[1] + p[1], sum[2] + p[2], sum[3] + p[3]]);
    }
  }
  return [...at.values()].sort((a, b) => a[0] - b[0]);
}

/** Streams by how each is delivered, in the words its own badge uses: "1 direct play · 1 direct stream · 1 transcode". */
function DeliveryCounts({ streams }: { streams: Stream[] }) {
  const ways = streams.map((s) => decisionOf({ ...s, started: !!s.hlsSessionId }).label);
  const parts = ([["Direct play", "good-text"], ["Direct stream", "good-text"], ["Transcode", "warn-text"], ["Starting", "muted"], ["Not started", "muted"]] as const)
    .map(([label, cls]) => [label, cls, ways.filter((w) => w === label).length] as const).filter(([, , n]) => n > 0);
  if (parts.length === 0) return <>No active streams</>;
  return <>{parts.map(([label, cls, n], i) => (
    <span key={label}>{i > 0 && " · "}<span className={`${cls} nowrap`}>{n} {label.toLowerCase()}</span></span>
  ))}</>;
}

export function NowPlaying({ data }: { data: Overview | null }) {
  const info = useTitles((data?.rooms ?? []).map((r) => r.ratingKey));
  if (!data) return <p className="empty">Loading…</p>;
  const t = data.totals;
  const flow = allFlow(data.rooms);
  const last = flow.length ? flow[flow.length - 1] : null;
  const required = data.rooms.reduce((s, r) => s + requiredBps(r), 0);
  const stalls = data.rooms.reduce((s, r) => s + sessionTotals(r).stalls, 0);
  const recorded = data.rooms.some((r) => r.clients.some((c) => c.data));
  const playing = data.rooms.filter((r) => r.ratingKey);
  return (
    <>
      <div className="page-head">
        <h1>Activity</h1>
        <p className="muted">Times in your local time zone ({zoneLabel()}).</p>
      </div>
      <div className={`stats${recorded ? " six" : ""}`}>
        <Stat icon={<Icon name="now" />} label="Active sessions" value={playing.length}
          sub={`${t.rooms} ${t.rooms === 1 ? "room" : "rooms"} open`} />
        <Stat icon={<Icon name="users" />} label="Viewers" value={t.watching}
          sub={<><span className="nowrap">Watching now</span> · <span className="nowrap">{t.people} connected</span></>} />
        <Stat icon={<Icon name="stream" />} label="Streams" value={t.streams}
          sub={<DeliveryCounts streams={data.rooms.flatMap((r) => r.streams)} />} />
        <Stat icon={<Icon name="upload" />} label="Server upload" value={recorded ? bps(last ? last[1] : 0) : rate(t.feedKbps)}
          sub={recorded ? `Required: ${bps(required)}` : "Required bitrate of all streams"}>
          {recorded && <Spark values={flow.map((p) => p[1])} />}
        </Stat>
        {recorded && (
          <Stat icon={<Icon name="split" />} label="Current offload" value={last ? `${pct(last[2] + last[3], last[1] + last[2] + last[3])}%` : "—"}
            sub="Served by Discord's cache and peers">
            {last && <SplitBar server={last[1]} cache={last[2]} peers={last[3]} legend={false} fmt={bps} />}
          </Stat>
        )}
        {recorded && (
          <Stat icon={<Icon name="pulse" />} label="Buffering" tone={stalls === 0 ? "good" : stalls > 5 ? "bad" : "warn"}
            value={stalls === 0 ? "None" : `${stalls} ${stalls === 1 ? "event" : "events"}`} sub="Across active sessions" />
        )}
      </div>
      {data.rooms.length === 0
        ? (
          <section className="card empty-state">
            <Icon name="film" size={36} />
            <h3>No active sessions</h3>
            <p className="muted">Rooms appear here when a user launches the Activity in Discord.</p>
          </section>
        )
        : data.rooms.map((r) => {
          const i = info(r.ratingKey);
          return <Session key={r.id} room={r} durationS={i?.durationS ?? null} sub={titleLine(i)} tracks={i?.tracks ?? null} />;
        })}
    </>
  );
}
