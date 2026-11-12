import { useState } from "react";
import type { Client, Overview, Room, Stream } from "./types";
import { ago, bytes, clock, dateTime, quality, rate, zoneLabel } from "./format";
import { BufferingCell, bufferingTone, DataCell, DecisionBadge } from "./parts";
import { StreamCard, type StreamInfo } from "./streams";
import { Icon } from "./icons";
import { Poster, titleLine, useTitles } from "./titles";
import { Avatar, bps, FlowChart, pct, Progress, SOURCES, Spark, SplitBar, Stat, type FlowPoint } from "./viz";

/** What a player can decode (ffmpeg/plan.ts, PLAYER_CAPS), by name. */
const CAP_LABELS: Record<string, string> = {
  hevc: "HEVC", av1: "AV1", vp9: "VP9", opus: "Opus", flac: "FLAC", ac3: "AC3", eac3: "E-AC3",
  hdr: "HDR", tenBit: "10-bit", uhd: "4K", hi10: "10-bit H.264",
};

type State = "playing" | "paused" | "buffering" | "idle";

const stateOf = (room: Room): State => (!room.ratingKey ? "idle" : room.waiting ? "buffering" : room.playing ? "playing" : "paused");
const STATE: Record<State, { label: string; tone: string }> = {
  playing: { label: "Playing", tone: "good" },
  paused: { label: "Paused", tone: "muted" },
  buffering: { label: "Buffering", tone: "warn" },
  idle: { label: "Idle", tone: "muted" },
};

/** A person's name where it is known: from the room, or from the history for somebody who has left. */
const known = (room: Room, userId: string | null | undefined) =>
  (userId ? room.clients.find((c) => c.userId === userId)?.username ?? room.names?.[userId] ?? null : null);
const nameOf = (room: Room, userId: string | null) => (userId ? known(room, userId) ?? userId : "—");

const listed = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** A room everybody has left, in a sentence: who it is kept for. */
function heldNote(room: Room): string {
  const host = known(room, room.heldFor?.hostUserId ?? room.discord.hostUserId);
  return `Everyone has left. The session is kept for a short time so ${host ?? "the host"} can return and continue from where they stopped.`;
}

/** Viewers who left a stream of their own a moment ago: by name, or by how many when a name isn't known. */
function awayNote(room: Room): string {
  const n = room.away.length;
  const names = room.away.map((a) => known(room, a.userId)).filter((name): name is string => !!name);
  const who = names.length === n ? listed(names) : n === 1 ? "A viewer" : `${n} viewers`;
  return `${who} left a moment ago. ${n === 1 ? "Their stream is" : "Their streams are"} kept briefly in case they return.`;
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
function infoOf(room: Room, stream: Stream, n: number): StreamInfo {
  return {
    n, started: !!stream.hlsSessionId, decision: stream.decision, reason: stream.reason, notes: stream.notes, kbps: stream.kbps,
    kbpsSource: stream.kbpsSource, engine: stream.engine, quality: stream.quality, variantKey: stream.variantKey,
    hlsSessionId: stream.hlsSessionId, audioStreamId: stream.audioStreamId, subtitleStreamId: stream.subtitleStreamId,
    ownerName: stream.ownerUserId ? nameOf(room, stream.ownerUserId) : null, ownerUserId: stream.ownerUserId, offsetS: stream.sessionOffset,
    isHostStream: stream.isHostStream, viewers: stream.viewers.map((id) => ({ id, name: nameOf(room, id) })), idleS: stream.idleS,
    plexTranscodeKey: stream.plexTranscodeKey, plexClientId: stream.plexClientId, notesAt: stream.notesAt,
  };
}

function status(c: Client): { text: string; tone: string } {
  if (!c.connected) return { text: "Disconnected", tone: "bad" };
  if (c.away) return { text: "Away", tone: "muted" };
  if (c.loading) return { text: "Buffering", tone: "warn" };
  if (c.watching) return { text: "Watching", tone: "good" };
  return { text: "Browsing", tone: "muted" };
}

const ROLE: Record<string, string> = { host: "Host", "co-host": "Co-host", viewer: "Viewer" };

function Viewers({ room }: { room: Room }) {
  const [open, setOpen] = useState<string | null>(null);
  const streamOf = new Map(room.streams.map((s, i) => [s.variantKey, { n: i + 1, s }]));
  const recorded = room.clients.some((c) => c.data);
  return (
    <div className="table-wrap">
      <table className="table viewers">
        <thead>
          <tr>
            <th>Viewer</th><th>Status</th><th>Stream</th>
            {recorded && <><th>Watched</th><th>Data received</th><th>Buffering</th></>}
            <th aria-label="Details" />
          </tr>
        </thead>
        <tbody>
          {room.clients.map((c) => {
            const st = status(c);
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
                      </span>
                    </span>
                  </td>
                  <td><span className={`health ${st.tone}`}><span className={`dot ${st.tone}`} />{st.text}</span></td>
                  <td>{on ? <span className="nowrap">Stream {on.n} <DecisionBadge s={{ ...on.s, started: !!on.s.hlsSessionId }} /></span> : "—"}</td>
                  {recorded && (c.data
                    ? <><td className="nowrap">{clock(c.data.watchedS)}</td><td><DataCell d={c.data} /></td><td><BufferingCell d={c.data} /></td></>
                    : <><td>—</td><td>—</td><td>—</td></>)}
                  <td className="chev-cell"><span className={`chev${shown ? " open" : ""}`}><Icon name="chevron" size={16} /></span></td>
                </tr>
                {shown && (
                  <tr className="detail-row">
                    <td colSpan={recorded ? 7 : 4}>
                      <dl className="grid">
                        <dt>Discord user ID</dt><dd className="mono">{c.userId}</dd>
                        <dt>Joined</dt><dd>{dateTime(c.joinedAt)} ({ago((Date.now() - c.joinedAt) / 1000)} ago)</dd>
                        <dt>Stream key</dt><dd className="mono">{c.variantKey ?? "—"}</dd>
                        <dt>Quality limit</dt><dd>{quality(c.quality)}</dd>
                        <dt>Subtitle track</dt><dd className="mono">{c.subtitleStreamId || "Off"}</dd>
                        <dt>Player can decode</dt>
                        <dd>{c.caps.length ? c.caps.map((cap) => CAP_LABELS[cap] ?? cap).join(", ") : "H.264 and AAC only"}{c.av1Encode ? " · can encode AV1" : ""}</dd>
                        {c.data && (
                          <>
                            <dt>From the server</dt><dd>{bytes(c.data.botBytes)}</dd>
                            <dt>From Discord's cache</dt><dd>{bytes(Math.min(c.data.edgeHitBytes, c.data.httpBytes))}</dd>
                            <dt>From other viewers</dt><dd>{bytes(c.data.p2pBytes)}</dd>
                          </>
                        )}
                      </dl>
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

function Session({ room, durationS, sub }: { room: Room; durationS: number | null; sub: string | null }) {
  const state = stateOf(room);
  const watching = room.clients.filter((c) => c.connected && c.watching).length;
  const totals = sessionTotals(room);
  const recorded = room.clients.some((c) => c.data);
  const points = (room.flow?.points ?? []) as FlowPoint[];
  const now = points.length ? points[points.length - 1] : null;
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
        {room.clients.length > 0 && <Viewers room={room} />}
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
            <span className={`badge big ${STATE[state].tone}`}><span className={`dot ${STATE[state].tone}`} />{STATE[state].label}{room.hostWaiting ? " · host" : ""}</span>
          </div>
          <Progress positionS={room.positionS} durationS={durationS} state={state} />
          <Facts room={room} watching={watching} />
          <div className="session-kpis">
            <div className="kpi"><span className="kpi-label">Streams</span><span className="kpi-value">{room.streams.length}</span>
              <span className="kpi-sub">{room.streams.filter((s) => s.decision === "transcode").length} transcoding</span></div>
            <div className="kpi"><span className="kpi-label">Required bitrate</span><span className="kpi-value">{required ? bps(required) : "—"}</span>
              <span className="kpi-sub">{room.playing ? "all viewers combined" : "nothing while paused"}</span></div>
            {recorded && (
              <>
                <div className="kpi"><span className="kpi-label">Data delivered</span><span className="kpi-value">{bytes(totals.total)}</span>
                  <span className="kpi-sub">{pct(totals.cache + totals.peers, totals.total)}% not from the server</span></div>
                <div className={`kpi ${health}`}><span className="kpi-label">Buffering</span>
                  <span className="kpi-value">{totals.stalls === 0 ? "None" : `${totals.stalls} ${totals.stalls === 1 ? "event" : "events"}`}</span>
                  <span className="kpi-sub">{totals.stalls ? `${clock(totals.stalledMs / 1000)} in total` : "playback is smooth"}{totals.errors ? ` · ${totals.errors} errors` : ""}</span></div>
              </>
            )}
          </div>
        </div>
        {recorded && (
          <div className="session-flow">
            <div className="panel-head">
              <h4>Delivery · last 10 minutes</h4>
              <ul className="legend">
                {SOURCES.map((s) => <li key={s.key}><span className="swatch" style={{ background: s.color }} />{s.label}</li>)}
                <li><span className="swatch dashed" />Required</li>
              </ul>
            </div>
            <div className="flow-now">
              {SOURCES.map((s, i) => (
                <span key={s.key}><span className="swatch" style={{ background: s.color }} /><strong>{bps(now ? now[i + 1] : 0)}</strong></span>
              ))}
              {required > 0 && <span className="muted">needs {bps(required)}</span>}
            </div>
            <FlowChart points={points} requiredBps={required || null} stepS={room.flow?.stepS ?? 10} />
          </div>
        )}
      </div>

      {recorded && (
        <div className="session-block">
          <h4>Where the data came from · this session</h4>
          <SplitBar server={totals.server} cache={totals.cache} peers={totals.peers} />
        </div>
      )}

      {room.streams.length > 0 && (
        <div className="session-block">
          <h4>Streams ({room.streams.length})</h4>
          {room.streams.map((s, i) => <StreamCard key={s.variantKey} s={infoOf(room, s, i + 1)} />)}
        </div>
      )}

      <div className="session-block">
        <h4>Viewers ({room.clients.length})</h4>
        <Viewers room={room} />
      </div>

      {(room.away.length > 0 || room.queue.length > 0 || room.held) && (
        <div className="session-block">
          {room.held && <p className="note">{heldNote(room)}</p>}
          {!room.held && room.away.length > 0 && <p className="note">{awayNote(room)}</p>}
          {room.queue.length > 0 && (
            <details className="queue">
              <summary>Up next ({room.queue.length})</summary>
              <ol>{room.queue.map((q, i) => <li key={`${q.ratingKey}-${i}`}>{q.title} <span className="muted">{q.type}</span></li>)}</ol>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

function Facts({ room, watching }: { room: Room; watching: number }) {
  return (
    <div className="facts">
      <span className="fact"><Icon name="users" size={14} />Host <strong>{nameOf(room, room.discord.hostUserId)}</strong></span>
      <span className="fact"><Icon name="people" size={14} /><strong>{watching}</strong> of {room.clients.length} watching</span>
      <span className="fact" title="Discord server ID"><Icon name="places" size={14} />Server <span className="mono">{room.discord.guildId ?? "—"}</span></span>
      <span className="fact" title="Discord channel ID">Channel <span className="mono">{room.discord.channelId ?? "—"}</span></span>
      <span className="fact" title={`Room ${room.id}`}><Icon name="clock" size={14} />Opened {dateTime(room.discord.startedAt)}</span>
      {room.playId ? <a className="fact" href={`#history/${room.playId}`}>Session timeline →</a> : null}
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
        <h1>Now Playing</h1>
        <p className="muted">Every active room, updated live. Times are in your local time ({zoneLabel()}).</p>
      </div>
      <div className="stats">
        <Stat icon={<Icon name="now" />} label="Active sessions" value={playing.length}
          sub={`${t.rooms} ${t.rooms === 1 ? "room" : "rooms"} open`} />
        <Stat icon={<Icon name="users" />} label="Viewers" value={t.watching}
          sub={`${t.people} connected`} />
        <Stat icon={<Icon name="stream" />} label="Streams" value={t.streams}
          sub={<><span className="good-text">{t.copied} direct</span> · <span className={t.reencoded ? "warn-text" : ""}>{t.reencoded} transcoding</span></>} />
        <Stat icon={<Icon name="upload" />} label="Server upload" value={recorded ? bps(last ? last[1] : 0) : rate(t.feedKbps)}
          sub={recorded ? `Players need ${bps(required)} in total` : "Required bitrate of all streams"}>
          {recorded && <Spark values={flow.map((p) => p[1])} />}
        </Stat>
        {recorded && (
          <Stat icon={<Icon name="split" />} label="Delivery right now" value={last ? `${pct(last[2] + last[3], last[1] + last[2] + last[3])}% offloaded` : "—"}
            sub="Share served by Discord's cache and peers">
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
            <h3>Nothing is playing</h3>
            <p className="muted">A room appears here as soon as someone opens the Activity in Discord.</p>
          </section>
        )
        : data.rooms.map((r) => {
          const i = info(r.ratingKey);
          return <Session key={r.id} room={r} durationS={i?.durationS ?? null} sub={titleLine(i)} />;
        })}
    </>
  );
}
