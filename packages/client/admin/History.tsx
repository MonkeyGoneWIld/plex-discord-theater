import { useState } from "react";
import { api } from "./api";
import type { PlayDetail, PlayEvent, PlayStream, PlaySummary } from "./types";
import { bytes, clock, quality, rate, utc, utcTime } from "./format";
import {
  BufferingCell, DataCell, eventText, eventTone, GROUP_LABELS, groupOf, NotesList, useLoad, Where, Who,
  type EventGroup,
} from "./parts";

const PAGE = 50;

function ended(p: { endedAt: number | null; endReason: string | null; endBy: string | null }) {
  if (p.endedAt === null) return <span className="badge good">Playing now</span>;
  const why = p.endReason === "stopped" ? `Stopped${p.endBy ? ` by ${p.endBy}` : ""}`
    : p.endReason === "another title" ? "Another title played"
      : p.endReason === "room closed" ? "Everybody left"
        : p.endReason === "server stopped" ? "The bot stopped"
          : p.endReason === "server restarted" ? "The bot stopped without warning"
            : p.endReason ?? "Ended";
  return <span className="muted">{why}</span>;
}

/** Every play, newest first; one opens to all of it. */
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
  return (
    <section className="card">
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setQuery(q); setPages([undefined]); }}>
        <label className="grow">
          <span>Find a title, a person's name or Discord ID, or a server or channel ID</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ghost Stories, crispymage, 4021…" />
        </label>
        <button type="submit">Find</button>
        {query && <button type="button" className="ghost" onClick={() => { setQ(""); setQuery(""); setPages([undefined]); }}>Show all</button>}
      </form>
      {busy && !data ? <p className="empty">Loading…</p> : plays.length === 0 ? (
        <p className="empty">{query ? "Nothing matches." : "Nothing has played since the admin page was turned on."}</p>
      ) : (
        <div className="table-wrap">
          <table className="table rows">
            <thead>
              <tr>
                <th>Started</th><th>Title</th><th>Where</th><th>Host</th><th>Viewers</th><th>Played</th>
                <th>Streams</th><th>Data</th><th>Stalls</th><th>Ended</th>
              </tr>
            </thead>
            <tbody>
              {plays.map((p) => <PlayRow key={p.id} p={p} />)}
            </tbody>
          </table>
        </div>
      )}
      <div className="pager">
        <button className="ghost" disabled={pages.length < 2} onClick={() => setPages(pages.slice(0, -1))}>Newer</button>
        <button className="ghost" disabled={plays.length < PAGE} onClick={() => setPages([...pages, plays[plays.length - 1].id])}>Older</button>
      </div>
    </section>
  );
}

function PlayRow({ p }: { p: PlaySummary }) {
  const open = () => { location.hash = `history/${p.id}`; };
  return (
    <tr className="link-row" onClick={open} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") open(); }}>
      <td className="nowrap">{utc(p.startedAt)}</td>
      <td className="title-cell"><a href={`#history/${p.id}`} onClick={(e) => e.stopPropagation()}><strong>{p.title ?? p.ratingKey}</strong></a></td>
      <td><Where guildId={p.guildId} channelId={p.channelId} /></td>
      <td>{p.hostName ?? p.hostUserId ?? "—"}</td>
      <td>{p.names.length ? p.names.join(", ") : "—"}</td>
      <td className="nowrap">{clock(p.playedS)}</td>
      <td className="nowrap">{p.streams}{p.reencoded ? ` · ${p.reencoded} re-encoded` : ""}</td>
      <td className="nowrap">{bytes(p.bytes)}</td>
      <td>{p.stalls || "—"}</td>
      <td>{ended(p)}</td>
    </tr>
  );
}

function PlayPage({ id, onError }: { id: number; onError: (e: unknown) => void }) {
  const { data, busy, reload } = useLoad(() => api.play(id), [id], onError);
  if (!data) return <p className="empty">{busy ? "Loading…" : "No such play."}</p>;
  const { play, viewers, streams, events } = data;
  const nameOf = (userId: string | null) => viewers.find((v) => v.userId === userId)?.username ?? userId;
  return (
    <>
      <div className="crumbs"><a href="#history">← History</a></div>
      <section className="card">
        <header className="room-head">
          <div>
            <h3>{play.title ?? play.ratingKey}</h3>
            <div className="room-meta">
              {ended(play)}
              <span>Played {clock(play.playedS)}</span>
              <span>From {clock(play.startPosS ?? 0)} to {clock(play.lastPosS ?? 0)}</span>
              <span>Most watching at once: {play.peakViewers}</span>
              {play.endedAt === null && <button className="link" onClick={reload}>Refresh</button>}
            </div>
          </div>
          <dl className="room-ids">
            <dt>Host</dt><dd><Who id={play.hostUserId} name={play.hostName} /></dd>
            <dt>Server</dt><dd className="mono">{play.guildId ?? "—"}</dd>
            <dt>Channel</dt><dd className="mono">{play.channelId ?? "—"}</dd>
            <dt>Room</dt><dd className="mono">{play.roomId}</dd>
            <dt>Started</dt><dd>{utc(play.startedAt)}</dd>
            <dt>Ended</dt><dd>{play.endedAt ? utc(play.endedAt) : "—"}</dd>
            <dt>Plex item</dt><dd className="mono">{play.ratingKey}</dd>
          </dl>
        </header>

        <h4>Viewers ({viewers.length})</h4>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Person</th><th>Discord ID</th><th>Role</th><th>Watched</th><th>Data</th><th>Buffering</th><th>First seen</th><th>Last seen</th></tr>
            </thead>
            <tbody>
              {viewers.map((v) => (
                <tr key={v.userId}>
                  <td><Who id={v.userId} name={v.username} /></td>
                  <td className="mono">{v.userId}</td>
                  <td>{v.role === "host" ? "Host" : v.role === "co-host" ? "Co-host" : "Viewer"}</td>
                  <td className="nowrap">{clock(v.watchedS)}</td>
                  <td><DataCell d={v} /></td>
                  <td><BufferingCell d={v} /></td>
                  <td className="nowrap">{utcTime(v.firstSeen)}</td>
                  <td className="nowrap">{utcTime(v.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h4>Streams ({streams.length})</h4>
        {streams.length === 0 ? <p className="muted">None was started.</p>
          : streams.map((s, i) => <StreamCard key={s.id} n={i + 1} s={s} ownerName={nameOf(s.ownerUserId)} />)}
      </section>

      <Timeline events={events} />
    </>
  );
}

function StreamCard({ n, s, ownerName }: { n: number; s: PlayStream; ownerName: string | null }) {
  const [open, setOpen] = useState(false);
  const badge = s.decision === "copy" ? <span className="badge good">Direct copy</span>
    : s.decision === "transcode" ? <span className="badge warn">Re-encoded</span>
      : <span className="badge muted">No details</span>;
  const why = s.decision === "transcode" ? s.reason ?? "No reason given"
    : s.decision === "copy"
      ? s.notes.audio === "transcode" ? `Video copied; audio converted${s.notes.audioReason ? `: ${s.notes.audioReason}` : ""}` : "Video and audio copied from the file"
      : "Its playlist was never made";
  return (
    <div className={`stream ${open ? "open" : ""}`}>
      <button className="stream-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="chev" aria-hidden>{open ? "▾" : "▸"}</span>
        <span className="stream-main">
          <span className="stream-line">
            <span className="muted">#{n}</span>{badge}<span className="stream-why">{why}</span>
          </span>
          <span className="stream-sub">
            {s.engine === "ffmpeg" ? "FFmpeg" : s.engine === "plex" ? "Plex" : "—"}
            {" · "}{rate(s.kbps)}{" · "}{quality(s.quality ?? 0)}
            {" · "}for {ownerName ?? "the room"}
            {" · "}{utcTime(s.startedAt)}–{s.endedAt ? utcTime(s.endedAt) : "now"} UTC
            {" · "}most watching {s.peakViewers}
          </span>
        </span>
      </button>
      {open && (
        <div className="stream-detail">
          <dl className="grid">
            <dt>Stream</dt><dd className="mono">{s.variantKey ?? "—"}</dd>
            <dt>HLS session</dt><dd className="mono">{s.hlsSessionId}</dd>
            <dt>Audio track</dt><dd className="mono">{s.audioStreamId ?? "—"}</dd>
            <dt>Burned-in subtitle</dt><dd className="mono">{s.subtitleStreamId || "None"}</dd>
            <dt>Made for</dt><dd>{ownerName ?? "The room"} <span className="mono muted">{s.ownerUserId ?? ""}</span></dd>
            <dt>Starts at</dt><dd>{clock(s.offsetS ?? 0)} into the title</dd>
            <dt>Started</dt><dd>{utc(s.startedAt)}</dd>
            <dt>Ended</dt><dd>{utc(s.endedAt)}</dd>
          </dl>
          <NotesList notes={s.notes} />
        </div>
      )}
    </div>
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
      <div className="room-head">
        <h3>What happened ({events.length})</h3>
        <div className="chips" role="group" aria-label="Show">
          {ALL_GROUPS.filter((g) => counts.get(g)).map((g) => (
            <button key={g} className={`chip ${shown.has(g) ? "on" : ""}`} aria-pressed={shown.has(g)} onClick={() => toggle(g)}>
              {GROUP_LABELS[g]} <span className="muted">{counts.get(g)}</span>
            </button>
          ))}
        </div>
      </div>
      {list.length === 0 ? <p className="empty">Nothing to show.</p> : (
        <ol className="timeline">
          {list.map((e) => (
            <li key={e.id} className={`event ${eventTone(e)}`}>
              <button className="event-head" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>
                <span className="event-time mono">{utcTime(e.at)}</span>
                <span className="event-pos mono">{e.posS === null ? "" : clock(e.posS)}</span>
                <span className="event-text">{eventText(e)}</span>
              </button>
              {open === e.id && (
                <dl className="grid event-detail">
                  <dt>What</dt><dd className="mono">{e.kind}</dd>
                  <dt>When</dt><dd>{utc(e.at)}</dd>
                  <dt>Where in the title</dt><dd>{e.posS === null ? "—" : clock(e.posS)}</dd>
                  <dt>Who</dt><dd>{e.userId ? <><Who id={e.userId} name={e.username} /> <span className="mono muted">{e.userId}</span></> : "—"}</dd>
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
