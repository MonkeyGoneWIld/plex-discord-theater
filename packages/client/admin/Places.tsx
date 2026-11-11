import { useState } from "react";
import { api } from "./api";
import type { PlaceGuild, UsageRow } from "./types";
import { clock, utc } from "./format";
import { useLoad, Who } from "./parts";

const PAGE = 50;

/** Where the bot is used: each Discord server, its channels, and who launched or joined it. */
export function Places({ onError }: { onError: (e: unknown) => void }) {
  const { data, busy } = useLoad(() => api.places(), [], onError);
  const guilds = data?.guilds ?? [];
  return (
    <>
      <p className="note">
        Discord tells the bot a server's and a channel's ID, not their names. To see one in Discord, turn on
        Developer Mode and right-click the server or channel: Copy ID matches it.
      </p>
      {busy && !data ? <p className="empty">Loading…</p> : guilds.length === 0
        ? <section className="card"><p className="empty">The bot hasn't been launched since the admin page was turned on.</p></section>
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
          <h3>{g.guildId ? <>Server <span className="mono">{g.guildId}</span></> : "No server (a DM or group)"}</h3>
          <div className="room-meta">
            <span>{g.channels.length} {g.channels.length === 1 ? "channel" : "channels"}</span>
            <span>Launched {g.launches} {g.launches === 1 ? "time" : "times"}</span>
            <span>{g.people} {g.people === 1 ? "person" : "people"}</span>
            <span>{g.plays} {g.plays === 1 ? "play" : "plays"}, {clock(g.playedS)}</span>
          </div>
        </div>
        <dl className="room-ids">
          <dt>First used</dt><dd>{utc(g.first)}</dd>
          <dt>Last used</dt><dd>{utc(g.last)}</dd>
        </dl>
      </header>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr><th>Channel</th><th>Launched</th><th>Joined</th><th>People</th><th>Plays</th><th>Played</th><th>First</th><th>Last</th></tr>
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
                <td className="nowrap">{utc(c.first)}</td>
                <td className="nowrap">{utc(c.last)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const kindName = (k: string) => (k === "launch" ? "Launched the bot" : k === "join" ? "Joined" : k);

/** Every launch and join, newest first. */
function Launches({ onError }: { onError: (e: unknown) => void }) {
  const [pages, setPages] = useState<Array<number | undefined>>([undefined]);
  const before = pages[pages.length - 1];
  const { data, busy } = useLoad(() => api.usage({ before, limit: PAGE }), [before], onError);
  const rows: UsageRow[] = data?.usage ?? [];
  return (
    <section className="card">
      <h3>Launches and joins</h3>
      {busy && !data ? <p className="empty">Loading…</p> : rows.length === 0 ? <p className="empty">None yet.</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>What</th><th>Who</th><th>Discord ID</th><th>Server</th><th>Channel</th><th>Room</th></tr></thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id}>
                  <td className="nowrap">{utc(u.at)}</td>
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
        <button className="ghost" disabled={pages.length < 2} onClick={() => setPages(pages.slice(0, -1))}>Newer</button>
        <button className="ghost" disabled={rows.length < PAGE} onClick={() => setPages([...pages, rows[rows.length - 1].id])}>Older</button>
      </div>
    </section>
  );
}
