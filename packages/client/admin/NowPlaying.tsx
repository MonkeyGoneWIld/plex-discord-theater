import { useState } from "react";
import type { Client, Overview, Room, Stream } from "./types";
import { ago, clock, quality, rate, short, utc } from "./format";

/** What each note a stream's playlist carries is, in words (routes/plex.ts, streamNotes). */
const NOTE_LABELS: Record<string, string> = {
  engine: "Engine",
  encoder: "Encoder",
  fallback: "Why Plex makes it",
  video: "Video",
  reason: "Why the video is re-encoded",
  kbps: "Video bitrate (kbps)",
  quality: "Quality",
  allowed: "Bitrate allowed (kbps)",
  videoFrom: "Source video",
  range: "Dynamic range",
  perScreen: "Per screen",
  audio: "Audio",
  audioFrom: "Source audio",
  audioTo: "Audio sent",
  audioKbps: "Audio bitrate (kbps)",
  audioReason: "Why the audio is converted",
};

/** What a player can decode (ffmpeg/plan.ts, PLAYER_CAPS), in words. */
const CAP_LABELS: Record<string, string> = {
  hevc: "HEVC", av1: "AV1", vp9: "VP9", opus: "Opus", flac: "FLAC", ac3: "AC3", eac3: "E-AC3",
  hdr: "HDR", tenBit: "10-bit", uhd: "4K", hi10: "10-bit H.264",
};

function nameOf(room: Room, userId: string | null): string {
  if (!userId) return "—";
  return room.clients.find((c) => c.userId === userId)?.username ?? userId;
}

function decisionBadge(s: Stream) {
  if (!s.hlsSessionId) return <span className="badge muted">Not started</span>;
  if (s.decision === "copy") return <span className="badge good">Direct copy</span>;
  if (s.decision === "transcode") return <span className="badge warn">Re-encoded</span>;
  return <span className="badge muted">Starting</span>;
}

function roomState(room: Room) {
  if (!room.ratingKey) return <span className="badge muted">Idle</span>;
  if (room.waiting) return <span className="badge info">Waiting{room.hostWaiting ? " for the host" : ""}</span>;
  return room.playing ? <span className="badge good">Playing</span> : <span className="badge muted">Paused</span>;
}

function StreamRow({ room, stream }: { room: Room; stream: Stream }) {
  const [open, setOpen] = useState(false);
  const watchers = stream.viewers.map((id) => nameOf(room, id));
  const why = stream.decision === "transcode"
    ? stream.reason ?? "No reason given"
    : stream.decision === "copy"
      ? stream.notes.audio === "transcode" ? `Video copied; audio converted${stream.notes.audioReason ? `: ${stream.notes.audioReason}` : ""}` : "Video and audio copied from the file"
      : stream.hlsSessionId ? "The stream's playlist hasn't been made yet" : "Nobody has started this stream";
  return (
    <div className={`stream ${open ? "open" : ""}`}>
      <button className="stream-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="chev" aria-hidden>{open ? "▾" : "▸"}</span>
        <span className="stream-main">
          <span className="stream-line">
            {decisionBadge(stream)}
            {stream.isHostStream && <span className="badge outline">Host's stream</span>}
            <span className="stream-why">{why}</span>
          </span>
          <span className="stream-sub">
            {stream.engine === "ffmpeg" ? "FFmpeg" : stream.engine === "plex" ? "Plex" : "—"}
            {" · "}{rate(stream.kbps)}{stream.kbpsSource ? ` (${stream.kbpsSource})` : ""}
            {" · "}{quality(stream.quality)}
            {" · "}{watchers.length} watching{watchers.length ? `: ${watchers.join(", ")}` : ""}
          </span>
        </span>
      </button>
      {open && (
        <div className="stream-detail">
          <dl className="grid">
            <dt>Stream</dt><dd className="mono">{stream.variantKey}</dd>
            <dt>HLS session</dt><dd className="mono">{stream.hlsSessionId ?? "—"}</dd>
            <dt>Audio track</dt><dd className="mono">{stream.audioStreamId}</dd>
            <dt>Burned-in subtitle</dt><dd className="mono">{stream.subtitleStreamId || "None"}</dd>
            <dt>Driven by</dt><dd>{nameOf(room, stream.ownerUserId)} <span className="mono muted">{stream.ownerUserId ?? ""}</span></dd>
            <dt>Starts at</dt><dd>{clock(stream.sessionOffset)} into the title</dd>
            <dt>Unwatched for</dt><dd>{stream.idleS === null ? "Watched now" : ago(stream.idleS)}</dd>
            <dt>Plex transcode key</dt><dd className="mono">{stream.plexTranscodeKey ?? "—"}</dd>
            <dt>Plex Now Playing player</dt><dd className="mono">{stream.plexClientId ?? "—"}</dd>
            <dt>Playlist made</dt><dd>{utc(stream.notesAt)}</dd>
          </dl>
          {Object.keys(stream.notes).length > 0 && (
            <>
              <h4>What the playlist told its players</h4>
              <dl className="grid">
                {Object.entries(stream.notes).map(([k, v]) => (
                  <FragmentPair key={k} label={NOTE_LABELS[k] ?? k} value={String(v)} code={k} />
                ))}
              </dl>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function FragmentPair({ label, value, code }: { label: string; value: string; code: string }) {
  return (
    <>
      <dt title={`com.pdt.${code}`}>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function status(c: Client): { text: string; tone: string } {
  if (!c.connected) return { text: "Disconnected", tone: "bad" };
  if (c.away) return { text: "Away from Discord", tone: "muted" };
  if (c.loading) return { text: "Buffering", tone: "warn" };
  if (c.watching) return { text: "Watching", tone: "good" };
  return { text: "Browsing", tone: "muted" };
}

function People({ room }: { room: Room }) {
  const streamOf = new Map(room.streams.map((s, i) => [s.variantKey, i + 1]));
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Person</th><th>Discord ID</th><th>Role</th><th>Status</th><th>Stream</th>
          <th>Subtitle</th><th>Quality</th><th>Player can decode</th><th>Joined</th>
        </tr>
      </thead>
      <tbody>
        {room.clients.map((c) => {
          const st = status(c);
          return (
            <tr key={c.userId}>
              <td>{c.username ?? "—"}</td>
              <td className="mono">{c.userId}</td>
              <td>{c.role === "host" ? "Host" : c.role === "co-host" ? "Co-host" : "Viewer"}</td>
              <td><span className={`dot ${st.tone}`} />{st.text}</td>
              <td>{c.variantKey ? <>#{streamOf.get(c.variantKey) ?? "?"} <span className="mono muted">{c.variantKey}</span></> : "—"}</td>
              <td className="mono">{c.subtitleStreamId || "Off"}</td>
              <td>{quality(c.quality)}</td>
              <td className="caps">{c.caps.length ? c.caps.map((cap) => CAP_LABELS[cap] ?? cap).join(", ") : "H.264 and AAC only"}{c.av1Encode ? " · encodes AV1" : ""}</td>
              <td title={utc(c.joinedAt)}>{ago((Date.now() - c.joinedAt) / 1000)} ago</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function RoomCard({ room }: { room: Room }) {
  const [people, setPeople] = useState(true);
  const watching = room.clients.filter((c) => c.connected && c.watching).length;
  return (
    <section className="card room">
      <header className="room-head">
        <div>
          <h3>{room.title ?? "Nothing playing"}</h3>
          <div className="room-meta">
            {roomState(room)}
            {room.ratingKey && <span>{clock(room.positionS)}</span>}
            <span>{watching} of {room.clients.length} watching</span>
            <span>{room.streams.length} {room.streams.length === 1 ? "stream" : "streams"}</span>
            {room.queue.length > 0 && <span>{room.queue.length} queued</span>}
          </div>
        </div>
        <dl className="room-ids">
          <dt>Host</dt><dd>{nameOf(room, room.discord.hostUserId)}</dd>
          <dt>Server</dt><dd className="mono">{room.discord.guildId ?? "—"}</dd>
          <dt>Channel</dt><dd className="mono">{room.discord.channelId ?? "—"}</dd>
          <dt>Room</dt><dd className="mono" title={room.id}>{short(room.id, 14)}</dd>
          <dt>Started</dt><dd>{utc(room.discord.startedAt)}</dd>
        </dl>
      </header>
      {room.heldFor && <p className="note">Nobody is in this room; it is kept for its host to come back to.</p>}
      <div className="room-facts">
        <span>Last play, pause or seek {ago(room.stateAgeS)} ago</span>
        <span>Host heard from {room.hostHeartbeatAgeS === null ? "never" : `${ago(room.hostHeartbeatAgeS)} ago`}</span>
        {room.ratingKey && <span className="mono">ratingKey {room.ratingKey}</span>}
        {room.coHostIds.length > 0 && <span>Co-hosts: {room.coHostIds.map((id) => nameOf(room, id)).join(", ")}</span>}
      </div>
      {room.streams.length > 0 && (
        <div className="streams">
          <h4>Streams</h4>
          {room.streams.map((s) => <StreamRow key={s.variantKey} room={room} stream={s} />)}
        </div>
      )}
      <div className="people">
        <button className="link" onClick={() => setPeople(!people)} aria-expanded={people}>
          {people ? "▾" : "▸"} People ({room.clients.length})
        </button>
        {people && <People room={room} />}
      </div>
      {room.away.length > 0 && (
        <p className="note">
          Kept for viewers who left their own stream a moment ago: {room.away.map((a) => `${nameOf(room, a.userId)} (${a.variantKey})`).join(", ")}
        </p>
      )}
      {room.queue.length > 0 && (
        <details className="queue">
          <summary>Queue ({room.queue.length})</summary>
          <ol>{room.queue.map((q, i) => <li key={`${q.ratingKey}-${i}`}>{q.title} <span className="muted">{q.type}</span></li>)}</ol>
        </details>
      )}
    </section>
  );
}

function Tile({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}

export function NowPlaying({ data }: { data: Overview | null }) {
  if (!data) return <p className="empty">Loading…</p>;
  const t = data.totals;
  return (
    <>
      <div className="tiles">
        <Tile label="Rooms" value={t.rooms} />
        <Tile label="People connected" value={t.people} sub={`${t.watching} watching`} />
        <Tile label="Streams" value={t.streams} sub={`${t.copied} copied · ${t.reencoded} re-encoded`} />
        <Tile label="Upload, one feed a stream" value={rate(t.feedKbps)} sub="Before Discord's cache and peer sharing" />
      </div>
      {data.rooms.length === 0
        ? <p className="empty">No rooms open. A room shows here as soon as somebody opens the Activity.</p>
        : data.rooms.map((r) => <RoomCard key={r.id} room={r} />)}
    </>
  );
}
