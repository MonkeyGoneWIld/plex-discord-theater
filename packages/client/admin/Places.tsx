import { useState } from "react";
import { api } from "./api";
import type { PlaceGuild, UsageRow } from "./types";
import { clock, dateTime } from "./format";
import { Downloads, useLoad, Who } from "./parts";

const PAGE = 50;

/** Where the bot is used: each Discord server, its channels, and who launched or joined it. */
export function Places({ onError }: { onError: (e: unknown) => void }) {
  const { data, busy } = useLoad(() => api.places(), [], onError);
  const guilds = data?.guilds ?? [];
  return (
    <>
      <div className="page-head">
        <h1>Discord Servers</h1>
        <p className="muted">Where the Activity is used: each Discord server and channel, with its launches, viewers and sessions.</p>
      </div>
      <p className="note">
        Discord shares server and channel IDs with an Activity, not their names. To match an ID in Discord, enable
        Developer Mode, then right-click the server or channel and choose Copy ID.
      </p>
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
          <h3>{g.guildId ? <>Server <span className="mono">{g.guildId}</span></> : "Direct message or group chat"}</h3>
          <div className="room-meta">
            <span>{g.channels.length} {g.channels.length === 1 ? "channel" : "channels"}</span>
            <span>{g.launches} {g.launches === 1 ? "launch" : "launches"}</span>
            <span>{g.people} {g.people === 1 ? "user" : "users"}</span>
            <span>{g.plays} {g.plays === 1 ? "session" : "sessions"} · {clock(g.playedS)} played</span>
          </div>
        </div>
        <dl className="room-ids">
          <dt>First active</dt><dd>{dateTime(g.first)}</dd>
          <dt>Last active</dt><dd>{dateTime(g.last)}</dd>
        </dl>
      </header>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr><th>Channel ID</th><th>Launches</th><th>Joins</th><th>Users</th><th>Sessions</th><th>Time played</th><th>First active</th><th>Last active</th></tr>
          </thead>
          <tbody>
            {g.channels.map((c) => (
              <tr key={c.channelId ?? "none"}>
                <td className="mono">{c.channelId ?? "—"}</td>
                <td>{c.launches || "—"}</td>
                <td>{c.joins || "—"}</td>
                <td className="caps">
                  {c.names.map((n, i) => <span key={n.userId}>{i > 0 && ", "}<Who id={n.userId} name={n.username} /></span>)}
                  {c.people > c.names.length && <span className="muted"> and {c.people - c.names.length} more</span>}
                  {c.people === 0 && "—"}
                </td>
                <td>{c.plays || "—"}</td>
                <td className="nowrap">{clock(c.playedS)}</td>
                <td className="nowrap">{dateTime(c.first)}</td>
                <td className="nowrap">{dateTime(c.last)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
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
      {busy && !data ? <p className="empty">Loading…</p> : rows.length === 0 ? <p className="empty">None recorded yet.</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Time</th><th>Event</th><th>User</th><th>Discord user ID</th><th>Server ID</th><th>Channel ID</th><th>Room</th></tr></thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id}>
                  <td className="nowrap">{dateTime(u.at)}</td>
                  <td>{kindName(u.kind)}</td>
                  <td><Who id={u.userId} name={u.username} /></td>
                  <td className="mono">{u.userId ?? "—"}</td>
                  <td className="mono">{u.guildId ?? "—"}</td>
                  <td className="mono">{u.channelId ?? "—"}</td>
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
