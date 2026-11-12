import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { overview, type ClientView, type Overview, type RoomView, type StreamView, type ViewerData } from "./data.js";
import { instanceHosts } from "../routes/discord.js";
import type { ClientLogEntry, ClientLogEvent, RequestEvent, TransportEvent } from "../services/admin-hooks.js";
import { zoneClock } from "./zone.js";

/**
 * The admin page's history (admin.sqlite): every play of a title in a room,
 * who watched it and for how long, each stream it made and why, the data each
 * viewer got and from where, their buffering, and everything that changed on
 * the way; and who launched the Activity where, and who asked for which title.
 *
 * Recorded only while the admin page is on. It watches the rooms every
 * RECORD_EVERY_MS (what the Now playing page shows) and hears the room's
 * commands, the players' logs and the requests as they happen
 * (services/admin-hooks.ts).
 */

export const RECORD_EVERY_MS = 2_000;
/** A longer gap between looks (the process paused) isn't counted as watched. */
const MAX_TICK_GAP_MS = 10_000;
const DAY_MS = 86_400_000;
/** The most days a graph covers: ten years. */
export const MAX_GRAPH_DAYS = 3_650;
/** Enough for a long film with a lot going on; a runaway player can't fill the disk. */
const MAX_EVENTS_PER_PLAY = 5_000;
const MAX_ERROR_EVENTS_PER_PLAY = 200;
/**
 * A player first heard from this soon after the recorder started was most
 * likely playing before it (the server restarted): its counters hold data
 * already counted, so its first sample only sets where they stand.
 */
const BASELINE_WINDOW_MS = 30_000;
/** A wait shorter than this isn't buffering anybody notices. */
const MIN_BUFFERING_MS = 250;
/** A player not heard from in this long is forgotten. */
const PLAYER_FORGET_MS = 10 * 60_000;

type Instance = { hostUserId: string; guildId: string | null; channelId: string | null; createdAt: number };

export interface RecorderOptions {
  dbPath: string;
  now?: () => number;
  /** The rooms as the Now playing page has them. */
  source?: (now: number) => Overview;
  /** Activity launches: routes/discord.ts's instanceHosts. */
  instances?: () => ReadonlyMap<string, Instance>;
}

interface ViewerTotals {
  watchedS: number;
  httpBytes: number;
  p2pBytes: number;
  edgeBytes: number;
  edgeHitBytes: number;
  stalls: number;
  stalledMs: number;
  errors: number;
  dirty: boolean;
}

interface StreamRow {
  id: number;
  eventId: number | null;
  variantKey: string;
  notesAt: number | null;
  offsetS: number;
  peak: number;
  ended: boolean;
}

interface OpenPlay {
  id: number;
  ratingKey: string;
  events: number;
  errorEvents: number;
  playedS: number;
  peak: number;
  lastTick: number;
  streams: Map<string, StreamRow>;
  viewers: Map<string, ViewerTotals>;
  /** What its players have had, at each look: for the dashboard's live graph. */
  flow: FlowSample[];
}

/** Everything a play's players have had by one moment, by where it came from. */
export interface FlowSample { t: number; bot: number; hit: number; p2p: number }

/** How much of a room's delivery is kept for its graph, each point's spacing, and what a point averages over. */
export const FLOW_KEEP_MS = 10 * 60_000;
export const FLOW_STEP_MS = 10_000;
export const FLOW_WINDOW_MS = 30_000;

/** A room's delivery over the last minutes: [time, from the server, from Discord's cache, from other viewers], bits a second. */
export interface RoomFlow {
  stepS: number;
  windowS: number;
  points: Array<[number, number, number, number]>;
}

/**
 * The rate of each source at each step, from the totals at each look. Players
 * say what they have had every 10 seconds, so a total climbs in steps: each
 * point is the average over FLOW_WINDOW_MS before it.
 */
export function flowSeries(samples: FlowSample[], now: number): RoomFlow {
  const points: RoomFlow["points"] = [];
  const out: RoomFlow = { stepS: FLOW_STEP_MS / 1000, windowS: FLOW_WINDOW_MS / 1000, points };
  if (samples.length === 0) return out;
  const at = (t: number): FlowSample | null => {
    let found: FlowSample | null = null;
    for (const s of samples) {
      if (s.t > t) break;
      found = s;
    }
    return found;
  };
  const last = Math.floor(now / FLOW_STEP_MS) * FLOW_STEP_MS;
  for (let g = last - FLOW_KEEP_MS; g <= last; g += FLOW_STEP_MS) {
    const cur = at(g);
    if (!cur) continue;
    const prev = at(g - FLOW_WINDOW_MS) ?? samples[0];
    const seconds = Math.max(FLOW_STEP_MS, cur.t - prev.t) / 1000;
    const bps = (a: number, b: number) => Math.max(0, Math.round(((a - b) * 8) / seconds));
    points.push([g, bps(cur.bot, prev.bot), bps(cur.hit, prev.hit), bps(cur.p2p, prev.p2p)]);
  }
  return out;
}

interface ClientSnap {
  connected: boolean;
  variantKey: string | null;
  subtitleStreamId: number;
  quality: number;
  role: string;
  away: boolean;
}

interface RoomSnap {
  clients: Map<string, ClientSnap>;
  /** Everybody seen in the room, for one "join" each in the usage log. */
  ever: Set<string>;
  waitingSince: number | null;
}

/** One page load of a player, from its log lines. */
interface PlayerState {
  session: string;
  p2p: number;
  http: number;
  edge: number;
  edgeHit: number;
  sampled: boolean;
  waitingSince: number | null;
  waitingAfterSeek: boolean;
  lastAt: number;
}

export interface PlaySummary {
  id: number;
  roomId: string;
  ratingKey: string;
  title: string | null;
  guildId: string | null;
  channelId: string | null;
  hostUserId: string | null;
  hostName: string | null;
  startedAt: number;
  endedAt: number | null;
  endReason: string | null;
  endBy: string | null;
  startPosS: number | null;
  lastPosS: number | null;
  playedS: number;
  peakViewers: number;
  viewers: number;
  names: string[];
  streams: number;
  reencoded: number;
  bytes: number;
  /** Of `bytes`: what the server sent, what Discord's cache answered, what other viewers shared. */
  botBytes: number;
  cacheBytes: number;
  p2pBytes: number;
  stalls: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY,
  room_id TEXT NOT NULL,
  rating_key TEXT NOT NULL,
  title TEXT,
  guild_id TEXT,
  channel_id TEXT,
  host_user_id TEXT,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT,
  end_by TEXT,
  start_pos_s REAL,
  last_pos_s REAL,
  played_s REAL NOT NULL DEFAULT 0,
  peak_viewers INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS plays_started ON plays(started_at);
CREATE TABLE IF NOT EXISTS play_viewers (
  play_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT,
  role TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  watched_s REAL NOT NULL DEFAULT 0,
  http_bytes INTEGER NOT NULL DEFAULT 0,
  p2p_bytes INTEGER NOT NULL DEFAULT 0,
  edge_bytes INTEGER NOT NULL DEFAULT 0,
  edge_hit_bytes INTEGER NOT NULL DEFAULT 0,
  stalls INTEGER NOT NULL DEFAULT 0,
  stalled_ms INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (play_id, user_id)
);
CREATE INDEX IF NOT EXISTS play_viewers_user ON play_viewers(user_id);
CREATE TABLE IF NOT EXISTS play_streams (
  id INTEGER PRIMARY KEY,
  play_id INTEGER NOT NULL,
  hls_session_id TEXT NOT NULL,
  variant_key TEXT,
  engine TEXT,
  decision TEXT,
  reason TEXT,
  summary TEXT,
  audio_stream_id INTEGER,
  subtitle_stream_id INTEGER,
  quality INTEGER,
  owner_user_id TEXT,
  offset_s REAL,
  kbps INTEGER,
  notes TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  peak_viewers INTEGER NOT NULL DEFAULT 0,
  UNIQUE (play_id, hls_session_id)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  play_id INTEGER,
  room_id TEXT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  user_id TEXT,
  username TEXT,
  pos_s REAL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS events_play ON events(play_id, at);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  room_id TEXT,
  user_id TEXT,
  username TEXT,
  guild_id TEXT,
  channel_id TEXT
);
CREATE INDEX IF NOT EXISTS usage_at ON usage(at);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  user_id TEXT,
  username TEXT,
  media_type TEXT NOT NULL,
  tmdb_id INTEGER NOT NULL,
  seasons TEXT,
  title TEXT,
  outcome TEXT NOT NULL,
  status INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS requests_at ON requests(at);
CREATE TABLE IF NOT EXISTS people (
  user_id TEXT PRIMARY KEY,
  username TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
`;

const num = (v: unknown): number =>
  typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;

const json = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

function parse(v: unknown): unknown {
  if (typeof v !== "string") return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

/** A search: as typed, and as a LIKE pattern whose wildcards are only characters. */
function search(q: unknown): { q: string | null; like: string | null } {
  const text = typeof q === "string" && q.trim() ? q.trim().slice(0, 100) : null;
  return { q: text, like: text ? `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null };
}

/** A list's page: newest first, before an id. */
function page(limit: unknown, max = 500): number {
  const n = Math.floor(Number(limit));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 50;
}

export class Recorder {
  readonly startedAt: number;
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly source: (now: number) => Overview;
  private readonly instances: () => ReadonlyMap<string, Instance>;
  private readonly statements = new Map<string, Database.Statement>();
  private readonly open = new Map<string, OpenPlay>();
  private readonly snaps = new Map<string, RoomSnap>();
  private readonly players = new Map<string, PlayerState>();
  /** Who is connected where, as of the last look. */
  private readonly userRoom = new Map<string, string>();
  private readonly names = new Map<string, { username: string | null; written: number }>();
  private readonly launched = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(opts: RecorderOptions) {
    this.now = opts.now ?? Date.now;
    this.source = opts.source ?? overview;
    this.instances = opts.instances ?? (() => instanceHosts);
    this.startedAt = this.now();
    fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
    this.db = new Database(opts.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.db.pragma("user_version = 1");
    // A play the last run never saw end ended where it was last seen.
    this.db.exec(`
      UPDATE play_streams SET ended_at = (SELECT updated_at FROM plays WHERE plays.id = play_streams.play_id)
        WHERE ended_at IS NULL;
      UPDATE plays SET ended_at = updated_at, end_reason = 'server restarted' WHERE ended_at IS NULL;
    `);
    // Launches from before this run are the last run's to have recorded.
    for (const id of this.instances().keys()) this.launched.add(id);
  }

  private st(sql: string): Database.Statement {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  start(everyMs = RECORD_EVERY_MS): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        console.warn("[Admin] the recorder couldn't look at the rooms:", err instanceof Error ? err.message : err);
      }
    }, everyMs);
    this.timer.unref();
  }

  /** Every play still open ends with the server, and the database closes. */
  close(reason = "server stopped"): void {
    if (this.closed) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const at = this.now();
    this.db.transaction(() => {
      for (const roomId of [...this.open.keys()]) this.closePlay(roomId, at, reason, null);
    })();
    this.closed = true;
    this.db.close();
  }

  // ─── Watching the rooms ─────────────────────────────────────────

  /** Look at every room once. */
  tick(at = this.now()): void {
    if (this.closed) return;
    const ov = this.source(at);
    this.db.transaction(() => {
      this.recordLaunches(at);
      this.userRoom.clear();
      const present = new Set<string>();
      for (const room of ov.rooms) {
        present.add(room.id);
        this.observeRoom(room, at);
        this.sampleFlow(room.id, at);
      }
      for (const roomId of [...this.open.keys()]) {
        if (!present.has(roomId)) this.closePlay(roomId, at, "room closed", null);
      }
      for (const roomId of [...this.snaps.keys()]) if (!present.has(roomId)) this.snaps.delete(roomId);
      for (const play of this.open.values()) this.flushViewers(play);
      for (const [key, p] of this.players) if (at - p.lastAt > PLAYER_FORGET_MS) this.players.delete(key);
    })();
  }

  private recordLaunches(at: number): void {
    const instances = this.instances();
    for (const [id, inst] of instances) {
      if (this.launched.has(id)) continue;
      this.launched.add(id);
      if (inst.createdAt < this.startedAt) continue;
      this.st(`INSERT INTO usage (at, kind, room_id, user_id, username, guild_id, channel_id)
               VALUES (?, 'launch', ?, ?, ?, ?, ?)`)
        .run(inst.createdAt || at, id, inst.hostUserId, this.nameOf(inst.hostUserId), inst.guildId, inst.channelId);
    }
    for (const id of this.launched) if (!instances.has(id)) this.launched.delete(id);
  }

  private observeRoom(room: RoomView, at: number): void {
    let snap = this.snaps.get(room.id);
    if (!snap) {
      snap = { clients: new Map(), ever: new Set(), waitingSince: null };
      this.snaps.set(room.id, snap);
    }
    let play = this.open.get(room.id) ?? null;
    if (!room.ratingKey) {
      if (play) this.closePlay(room.id, at, "stopped", null);
      play = null;
    } else {
      play = this.ensurePlay(room.id, room.ratingKey, room.title, room.positionS, at, room);
    }

    const dt = play ? Math.min(Math.max(0, at - play.lastTick), MAX_TICK_GAP_MS) / 1000 : 0;
    const connected = room.clients.filter((c) => c.connected);
    for (const c of connected) {
      this.userRoom.set(c.userId, room.id);
      this.remember(c.userId, c.username, at);
    }

    if (play) {
      play.lastTick = at;
      if (room.playing) play.playedS += dt;
      const watching = connected.filter((c) => c.watching).length;
      play.peak = Math.max(play.peak, watching);
      for (const c of connected) {
        const v = this.viewer(play, c, at);
        // The time since the last look is theirs if they were watching then
        // too: somebody who just came gets theirs from the next.
        const before = snap.clients.get(c.userId);
        if (room.playing && c.watching && before?.connected && dt > 0) {
          v.watchedS += dt;
          v.dirty = true;
        }
      }
      this.st(`UPDATE plays SET updated_at = ?, last_pos_s = ?, played_s = ?, peak_viewers = ?,
                 title = COALESCE(title, ?), guild_id = COALESCE(guild_id, ?),
                 channel_id = COALESCE(channel_id, ?), host_user_id = COALESCE(host_user_id, ?)
               WHERE id = ?`)
        .run(at, room.positionS, play.playedS, play.peak, room.title, room.discord.guildId,
          room.discord.channelId, room.discord.hostUserId, play.id);
    }

    // Who came, went and changed what.
    const now = new Map<string, ClientSnap>();
    for (const c of room.clients) {
      const cur: ClientSnap = {
        connected: c.connected, variantKey: c.variantKey, subtitleStreamId: c.subtitleStreamId,
        quality: c.quality, role: c.role, away: c.away,
      };
      now.set(c.userId, cur);
      const prev = snap.clients.get(c.userId);
      if (!c.connected) {
        if (prev?.connected) this.event(play, room.id, at, "left", c.userId, c.username, room.positionS, null);
        continue;
      }
      if (!snap.ever.has(c.userId)) {
        snap.ever.add(c.userId);
        this.st(`INSERT INTO usage (at, kind, room_id, user_id, username, guild_id, channel_id)
                 VALUES (?, 'join', ?, ?, ?, ?, ?)`)
          .run(at, room.id, c.userId, c.username, room.discord.guildId, room.discord.channelId);
      }
      if (!prev?.connected) {
        this.event(play, room.id, at, prev ? "came back" : "joined", c.userId, c.username, room.positionS, { role: c.role });
        continue;
      }
      const changed = (kind: string, from: unknown, to: unknown) =>
        this.event(play, room.id, at, kind, c.userId, c.username, room.positionS, { from, to });
      if (c.variantKey && c.variantKey !== prev.variantKey) {
        const s = room.streams.find((x) => x.variantKey === c.variantKey);
        this.event(play, room.id, at, "stream changed", c.userId, c.username, room.positionS, {
          from: prev.variantKey, to: c.variantKey,
          audioStreamId: s?.audioStreamId ?? null, subtitleStreamId: s?.subtitleStreamId ?? null,
        });
      }
      if (c.subtitleStreamId !== prev.subtitleStreamId) changed("subtitles", prev.subtitleStreamId, c.subtitleStreamId);
      if (c.quality !== prev.quality) changed("quality", prev.quality, c.quality);
      if (c.role !== prev.role) changed("role", prev.role, c.role);
      if (c.away !== prev.away) {
        this.event(play, room.id, at, c.away ? "away from Discord" : "back in Discord", c.userId, c.username, room.positionS, null);
      }
    }
    for (const [userId, prev] of snap.clients) {
      if (prev.connected && !now.has(userId)) this.event(play, room.id, at, "left", userId, this.nameOf(userId), room.positionS, null);
    }
    snap.clients = now;
    if (play) this.observeStreams(play, room, at);

    // The room holding everybody for the slowest.
    if (room.waiting && snap.waitingSince === null) snap.waitingSince = at;
    if (!room.waiting && snap.waitingSince !== null) {
      this.event(play, room.id, at, "room waited", null, null, room.positionS, { ms: at - snap.waitingSince });
      snap.waitingSince = null;
    }
  }

  private observeStreams(play: OpenPlay, room: RoomView, at: number): void {
    const live = room.streams.filter((s): s is StreamView & { hlsSessionId: string } => !!s.hlsSessionId);
    const liveIds = new Set(live.map((s) => s.hlsSessionId));
    // Streams gone since the last look, by variant: one back under a new
    // session is a restart, not an end and a start.
    const gone = new Map<string, { sessionId: string; row: StreamRow }>();
    for (const [sessionId, row] of play.streams) {
      if (row.ended || liveIds.has(sessionId)) continue;
      row.ended = true;
      this.st("UPDATE play_streams SET ended_at = ? WHERE id = ?").run(at, row.id);
      gone.set(row.variantKey, { sessionId, row });
    }
    for (const s of live) {
      const known = play.streams.get(s.hlsSessionId);
      if (!known) {
        const id = Number(this.st(`INSERT INTO play_streams (play_id, hls_session_id, variant_key, engine, decision,
                   reason, summary, audio_stream_id, subtitle_stream_id, quality, owner_user_id, offset_s, kbps,
                   notes, started_at, peak_viewers)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(play.id, s.hlsSessionId, s.variantKey, s.engine, s.decision, s.reason, s.summary, s.audioStreamId,
            s.subtitleStreamId, s.quality, s.ownerUserId, s.sessionOffset, s.kbps, json(s.notes), at, s.viewers.length)
          .lastInsertRowid);
        const before = gone.get(s.variantKey);
        if (before) gone.delete(s.variantKey);
        const eventId = this.event(play, room.id, at, before ? "stream restarted" : "stream started", s.ownerUserId,
          s.ownerUserId ? this.nameOf(s.ownerUserId) : null, room.positionS, this.streamDetail(s, before?.sessionId));
        play.streams.set(s.hlsSessionId, {
          id, eventId, variantKey: s.variantKey, notesAt: s.notesAt, offsetS: s.sessionOffset,
          peak: s.viewers.length, ended: false,
        });
        continue;
      }
      if (s.notesAt !== known.notesAt) {
        // What the playlist said arrives a moment after the stream starts:
        // the stream's row, and the line that said it started, get it.
        const firstNotes = known.notesAt === null;
        known.notesAt = s.notesAt;
        this.st(`UPDATE play_streams SET engine = ?, decision = ?, reason = ?, summary = ?, kbps = ?, notes = ?
                 WHERE id = ?`)
          .run(s.engine, s.decision, s.reason, s.summary, s.kbps, json(s.notes), known.id);
        if (firstNotes && known.eventId !== null) {
          this.st("UPDATE events SET detail = ? WHERE id = ?").run(json(this.streamDetail(s)), known.eventId);
        }
      }
      if (s.sessionOffset !== known.offsetS) {
        this.event(play, room.id, at, "stream restarted", null, null, room.positionS, {
          variant: s.variantKey, session: s.hlsSessionId, fromOffsetS: known.offsetS, toOffsetS: s.sessionOffset,
        });
        known.offsetS = s.sessionOffset;
        this.st("UPDATE play_streams SET offset_s = ? WHERE id = ?").run(s.sessionOffset, known.id);
      }
      if (s.viewers.length > known.peak) {
        known.peak = s.viewers.length;
        this.st("UPDATE play_streams SET peak_viewers = ? WHERE id = ?").run(known.peak, known.id);
      }
    }
    for (const [variantKey, { sessionId }] of gone) {
      this.event(play, room.id, at, "stream ended", null, null, room.positionS, { variant: variantKey, session: sessionId });
    }
  }

  private streamDetail(s: StreamView, replaced?: string): Record<string, unknown> {
    return {
      variant: s.variantKey,
      session: s.hlsSessionId,
      ...(replaced ? { replaced } : {}),
      engine: s.engine,
      summary: s.summary,
      audioStreamId: s.audioStreamId,
      subtitleStreamId: s.subtitleStreamId,
      quality: s.quality,
      offsetS: s.sessionOffset,
    };
  }

  private ensurePlay(roomId: string, ratingKey: string, title: string | null, posS: number, at: number,
    room?: RoomView): OpenPlay {
    const open = this.open.get(roomId);
    if (open && open.ratingKey === ratingKey) return open;
    if (open) this.closePlay(roomId, at, "another title", null);
    const inst = this.instances().get(roomId);
    const guildId = room?.discord.guildId ?? inst?.guildId ?? null;
    const channelId = room?.discord.channelId ?? inst?.channelId ?? null;
    const hostUserId = room?.discord.hostUserId ?? inst?.hostUserId ?? null;
    const id = Number(this.st(`INSERT INTO plays (room_id, rating_key, title, guild_id, channel_id, host_user_id,
               started_at, updated_at, start_pos_s, last_pos_s)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(roomId, ratingKey, title, guildId, channelId, hostUserId, at, at, posS, posS).lastInsertRowid);
    const play: OpenPlay = {
      id, ratingKey, events: 0, errorEvents: 0, playedS: 0, peak: 0, lastTick: at,
      streams: new Map(), viewers: new Map(), flow: [],
    };
    this.open.set(roomId, play);
    return play;
  }

  private closePlay(roomId: string, at: number, reason: string, by: string | null): void {
    const play = this.open.get(roomId);
    if (!play) return;
    this.flushViewers(play);
    this.st("UPDATE play_streams SET ended_at = ? WHERE play_id = ? AND ended_at IS NULL").run(at, play.id);
    this.st("UPDATE plays SET ended_at = ?, updated_at = ?, end_reason = ?, end_by = ?, played_s = ? WHERE id = ?")
      .run(at, at, reason, by, play.playedS, play.id);
    play.events = 0; // the end is always written
    this.event(play, roomId, at, "ended", null, by, null, { reason });
    this.open.delete(roomId);
  }

  private viewer(play: OpenPlay, c: ClientView, at: number): ViewerTotals {
    this.st(`INSERT INTO play_viewers (play_id, user_id, username, role, first_seen, last_seen)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (play_id, user_id) DO UPDATE SET
               username = COALESCE(excluded.username, username), role = excluded.role, last_seen = excluded.last_seen`)
      .run(play.id, c.userId, c.username, c.role, at, at);
    let v = play.viewers.get(c.userId);
    if (!v) {
      v = { watchedS: 0, httpBytes: 0, p2pBytes: 0, edgeBytes: 0, edgeHitBytes: 0, stalls: 0, stalledMs: 0, errors: 0, dirty: false };
      play.viewers.set(c.userId, v);
    }
    return v;
  }

  private flushViewers(play: OpenPlay): void {
    for (const [userId, v] of play.viewers) {
      if (!v.dirty) continue;
      v.dirty = false;
      this.st(`UPDATE play_viewers SET watched_s = ?, http_bytes = ?, p2p_bytes = ?, edge_bytes = ?,
                 edge_hit_bytes = ?, stalls = ?, stalled_ms = ?, errors = ?
               WHERE play_id = ? AND user_id = ?`)
        .run(v.watchedS, Math.round(v.httpBytes), Math.round(v.p2pBytes), Math.round(v.edgeBytes),
          Math.round(v.edgeHitBytes), v.stalls, Math.round(v.stalledMs), v.errors, play.id, userId);
    }
  }

  /** One line of a play's (or, with none, a room's) history. Its id, or null if it wasn't kept. */
  private event(play: OpenPlay | null, roomId: string, at: number, kind: string, userId: string | null,
    username: string | null, posS: number | null, detail: unknown): number | null {
    if (play) {
      if (play.events >= MAX_EVENTS_PER_PLAY) return null;
      play.events++;
    }
    return Number(this.st(`INSERT INTO events (play_id, room_id, at, kind, user_id, username, pos_s, detail)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(play?.id ?? null, roomId, at, kind, userId, username, posS, json(detail)).lastInsertRowid);
  }

  private remember(userId: string | null, username: string | null, at = this.now()): void {
    if (!userId) return;
    const known = this.names.get(userId);
    if (known && (username === null || known.username === username) && at - known.written < 60_000) return;
    const name = username ?? known?.username ?? null;
    this.names.set(userId, { username: name, written: at });
    this.st(`INSERT INTO people (user_id, username, first_seen, last_seen) VALUES (?, ?, ?, ?)
             ON CONFLICT (user_id) DO UPDATE SET username = COALESCE(excluded.username, username), last_seen = excluded.last_seen`)
      .run(userId, name, at, at);
  }

  private nameOf(userId: string): string | null {
    const known = this.names.get(userId);
    if (known) return known.username;
    const row = this.st("SELECT username FROM people WHERE user_id = ?").get(userId) as { username: string | null } | undefined;
    return row?.username ?? null;
  }

  // ─── What happens between looks ─────────────────────────────────

  /** A play, pause, resume, seek or stop the room acted on. */
  transport(e: TransportEvent): void {
    if (this.closed) return;
    this.db.transaction(() => {
      this.remember(e.userId, e.username, e.at);
      if (e.type === "stop") {
        const play = this.open.get(e.roomId);
        if (!play) return;
        this.event(play, e.roomId, e.at, "stop", e.userId, e.username, e.fromS, { role: e.role });
        this.closePlay(e.roomId, e.at, "stopped", e.username ?? e.userId);
        return;
      }
      if (!e.ratingKey) return;
      const play = this.ensurePlay(e.roomId, e.ratingKey, e.title, e.toS, e.at);
      this.event(play, e.roomId, e.at, e.type, e.userId, e.username, e.toS,
        e.type === "seek" ? { role: e.role, fromS: e.fromS, toS: e.toS } : { role: e.role });
    })();
  }

  /** A batch of one player's log lines. */
  clientLog(e: ClientLogEvent): void {
    if (this.closed || !e.userId) return;
    const userId = e.userId;
    const key = `${userId}|${e.clientId}`;
    this.db.transaction(() => {
      for (const entry of e.entries) {
        if (entry.tag === "Health" && entry.msg === "sample") this.sample(key, userId, entry);
        else if (entry.tag === "Video" && entry.msg === "waiting (buffer starved)") this.waiting(key, entry);
        else if (entry.tag === "Video" && entry.msg === "playing") this.playing(key, userId, entry);
        if (entry.level === "ERROR") this.playerError(userId, entry);
      }
    })();
  }

  private player(key: string, t: number): PlayerState {
    let p = this.players.get(key);
    if (!p) {
      p = { session: "", p2p: 0, http: 0, edge: 0, edgeHit: 0, sampled: false, waitingSince: null, waitingAfterSeek: false, lastAt: t };
      this.players.set(key, p);
    }
    p.lastAt = t;
    return p;
  }

  /** The viewer's open play, and their totals in it. */
  private viewerNow(userId: string): { play: OpenPlay; roomId: string; v: ViewerTotals } | null {
    const roomId = this.userRoom.get(userId);
    const play = roomId ? this.open.get(roomId) : undefined;
    const v = play?.viewers.get(userId);
    return roomId && play && v ? { play, roomId, v } : null;
  }

  /**
   * The player's Health sample, every 10 seconds: what its stream has taken
   * from the network (httpMB, counting what Discord's proxy answered) and from
   * peers (p2pMB), since its player started, and what Discord's cache handed
   * it (edgeHitMB of edgeMB), since its stream started. Counted by the change.
   */
  private sample(key: string, userId: string, entry: ClientLogEntry): void {
    const d = entry.data;
    const p2p = num(d.p2pMB) * 1e6;
    const http = num(d.httpMB) * 1e6;
    if (!Number.isFinite(p2p) || !Number.isFinite(http)) return;
    const edge = Number.isFinite(num(d.edgeMB)) ? num(d.edgeMB) * 1e6 : 0;
    const edgeHit = Number.isFinite(num(d.edgeHitMB)) ? num(d.edgeHitMB) * 1e6 : 0;
    const session = String(d.session ?? "");
    const p = this.player(key, entry.t);
    const baseline = !p.sampled && entry.t - this.startedAt < BASELINE_WINDOW_MS;
    // A new player (a new stream, a rebuild) counts from zero again.
    const restarted = p.sampled && (session !== p.session || p2p < p.p2p || http < p.http);
    // The Discord cache figures start again with each stream too (and with
    // the page, on a player from before they did).
    const pageReloaded = restarted || edge < p.edge || edgeHit < p.edgeHit;
    const delta = {
      http: baseline ? 0 : restarted ? http : http - p.http,
      p2p: baseline ? 0 : restarted ? p2p : p2p - p.p2p,
      edge: baseline ? 0 : pageReloaded ? edge : edge - p.edge,
      edgeHit: baseline ? 0 : pageReloaded ? edgeHit : edgeHit - p.edgeHit,
    };
    Object.assign(p, { session, p2p, http, edge, edgeHit, sampled: true });
    const now = this.viewerNow(userId);
    if (!now) return;
    now.v.httpBytes += Math.max(0, delta.http);
    now.v.p2pBytes += Math.max(0, delta.p2p);
    now.v.edgeBytes += Math.max(0, delta.edge);
    now.v.edgeHitBytes += Math.max(0, delta.edgeHit);
    now.v.dirty = true;
  }

  private waiting(key: string, entry: ClientLogEntry): void {
    if (entry.data.paused === true) return;
    const p = this.player(key, entry.t);
    if (p.waitingSince !== null) return;
    p.waitingSince = entry.t;
    p.waitingAfterSeek = entry.data.seeking === true;
  }

  private playing(key: string, userId: string, entry: ClientLogEntry): void {
    const p = this.player(key, entry.t);
    if (p.waitingSince === null) return;
    const ms = Math.max(0, entry.t - p.waitingSince);
    const afterSeek = p.waitingAfterSeek;
    p.waitingSince = null;
    if (ms < MIN_BUFFERING_MS) return;
    const now = this.viewerNow(userId);
    if (!now) return;
    if (!afterSeek) {
      now.v.stalls++;
      now.v.stalledMs += ms;
      now.v.dirty = true;
    }
    const posS = num(entry.data.posS);
    this.event(now.play, now.roomId, entry.t, afterSeek ? "loaded after seek" : "buffering", userId,
      this.nameOf(userId), Number.isFinite(posS) ? posS : null, { ms });
  }

  private playerError(userId: string, entry: ClientLogEntry): void {
    const now = this.viewerNow(userId);
    if (!now) return;
    now.v.errors++;
    now.v.dirty = true;
    if (now.play.errorEvents >= MAX_ERROR_EVENTS_PER_PLAY) return;
    now.play.errorEvents++;
    const posS = num(entry.data.posS);
    this.event(now.play, now.roomId, entry.t, "player error", userId, this.nameOf(userId),
      Number.isFinite(posS) ? posS : null, { tag: entry.tag, msg: entry.msg });
  }

  /** A title asked for through Seerr. */
  request(e: RequestEvent): void {
    if (this.closed) return;
    const id = Number(this.st(`INSERT INTO requests (at, user_id, username, media_type, tmdb_id, seasons, outcome, status, error)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(e.at, e.userId, e.userId ? this.nameOf(e.userId) : null, e.mediaType, e.tmdbId, json(e.seasons),
        e.outcome, e.status, e.error).lastInsertRowid);
    e.title?.then((title) => {
      if (title && !this.closed) this.st("UPDATE requests SET title = ? WHERE id = ?").run(title.slice(0, 300), id);
    }).catch(() => {});
  }

  // ─── For the admin page ─────────────────────────────────────────

  /** Each viewer's totals in their room's play so far, for the Now playing page. */
  /** One more look at what a room's players have had, for its graph. */
  private sampleFlow(roomId: string, at: number): void {
    const play = this.open.get(roomId);
    if (!play) return;
    const s: FlowSample = { t: at, bot: 0, hit: 0, p2p: 0 };
    for (const v of play.viewers.values()) {
      s.bot += Math.max(0, v.httpBytes - v.edgeHitBytes);
      s.hit += v.edgeHitBytes;
      s.p2p += v.p2pBytes;
    }
    play.flow.push(s);
    const oldest = at - FLOW_KEEP_MS - FLOW_WINDOW_MS - FLOW_STEP_MS;
    while (play.flow.length > 1 && play.flow[0].t < oldest) play.flow.shift();
  }

  annotate(ov: Overview): Overview {
    for (const room of ov.rooms) {
      const play = this.open.get(room.id);
      room.playId = play?.id ?? null;
      room.flow = play ? flowSeries(play.flow, ov.at) : null;
      for (const c of room.clients) {
        const v = play?.viewers.get(c.userId);
        if (v) c.data = viewerData(v);
      }
      // Who has left is no longer among its clients, and the page had only
      // their Discord ID to show.
      const here = new Set(room.clients.map((c) => c.userId));
      const names: Record<string, string> = {};
      const gone = [room.discord.hostUserId, room.heldFor?.hostUserId, ...room.away.map((a) => a.userId), ...room.streams.map((s) => s.ownerUserId)];
      for (const id of gone) {
        if (!id || here.has(id) || names[id]) continue;
        const name = this.nameOf(id);
        if (name) names[id] = name;
      }
      room.names = names;
    }
    return ov;
  }

  history(opts: { limit?: unknown; before?: unknown; q?: unknown } = {}): PlaySummary[] {
    const before = Number.isInteger(Number(opts.before)) && Number(opts.before) > 0 ? Number(opts.before) : null;
    const { q, like } = search(opts.q);
    const rows = this.st(`
      SELECT p.*, ${HOST_NAME},
        (SELECT COUNT(*) FROM play_viewers v WHERE v.play_id = p.id) AS viewers,
        (SELECT json_group_array(COALESCE(v.username, v.user_id)) FROM play_viewers v WHERE v.play_id = p.id) AS names,
        (SELECT COUNT(*) FROM play_streams s WHERE s.play_id = p.id) AS streams,
        (SELECT COUNT(*) FROM play_streams s WHERE s.play_id = p.id AND s.decision = 'transcode') AS reencoded,
        (SELECT COALESCE(SUM(v.http_bytes + v.p2p_bytes), 0) FROM play_viewers v WHERE v.play_id = p.id) AS bytes,
        (SELECT COALESCE(SUM(MAX(0, v.http_bytes - v.edge_hit_bytes)), 0) FROM play_viewers v WHERE v.play_id = p.id) AS bot,
        (SELECT COALESCE(SUM(MIN(v.http_bytes, v.edge_hit_bytes)), 0) FROM play_viewers v WHERE v.play_id = p.id) AS hit,
        (SELECT COALESCE(SUM(v.p2p_bytes), 0) FROM play_viewers v WHERE v.play_id = p.id) AS p2p,
        (SELECT COALESCE(SUM(v.stalls), 0) FROM play_viewers v WHERE v.play_id = p.id) AS stalls
      FROM plays p
      WHERE (@before IS NULL OR p.id < @before)
        AND (@like IS NULL OR p.title LIKE @like ESCAPE '\\' OR p.rating_key = @q OR p.guild_id = @q
             OR p.channel_id = @q OR EXISTS (SELECT 1 FROM play_viewers v WHERE v.play_id = p.id
               AND (v.username LIKE @like ESCAPE '\\' OR v.user_id = @q)))
      ORDER BY p.id DESC LIMIT @limit`).all({ before, like, q, limit: page(opts.limit) }) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ ...playOf(r), viewers: Number(r.viewers), names: (parse(r.names) as string[] | null) ?? [],
      streams: Number(r.streams), reencoded: Number(r.reencoded), bytes: Number(r.bytes), botBytes: Number(r.bot),
      cacheBytes: Number(r.hit), p2pBytes: Number(r.p2p), stalls: Number(r.stalls) }));
  }

  /** One play, whole: its viewers, streams and every line of its history. */
  play(id: number) {
    const r = this.st(`SELECT p.*, ${HOST_NAME} FROM plays p WHERE p.id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    const viewers = (this.st("SELECT * FROM play_viewers WHERE play_id = ? ORDER BY first_seen").all(id) as Array<Record<string, unknown>>)
      .map((v) => ({
        userId: String(v.user_id), username: (v.username as string | null) ?? null, role: (v.role as string | null) ?? null,
        firstSeen: Number(v.first_seen), lastSeen: Number(v.last_seen),
        ...viewerData({
          watchedS: Number(v.watched_s), httpBytes: Number(v.http_bytes), p2pBytes: Number(v.p2p_bytes),
          edgeBytes: Number(v.edge_bytes), edgeHitBytes: Number(v.edge_hit_bytes), stalls: Number(v.stalls),
          stalledMs: Number(v.stalled_ms), errors: Number(v.errors), dirty: false,
        }),
      }));
    const streams = (this.st("SELECT * FROM play_streams WHERE play_id = ? ORDER BY id").all(id) as Array<Record<string, unknown>>)
      .map((s) => ({
        id: Number(s.id), hlsSessionId: String(s.hls_session_id), variantKey: (s.variant_key as string | null) ?? null,
        engine: (s.engine as string | null) ?? null, decision: (s.decision as string | null) ?? null,
        reason: (s.reason as string | null) ?? null, summary: (s.summary as string | null) ?? null,
        audioStreamId: s.audio_stream_id as number | null, subtitleStreamId: s.subtitle_stream_id as number | null,
        quality: s.quality as number | null, ownerUserId: (s.owner_user_id as string | null) ?? null,
        offsetS: s.offset_s as number | null, kbps: s.kbps as number | null,
        notes: (parse(s.notes) as Record<string, string | number> | null) ?? {},
        startedAt: Number(s.started_at), endedAt: (s.ended_at as number | null) ?? null,
        peakViewers: Number(s.peak_viewers),
      }));
    const events = (this.st("SELECT * FROM events WHERE play_id = ? ORDER BY at, id").all(id) as Array<Record<string, unknown>>)
      .map((e) => ({
        id: Number(e.id), at: Number(e.at), kind: String(e.kind), userId: (e.user_id as string | null) ?? null,
        username: (e.username as string | null) ?? null, posS: (e.pos_s as number | null) ?? null, detail: parse(e.detail),
      }));
    return { play: playOf(r), viewers, streams, events };
  }

  usage(opts: { limit?: unknown; before?: unknown } = {}) {
    const before = Number(opts.before) > 0 ? Number(opts.before) : null;
    return (this.st(`SELECT * FROM usage WHERE (@before IS NULL OR id < @before) ORDER BY id DESC LIMIT @limit`)
      .all({ before, limit: page(opts.limit) }) as Array<Record<string, unknown>>)
      .map((u) => ({
        id: Number(u.id), at: Number(u.at), kind: String(u.kind), roomId: (u.room_id as string | null) ?? null,
        userId: (u.user_id as string | null) ?? null, username: (u.username as string | null) ?? null,
        guildId: (u.guild_id as string | null) ?? null, channelId: (u.channel_id as string | null) ?? null,
      }));
  }

  requests(opts: { limit?: unknown; before?: unknown; q?: unknown; userId?: string } = {}) {
    const before = Number(opts.before) > 0 ? Number(opts.before) : null;
    const { q, like } = search(opts.q);
    // A request from somebody not yet seen in a room has no name; the one
    // they were seen by since stands in.
    return (this.st(`SELECT r.*, COALESCE(r.username, pe.username) AS username
        FROM requests r LEFT JOIN people pe ON pe.user_id = r.user_id
        WHERE (@before IS NULL OR r.id < @before)
        AND (@userId IS NULL OR r.user_id = @userId)
        AND (@like IS NULL OR r.title LIKE @like ESCAPE '\\' OR COALESCE(r.username, pe.username) LIKE @like ESCAPE '\\'
             OR r.user_id = @q OR CAST(r.tmdb_id AS TEXT) = @q)
        ORDER BY r.id DESC LIMIT @limit`)
      .all({ before, q, like, userId: opts.userId ?? null, limit: page(opts.limit) }) as Array<Record<string, unknown>>)
      .map((r) => ({
        id: Number(r.id), at: Number(r.at), userId: (r.user_id as string | null) ?? null,
        username: (r.username as string | null) ?? null, mediaType: String(r.media_type), tmdbId: Number(r.tmdb_id),
        seasons: parse(r.seasons) as number[] | "all" | null, title: (r.title as string | null) ?? null,
        outcome: String(r.outcome), status: (r.status as number | null) ?? null, error: (r.error as string | null) ?? null,
      }));
  }

  /** Everybody seen, most recently first, with what they have watched and had. */
  people(opts: { q?: unknown; limit?: unknown; offset?: unknown } = {}): PersonSummary[] {
    const { q, like } = search(opts.q);
    const offset = Math.max(0, Math.floor(Number(opts.offset)) || 0);
    return (this.st(`${PEOPLE_SELECT}
      WHERE (@like IS NULL OR pe.username LIKE @like ESCAPE '\\' OR pe.user_id = @q)
      ORDER BY pe.last_seen DESC LIMIT @limit OFFSET @offset`)
      .all({ q, like, limit: page(opts.limit), offset }) as Array<Record<string, unknown>>).map(personOf);
  }

  /** One person: their totals, every play they were in, their requests, where they used it. */
  person(userId: string) {
    const row = this.st(`${PEOPLE_SELECT} WHERE pe.user_id = @userId`).get({ userId }) as Record<string, unknown> | undefined;
    if (!row) return null;
    const plays = (this.st(`SELECT p.*, ${HOST_NAME}, v.role AS v_role, v.first_seen AS v_first, v.last_seen AS v_last, v.watched_s AS v_watched,
        v.http_bytes AS v_http, v.p2p_bytes AS v_p2p, v.edge_bytes AS v_edge, v.edge_hit_bytes AS v_hit,
        v.stalls AS v_stalls, v.stalled_ms AS v_stalled, v.errors AS v_errors
      FROM play_viewers v JOIN plays p ON p.id = v.play_id WHERE v.user_id = ? ORDER BY p.id DESC LIMIT 500`)
      .all(userId) as Array<Record<string, unknown>>)
      .map((r) => ({
        ...playOf(r),
        role: (r.v_role as string | null) ?? null,
        firstSeen: Number(r.v_first),
        lastSeen: Number(r.v_last),
        ...viewerData({
          watchedS: Number(r.v_watched), httpBytes: Number(r.v_http), p2pBytes: Number(r.v_p2p),
          edgeBytes: Number(r.v_edge), edgeHitBytes: Number(r.v_hit), stalls: Number(r.v_stalls),
          stalledMs: Number(r.v_stalled), errors: Number(r.v_errors), dirty: false,
        }),
      }));
    const places = (this.st(`SELECT guild_id, channel_id, SUM(kind = 'launch') AS launches, SUM(kind = 'join') AS joins,
        MIN(at) AS first, MAX(at) AS last
      FROM usage WHERE user_id = ? GROUP BY guild_id, channel_id ORDER BY last DESC`).all(userId) as Array<Record<string, unknown>>)
      .map((r) => ({
        guildId: (r.guild_id as string | null) ?? null, channelId: (r.channel_id as string | null) ?? null,
        launches: Number(r.launches), joins: Number(r.joins), first: Number(r.first), last: Number(r.last),
      }));
    return { person: personOf(row), plays, requests: this.requests({ userId, limit: 500 }), places };
  }

  /** Every Discord server the Activity was used in, and each of its channels. */
  places(): PlaceGuild[] {
    const usage = this.st(`SELECT guild_id, channel_id, SUM(kind = 'launch') AS launches, SUM(kind = 'join') AS joins,
        COUNT(DISTINCT user_id) AS people, MIN(at) AS first, MAX(at) AS last
      FROM usage GROUP BY guild_id, channel_id`).all() as Array<Record<string, unknown>>;
    const plays = this.st(`SELECT guild_id, channel_id, COUNT(*) AS plays, COALESCE(SUM(played_s), 0) AS played_s,
        MIN(started_at) AS first, MAX(updated_at) AS last
      FROM plays GROUP BY guild_id, channel_id`).all() as Array<Record<string, unknown>>;
    const guildPeople = new Map((this.st(`SELECT guild_id, COUNT(DISTINCT user_id) AS n FROM usage GROUP BY guild_id`)
      .all() as Array<{ guild_id: string | null; n: number }>).map((r) => [r.guild_id ?? "", r.n] as const));
    const who = this.st(`SELECT u.guild_id, u.channel_id, u.user_id, COALESCE(pe.username, MAX(u.username)) AS name, MAX(u.at) AS last
      FROM usage u LEFT JOIN people pe ON pe.user_id = u.user_id
      GROUP BY u.guild_id, u.channel_id, u.user_id ORDER BY last DESC`).all() as Array<Record<string, unknown>>;
    const key = (g: unknown, c: unknown) => `${g ?? ""}|${c ?? ""}`;
    const channels = new Map<string, PlaceChannel>();
    const channelOf = (g: unknown, c: unknown): PlaceChannel => {
      let ch = channels.get(key(g, c));
      if (!ch) {
        ch = { guildId: (g as string | null) ?? null, channelId: (c as string | null) ?? null, launches: 0, joins: 0,
          people: 0, names: [], plays: 0, playedS: 0, first: null, last: null };
        channels.set(key(g, c), ch);
      }
      return ch;
    };
    const span = (ch: PlaceChannel, first: unknown, last: unknown) => {
      const f = Number(first), l = Number(last);
      if (Number.isFinite(f)) ch.first = ch.first === null ? f : Math.min(ch.first, f);
      if (Number.isFinite(l)) ch.last = ch.last === null ? l : Math.max(ch.last, l);
    };
    for (const r of usage) {
      const ch = channelOf(r.guild_id, r.channel_id);
      ch.launches = Number(r.launches);
      ch.joins = Number(r.joins);
      ch.people = Number(r.people);
      span(ch, r.first, r.last);
    }
    for (const r of plays) {
      const ch = channelOf(r.guild_id, r.channel_id);
      ch.plays = Number(r.plays);
      ch.playedS = Math.round(Number(r.played_s));
      span(ch, r.first, r.last);
    }
    for (const r of who) {
      const ch = channelOf(r.guild_id, r.channel_id);
      if (ch.names.length < 30) ch.names.push({ userId: String(r.user_id), username: (r.name as string | null) ?? null });
    }
    const guilds = new Map<string, PlaceGuild>();
    for (const ch of channels.values()) {
      const g = ch.guildId ?? "";
      let guild = guilds.get(g);
      if (!guild) {
        guild = { guildId: ch.guildId, launches: 0, joins: 0, people: guildPeople.get(g) ?? 0, plays: 0, playedS: 0,
          first: null, last: null, channels: [] };
        guilds.set(g, guild);
      }
      guild.launches += ch.launches;
      guild.joins += ch.joins;
      guild.plays += ch.plays;
      guild.playedS += ch.playedS;
      if (ch.first !== null) guild.first = guild.first === null ? ch.first : Math.min(guild.first, ch.first);
      if (ch.last !== null) guild.last = guild.last === null ? ch.last : Math.max(guild.last, ch.last);
      guild.channels.push(ch);
    }
    for (const g of guilds.values()) g.channels.sort((a, b) => (b.last ?? 0) - (a.last ?? 0));
    return [...guilds.values()].sort((a, b) => (b.last ?? 0) - (a.last ?? 0));
  }

  /**
   * What players were given over HTTP, how much of it Discord's cache answered
   * and how much came from other viewers, by when the play started: the last
   * day, week, and all of it; and the titles that took the most.
   */
  discordCache(now = this.now()) {
    const sums = (since: number | null) => {
      const r = this.st(`SELECT COALESCE(SUM(v.http_bytes), 0) AS http, COALESCE(SUM(v.edge_bytes), 0) AS edge,
          COALESCE(SUM(v.edge_hit_bytes), 0) AS hit, COALESCE(SUM(v.p2p_bytes), 0) AS p2p, COUNT(DISTINCT p.id) AS plays
        FROM play_viewers v JOIN plays p ON p.id = v.play_id WHERE (@since IS NULL OR p.started_at >= @since)`)
        .get({ since }) as Record<string, number>;
      return cacheSums(r);
    };
    const titles = (this.st(`SELECT p.rating_key, MAX(p.title) AS title, COUNT(DISTINCT p.id) AS plays,
        COALESCE(SUM(v.http_bytes), 0) AS http, COALESCE(SUM(v.edge_bytes), 0) AS edge,
        COALESCE(SUM(v.edge_hit_bytes), 0) AS hit, COALESCE(SUM(v.p2p_bytes), 0) AS p2p
      FROM play_viewers v JOIN plays p ON p.id = v.play_id
      GROUP BY p.rating_key ORDER BY SUM(v.http_bytes + v.p2p_bytes) DESC LIMIT 50`).all() as Array<Record<string, unknown>>)
      .map((r) => ({ ratingKey: String(r.rating_key), title: (r.title as string | null) ?? null, ...cacheSums(r as Record<string, number>) }));
    return { day: sums(now - 86_400_000), week: sums(now - 7 * 86_400_000), all: sums(null), titles };
  }

  /** Titles by their keys, as the history has them. */
  titles(ratingKeys: string[]): Map<string, string> {
    const out = new Map<string, string>();
    const stmt = this.st("SELECT title FROM plays WHERE rating_key = ? AND title IS NOT NULL ORDER BY id DESC LIMIT 1");
    for (const k of new Set(ratingKeys)) {
      const row = stmt.get(k) as { title: string } | undefined;
      if (row) out.set(k, row.title);
    }
    return out;
  }

  /** The play each stream session was part of, by its session id. */
  sessions(sessionIds: string[]): Map<string, { playId: number; title: string | null; ratingKey: string }> {
    const out = new Map<string, { playId: number; title: string | null; ratingKey: string }>();
    const stmt = this.st(`SELECT p.id, p.title, p.rating_key FROM play_streams s JOIN plays p ON p.id = s.play_id
      WHERE s.hls_session_id = ? ORDER BY s.id DESC LIMIT 1`);
    for (const id of new Set(sessionIds)) {
      const row = stmt.get(id) as { id: number; title: string | null; rating_key: string } | undefined;
      if (row) out.set(id, { playId: row.id, title: row.title, ratingKey: row.rating_key });
    }
    return out;
  }

  // ─── Graphs, the file, trimming ──────────────────────────────

  /**
   * The history by day over the last `days` days (0: all of it): plays,
   * people, the data sent and where from, streams, buffering, requests and
   * launches; plays by hour and weekday; the titles, people and servers most
   * watched; and why streams were re-encoded. A play counts on the day, hour
   * and weekday it started, on the clock of `zone`: the time zone of whoever
   * has the page open, UTC when it isn't said.
   */
  graphs(opts: { days?: unknown; zone?: unknown } = {}, now = this.now()): Graphs {
    const asked = Math.floor(Number(opts.days ?? 30));
    const days = Number.isFinite(asked) && asked >= 0 ? Math.min(asked, MAX_GRAPH_DAYS) : 30;
    const zone = zoneClock(opts.zone);
    const today = zone.day(now);
    let first = today - Math.max(1, days) + 1;
    if (days === 0) {
      const r = this.st(`SELECT MIN(at) AS at FROM (SELECT MIN(started_at) AS at FROM plays
          UNION ALL SELECT MIN(at) FROM usage UNION ALL SELECT MIN(at) FROM requests)`).get() as { at: number | null };
      first = r.at === null ? today : Math.max(today - MAX_GRAPH_DAYS + 1, Math.min(today, zone.day(r.at)));
    }
    const from = zone.dayStart(first);
    const local = (column: string) => zone.sql(column, from, now);
    const dayOf = (column: string) => `CAST(${local(column)} / 86400000 AS INTEGER)`;
    const byDay = new Map<number, GraphDay>();
    for (let d = first; d <= today; d++) byDay.set(d, emptyDay(d * DAY_MS));
    const rows = (sql: string) => this.st(sql).all({ from }) as Array<Record<string, unknown>>;
    const each = (sql: string, fill: (g: GraphDay, r: Record<string, unknown>) => void) => {
      for (const r of rows(sql)) {
        const g = byDay.get(int(r.d));
        if (g) fill(g, r);
      }
    };
    const DAY = dayOf("started_at");
    each(`SELECT ${DAY} AS d, COUNT(*) AS plays, COALESCE(SUM(played_s), 0) AS played, MAX(peak_viewers) AS peak
      FROM plays WHERE started_at >= @from GROUP BY d`, (g, r) => {
      g.plays = int(r.plays);
      g.playedS = Math.round(int(r.played));
      g.peakViewers = int(r.peak);
    });
    each(`SELECT ${dayOf("p.started_at")} AS d, COUNT(DISTINCT v.user_id) AS people,
        SUM(v.watched_s) AS watched, SUM(v.http_bytes) AS http, SUM(v.edge_bytes) AS edge, SUM(v.edge_hit_bytes) AS hit,
        SUM(MAX(0, v.http_bytes - v.edge_hit_bytes)) AS bot, SUM(v.p2p_bytes) AS p2p,
        SUM(v.stalls) AS stalls, SUM(v.stalled_ms) AS stalled, SUM(v.errors) AS errors
      FROM play_viewers v JOIN plays p ON p.id = v.play_id WHERE p.started_at >= @from GROUP BY d`, (g, r) => {
      g.people = int(r.people);
      g.watchedS = Math.round(int(r.watched));
      g.httpBytes = int(r.http);
      g.edgeBytes = int(r.edge);
      g.edgeHitBytes = int(r.hit);
      g.botBytes = int(r.bot);
      g.p2pBytes = int(r.p2p);
      g.stalls = int(r.stalls);
      g.stalledMs = int(r.stalled);
      g.errors = int(r.errors);
    });
    each(`SELECT ${DAY} AS d, COUNT(*) AS streams, SUM(decision = 'copy') AS copies, SUM(decision = 'transcode') AS reencodes
      FROM play_streams WHERE started_at >= @from GROUP BY d`, (g, r) => {
      g.streams = int(r.streams);
      g.copies = int(r.copies);
      g.reencodes = int(r.reencodes);
    });
    each(`SELECT ${dayOf("at")} AS d, COUNT(*) AS n FROM requests WHERE at >= @from GROUP BY d`,
      (g, r) => { g.requests = int(r.n); });
    each(`SELECT ${dayOf("at")} AS d, COUNT(*) AS n FROM usage WHERE kind = 'launch' AND at >= @from GROUP BY d`,
      (g, r) => { g.launches = int(r.n); });

    const daily = [...byDay.values()];
    const sum = (k: keyof GraphDay) => daily.reduce((s, g) => s + g[k], 0);
    const people = this.st(`SELECT COUNT(DISTINCT v.user_id) AS n FROM play_viewers v JOIN plays p ON p.id = v.play_id
      WHERE p.started_at >= @from`).get({ from }) as { n: number };
    const edge = sum("edgeBytes");
    const totals = {
      plays: sum("plays"), playedS: sum("playedS"), watchedS: sum("watchedS"), people: int(people.n),
      httpBytes: sum("httpBytes"), edgeBytes: edge, edgeHitBytes: sum("edgeHitBytes"), botBytes: sum("botBytes"),
      p2pBytes: sum("p2pBytes"), hitShare: edge > 0 ? sum("edgeHitBytes") / edge : null,
      stalls: sum("stalls"), stalledMs: sum("stalledMs"), errors: sum("errors"),
      streams: sum("streams"), copies: sum("copies"), reencodes: sum("reencodes"),
      requests: sum("requests"), launches: sum("launches"),
    };

    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, plays: 0, playedS: 0 }));
    for (const r of rows(`SELECT CAST(${local("started_at")} / 3600000 AS INTEGER) % 24 AS h, COUNT(*) AS plays,
        COALESCE(SUM(played_s), 0) AS played FROM plays WHERE started_at >= @from GROUP BY h`)) {
      const h = hours[int(r.h)];
      if (h) Object.assign(h, { plays: int(r.plays), playedS: Math.round(int(r.played)) });
    }
    // 1 January 1970 was a Thursday: day 0 is weekday 4, Sunday being 0.
    const weekdays = Array.from({ length: 7 }, (_, weekday) => ({ weekday, plays: 0, playedS: 0 }));
    for (const r of rows(`SELECT (${DAY} + 4) % 7 AS w, COUNT(*) AS plays, COALESCE(SUM(played_s), 0) AS played
        FROM plays WHERE started_at >= @from GROUP BY w`)) {
      const w = weekdays[int(r.w)];
      if (w) Object.assign(w, { plays: int(r.plays), playedS: Math.round(int(r.played)) });
    }

    const titles = rows(`SELECT p.rating_key AS k, MAX(p.title) AS title, COUNT(DISTINCT p.id) AS plays,
        COUNT(DISTINCT v.user_id) AS people, COALESCE(SUM(v.watched_s), 0) AS watched
      FROM plays p LEFT JOIN play_viewers v ON v.play_id = p.id WHERE p.started_at >= @from
      GROUP BY p.rating_key ORDER BY watched DESC, plays DESC LIMIT 10`)
      .map((r) => ({ ratingKey: String(r.k), title: (r.title as string | null) ?? null, plays: int(r.plays),
        people: int(r.people), watchedS: Math.round(int(r.watched)) }));
    const topPeople = rows(`SELECT v.user_id AS id, COALESCE(pe.username, MAX(v.username)) AS name, COUNT(*) AS plays,
        SUM(v.watched_s) AS watched, SUM(v.http_bytes + v.p2p_bytes) AS bytes
      FROM play_viewers v JOIN plays p ON p.id = v.play_id LEFT JOIN people pe ON pe.user_id = v.user_id
      WHERE p.started_at >= @from GROUP BY v.user_id ORDER BY watched DESC, plays DESC LIMIT 10`)
      .map((r) => ({ userId: String(r.id), username: (r.name as string | null) ?? null, plays: int(r.plays),
        watchedS: Math.round(int(r.watched)), bytes: int(r.bytes) }));
    const servers = rows(`SELECT p.guild_id AS g, COUNT(DISTINCT p.id) AS plays, COUNT(DISTINCT v.user_id) AS people,
        COALESCE(SUM(v.watched_s), 0) AS watched
      FROM plays p LEFT JOIN play_viewers v ON v.play_id = p.id WHERE p.started_at >= @from
      GROUP BY p.guild_id ORDER BY watched DESC, plays DESC LIMIT 10`)
      .map((r) => ({ guildId: (r.g as string | null) ?? null, plays: int(r.plays), people: int(r.people),
        watchedS: Math.round(int(r.watched)) }));
    const reasons = rows(`SELECT COALESCE(reason, 'No reason given') AS reason, COUNT(*) AS n FROM play_streams
      WHERE decision = 'transcode' AND started_at >= @from GROUP BY 1 ORDER BY n DESC, reason LIMIT 8`)
      .map((r) => ({ reason: String(r.reason), streams: int(r.n) }));

    return { days, zone: zone.zone, from, to: zone.dayStart(today + 1), totals, daily, hours, weekdays, titles, people: topPeople,
      servers, reasons };
  }

  /** The history file: how big it is, what it holds, and from when. */
  summary(): HistorySummary {
    const size = (f: string) => {
      try {
        return fs.statSync(f).size;
      } catch {
        return 0;
      }
    };
    const count = (sql: string) => int((this.st(sql).get() as { n: number }).n);
    const span = this.st(`SELECT MIN(at) AS first, MAX(at) AS last FROM (
        SELECT started_at AS at FROM plays UNION ALL SELECT at FROM usage UNION ALL SELECT at FROM requests)`)
      .get() as { first: number | null; last: number | null };
    return {
      path: this.db.name,
      bytes: size(this.db.name) + size(`${this.db.name}-wal`),
      plays: count("SELECT COUNT(*) AS n FROM plays"),
      open: count("SELECT COUNT(*) AS n FROM plays WHERE ended_at IS NULL"),
      events: count("SELECT COUNT(*) AS n FROM events"),
      usage: count("SELECT COUNT(*) AS n FROM usage"),
      requests: count("SELECT COUNT(*) AS n FROM requests"),
      people: count("SELECT COUNT(*) AS n FROM people"),
      first: span.first ?? null,
      last: span.last ?? null,
    };
  }

  /**
   * What removing the history from before `before` would remove: plays that
   * ended before it, with their viewers, streams and lines; launches, joins
   * and requests from before it; and people seen only before it. A play still
   * going is never removed.
   */
  trimPreview(before: number): TrimCounts {
    const one = (sql: string) => int((this.st(sql).get({ before }) as { n: number }).n);
    return {
      before,
      plays: one(`SELECT COUNT(*) AS n FROM plays p WHERE ${OLD_PLAY}`),
      events: one(`SELECT COUNT(*) AS n FROM events e WHERE ${OLD_EVENT}`),
      usage: one("SELECT COUNT(*) AS n FROM usage WHERE at < @before"),
      requests: one("SELECT COUNT(*) AS n FROM requests WHERE at < @before"),
      people: one(`SELECT COUNT(*) AS n FROM people pe WHERE ${OLD_PERSON}`),
    };
  }

  /** Remove the history from before `before` (see trimPreview), then shrink the file. */
  trim(before: number): TrimCounts & { bytesBefore: number; bytesAfter: number } {
    const bytesBefore = this.summary().bytes;
    const counts = this.trimPreview(before);
    this.db.transaction(() => {
      // People first: who is left with nothing is judged on what is still there.
      this.st(`DELETE FROM people WHERE user_id IN (SELECT pe.user_id FROM people pe WHERE ${OLD_PERSON})`).run({ before });
      this.st(`DELETE FROM events WHERE id IN (SELECT e.id FROM events e WHERE ${OLD_EVENT})`).run({ before });
      this.st(`DELETE FROM play_viewers WHERE play_id IN (SELECT p.id FROM plays p WHERE ${OLD_PLAY})`).run({ before });
      this.st(`DELETE FROM play_streams WHERE play_id IN (SELECT p.id FROM plays p WHERE ${OLD_PLAY})`).run({ before });
      this.st(`DELETE FROM plays WHERE id IN (SELECT p.id FROM plays p WHERE ${OLD_PLAY})`).run({ before });
      this.st("DELETE FROM usage WHERE at < @before").run({ before });
      this.st("DELETE FROM requests WHERE at < @before").run({ before });
    })();
    // Names written recently are written again only after a while: those
    // removed must be written the next time they are seen.
    this.names.clear();
    this.db.exec("VACUUM");
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    return { ...counts, bytesBefore, bytesAfter: this.summary().bytes };
  }

  /** The whole history, as one SQLite file. */
  snapshot(): Buffer {
    return this.db.serialize();
  }
}

/** A play to remove when trimming (as p): ended, before @before. */
const OLD_PLAY = "p.ended_at IS NOT NULL AND p.ended_at < @before";
/** A line to remove (as e): of a play removed, or of no play and before @before. */
const OLD_EVENT = `(e.play_id IN (SELECT p.id FROM plays p WHERE ${OLD_PLAY}) OR (e.play_id IS NULL AND e.at < @before))`;
/** Somebody to remove (as pe): last seen before @before, and in nothing kept. */
const OLD_PERSON = `pe.last_seen < @before
  AND NOT EXISTS (SELECT 1 FROM play_viewers v JOIN plays p ON p.id = v.play_id
    WHERE v.user_id = pe.user_id AND NOT (${OLD_PLAY}))
  AND NOT EXISTS (SELECT 1 FROM usage u WHERE u.user_id = pe.user_id AND u.at >= @before)
  AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.user_id = pe.user_id AND r.at >= @before)`;

const int = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export interface GraphDay {
  /** The date, written as its midnight in UTC: a day on the clock of the zone asked for, not an instant. */
  day: number;
  plays: number;
  playedS: number;
  peakViewers: number;
  people: number;
  watchedS: number;
  httpBytes: number;
  edgeBytes: number;
  edgeHitBytes: number;
  botBytes: number;
  p2pBytes: number;
  stalls: number;
  stalledMs: number;
  errors: number;
  streams: number;
  copies: number;
  reencodes: number;
  requests: number;
  launches: number;
}

function emptyDay(day: number): GraphDay {
  return { day, plays: 0, playedS: 0, peakViewers: 0, people: 0, watchedS: 0, httpBytes: 0, edgeBytes: 0, edgeHitBytes: 0,
    botBytes: 0, p2pBytes: 0, stalls: 0, stalledMs: 0, errors: 0, streams: 0, copies: 0, reencodes: 0, requests: 0, launches: 0 };
}

export interface Graphs {
  days: number;
  /** The time zone its days, hours and weekdays are in. */
  zone: string;
  /** The instants its first day begins and its last ends. */
  from: number;
  to: number;
  totals: Omit<GraphDay, "day" | "peakViewers"> & { hitShare: number | null };
  daily: GraphDay[];
  hours: Array<{ hour: number; plays: number; playedS: number }>;
  weekdays: Array<{ weekday: number; plays: number; playedS: number }>;
  titles: Array<{ ratingKey: string; title: string | null; plays: number; people: number; watchedS: number }>;
  people: Array<{ userId: string; username: string | null; plays: number; watchedS: number; bytes: number }>;
  servers: Array<{ guildId: string | null; plays: number; people: number; watchedS: number }>;
  reasons: Array<{ reason: string; streams: number }>;
}

export interface HistorySummary {
  path: string;
  bytes: number;
  plays: number;
  open: number;
  events: number;
  usage: number;
  requests: number;
  people: number;
  first: number | null;
  last: number | null;
}

export interface TrimCounts {
  before: number;
  plays: number;
  events: number;
  usage: number;
  requests: number;
  people: number;
}

/** The host's name, as last seen, beside a play (as p). */
const HOST_NAME = "(SELECT pe.username FROM people pe WHERE pe.user_id = p.host_user_id) AS host_name";

const PEOPLE_SELECT = `
  SELECT pe.user_id, pe.username, pe.first_seen, pe.last_seen,
    COALESCE(v.plays, 0) AS plays, COALESCE(v.watched_s, 0) AS watched_s, COALESCE(v.http, 0) AS http,
    COALESCE(v.p2p, 0) AS p2p, COALESCE(v.edge, 0) AS edge, COALESCE(v.hit, 0) AS hit,
    COALESCE(v.stalls, 0) AS stalls, COALESCE(v.stalled_ms, 0) AS stalled_ms, COALESCE(v.errors, 0) AS errors,
    (SELECT COUNT(*) FROM plays p WHERE p.host_user_id = pe.user_id) AS hosted,
    (SELECT COUNT(*) FROM usage u WHERE u.user_id = pe.user_id AND u.kind = 'launch') AS launches,
    (SELECT COUNT(*) FROM requests r WHERE r.user_id = pe.user_id) AS requests,
    (SELECT p.title FROM play_viewers lv JOIN plays p ON p.id = lv.play_id WHERE lv.user_id = pe.user_id
      ORDER BY lv.last_seen DESC LIMIT 1) AS last_title
  FROM people pe
  LEFT JOIN (SELECT user_id, COUNT(*) AS plays, SUM(watched_s) AS watched_s, SUM(http_bytes) AS http,
      SUM(p2p_bytes) AS p2p, SUM(edge_bytes) AS edge, SUM(edge_hit_bytes) AS hit, SUM(stalls) AS stalls,
      SUM(stalled_ms) AS stalled_ms, SUM(errors) AS errors
    FROM play_viewers GROUP BY user_id) v ON v.user_id = pe.user_id`;

export interface PersonSummary extends ViewerData {
  userId: string;
  username: string | null;
  firstSeen: number;
  lastSeen: number;
  plays: number;
  hosted: number;
  launches: number;
  requests: number;
  lastTitle: string | null;
}

function personOf(r: Record<string, unknown>): PersonSummary {
  return {
    userId: String(r.user_id),
    username: (r.username as string | null) ?? null,
    firstSeen: Number(r.first_seen),
    lastSeen: Number(r.last_seen),
    plays: Number(r.plays),
    hosted: Number(r.hosted),
    launches: Number(r.launches),
    requests: Number(r.requests),
    lastTitle: (r.last_title as string | null) ?? null,
    ...viewerData({
      watchedS: Number(r.watched_s), httpBytes: Number(r.http), p2pBytes: Number(r.p2p), edgeBytes: Number(r.edge),
      edgeHitBytes: Number(r.hit), stalls: Number(r.stalls), stalledMs: Number(r.stalled_ms), errors: Number(r.errors),
      dirty: false,
    }),
  };
}

export interface PlaceChannel {
  guildId: string | null;
  channelId: string | null;
  launches: number;
  joins: number;
  people: number;
  /** The people who came, most recently first; 30 at most. */
  names: Array<{ userId: string; username: string | null }>;
  plays: number;
  playedS: number;
  first: number | null;
  last: number | null;
}

export interface PlaceGuild extends Omit<PlaceChannel, "channelId" | "names"> {
  channels: PlaceChannel[];
}

function cacheSums(r: Record<string, number>) {
  const http = Number(r.http), edge = Number(r.edge), hit = Number(r.hit), p2p = Number(r.p2p);
  return {
    plays: r.plays === undefined ? undefined : Number(r.plays),
    httpBytes: http,
    edgeBytes: edge,
    edgeHitBytes: hit,
    p2pBytes: p2p,
    botBytes: Math.max(0, http - hit),
    /** Of what Discord's proxy answered with a cache status, the share its cache had. */
    hitShare: edge > 0 ? hit / edge : null,
  };
}

function viewerData(v: ViewerTotals): ViewerData {
  return {
    watchedS: Math.round(v.watchedS),
    httpBytes: Math.round(v.httpBytes),
    p2pBytes: Math.round(v.p2pBytes),
    edgeBytes: Math.round(v.edgeBytes),
    edgeHitBytes: Math.round(v.edgeHitBytes),
    // Everything not from peers came over HTTP; what Discord's cache didn't
    // answer of it, the bot sent.
    botBytes: Math.round(Math.max(0, v.httpBytes - v.edgeHitBytes)),
    stalls: v.stalls,
    stalledMs: Math.round(v.stalledMs),
    errors: v.errors,
  };
}

function playOf(r: Record<string, unknown>) {
  return {
    id: Number(r.id),
    roomId: String(r.room_id),
    ratingKey: String(r.rating_key),
    title: (r.title as string | null) ?? null,
    guildId: (r.guild_id as string | null) ?? null,
    channelId: (r.channel_id as string | null) ?? null,
    hostUserId: (r.host_user_id as string | null) ?? null,
    hostName: (r.host_name as string | null) ?? null,
    startedAt: Number(r.started_at),
    endedAt: (r.ended_at as number | null) ?? null,
    endReason: (r.end_reason as string | null) ?? null,
    endBy: (r.end_by as string | null) ?? null,
    startPosS: (r.start_pos_s as number | null) ?? null,
    lastPosS: (r.last_pos_s as number | null) ?? null,
    playedS: Math.round(Number(r.played_s)),
    peakViewers: Number(r.peak_viewers),
  };
}
