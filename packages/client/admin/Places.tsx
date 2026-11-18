import { useState } from "react";
import { api } from "./api";
import type { PlaceGuild, UsageRow } from "./types";
import { dayTime, hoursMinutes } from "./format";
import { Downloads, PlaceName, useLoad, Who } from "./parts";
import { MiniChart } from "./lazy";
import { Avatar } from "./viz";

const PAGE = 50;

/** Where the bot is used: each Discord server, its channels, and who launched or joined it. */
export function Places({ onError }: { onError: (e: unknown) => void }) {
  const { data, busy } = useLoad(() => api.places(), [], onError);
  const guilds = data?.guilds ?? [];
  return (
    <>
      <div className="page-head">
        <h1>Discord Servers</h1>
        <p className="muted">Discord servers and channels where the Activity is used, with launches, users and sessions.</p>
      </div>
      <MiniChart kind="servers" onError={onError} />
      {busy && !data ? <p className="empty">Loading…</p> : guilds.length === 0
        ? <section className="card"><p className="empty">No launches have been recorded yet.</p></section>
        : guilds.map((g) => <GuildCard key={g.guildId ?? "none"} g={g} />)}
      <Launches onError={onError} />
    </>
  );
}

function GuildCard({ g }: { g: PlaceGuild }) {
  return (
    <section className="card">
      <header className="room-head">
        <div>
          <h3>{g.guildId ? <PlaceName kind="guild" id={g.guildId} /> : "Direct message or group chat"}</h3>
          {g.guildId && <div className="muted small mono">Server ID {g.guildId}</div>}
          <div className="room-meta">
            <span>{g.channels.length} {g.channels.length === 1 ? "channel" : "channels"}</span>
            <span>{g.launches} {g.launches === 1 ? "launch" : "launches"}</span>
            <span>{g.people} {g.people === 1 ? "user" : "users"}</span>
            <span>{g.plays} {g.plays === 1 ? "session" : "sessions"} · {hoursMinutes(g.playedS)} played</span>
          </div>
        </div>
        <dl className="room-ids">
          <dt>First active</dt><dd>{dayTime(g.first)}</dd>
          <dt>Last active</dt><dd>{dayTime(g.last)}</dd>
        </dl>
      </header>
      <div className="table-wrap channel-table">
        <table className="table wrap-heads">
          <thead>
            <tr><th>Channel</th><th>Launches</th><th>Joins</th><th>Users</th><th>Sessions</th><th>Time played</th><th>First active</th><th>Last active</th></tr>
          </thead>
          <tbody>
            {g.channels.map((c) => (
              <tr key={c.channelId ?? "none"}>
                <td><PlaceName kind="channel" id={c.channelId} /></td>
                <td>{c.launches || "—"}</td>
                <td>{c.joins || "—"}</td>
                <td className="users-cell"><UserList names={c.names} total={c.people} /></td>
                <td>{c.plays || "—"}</td>
                <td className="nowrap">{hoursMinutes(c.playedS)}</td>
                <td className="when-cell">{dayTime(c.first)}</td>
                <td className="when-cell">{dayTime(c.last)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* A phone: each channel as a card, its users across the full width rather than in a column scrolled sideways. */}
      <ul className="channel-cards">
        {g.channels.map((c) => (
          <li key={c.channelId ?? "none"}>
            <div className="channel-name"><PlaceName kind="channel" id={c.channelId} /></div>
            <div className="muted small">
              {[`${c.launches} ${c.launches === 1 ? "launch" : "launches"}`, `${c.joins} ${c.joins === 1 ? "join" : "joins"}`,
                `${c.plays} ${c.plays === 1 ? "session" : "sessions"}`, `${hoursMinutes(c.playedS)} played`].join(" · ")}
            </div>
            <div className="muted small">First active {dayTime(c.first)} · Last active {dayTime(c.last)}</div>
            <UserList names={c.names} total={c.people} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A channel's users up to this many all show; past it, the first eight, the rest on request. */
const USERS_ALL_UP_TO = 10;
const USERS_SHOWN = 8;

/** A channel's users as chips that wrap, most recent first; a long list shortened to its first eight. */
function UserList({ names, total }: { names: Array<{ userId: string; username: string | null }>; total: number }) {
  const [all, setAll] = useState(false);
  if (total === 0) return <>—</>;
  const shown = all || names.length <= USERS_ALL_UP_TO ? names : names.slice(0, USERS_SHOWN);
  const hidden = names.length - shown.length;
  const unlisted = total - names.length;
  return (
    <div className="user-list">
      {shown.map((n) => (
        <a key={n.userId} className="user-chip" href={`#people/${n.userId}`} title={n.username ?? n.userId}>
          <Avatar id={n.userId} name={n.username} size={16} /><span>{n.username ?? n.userId}</span>
        </a>
      ))}
      {unlisted > 0 && hidden === 0 && <span className="muted small">and {unlisted} more</span>}
      {hidden > 0 && <button type="button" className="link" onClick={() => setAll(true)}>Show all {names.length}</button>}
      {all && names.length > USERS_ALL_UP_TO && <button type="button" className="link" onClick={() => setAll(false)}>Show fewer</button>}
    </div>
  );
}

const kindName = (k: string) => (k === "launch" ? "Launched the Activity" : k === "join" ? "Joined a room" : k);

/** Every launch and join, newest first. */
function Launches({ onError }: { onError: (e: unknown) => void }) {
  const [pages, setPages] = useState<Array<number | undefined>>([undefined]);
  const before = pages[pages.length - 1];
  const { data, busy } = useLoad(() => api.usage({ before, limit: PAGE }), [before], onError);
  const rows: UsageRow[] = data?.usage ?? [];
  return (
    <section className="card">
      <div className="room-head">
        <h3>Launches and joins</h3>
        <Downloads kind="usage" />
      </div>
      {busy && !data ? <p className="empty">Loading…</p> : rows.length === 0 ? <p className="empty">No launches or joins have been recorded.</p> : (
        <div className="table-wrap">
          <table className="table wrap-heads">
            <thead><tr><th>Time</th><th>Event</th><th>User</th><th>Discord user ID</th><th>Server</th><th>Channel</th><th>Room</th></tr></thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id}>
                  <td className="when-cell">{dayTime(u.at)}</td>
                  <td>{kindName(u.kind)}</td>
                  <td><Who id={u.userId} name={u.username} /></td>
                  <td className="mono">{u.userId ?? "—"}</td>
                  <td><PlaceName kind="guild" id={u.guildId} /></td>
                  <td><PlaceName kind="channel" id={u.channelId} /></td>
                  <td className="mono">{u.roomId ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="pager">
        <button className="ghost" disabled={pages.length < 2} onClick={() => setPages(pages.slice(0, -1))}>Previous</button>
        <button className="ghost" disabled={rows.length < PAGE} onClick={() => setPages([...pages, rows[rows.length - 1].id])}>Next</button>
      </div>
    </section>
  );
}
