import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { overview, type ClientView, type Overview, type RoomView, type StreamView, type ViewerData } from "./data.js";
import { instanceHosts } from "../routes/discord.js";
import type {
  ClientLogEntry, ClientLogEvent, HostRequestEvent, PlaceEvent, ProcessingEvent, RequestEvent, SentEvent, StreamIssueEvent, TransportEvent,
} from "../services/admin-hooks.js";
import { zoneClock } from "./zone.js";
import { systemSampler, type SystemSample } from "./system.js";

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
/**
 * A stop of the picture that began this soon after the viewer joined, the
 * title started or their stream changed is the start loading, not
 * buffering: on 17 November every viewer who joined was counted as
 * buffering once, for the seconds their player took to load the start.
 */
const START_LOAD_MS = 6_000;
/** …and one this close around a seek, the seek's. */
const SEEK_LOAD_BEFORE_MS = 1_000;
const SEEK_LOAD_AFTER_MS = 3_000;
/** A viewer following the host onto a stream this soon after the host moved followed them. */
const HOST_MOVE_MS = 15_000;
/** How long after the room notes how its host or a co-host changed a change seen is put down to it. */
const ROLE_WHY_MS = 10_000;
/** How long a workaround said before its title's play opened waits for it. */
const ISSUE_WAIT_MS = 30_000;
/** What a viewer had been doing in the room before a session: what their client and role were as it opened. */
const LEAD_KINDS = ["joined", "came back", "switched client", "role", "left"];
/** Players whose key is remembered, for who sent whom what: the most recent kept. */
const MAX_PEER_KEYS = 500;
/** How often the room's position in the title is written down, for the session's charts. */
const POSITION_EVERY_MS = 10_000;
/** A player that has said nothing for this long says nothing of how it is now. */
const PLAYER_QUIET_MS = 30_000;
const HOUR_MS = 3_600_000;
/** A period this short is shown by the hour. */
const HOURLY_UP_TO_MS = 72 * HOUR_MS;
/** A player not heard from in this long is forgotten. */
const PLAYER_FORGET_MS = 10 * 60_000;
/** How much of each player's drift and buffer is kept for Now Playing's charts. */
export const HEALTH_KEEP_MS = 10 * 60_000;
/** Drift past which a player corrects itself (client Player.tsx DRIFT_THRESHOLD_S): out of sync. */
export const OUT_OF_SYNC_S = 2;

type Instance = { hostUserId: string; guildId: string | null; channelId: string | null; createdAt: number };

export interface RecorderOptions {
  dbPath: string;
  now?: () => number;
  /** The rooms as the Now playing page has them. */
  source?: (now: number) => Overview;
  /** Activity launches: routes/discord.ts's instanceHosts. */
  instances?: () => ReadonlyMap<string, Instance>;
  /** The server's load, sampled once a minute (system.ts); null records none. */
  system?: () => SystemSample | null;
}

interface ViewerTotals {
  /** When they joined the play, or came back to it. */
  joinedAt: number;
  /** When they started on, or moved to, the stream they are on. */
  streamAt: number;
  watchedS: number;
  httpBytes: number;
  p2pBytes: number;
  /** What their player sent to other viewers' players. */
  upBytes: number;
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
  /** How many were on it at the last look: none, and its end is nobody's loss. */
  lastViewers: number;
}

interface OpenPlay {
  id: number;
  ratingKey: string;
  events: number;
  errorEvents: number;
  playedS: number;
  peak: number;
  lastTick: number;
  startedAt: number;
  /** The last play and seek the room acted on. */
  playAt: number;
  seekAt: number;
  /** When the room's position was last written down, and whether it was playing then. */
  posAt: number;
  posPlaying: boolean | null;
  streams: Map<string, StreamRow>;
  viewers: Map<string, ViewerTotals>;
  /** What its players have had, at each look: for the dashboard's live graph. */
  flow: FlowSample[];
  /** Whether a player has said the title reached its end: said once. */
  reachedEnd: boolean;
  /** What each viewer's player sent another's, by "from|to": for Now Playing. */
  shares: Map<string, number>;
  /** The workarounds its streams needed, said once a play each. */
  issues: Set<string>;
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
  device: string | null;
}

interface RoomSnap {
  clients: Map<string, ClientSnap>;
  /** Everybody seen in the room, for one "join" each in the usage log. */
  ever: Set<string>;
  /** The play its clients were last seen in: a stream of the title before is no change in this one. */
  playId: number | null;
  waitingSince: number | null;
  /** What the room waited for the host for, and the track change behind it. */
  waitWhy: string | null;
  waitSwitching: string | null;
  /** The host's last move to another stream: those on theirs follow. */
  hostMove: { at: number; name: string | null; from: string; to: string; why: string | null } | null;
  /** The host's last change of subtitles: those following the host's change with them. */
  hostSubtitle: { at: number; name: string | null; from: number; to: number } | null;
  /** The client each viewer was last on, by user id: one back on another is a switch. */
  devices: Map<string, string>;
}

/** A stream's tracks, without what makes it somebody's own: "135844:0". */
const tracksOf = (key: string) => key.split(/[@/]/)[0];

/** One page load of a player, from its log lines. */
interface PlayerState {
  session: string;
  p2p: number;
  http: number;
  edge: number;
  edgeHit: number;
  /** What it has sent to other players, in all and to each by their player key; and of that, what was put down to whom. */
  up: number;
  upTo: Map<string, number>;
  upCredited: Map<string, number>;
  sampled: boolean;
  waitingSince: number | null;
  waitingAfterSeek: boolean;
  /** The picture's readyState as it stopped: 0 is a player with nothing loaded yet. */
  waitingReady: number | null;
  /** Whether the picture has moved on this page: a stop before it does is the start loading. */
  played: boolean;
  lastAt: number;
  /** Its last Health sample's distance from the room (null for the host's) and what it has downloaded ahead, seconds. */
  driftS: number | null;
  aheadS: number | null;
  /** Those over the last HEALTH_KEEP_MS: [time, drift, ahead]. */
  health: Array<[number, number | null, number | null]>;
}

/** What a viewer's player is doing, as the Now Playing page shows it. */
export interface PlayerNow {
  /** Stopped for want of data, loading the start or a stream, or loading after a seek; null when it isn't. */
  stall: "buffering" | "start" | "seek" | null;
  sinceMs: number | null;
  /** Its last sample: how far from the room it is (null for the host), and how much it has downloaded ahead, seconds. */
  driftS?: number | null;
  aheadS?: number | null;
  /** Those over the last minutes: [time, drift, ahead]. */
  health?: Array<[number, number | null, number | null]>;
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
CREATE INDEX IF NOT EXISTS events_room_user ON events(room_id, user_id, at);
CREATE INDEX IF NOT EXISTS events_user ON events(user_id, at);
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
-- Where in the title the room (user_id NULL) and each viewer's player were.
CREATE TABLE IF NOT EXISTS positions (
  play_id INTEGER NOT NULL,
  user_id TEXT,
  at INTEGER NOT NULL,
  pos_s REAL NOT NULL,
  playing INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS positions_play ON positions(play_id, at);
-- Each minute: what the bot's port sent (sent), what players had from it
-- (bot), from Discord's cache (hit) and from each other (p2p); and, at most,
-- the viewers watching something playing, the streams they were on and
-- those streams' bitrates added up (feed: one feed of each).
CREATE TABLE IF NOT EXISTS traffic (
  minute INTEGER PRIMARY KEY,
  sent_bytes INTEGER NOT NULL DEFAULT 0,
  bot_bytes INTEGER NOT NULL DEFAULT 0,
  hit_bytes INTEGER NOT NULL DEFAULT 0,
  p2p_bytes INTEGER NOT NULL DEFAULT 0,
  viewers INTEGER NOT NULL DEFAULT 0,
  streams INTEGER NOT NULL DEFAULT 0,
  feed_kbps INTEGER NOT NULL DEFAULT 0
);
-- Each minute of a play: what its players had from the bot (bot), from
-- Discord's cache (hit) and from each other (p2p).
CREATE TABLE IF NOT EXISTS play_flow (
  play_id INTEGER NOT NULL,
  minute INTEGER NOT NULL,
  bot_bytes INTEGER NOT NULL DEFAULT 0,
  hit_bytes INTEGER NOT NULL DEFAULT 0,
  p2p_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (play_id, minute)
);
-- What one viewer's player sent another's in a play.
CREATE TABLE IF NOT EXISTS play_shares (
  play_id INTEGER NOT NULL,
  from_user TEXT NOT NULL,
  to_user TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (play_id, from_user, to_user)
);
-- Each viewer's player in a play, every 10 seconds (its Health sample): its
-- offset from the room (null for the host), what it had downloaded ahead and
-- in the browser's buffer, what it had from the server (bot), Discord's cache
-- (hit) and other viewers (p2p) and sent them (up) since its last sample, the
-- frames it showed and dropped since then, its memory, its peers and its
-- playback rate while correcting drift.
CREATE TABLE IF NOT EXISTS play_health (
  play_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  drift_s REAL,
  ahead_s REAL,
  buffer_s REAL,
  bot_bytes INTEGER NOT NULL DEFAULT 0,
  hit_bytes INTEGER NOT NULL DEFAULT 0,
  p2p_bytes INTEGER NOT NULL DEFAULT 0,
  up_bytes INTEGER NOT NULL DEFAULT 0,
  frames_shown INTEGER,
  frames_dropped INTEGER,
  heap_mb REAL,
  peers INTEGER,
  rate_x REAL
);
CREATE INDEX IF NOT EXISTS play_health_play ON play_health(play_id, at);
-- How long each step of preparing a title or making its stream took
-- (services/admin-hooks.ts ProcessingKind), for the stream it served when
-- there was one.
CREATE TABLE IF NOT EXISTS processing (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  hls_session_id TEXT,
  rating_key TEXT,
  ms INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS processing_at ON processing(at);
CREATE INDEX IF NOT EXISTS processing_title ON processing(rating_key, at);
CREATE INDEX IF NOT EXISTS processing_session ON processing(hls_session_id);
-- The server's load, each minute: the machine's CPU and memory, the bot's
-- CPU share and memory, the load average, and at most the streams running,
-- the transcodes among them and the viewers watching.
CREATE TABLE IF NOT EXISTS system_load (
  minute INTEGER PRIMARY KEY,
  cpu_pct REAL,
  bot_cpu_pct REAL,
  mem_pct REAL,
  rss_mb REAL,
  load1 REAL,
  streams INTEGER NOT NULL DEFAULT 0,
  encodes INTEGER NOT NULL DEFAULT 0,
  viewers INTEGER NOT NULL DEFAULT 0
);
-- Discord servers' and channels' names.
CREATE TABLE IF NOT EXISTS places (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  guild_id TEXT,
  updated_at INTEGER NOT NULL
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
  private readonly system: () => SystemSample | null;
  /** The minute the machine's load was last sampled in. */
  private loadMinute = -1;
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
  /** Whose each player is, by the key its peer id starts with: for who sent whom what. */
  private readonly peerKeys = new Map<string, string>();
  /** Workarounds said of a title before its play opened (streamIssue). */
  private pendingIssues: StreamIssueEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(opts: RecorderOptions) {
    this.now = opts.now ?? Date.now;
    this.system = opts.system ?? systemSampler();
    this.source = opts.source ?? overview;
    this.instances = opts.instances ?? (() => instanceHosts);
    this.startedAt = this.now();
    fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
    this.db = new Database(opts.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    // Columns added since the tables were first made.
    const has = (table: string, col: string) =>
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === col);
    if (!has("plays", "end_cause")) this.db.exec("ALTER TABLE plays ADD COLUMN end_cause TEXT");
    if (!has("play_viewers", "up_bytes")) this.db.exec("ALTER TABLE play_viewers ADD COLUMN up_bytes INTEGER NOT NULL DEFAULT 0");
    if (Number(this.db.pragma("user_version", { simple: true })) < 2) this.db.transaction(() => mendHistory(this.db))();
    this.db.pragma("user_version = 2");
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
      // Who watched while something played, the streams they were on, and
      // those streams' bitrates: what the upload is for.
      let watching = 0;
      let feeds = 0;
      let feedKbps = 0;
      for (const r of ov.rooms) {
        if (!r.playing) continue;
        watching += r.clients.filter((c) => c.connected && c.watching).length;
        for (const s of r.streams) {
          if (!s.hlsSessionId || s.viewers.length === 0) continue;
          feeds++;
          feedKbps += s.kbps ?? 0;
        }
      }
      if (watching || feeds) this.traffic(at, { viewers: watching, streams: feeds, feedKbps });
      this.load(at, ov.rooms, watching);
      for (const play of this.open.values()) this.flushViewers(play);
      for (const [key, p] of this.players) if (at - p.lastAt > PLAYER_FORGET_MS) this.players.delete(key);
    })();
  }

  /**
   * The minute's streams running, transcodes among them and viewers (at most,
   * look by look), and once a minute the machine's load (system.ts).
   */
  private load(at: number, rooms: RoomView[], watching: number): void {
    const minute = Math.floor(at / 60_000);
    let streams = 0;
    let encodes = 0;
    for (const r of rooms) {
      for (const s of r.streams) {
        if (!s.hlsSessionId) continue;
        streams++;
        if (s.decision === "transcode") encodes++;
      }
    }
    this.st(`INSERT INTO system_load (minute, streams, encodes, viewers) VALUES (?, ?, ?, ?)
             ON CONFLICT (minute) DO UPDATE SET streams = MAX(streams, excluded.streams), encodes = MAX(encodes, excluded.encodes),
               viewers = MAX(viewers, excluded.viewers)`).run(minute, streams, encodes, watching);
    if (minute === this.loadMinute) return;
    this.loadMinute = minute;
    const s = this.system();
    if (!s) return;
    this.st("UPDATE system_load SET cpu_pct = ?, bot_cpu_pct = ?, mem_pct = ?, rss_mb = ?, load1 = ? WHERE minute = ?")
      .run(s.cpuPct, s.botCpuPct, s.memPct, s.rssMb, s.load1, minute);
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
      snap = { clients: new Map(), ever: new Set(), playId: null, waitingSince: null, waitWhy: null, waitSwitching: null, hostMove: null,
        hostSubtitle: null, devices: new Map() };
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
      if (at - play.posAt >= POSITION_EVERY_MS || play.posPlaying !== room.playing) this.position(play, null, at, room.positionS, room.playing);
      this.st(`UPDATE plays SET updated_at = ?, last_pos_s = ?, played_s = ?, peak_viewers = ?,
                 title = COALESCE(title, ?), guild_id = COALESCE(guild_id, ?),
                 channel_id = COALESCE(channel_id, ?), host_user_id = COALESCE(host_user_id, ?)
               WHERE id = ?`)
        .run(at, room.positionS, play.playedS, play.peak, room.title, room.discord.guildId,
          room.discord.channelId, room.discord.hostUserId, play.id);
    }

    // The room holding everybody for the host, and why.
    if (room.waiting) {
      if (snap.waitingSince === null) Object.assign(snap, { waitingSince: at, waitWhy: room.waitingWhy ?? null, waitSwitching: null });
      snap.waitWhy ??= room.waitingWhy ?? null;
      snap.waitSwitching = room.switching ?? snap.waitSwitching;
    }

    // Who came, went and changed what. A stream and subtitles of the title
    // before are nobody's change in this one: on 17 November every viewer
    // "switched stream" and "changed subtitles" as each episode began.
    const sameTitle = snap.playId === (play?.id ?? null);
    snap.playId = play?.id ?? null;
    const ofTitle = (key: string | null) => !!key && (room.streams.some((s) => s.variantKey === key)
      || (!!play && [...play.streams.values()].some((s) => s.variantKey === key)));
    // The host moving to another stream moves everyone on theirs: who did, and why.
    const host = room.clients.find((c) => c.connected && c.role === "host");
    const hostBefore = host ? snap.clients.get(host.userId) : undefined;
    if (host?.variantKey && hostBefore?.connected && sameTitle && ofTitle(hostBefore.variantKey)
      && host.variantKey !== hostBefore.variantKey) {
      snap.hostMove = { at, name: host.username, from: hostBefore.variantKey!, to: host.variantKey, why: room.switching ?? snap.waitSwitching };
    }
    // And the host's subtitles, which those on the host's choice follow without a stream of their own.
    if (host && hostBefore?.connected && sameTitle && hostBefore.variantKey && ofTitle(hostBefore.variantKey)
      && host.subtitleStreamId !== hostBefore.subtitleStreamId) {
      snap.hostSubtitle = { at, name: host.username, from: hostBefore.subtitleStreamId, to: host.subtitleStreamId };
    }
    const now = new Map<string, ClientSnap>();
    for (const c of room.clients) {
      const cur: ClientSnap = {
        connected: c.connected, variantKey: c.variantKey, subtitleStreamId: c.subtitleStreamId,
        quality: c.quality, role: c.role, away: c.away, device: c.device ?? null,
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
      // Which client: the Discord app or a browser, on which system, and what
      // its player plays; one back on another, or replaced by another, is a switch.
      const before = snap.devices.get(c.userId) ?? null;
      const device = c.device ?? null;
      if (device) snap.devices.set(c.userId, device);
      const switched = () => {
        if (before && device && device !== before) {
          this.event(play, room.id, at, "switched client", c.userId, c.username, room.positionS, {
            from: before, to: device, role: c.role, caps: c.caps, ...(c.av1Encode ? { av1Encode: true } : {}),
          });
        }
      };
      // How the host or a co-host changed, as the room noted it a moment ago.
      const rw = room.roleWhy && at - room.roleWhy.at <= ROLE_WHY_MS ? room.roleWhy : null;
      const how = rw ? { why: rw.why, ...(rw.by ? { by: rw.by } : {}), ...(rw.to ? { target: rw.to } : {}), ...(rw.away ? { away: true } : {}) } : {};
      if (!prev?.connected) {
        const v = play?.viewers.get(c.userId);
        if (v) Object.assign(v, { joinedAt: at, streamAt: at });
        // Host on coming in: back in time, or nobody else was.
        const became = rw && c.role === "host" && (rw.why === "host back" || rw.why === "nobody was host") && rw.to === (c.username ?? c.userId);
        this.event(play, room.id, at, prev ? "came back" : "joined", c.userId, c.username, room.positionS, {
          role: c.role, ...(device ? { device } : {}), caps: c.caps, ...(c.av1Encode ? { av1Encode: true } : {}),
          ...(became ? { why: rw.why } : {}),
          // The stream they come in on: one who joins onto the host's stream has no move to record.
          ...(c.variantKey ? { stream: c.variantKey } : {}),
        });
        switched();
        continue;
      }
      switched();
      const changed = (kind: string, from: unknown, to: unknown) =>
        this.event(play, room.id, at, kind, c.userId, c.username, room.positionS, { from, to });
      // Somebody who joined starts on a stream; they didn't move from one.
      const carried = !sameTitle || (!!prev.variantKey && !ofTitle(prev.variantKey));
      if (c.variantKey && c.variantKey !== prev.variantKey) {
        const s = room.streams.find((x) => x.variantKey === c.variantKey);
        const from = carried ? null : prev.variantKey;
        const v = play?.viewers.get(c.userId);
        if (v) v.streamAt = at;
        const move = snap.hostMove;
        const byHost = !!move && c.role === "host" && move.at === at;
        const followed = !!move && !!from && c.role !== "host" && at - move.at <= HOST_MOVE_MS
          && tracksOf(from) === tracksOf(move.from) && tracksOf(c.variantKey) === tracksOf(move.to);
        this.event(play, room.id, at, "stream changed", c.userId, c.username, room.positionS, {
          from, to: c.variantKey,
          audioStreamId: s?.audioStreamId ?? null, subtitleStreamId: s?.subtitleStreamId ?? null,
          ...(followed ? { host: move.name ?? "the host" } : {}),
          ...((followed || byHost) && move.why ? { why: move.why } : {}),
        });
      }
      // Subtitles they start on, with their first stream, are no change either.
      if (!carried && prev.variantKey && c.subtitleStreamId !== prev.subtitleStreamId) {
        // The host's change, carried to those following the host's subtitles.
        const hs = snap.hostSubtitle;
        const followed = !!hs && c.role !== "host" && at - hs.at <= HOST_MOVE_MS && c.subtitleStreamId === hs.to;
        this.event(play, room.id, at, "subtitles", c.userId, c.username, room.positionS, {
          from: prev.subtitleStreamId, to: c.subtitleStreamId,
          ...(c.role === "host" ? { byHost: true } : followed ? { host: hs.name ?? "the host" } : {}),
        });
      }
      if (c.quality !== prev.quality) changed("quality", prev.quality, c.quality);
      if (c.role !== prev.role) {
        this.event(play, room.id, at, "role", c.userId, c.username, room.positionS, { from: prev.role, to: c.role, ...how });
      }
      if (c.away !== prev.away) {
        this.event(play, room.id, at, c.away ? "away from Discord" : "back in Discord", c.userId, c.username, room.positionS, null);
      }
    }
    for (const [userId, prev] of snap.clients) {
      if (prev.connected && !now.has(userId)) this.event(play, room.id, at, "left", userId, this.nameOf(userId), room.positionS, null);
    }
    snap.clients = now;
    if (play) this.observeStreams(play, room, at);

    // The room held everybody for the host's picture.
    if (!room.waiting && snap.waitingSince !== null) {
      this.event(play, room.id, at, "room waited", null, null, room.positionS, {
        ms: at - snap.waitingSince, why: snap.waitWhy, ...(snap.waitSwitching ? { switching: snap.waitSwitching } : {}),
      });
      Object.assign(snap, { waitingSince: null, waitWhy: null, waitSwitching: null });
    }
  }

  private observeStreams(play: OpenPlay, room: RoomView, at: number): void {
    const live = room.streams.filter((s): s is StreamView & { hlsSessionId: string } => !!s.hlsSessionId);
    const liveIds = new Set(live.map((s) => s.hlsSessionId));
    // Streams gone since the last look, by variant: one back under a new
    // session is a restart, not an end and a start.
    const gone = new Map<string, { sessionId: string; row: StreamRow }>();
    for (const [sessionId, row] of play.streams) {
      if (row.ended || liveIds.has(sessionId)) {
        if (!row.ended) row.lastViewers = live.find((s) => s.hlsSessionId === sessionId)?.viewers.length ?? row.lastViewers;
        continue;
      }
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
          peak: s.viewers.length, ended: false, lastViewers: s.viewers.length,
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
    for (const [variantKey, { sessionId, row }] of gone) {
      // Why: the host moving everybody on it to another, or nobody left on it.
      const move = this.snaps.get(room.id)?.hostMove;
      const why = move && move.from === variantKey && at - move.at <= HOST_MOVE_MS
        ? { host: move.name ?? "the host", ...(move.why ? { switching: move.why } : {}) }
        : row.lastViewers === 0 ? { unwatched: true } : {};
      this.event(play, room.id, at, "stream ended", null, null, room.positionS, { variant: variantKey, session: sessionId, ...why });
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
    room?: RoomView, next?: { by: string | null; cause?: string | null; askedBy?: string | null }): OpenPlay {
    const open = this.open.get(roomId);
    if (open && open.ratingKey === ratingKey) return open;
    if (open) {
      this.closePlay(roomId, at, "another title", next?.by ?? null,
        { next: title, ...(next?.cause ? { cause: next.cause } : {}), ...(next?.askedBy ? { askedBy: next.askedBy } : {}) });
    }
    const inst = this.instances().get(roomId);
    const guildId = room?.discord.guildId ?? inst?.guildId ?? null;
    const channelId = room?.discord.channelId ?? inst?.channelId ?? null;
    const hostUserId = room?.discord.hostUserId ?? inst?.hostUserId ?? null;
    const id = Number(this.st(`INSERT INTO plays (room_id, rating_key, title, guild_id, channel_id, host_user_id,
               started_at, updated_at, start_pos_s, last_pos_s)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(roomId, ratingKey, title, guildId, channelId, hostUserId, at, at, posS, posS).lastInsertRowid);
    const play: OpenPlay = {
      id, ratingKey, events: 0, errorEvents: 0, playedS: 0, peak: 0, lastTick: at, startedAt: at, playAt: 0, seekAt: 0,
      posAt: 0, posPlaying: null, streams: new Map(), viewers: new Map(), flow: [], reachedEnd: false, shares: new Map(),
      issues: new Set(),
    };
    this.open.set(roomId, play);
    const waiting = this.pendingIssues.filter((x) => x.ratingKey === ratingKey && at - x.at < ISSUE_WAIT_MS);
    this.pendingIssues = this.pendingIssues.filter((x) => !waiting.includes(x) && at - x.at < ISSUE_WAIT_MS);
    for (const x of waiting) this.writeIssue(play, roomId, x);
    return play;
  }

  /**
   * The end of a play, and why: `reason` is what ended it (stopped, another
   * title, room closed), and `more` what the player said of it — its cause
   * ("finished", "next episode"), the next title, who asked for it.
   */
  private closePlay(roomId: string, at: number, reason: string, by: string | null,
    more: { cause?: string | null; next?: string | null; askedBy?: string | null } = {}): void {
    const play = this.open.get(roomId);
    if (!play) return;
    this.flushViewers(play);
    this.st("UPDATE play_streams SET ended_at = ? WHERE play_id = ? AND ended_at IS NULL").run(at, play.id);
    // A stop of a title that reached its end is its finishing, whatever the host pressed after.
    const cause = more.cause ?? (reason === "stopped" && play.reachedEnd ? "finished" : null);
    this.st("UPDATE plays SET ended_at = ?, updated_at = ?, end_reason = ?, end_by = ?, end_cause = ?, played_s = ? WHERE id = ?")
      .run(at, at, reason, by, cause, play.playedS, play.id);
    play.events = 0; // the end is always written
    this.event(play, roomId, at, "ended", null, by, null, {
      reason, ...(cause ? { cause } : {}), ...(more.next ? { next: more.next } : {}), ...(more.askedBy ? { askedBy: more.askedBy } : {}),
      ...(play.reachedEnd ? { reachedEnd: true } : {}),
    });
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
      v = { joinedAt: at, streamAt: at, watchedS: 0, httpBytes: 0, p2pBytes: 0, upBytes: 0, edgeBytes: 0, edgeHitBytes: 0, stalls: 0, stalledMs: 0,
        errors: 0, dirty: false };
      play.viewers.set(c.userId, v);
    }
    return v;
  }

  private flushViewers(play: OpenPlay): void {
    for (const [userId, v] of play.viewers) {
      if (!v.dirty) continue;
      v.dirty = false;
      this.st(`UPDATE play_viewers SET watched_s = ?, http_bytes = ?, p2p_bytes = ?, up_bytes = ?, edge_bytes = ?,
                 edge_hit_bytes = ?, stalls = ?, stalled_ms = ?, errors = ?
               WHERE play_id = ? AND user_id = ?`)
        .run(v.watchedS, Math.round(v.httpBytes), Math.round(v.p2pBytes), Math.round(v.upBytes), Math.round(v.edgeBytes),
          Math.round(v.edgeHitBytes), v.stalls, Math.round(v.stalledMs), v.errors, play.id, userId);
    }
  }

  /** One line of a play's (or, with none, a room's) history. Its id, or null if it wasn't kept. */
  private event(play: OpenPlay | null, roomId: string | null, at: number, kind: string, userId: string | null,
    username: string | null, posS: number | null, detail: unknown): number | null {
    if (play) {
      if (play.events >= MAX_EVENTS_PER_PLAY) return null;
      play.events++;
    }
    return Number(this.st(`INSERT INTO events (play_id, room_id, at, kind, user_id, username, pos_s, detail)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(play?.id ?? null, roomId, at, kind, userId, username, posS, json(detail)).lastInsertRowid);
  }

  /** Where the room (userId null) or a viewer's player was in the title. */
  private position(play: OpenPlay, userId: string | null, at: number, posS: number, playing: boolean): void {
    if (!Number.isFinite(posS) || posS < 0) return;
    this.st("INSERT INTO positions (play_id, user_id, at, pos_s, playing) VALUES (?, ?, ?, ?, ?)")
      .run(play.id, userId, at, Math.round(posS * 10) / 10, playing ? 1 : 0);
    if (userId === null) Object.assign(play, { posAt: at, posPlaying: playing });
  }

  /** A minute's traffic, added to what it has. */
  private traffic(at: number, add: { sent?: number; bot?: number; hit?: number; p2p?: number; viewers?: number; streams?: number;
    feedKbps?: number }): void {
    this.st(`INSERT INTO traffic (minute, sent_bytes, bot_bytes, hit_bytes, p2p_bytes, viewers, streams, feed_kbps)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (minute) DO UPDATE SET sent_bytes = sent_bytes + excluded.sent_bytes,
               bot_bytes = bot_bytes + excluded.bot_bytes, hit_bytes = hit_bytes + excluded.hit_bytes,
               p2p_bytes = p2p_bytes + excluded.p2p_bytes, viewers = MAX(viewers, excluded.viewers),
               streams = MAX(streams, excluded.streams), feed_kbps = MAX(feed_kbps, excluded.feed_kbps)`)
      .run(Math.floor(at / 60_000), Math.round(add.sent ?? 0), Math.round(add.bot ?? 0), Math.round(add.hit ?? 0),
        Math.round(add.p2p ?? 0), add.viewers ?? 0, add.streams ?? 0, Math.round(add.feedKbps ?? 0));
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
      const cause = e.cause ? { cause: e.cause } : {};
      if (e.type === "stop") {
        const play = this.open.get(e.roomId);
        if (!play) return;
        this.event(play, e.roomId, e.at, "stop", e.userId, e.username, e.fromS, { role: e.role, ...cause });
        this.closePlay(e.roomId, e.at, "stopped", e.username ?? e.userId, { cause: e.cause });
        return;
      }
      if (!e.ratingKey) return;
      const play = this.ensurePlay(e.roomId, e.ratingKey, e.title, e.toS, e.at, undefined,
        { by: e.username ?? e.userId, cause: e.cause, askedBy: e.askedBy });
      if (e.type === "play") play.playAt = e.at;
      if (e.type === "seek") {
        play.seekAt = e.at;
        this.position(play, null, e.at, e.fromS, true);
      }
      this.position(play, null, e.at, e.toS, e.type !== "pause");
      // A play that only rebuilt the stream of the title playing (a track
      // change, a seek past the stream) is no start: its stream's restart says it.
      if (e.type === "play" && e.rebuild) return;
      this.event(play, e.roomId, e.at, e.type, e.userId, e.username, e.toS,
        e.type === "seek" ? { role: e.role, fromS: e.fromS, toS: e.toS, ...cause }
          : { role: e.role, ...cause, ...(e.askedBy ? { askedBy: e.askedBy } : {}) });
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
        else if (entry.tag === "Discord" && entry.msg === "channel") this.channelName(entry);
        else if ((entry.tag === "Video" && entry.msg === "ended")
          || (entry.tag === "HLS" && entry.msg === "reached the break, ending the title")) this.reachedEnd(userId, entry);
        if (entry.level === "ERROR") this.playerError(userId, entry);
      }
    })();
  }

  private player(key: string, t: number): PlayerState {
    let p = this.players.get(key);
    if (!p) {
      p = { session: "", p2p: 0, http: 0, edge: 0, edgeHit: 0, up: 0, upTo: new Map(), upCredited: new Map(), sampled: false,
        waitingSince: null, waitingAfterSeek: false, waitingReady: null, played: false, lastAt: t, driftS: null, aheadS: null, health: [] };
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
    const up = Number.isFinite(num(d.upMB)) ? num(d.upMB) * 1e6 : 0;
    const upTo = new Map<string, number>();
    if (d.upTo && typeof d.upTo === "object") {
      for (const [k, mb] of Object.entries(d.upTo as Record<string, unknown>)) {
        if (/^[0-9A-Za-z]{8}$/.test(k) && Number.isFinite(num(mb)) && num(mb) > 0) upTo.set(k, num(mb) * 1e6);
      }
    }
    if (typeof d.peerKey === "string" && /^[0-9A-Za-z]{8}$/.test(d.peerKey)) {
      this.peerKeys.set(d.peerKey, userId);
      while (this.peerKeys.size > MAX_PEER_KEYS) this.peerKeys.delete(this.peerKeys.keys().next().value as string);
    }
    const p = this.player(key, entry.t);
    // The last minutes' sync and buffer are the stream's now playing: not those of the title or stream before it.
    if (p.sampled && session !== p.session) p.health = [];
    const baseline = !p.sampled && entry.t - this.startedAt < BASELINE_WINDOW_MS;
    // A new player (a new stream, a rebuild) counts from zero again.
    const restarted = p.sampled && (session !== p.session || p2p < p.p2p || http < p.http);
    // The Discord cache figures start again with each stream too (and with
    // the page, on a player from before they did).
    const pageReloaded = restarted || edge < p.edge || edgeHit < p.edgeHit;
    // What it sent the others starts again with each stream as well.
    const upRestarted = restarted || up < p.up;
    if (upRestarted) p.upCredited = new Map();
    const delta = {
      http: baseline ? 0 : restarted ? http : http - p.http,
      p2p: baseline ? 0 : restarted ? p2p : p2p - p.p2p,
      edge: baseline ? 0 : pageReloaded ? edge : edge - p.edge,
      edgeHit: baseline ? 0 : pageReloaded ? edgeHit : edgeHit - p.edgeHit,
      up: baseline ? 0 : upRestarted ? up : up - p.up,
    };
    Object.assign(p, { session, p2p, http, edge, edgeHit, up, upTo, sampled: true });
    if (baseline) p.upCredited = new Map(upTo);
    const paused = d.paused === true || d.paused === "true";
    if (!paused && num(d.playedS) > 0) p.played = true;
    const drift = num(d.driftS);
    const ahead = num(d.downloadedAheadS);
    p.driftS = Number.isFinite(drift) ? Math.round(drift * 100) / 100 : null;
    p.aheadS = Number.isFinite(ahead) ? Math.round(ahead * 10) / 10 : null;
    p.health.push([entry.t, p.driftS, p.aheadS]);
    while (p.health.length > 1 && p.health[0][0] < entry.t - HEALTH_KEEP_MS) p.health.shift();
    const now = this.viewerNow(userId);
    if (!now) return;
    now.v.httpBytes += Math.max(0, delta.http);
    now.v.p2pBytes += Math.max(0, delta.p2p);
    now.v.edgeBytes += Math.max(0, delta.edge);
    now.v.edgeHitBytes += Math.max(0, delta.edgeHit);
    now.v.upBytes += Math.max(0, delta.up);
    now.v.dirty = true;
    this.shares(now.play, userId, p);
    const got = Math.max(0, delta.http);
    const hit = Math.min(got, Math.max(0, delta.edgeHit));
    const real = (v: unknown, places = 1) => {
      const n = num(v);
      return Number.isFinite(n) ? Math.round(n * 10 ** places) / 10 ** places : null;
    };
    const whole = (v: unknown) => (Number.isFinite(num(v)) ? Math.round(num(v)) : null);
    this.st(`INSERT INTO play_health (play_id, user_id, at, drift_s, ahead_s, buffer_s, bot_bytes, hit_bytes, p2p_bytes, up_bytes,
               frames_shown, frames_dropped, heap_mb, peers, rate_x) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(now.play.id, userId, entry.t, p.driftS, p.aheadS, real(d.bufAheadS), Math.round(got - hit), Math.round(hit),
        Math.round(Math.max(0, delta.p2p)), Math.round(Math.max(0, delta.up)), whole(d.framesShown), whole(d.framesDropped),
        real(d.heapUsedMB), whole(d.peers), d.rateX === undefined ? null : real(d.rateX, 3));
    if (got || delta.p2p > 0) {
      this.traffic(entry.t, { bot: got - hit, hit, p2p: Math.max(0, delta.p2p) });
      this.st(`INSERT INTO play_flow (play_id, minute, bot_bytes, hit_bytes, p2p_bytes) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (play_id, minute) DO UPDATE SET bot_bytes = bot_bytes + excluded.bot_bytes,
                 hit_bytes = hit_bytes + excluded.hit_bytes, p2p_bytes = p2p_bytes + excluded.p2p_bytes`)
        .run(now.play.id, Math.floor(entry.t / 60_000), Math.round(got - hit), Math.round(hit), Math.round(Math.max(0, delta.p2p)));
    }
    this.position(now.play, userId, entry.t, num(d.posS), !paused);
  }

  /**
   * What a player sent each other player since it was last put down, to whom
   * by their player's key: kept back for a key whose owner hasn't said yet.
   */
  private shares(play: OpenPlay, from: string, p: PlayerState): void {
    for (const [k, total] of p.upTo) {
      const to = this.peerKeys.get(k);
      if (!to) continue;
      const add = total - (p.upCredited.get(k) ?? 0);
      p.upCredited.set(k, total);
      if (to === from || !(add > 0)) continue;
      const pair = `${from}|${to}`;
      play.shares.set(pair, (play.shares.get(pair) ?? 0) + add);
      this.st(`INSERT INTO play_shares (play_id, from_user, to_user, bytes) VALUES (?, ?, ?, ?)
               ON CONFLICT (play_id, from_user, to_user) DO UPDATE SET bytes = bytes + excluded.bytes`)
        .run(play.id, from, to, Math.round(add));
    }
  }

  /** A player reaching the title's end, or the break it was ended at: said once a play. */
  private reachedEnd(userId: string, entry: ClientLogEntry): void {
    const now = this.viewerNow(userId);
    if (!now || now.play.reachedEnd) return;
    now.play.reachedEnd = true;
    const posS = num(entry.data.posS);
    const breakAtS = num(entry.data.breakAtS);
    this.event(now.play, now.roomId, entry.t, "reached the end", userId, this.nameOf(userId),
      Number.isFinite(posS) ? posS : Number.isFinite(breakAtS) ? breakAtS : null,
      entry.tag === "HLS" ? { early: true, ...(Number.isFinite(breakAtS) ? { breakAtS } : {}) } : null);
  }

  private waiting(key: string, entry: ClientLogEntry): void {
    if (entry.data.paused === true) return;
    const p = this.player(key, entry.t);
    if (p.waitingSince !== null) return;
    p.waitingSince = entry.t;
    p.waitingAfterSeek = entry.data.seeking === true;
    const ready = num(entry.data.readyState);
    p.waitingReady = Number.isFinite(ready) ? ready : null;
  }

  /**
   * What a stop of a player's picture from `start` is: loading after a seek,
   * loading the start (of the title, of their stream, of a player that
   * hasn't shown anything yet), or buffering — the picture stopping for want
   * of data, which is all that counts as buffering.
   */
  private stallKind(p: PlayerState, start: number, userId: string, play: OpenPlay): "seek" | "start" | "buffering" {
    const near = (t: number | undefined, before: number, after: number) => !!t && start >= t - before && start - t <= after;
    if (p.waitingAfterSeek || near(play.seekAt, SEEK_LOAD_BEFORE_MS, SEEK_LOAD_AFTER_MS)) return "seek";
    if (!p.played || p.waitingReady === 0) return "start";
    const v = play.viewers.get(userId);
    const starts = [play.startedAt, play.playAt, v?.joinedAt, v?.streamAt];
    return starts.some((t) => near(t, 2_000, START_LOAD_MS)) ? "start" : "buffering";
  }

  private playing(key: string, userId: string, entry: ClientLogEntry): void {
    const p = this.player(key, entry.t);
    const start = p.waitingSince;
    p.waitingSince = null;
    if (start === null) {
      p.played = true;
      return;
    }
    const ms = Math.max(0, entry.t - start);
    const now = this.viewerNow(userId);
    const kind = now ? this.stallKind(p, start, userId, now.play) : "buffering";
    p.played = true;
    if (ms < MIN_BUFFERING_MS || !now) return;
    if (kind === "buffering") {
      now.v.stalls++;
      now.v.stalledMs += ms;
      now.v.dirty = true;
    }
    const posS = num(entry.data.posS);
    this.event(now.play, now.roomId, entry.t, kind === "seek" ? "loaded after seek" : kind === "start" ? "loaded at start" : "buffering",
      userId, this.nameOf(userId), Number.isFinite(posS) ? posS : null, { ms });
  }

  /** What each of a user's players is doing now: the one that spoke last. */
  private playerNow(userId: string, at: number, play: OpenPlay | undefined): PlayerNow | null {
    let p: PlayerState | null = null;
    for (const [key, s] of this.players) if (key.startsWith(`${userId}|`) && (!p || s.lastAt > p.lastAt)) p = s;
    if (!p || at - p.lastAt > PLAYER_QUIET_MS) return null;
    const health = { driftS: p.driftS, aheadS: p.aheadS, health: p.health.filter(([t]) => t >= at - HEALTH_KEEP_MS) };
    if (p.waitingSince === null || !play) return { stall: null, sinceMs: null, ...health };
    return { stall: this.stallKind(p, p.waitingSince, userId, play), sinceMs: Math.max(0, at - p.waitingSince), ...health };
  }

  /** A Discord server's name, from the sign-in that saw it. */
  place(e: PlaceEvent): void {
    if (this.closed) return;
    const name = cleanName(e.name);
    if (!name || !/^\d{1,20}$/.test(e.id)) return;
    this.st(`INSERT INTO places (id, kind, name, guild_id, updated_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, name = excluded.name,
               guild_id = COALESCE(excluded.guild_id, guild_id), updated_at = excluded.updated_at`)
      .run(e.id, e.kind, name, e.guildId ?? null, e.at);
  }

  /** A voice channel's name, as the Activity in it read it: kept for a channel an Activity runs in. */
  private channelName(entry: ClientLogEntry): void {
    const id = String(entry.data.channelId ?? "");
    const inst = [...this.instances().values()].find((i) => i.channelId === id);
    if (!inst) return;
    this.place({ at: entry.t, kind: "channel", id, name: String(entry.data.name ?? ""), guildId: inst.guildId });
  }

  /** What the bot's port sent, from its sockets (services/upload-meter.ts). */
  sent(e: SentEvent): void {
    if (this.closed || !(e.bytes > 0)) return;
    this.traffic(e.at, { sent: e.bytes });
  }

  /** The names of Discord servers and channels, by id. */
  placeNames(): { guilds: Record<string, string>; channels: Record<string, string> } {
    const out = { guilds: {} as Record<string, string>, channels: {} as Record<string, string> };
    for (const r of this.st("SELECT id, kind, name FROM places").all() as Array<{ id: string; kind: string; name: string }>) {
      (r.kind === "guild" ? out.guilds : out.channels)[r.id] = r.name;
    }
    return out;
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

  /**
   * A request for the host role that came to nothing of its own: asked,
   * declined, or ended with who asked gone or the role moved. One accepted
   * or passed on is the role change after it.
   */
  hostRequest(e: HostRequestEvent): void {
    if (this.closed) return;
    const play = this.open.get(e.roomId) ?? null;
    const kind = e.outcome === "asked" ? "asked for host" : e.outcome === "declined" ? "request declined" : "request ended";
    const detail = {
      ...(e.hostName || e.hostId ? { host: e.hostName ?? (e.hostId ? this.nameOf(e.hostId) : null) ?? e.hostId } : {}),
      ...(e.away ? { away: true } : {}),
      ...(e.waitS !== undefined ? { waitS: e.waitS } : {}),
      ...(e.why ? { why: e.why } : {}),
    };
    this.remember(e.userId, e.username, e.at);
    this.event(play, e.roomId, e.at, kind, e.userId, e.username ?? this.nameOf(e.userId), play ? this.roomPos(e.roomId) : null, detail);
  }

  /** Where a room was at the last look. */
  private roomPos(roomId: string): number | null {
    const play = this.open.get(roomId);
    if (!play) return null;
    const r = this.st("SELECT last_pos_s AS p FROM plays WHERE id = ?").get(play.id) as { p: number | null } | undefined;
    return r?.p ?? null;
  }

  /**
   * A workaround a title's stream needed: written once a play, to the play
   * on that stream or title. One planned before the room's play opens waits
   * for it, a little (pendingIssues).
   */
  streamIssue(e: StreamIssueEvent): void {
    if (this.closed) return;
    const found = [...this.open].find(([, p]) => p.streams.has(e.hlsSessionId))
      ?? [...this.open].find(([, p]) => p.ratingKey === e.ratingKey) ?? null;
    if (!found) {
      this.pendingIssues = [...this.pendingIssues.filter((x) => e.at - x.at < ISSUE_WAIT_MS), e];
      return;
    }
    this.writeIssue(found[1], found[0], e);
  }

  private writeIssue(play: OpenPlay, roomId: string, e: StreamIssueEvent): void {
    if (play.issues.has(e.kind)) return;
    play.issues.add(e.kind);
    this.event(play, roomId, e.at, e.kind, null, null, null, { ratingKey: e.ratingKey, session: e.hlsSessionId.slice(0, 8), ...e.detail });
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
  /** A step of preparing a title or making its stream, and how long it took. */
  processing(e: ProcessingEvent): void {
    if (this.closed) return;
    this.st("INSERT INTO processing (at, kind, hls_session_id, rating_key, ms, ok, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(e.at, e.kind, e.hlsSessionId ?? null, e.ratingKey ?? null, Math.max(0, Math.round(e.ms)), e.ok ? 1 : 0,
        json(e.detail && Object.keys(e.detail).length ? e.detail : null));
  }

  /**
   * The server's load over a period, a step at a time (each a minute or more):
   * the machine's CPU and memory on average and at most, the bot's, the load
   * average, and at most the streams, transcodes and viewers.
   */
  systemLoad(opts: { hours?: unknown; days?: unknown; from?: unknown; to?: unknown } = {}, now = this.now()) {
    // The last so many hours or days, or from one time to another (a custom period, or a zoom into a chart):
    // within the 90 days kept, ten minutes at the least.
    const oldest = now - 90 * 24 * HOUR_MS;
    const f = Number(opts.from);
    const t = Number(opts.to);
    let from: number;
    let to: number;
    if (opts.from != null && opts.to != null && Number.isFinite(f) && Number.isFinite(t) && t > f) {
      to = Math.min(now, t);
      from = Math.max(oldest, Math.min(f, to - 10 * 60_000));
    } else {
      const asked = Number(opts.days) > 0 ? Number(opts.days) * 24 : Number(opts.hours) || 24;
      to = now;
      from = now - Math.min(24 * 90, Math.max(1, Math.floor(asked))) * HOUR_MS;
    }
    // About 360 steps, whole minutes each.
    const step = Math.max(1, Math.round((to - from) / 60_000 / 360));
    const rows = this.st(`SELECT (minute / @step) * @step AS m, AVG(cpu_pct) AS cpu, MAX(cpu_pct) AS cpu_max, AVG(bot_cpu_pct) AS bot,
        AVG(mem_pct) AS mem, MAX(mem_pct) AS mem_max, MAX(rss_mb) AS rss, AVG(load1) AS load1,
        MAX(streams) AS streams, MAX(encodes) AS encodes, MAX(viewers) AS viewers
      FROM system_load WHERE minute >= @from AND minute < @to GROUP BY m ORDER BY m`)
      .all({ step, from: Math.floor(from / 60_000), to: Math.ceil(to / 60_000) }) as Array<Record<string, number | null>>;
    const r1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
    // What the bot's port sent, as bits a second, over the same steps.
    const sent = new Map((this.st(`SELECT (minute / @step) * @step AS m, SUM(sent_bytes) AS b FROM traffic
        WHERE minute >= @from AND minute < @to GROUP BY m`).all({ step, from: Math.floor(from / 60_000), to: Math.ceil(to / 60_000) }) as
      Array<{ m: number; b: number }>).map((r) => [r.m, r.b] as const));
    return {
      from, to, stepMs: step * 60_000, cores: os.cpus().length, memTotalMb: Math.round(os.totalmem() / 1e6),
      points: rows.map((r) => ({
        at: Number(r.m) * 60_000, cpuPct: r1(r.cpu), cpuMaxPct: r1(r.cpu_max), botCpuPct: r1(r.bot), memPct: r1(r.mem), memMaxPct: r1(r.mem_max),
        rssMb: r1(r.rss), load1: r.load1 === null ? null : Math.round(r.load1 * 100) / 100,
        streams: Number(r.streams ?? 0), encodes: Number(r.encodes ?? 0), viewers: Number(r.viewers ?? 0),
        sentBps: Math.round(((sent.get(Number(r.m)) ?? 0) * 8) / (step * 60)),
      })),
    };
  }

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
      room.shares = play ? sharesOf(play.shares) : [];
      for (const c of room.clients) {
        const v = play?.viewers.get(c.userId);
        if (v) c.data = viewerData(v);
        c.player = c.connected ? this.playerNow(c.userId, ov.at, play) : null;
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
    // The host the session started with first, then everyone else as they joined.
    const viewers = (this.st("SELECT * FROM play_viewers WHERE play_id = ? ORDER BY user_id IS ? DESC, first_seen")
      .all(id, (r.host_user_id as string | null) ?? null) as Array<Record<string, unknown>>)
      .map((v) => ({
        userId: String(v.user_id), username: (v.username as string | null) ?? null, role: (v.role as string | null) ?? null,
        firstSeen: Number(v.first_seen), lastSeen: Number(v.last_seen),
        ...viewerData({
          watchedS: Number(v.watched_s), httpBytes: Number(v.http_bytes), p2pBytes: Number(v.p2p_bytes),
          upBytes: Number(v.up_bytes ?? 0),
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
    const play = playOf(r);
    const room: Track = [];
    const byViewer = new Map<string, Track>();
    for (const p of this.st("SELECT user_id, at, pos_s, playing FROM positions WHERE play_id = ? ORDER BY at, rowid").all(id) as
      Array<{ user_id: string | null; at: number; pos_s: number; playing: number }>) {
      const point: [number, number, number] = [p.at, p.pos_s, p.playing];
      if (p.user_id === null) room.push(point);
      else {
        let t = byViewer.get(p.user_id);
        if (!t) byViewer.set(p.user_id, (t = []));
        t.push(point);
      }
    }
    // A play from before positions were written down: the room's from its events.
    const track = room.length ? room : trackOfEvents(events, { ...play, updatedAt: Number(r.updated_at) });
    const watched: Record<string, Array<[number, number]>> = {};
    for (const v of viewers) {
      const own = byViewer.get(v.userId);
      watched[v.userId] = watchedParts(own && own.length > 1 ? own : within(track, presenceOf(v, events)));
    }
    // Each viewer's last few joins, client switches and role changes in the room
    // before the session opened: a host is in the room before they choose a
    // title, so their client and role are there, not in the session.
    const lead = viewers.flatMap((v) => (this.st(`SELECT * FROM events WHERE room_id = ? AND user_id = ? AND at <= ?
        AND (play_id IS NULL OR play_id <> ?) AND kind IN (${LEAD_KINDS.map(() => "?").join(", ")}) ORDER BY at DESC, id DESC LIMIT 8`)
      .all(play.roomId, v.userId, play.startedAt, play.id, ...LEAD_KINDS) as Array<Record<string, unknown>>)
      .reverse().map((e) => ({
        id: Number(e.id), at: Number(e.at), kind: String(e.kind), userId: (e.user_id as string | null) ?? null,
        username: (e.username as string | null) ?? null, posS: (e.pos_s as number | null) ?? null, detail: parse(e.detail),
      })));
    const shares = (this.st("SELECT from_user, to_user, bytes FROM play_shares WHERE play_id = ? AND bytes > 0 ORDER BY bytes DESC")
      .all(id) as Array<{ from_user: string; to_user: string; bytes: number }>)
      .map((s) => ({ from: s.from_user, to: s.to_user, bytes: Number(s.bytes) }));
    // What its players had from each source, minute by minute: [minute's start, server, Discord's cache, other viewers].
    const flow = (this.st("SELECT minute, bot_bytes, hit_bytes, p2p_bytes FROM play_flow WHERE play_id = ? ORDER BY minute").all(id) as
      Array<{ minute: number; bot_bytes: number; hit_bytes: number; p2p_bytes: number }>)
      .map((m): [number, number, number, number] => [m.minute * 60_000, Number(m.bot_bytes), Number(m.hit_bytes), Number(m.p2p_bytes)]);
    const positions = Object.fromEntries(byViewer);
    // Each viewer's player every 10 seconds: [time, offset from the room, downloaded ahead, browser buffer,
    // from the server, from Discord's cache, from other viewers, sent to them, frames shown, frames dropped,
    // memory in MB, peers, playback rate].
    const health: Record<string, HealthPoint[]> = {};
    for (const h of this.st("SELECT * FROM play_health WHERE play_id = ? ORDER BY at, rowid").all(id) as Array<Record<string, number | null>>) {
      const uid = String(h.user_id);
      (health[uid] ??= []).push([Number(h.at), h.drift_s, h.ahead_s, h.buffer_s, Number(h.bot_bytes), Number(h.hit_bytes),
        Number(h.p2p_bytes), Number(h.up_bytes), h.frames_shown, h.frames_dropped, h.heap_mb, h.peers, h.rate_x]);
    }
    // Its streams' preparation, and the title's around it that served no stream (subtitles, previews).
    const processing = (this.st(`SELECT * FROM processing
        WHERE hls_session_id IN (SELECT hls_session_id FROM play_streams WHERE play_id = @id)
          OR (rating_key = @rk AND at >= @from AND at <= @to
            AND (hls_session_id IS NULL OR hls_session_id NOT IN (SELECT hls_session_id FROM play_streams WHERE hls_session_id IS NOT NULL)))
        ORDER BY at, id`)
      .all({ id, rk: play.ratingKey, from: play.startedAt - PROCESSING_LEAD_MS, to: (play.endedAt ?? this.now()) + 120_000 }) as
      Array<Record<string, unknown>>)
      .map((p) => ({ id: Number(p.id), at: Number(p.at), kind: String(p.kind), hlsSessionId: (p.hls_session_id as string | null) ?? null,
        ms: Number(p.ms), ok: !!p.ok, detail: (parse(p.detail) as Record<string, unknown> | null) ?? {} }));
    return { play, viewers, streams, events, lead, track, watched, shares, flow, positions, health, processing };
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
        v.http_bytes AS v_http, v.p2p_bytes AS v_p2p, v.up_bytes AS v_up, v.edge_bytes AS v_edge, v.edge_hit_bytes AS v_hit,
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
          upBytes: Number(r.v_up ?? 0), edgeBytes: Number(r.v_edge), edgeHitBytes: Number(r.v_hit), stalls: Number(r.v_stalls),
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
    // Whom their player sent the most, and who sent theirs the most.
    const pairs = (dir: "from_user" | "to_user", other: "from_user" | "to_user") =>
      (this.st(`SELECT s.${other} AS id, (SELECT username FROM people WHERE user_id = s.${other}) AS name,
          SUM(s.bytes) AS bytes, COUNT(DISTINCT s.play_id) AS plays
        FROM play_shares s WHERE s.${dir} = ? GROUP BY s.${other} ORDER BY bytes DESC LIMIT 20`).all(userId) as Array<Record<string, unknown>>)
        .map((r) => ({ userId: String(r.id), username: (r.name as string | null) ?? null, bytes: Number(r.bytes), plays: Number(r.plays) }));
    // Every client they have been seen on, with what its player plays, and
    // how long they were host, co-host and viewer in their sessions.
    const seen = (this.st(`SELECT at, kind, room_id, play_id, detail FROM events WHERE user_id = ?
        AND kind IN (${LEAD_KINDS.map(() => "?").join(", ")}) ORDER BY at, id`).all(userId, ...LEAD_KINDS) as Array<Record<string, unknown>>)
      .map((e) => ({ at: Number(e.at), kind: String(e.kind), roomId: (e.room_id as string | null) ?? null,
        playId: (e.play_id as number | null) ?? null, detail: (parse(e.detail) ?? {}) as Record<string, unknown> }));
    const clients = new Map<string, { device: string; caps: string[] | null; av1Encode: boolean; first: number; last: number; plays: Set<number> }>();
    const deviceOf = (e: (typeof seen)[number]) => {
      const d = e.kind === "switched client" ? e.detail.to : e.kind === "joined" || e.kind === "came back" ? e.detail.device : null;
      return typeof d === "string" && d ? d : null;
    };
    for (const e of seen) {
      const device = deviceOf(e);
      if (!device) continue;
      let c = clients.get(device);
      if (!c) clients.set(device, (c = { device, caps: null, av1Encode: false, first: e.at, last: e.at, plays: new Set() }));
      c.last = e.at;
      if (Array.isArray(e.detail.caps)) {
        c.caps = e.detail.caps.filter((x): x is string => typeof x === "string");
        c.av1Encode = e.detail.av1Encode === true;
      }
    }
    // A client's sessions: those it was in use for, from the one it had as
    // the session opened (a host joins before choosing the title) to any it
    // moved to during it.
    for (const p of plays) {
      const here = seen.filter((e) => e.roomId === p.roomId && e.at <= p.lastSeen && deviceOf(e));
      const before = [...here].reverse().find((e) => e.at <= p.firstSeen);
      for (const e of [...(before ? [before] : []), ...here.filter((x) => x.at > p.firstSeen)]) clients.get(deviceOf(e)!)?.plays.add(p.id);
    }
    const roles = { host: 0, "co-host": 0, viewer: 0 };
    for (const p of plays) {
      const t = roleTime(seen.filter((e) => e.roomId === p.roomId), p.firstSeen, p.lastSeen);
      for (const k of Object.keys(roles) as Array<keyof typeof roles>) roles[k] += t[k];
    }
    return { person: personOf(row), plays, requests: this.requests({ userId, limit: 500 }), places,
      sentTo: pairs("from_user", "to_user"), gotFrom: pairs("to_user", "from_user"),
      clients: [...clients.values()].sort((a, b) => b.last - a.last)
        .map(({ plays: ps, ...c }) => ({ ...c, sessions: ps.size })),
      roleS: { host: Math.round(roles.host), coHost: Math.round(roles["co-host"]), viewer: Math.round(roles.viewer) } };
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
  graphs(opts: { days?: unknown; hours?: unknown; from?: unknown; to?: unknown; zone?: unknown } = {}, now = this.now()): Graphs {
    const zone = zoneClock(opts.zone);
    const today = zone.day(now);
    const whole = (v: unknown) =>
      (typeof v === "number" || (typeof v === "string" && v.trim() !== "")) && Number.isFinite(Number(v)) ? Math.floor(Number(v)) : null;
    const askedFrom = whole(opts.from);
    const askedTo = whole(opts.to);
    const askedHours = whole(opts.hours);
    let from: number;
    let to: number;
    let days: number;
    let lastHours: number | null = null;
    if (askedFrom !== null && askedTo !== null && askedTo > askedFrom) {
      // A period of its own: 21 September to 1 October, or 18:00 to 02:00.
      to = Math.min(askedTo, zone.dayStart(today + 1));
      from = Math.min(Math.max(askedFrom, to - MAX_GRAPH_DAYS * DAY_MS), to - 60_000);
      days = Math.ceil((to - from) / DAY_MS);
    } else if (askedHours !== null && askedHours > 0) {
      // The last so many hours, to now.
      lastHours = Math.min(askedHours, MAX_GRAPH_DAYS * 24);
      to = now;
      from = now - lastHours * HOUR_MS;
      days = Math.ceil(lastHours / 24);
    } else {
      const asked = Math.floor(Number(opts.days ?? 30));
      days = Number.isFinite(asked) && asked >= 0 ? Math.min(asked, MAX_GRAPH_DAYS) : 30;
      let first = today - Math.max(1, days) + 1;
      if (days === 0) {
        const r = this.st(`SELECT MIN(at) AS at FROM (SELECT MIN(started_at) AS at FROM plays
            UNION ALL SELECT MIN(at) FROM usage UNION ALL SELECT MIN(at) FROM requests)`).get() as { at: number | null };
        first = r.at === null ? today : Math.max(today - MAX_GRAPH_DAYS + 1, Math.min(today, zone.day(r.at)));
      }
      from = zone.dayStart(first);
      to = zone.dayStart(today + 1);
    }
    // Three days or less by the hour; longer, by the day.
    const bucket: "hour" | "day" = to - from <= HOURLY_UP_TO_MS ? "hour" : "day";
    const size = bucket === "hour" ? HOUR_MS : DAY_MS;
    const local = (column: string) => zone.sql(column, from, to);
    const dayOf = (column: string) => `CAST(${local(column)} / 86400000 AS INTEGER)`;
    const bucketOf = (column: string) => `CAST(${local(column)} / ${size} AS INTEGER)`;
    const slot = (t: number) => Math.floor((t + zone.offset(t)) / size);
    const byDay = new Map<number, GraphDay>();
    for (let d = slot(from); d <= slot(to - 1); d++) byDay.set(d, emptyDay(d * size));
    const rows = (sql: string) => this.st(sql).all({ from, to }) as Array<Record<string, unknown>>;
    const each = (sql: string, fill: (g: GraphDay, r: Record<string, unknown>) => void) => {
      for (const r of rows(sql)) {
        const g = byDay.get(int(r.d));
        if (g) fill(g, r);
      }
    };
    const DAY = bucketOf("started_at");
    const DAYNUM = dayOf("started_at");
    each(`SELECT ${DAY} AS d, COUNT(*) AS plays, COALESCE(SUM(played_s), 0) AS played, MAX(peak_viewers) AS peak
      FROM plays WHERE started_at >= @from AND started_at < @to GROUP BY d`, (g, r) => {
      g.plays = int(r.plays);
      g.playedS = Math.round(int(r.played));
      g.peakViewers = int(r.peak);
    });
    each(`SELECT ${bucketOf("p.started_at")} AS d, COUNT(DISTINCT v.user_id) AS people,
        SUM(v.watched_s) AS watched, SUM(v.http_bytes) AS http, SUM(v.edge_bytes) AS edge, SUM(v.edge_hit_bytes) AS hit,
        SUM(MAX(0, v.http_bytes - v.edge_hit_bytes)) AS bot, SUM(v.p2p_bytes) AS p2p,
        SUM(v.stalls) AS stalls, SUM(v.stalled_ms) AS stalled, SUM(v.errors) AS errors
      FROM play_viewers v JOIN plays p ON p.id = v.play_id WHERE p.started_at >= @from AND p.started_at < @to GROUP BY d`, (g, r) => {
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
      FROM play_streams WHERE started_at >= @from AND started_at < @to GROUP BY d`, (g, r) => {
      g.streams = int(r.streams);
      g.copies = int(r.copies);
      g.reencodes = int(r.reencodes);
    });
    each(`SELECT ${bucketOf("at")} AS d, COUNT(*) AS n FROM requests WHERE at >= @from AND at < @to GROUP BY d`,
      (g, r) => { g.requests = int(r.n); });
    each(`SELECT ${bucketOf("at")} AS d, COUNT(*) AS n FROM usage WHERE kind = 'launch' AND at >= @from AND at < @to GROUP BY d`,
      (g, r) => { g.launches = int(r.n); });

    const daily = [...byDay.values()];
    const sum = (k: keyof GraphDay) => daily.reduce((s, g) => s + g[k], 0);
    const people = this.st(`SELECT COUNT(DISTINCT v.user_id) AS n FROM play_viewers v JOIN plays p ON p.id = v.play_id
      WHERE p.started_at >= @from AND p.started_at < @to`).get({ from, to }) as { n: number };
    const edge = sum("edgeBytes");
    const totals = {
      plays: sum("plays"), playedS: sum("playedS"), watchedS: sum("watchedS"), people: int(people.n),
      httpBytes: sum("httpBytes"), edgeBytes: edge, edgeHitBytes: sum("edgeHitBytes"), botBytes: sum("botBytes"),
      p2pBytes: sum("p2pBytes"), hitShare: edge > 0 ? sum("edgeHitBytes") / edge : null,
      stalls: sum("stalls"), stalledMs: sum("stalledMs"), errors: sum("errors"),
      streams: sum("streams"), copies: sum("copies"), reencodes: sum("reencodes"),
      requests: sum("requests"), launches: sum("launches"),
      sentBytes: 0, peakKbps: 0,
    };

    // What the bot's port sent, minute by minute (services/upload-meter.ts):
    // the upload qBittorrent shares the line with.
    const kbpsOf = (bytes: number) => (bytes * 8) / 60 / 1000;
    const minutes = this.st(`SELECT minute, sent_bytes AS sent, viewers, streams, feed_kbps AS feed FROM traffic
        WHERE minute >= ? AND minute < ? AND sent_bytes > 0 ORDER BY minute`)
      .all(Math.floor(from / 60_000), Math.ceil(to / 60_000)) as Array<{ minute: number; sent: number; viewers: number; streams: number; feed: number }>;
    for (const m of minutes) {
      const g = byDay.get(slot(m.minute * 60_000));
      if (!g) continue;
      g.sentBytes += m.sent;
      g.peakKbps = Math.max(g.peakKbps, Math.round(kbpsOf(m.sent)));
    }
    totals.sentBytes = sum("sentBytes");
    totals.peakKbps = Math.max(0, ...daily.map((g) => g.peakKbps));
    const streaming = minutes.filter((m) => m.viewers > 0);
    // Whole minutes of one stream playing, the one before and after too: what
    // the bot sent for it over its bitrate is the weight the qBittorrent
    // manager should give it for that many viewers.
    const playingAt = new Set(streaming.map((m) => m.minute));
    const steady = (m: (typeof minutes)[number]) => m.streams === 1 && m.feed > 0 && playingAt.has(m.minute - 1) && playingAt.has(m.minute + 1);
    const rates = (ms: typeof minutes) => {
      const k = ms.map((m) => kbpsOf(m.sent)).sort((a, b) => a - b);
      const one = ms.filter(steady).map((m) => kbpsOf(m.sent) / m.feed);
      return {
        minutes: k.length,
        avgKbps: k.length ? Math.round(k.reduce((s, x) => s + x, 0) / k.length) : null,
        p95Kbps: k.length ? Math.round(k[Math.min(k.length - 1, Math.floor(k.length * 0.95))]) : null,
        peakKbps: k.length ? Math.round(k[k.length - 1]) : null,
        perStream: one.length ? Math.round((one.reduce((s, x) => s + x, 0) / one.length) * 100) / 100 : null,
        perStreamMinutes: one.length,
      };
    };
    const peak = streaming.reduce<(typeof minutes)[number] | null>((best, m) => (!best || m.sent > best.sent ? m : best), null);
    const since = this.st("SELECT MIN(minute) AS m FROM traffic WHERE sent_bytes > 0").get() as { m: number | null };
    const upload = {
      since: since.m === null ? null : since.m * 60_000,
      sentBytes: minutes.reduce((s, m) => s + m.sent, 0),
      ...rates(streaming),
      allMinutes: minutes.length,
      peakAt: peak ? peak.minute * 60_000 : null,
      byViewers: [1, 2, 3, 4].map((n) => ({ viewers: n, ...rates(streaming.filter((m) => (n === 4 ? m.viewers >= 4 : m.viewers === n))) })),
    };

    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, plays: 0, playedS: 0 }));
    for (const r of rows(`SELECT CAST(${local("started_at")} / 3600000 AS INTEGER) % 24 AS h, COUNT(*) AS plays,
        COALESCE(SUM(played_s), 0) AS played FROM plays WHERE started_at >= @from AND started_at < @to GROUP BY h`)) {
      const h = hours[int(r.h)];
      if (h) Object.assign(h, { plays: int(r.plays), playedS: Math.round(int(r.played)) });
    }
    // 1 January 1970 was a Thursday: day 0 is weekday 4, Sunday being 0.
    const weekdays = Array.from({ length: 7 }, (_, weekday) => ({ weekday, plays: 0, playedS: 0 }));
    for (const r of rows(`SELECT (${DAYNUM} + 4) % 7 AS w, COUNT(*) AS plays, COALESCE(SUM(played_s), 0) AS played
        FROM plays WHERE started_at >= @from AND started_at < @to GROUP BY w`)) {
      const w = weekdays[int(r.w)];
      if (w) Object.assign(w, { plays: int(r.plays), playedS: Math.round(int(r.played)) });
    }

    const titles = rows(`SELECT p.rating_key AS k, MAX(p.title) AS title, COUNT(DISTINCT p.id) AS plays,
        COUNT(DISTINCT v.user_id) AS people, COALESCE(SUM(v.watched_s), 0) AS watched
      FROM plays p LEFT JOIN play_viewers v ON v.play_id = p.id WHERE p.started_at >= @from AND p.started_at < @to
      GROUP BY p.rating_key ORDER BY watched DESC, plays DESC LIMIT 10`)
      .map((r) => ({ ratingKey: String(r.k), title: (r.title as string | null) ?? null, plays: int(r.plays),
        people: int(r.people), watchedS: Math.round(int(r.watched)) }));
    const topPeople = rows(`SELECT v.user_id AS id, COALESCE(pe.username, MAX(v.username)) AS name, COUNT(*) AS plays,
        SUM(v.watched_s) AS watched, SUM(v.http_bytes + v.p2p_bytes) AS bytes, SUM(v.p2p_bytes) AS got, SUM(v.up_bytes) AS up
      FROM play_viewers v JOIN plays p ON p.id = v.play_id LEFT JOIN people pe ON pe.user_id = v.user_id
      WHERE p.started_at >= @from AND p.started_at < @to GROUP BY v.user_id ORDER BY watched DESC, plays DESC LIMIT 10`)
      .map((r) => ({ userId: String(r.id), username: (r.name as string | null) ?? null, plays: int(r.plays),
        watchedS: Math.round(int(r.watched)), bytes: int(r.bytes), p2pBytes: int(r.got), upBytes: int(r.up) }));
    // Who sent the others the most, and what went between whom.
    const sharers = rows(`SELECT v.user_id AS id, COALESCE(pe.username, MAX(v.username)) AS name, COUNT(*) AS plays,
        SUM(v.up_bytes) AS up, SUM(v.p2p_bytes) AS got
      FROM play_viewers v JOIN plays p ON p.id = v.play_id LEFT JOIN people pe ON pe.user_id = v.user_id
      WHERE p.started_at >= @from AND p.started_at < @to GROUP BY v.user_id HAVING SUM(v.up_bytes) > 0
      ORDER BY up DESC LIMIT 10`)
      .map((r) => ({ userId: String(r.id), username: (r.name as string | null) ?? null, plays: int(r.plays),
        upBytes: int(r.up), p2pBytes: int(r.got) }));
    const pairs = rows(`SELECT s.from_user AS f, s.to_user AS t, SUM(s.bytes) AS bytes,
        (SELECT username FROM people WHERE user_id = s.from_user) AS fn, (SELECT username FROM people WHERE user_id = s.to_user) AS tn
      FROM play_shares s JOIN plays p ON p.id = s.play_id WHERE p.started_at >= @from AND p.started_at < @to
      GROUP BY s.from_user, s.to_user ORDER BY bytes DESC LIMIT 12`)
      .map((r) => ({ from: String(r.f), fromName: (r.fn as string | null) ?? null, to: String(r.t),
        toName: (r.tn as string | null) ?? null, bytes: int(r.bytes) }));
    const servers = rows(`SELECT p.guild_id AS g, COUNT(DISTINCT p.id) AS plays, COUNT(DISTINCT v.user_id) AS people,
        COALESCE(SUM(v.watched_s), 0) AS watched
      FROM plays p LEFT JOIN play_viewers v ON v.play_id = p.id WHERE p.started_at >= @from AND p.started_at < @to
      GROUP BY p.guild_id ORDER BY watched DESC, plays DESC LIMIT 10`)
      .map((r) => ({ guildId: (r.g as string | null) ?? null, plays: int(r.plays), people: int(r.people),
        watchedS: Math.round(int(r.watched)) }));
    const reasons = rows(`SELECT COALESCE(reason, 'No reason given') AS reason, COUNT(*) AS n FROM play_streams
      WHERE decision = 'transcode' AND started_at >= @from AND started_at < @to GROUP BY 1 ORDER BY n DESC, reason LIMIT 8`)
      .map((r) => ({ reason: String(r.reason), streams: int(r.n) }));

    // Each transcode reason, bucket by bucket: [bucket, reason, streams].
    const reasonDays = rows(`SELECT ${DAY} AS d, COALESCE(reason, 'No reason given') AS reason, COUNT(*) AS n FROM play_streams
      WHERE decision = 'transcode' AND started_at >= @from AND started_at < @to GROUP BY d, 2`)
      .map((r) => ({ day: int(r.d) * size, reason: String(r.reason), streams: int(r.n) }));
    // Sessions by weekday and hour together, local time.
    const heat = rows(`SELECT (CAST(${local("started_at")} / 86400000 AS INTEGER) + 4) % 7 AS w,
        CAST(${local("started_at")} / 3600000 AS INTEGER) % 24 AS h, COUNT(*) AS plays, COALESCE(SUM(played_s), 0) AS played
      FROM plays WHERE started_at >= @from AND started_at < @to GROUP BY w, h`)
      .map((r) => ({ weekday: int(r.w), hour: int(r.h), plays: int(r.plays), playedS: Math.round(int(r.played)) }));
    // Each viewer's session by the client they finished it on: their buffering,
    // and the streams of their own that had to be transcoded for it.
    const clients = rows(`SELECT device, COUNT(*) AS sessions, COUNT(DISTINCT user_id) AS people, SUM(watched) AS watched,
        SUM(stalls) AS stalls, SUM(stalled) AS stalled, SUM(own) AS own, SUM(transcoded) AS transcoded FROM (
        SELECT v.user_id, v.watched_s AS watched, v.stalls, v.stalled_ms AS stalled,
          (SELECT COALESCE(json_extract(e.detail, '$.to'), json_extract(e.detail, '$.device')) FROM events e
            WHERE e.room_id = p.room_id AND e.user_id = v.user_id AND e.at <= v.last_seen
            AND e.kind IN ('joined', 'came back', 'switched client') ORDER BY e.at DESC LIMIT 1) AS device,
          (SELECT COUNT(*) FROM play_streams s WHERE s.play_id = v.play_id AND s.owner_user_id = v.user_id) AS own,
          (SELECT COUNT(*) FROM play_streams s WHERE s.play_id = v.play_id AND s.owner_user_id = v.user_id AND s.decision = 'transcode') AS transcoded
        FROM play_viewers v JOIN plays p ON p.id = v.play_id WHERE p.started_at >= @from AND p.started_at < @to)
      GROUP BY device ORDER BY sessions DESC LIMIT 60`)
      .map((r) => ({ device: (r.device as string | null) ?? null, sessions: int(r.sessions), people: int(r.people),
        watchedS: Math.round(int(r.watched)), stalls: int(r.stalls), stalledMs: int(r.stalled),
        ownStreams: int(r.own), transcoded: int(r.transcoded) }));
    // Titles whose streams needed a workaround: sound that stops before the
    // picture, an end before the file's, subtitles burned in, HDR tone-mapped.
    const problems = new Map<string, { ratingKey: string; title: string | null; shortSound: number; earlyEnd: number; burned: number;
      toneMapped: number; plays: Set<number>; lastAt: number; lastPlayId: number | null }>();
    const problem = (k: string, title: string | null, playId: number | null, at: number) => {
      let p = problems.get(k);
      if (!p) problems.set(k, (p = { ratingKey: k, title, shortSound: 0, earlyEnd: 0, burned: 0, toneMapped: 0, plays: new Set(), lastAt: 0, lastPlayId: null }));
      p.title ??= title;
      if (playId !== null) p.plays.add(playId);
      if (at >= p.lastAt) Object.assign(p, { lastAt: at, lastPlayId: playId ?? p.lastPlayId });
      return p;
    };
    for (const r of rows(`SELECT e.kind, e.at, e.play_id AS pid, COALESCE(p.rating_key, json_extract(e.detail, '$.ratingKey')) AS k, p.title,
        json_extract(e.detail, '$.early') AS early FROM events e LEFT JOIN plays p ON p.id = e.play_id
      WHERE e.at >= @from AND e.at < @to AND (e.kind = 'short sound' OR e.kind = 'reached the end')`)) {
      if (!r.k || (r.kind === "reached the end" && !r.early)) continue;
      const p = problem(String(r.k), (r.title as string | null) ?? null, (r.pid as number | null) ?? null, int(r.at));
      if (r.kind === "short sound") p.shortSound++;
      else p.earlyEnd++;
    }
    for (const r of rows(`SELECT s.play_id AS pid, s.started_at AS at, p.rating_key AS k, p.title,
        (s.decision = 'transcode' AND (s.reason LIKE '%burn%' OR s.reason LIKE '%subtitle%')) AS burned,
        (json_extract(s.notes, '$.range') LIKE '%tone-mapped%') AS toned
      FROM play_streams s JOIN plays p ON p.id = s.play_id WHERE s.started_at >= @from AND s.started_at < @to`)) {
      if (!int(r.burned) && !int(r.toned)) continue;
      const p = problem(String(r.k), (r.title as string | null) ?? null, int(r.pid), int(r.at));
      if (int(r.burned)) p.burned++;
      if (int(r.toned)) p.toneMapped++;
    }
    const problemTitles = [...problems.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, 50)
      .map(({ plays: ps, ...p }) => ({ ...p, sessions: ps.size }));

    // How long each processing step took in the period, by whether it was a transcode where that is said;
    // and the median time to the first segment, bucket by bucket.
    const steps = new Map<string, { kind: string; encode: boolean | null; ms: number[]; failed: number }>();
    const firstBy = new Map<string, number[]>();
    for (const r of rows(`SELECT kind, ms, ok, json_extract(detail, '$.encode') AS encode, ${bucketOf("at")} AS d
        FROM processing WHERE at >= @from AND at < @to`)) {
      const encode = r.encode === null || r.encode === undefined ? null : !!int(r.encode);
      const k = `${String(r.kind)}|${encode}`;
      let s = steps.get(k);
      if (!s) steps.set(k, (s = { kind: String(r.kind), encode, ms: [], failed: 0 }));
      if (int(r.ok)) s.ms.push(int(r.ms));
      else s.failed++;
      if (String(r.kind) === "first segment" && int(r.ok)) {
        const fk = `${int(r.d)}|${encode ? "transcode" : "copy"}`;
        (firstBy.get(fk) ?? firstBy.set(fk, []).get(fk)!).push(int(r.ms));
      }
    }
    const at = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    const processing = [...steps.values()].map((s) => {
      const ms = [...s.ms].sort((a, b) => a - b);
      return { kind: s.kind, encode: s.encode, count: ms.length, failed: s.failed,
        avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null,
        p50Ms: ms.length ? at(ms, 0.5) : null, p95Ms: ms.length ? at(ms, 0.95) : null, maxMs: ms.length ? ms[ms.length - 1] : null };
    }).sort((a, b) => a.kind.localeCompare(b.kind) || Number(a.encode) - Number(b.encode));
    const processingDays = [...firstBy].map(([k, ms]) => {
      const [d, way] = k.split("|");
      const sorted = [...ms].sort((a, b) => a - b);
      return { day: Number(d) * size, way: way as "copy" | "transcode", p50Ms: at(sorted, 0.5), count: sorted.length };
    }).sort((a, b) => a.day - b.day);
    // Watch time by Discord server, bucket by bucket.
    const serverDays = rows(`SELECT ${bucketOf("p.started_at")} AS d, p.guild_id AS g, COUNT(DISTINCT p.id) AS plays,
        COALESCE(SUM(v.watched_s), 0) AS watched
      FROM plays p LEFT JOIN play_viewers v ON v.play_id = p.id WHERE p.started_at >= @from AND p.started_at < @to GROUP BY d, g`)
      .map((r) => ({ day: int(r.d) * size, guildId: (r.g as string | null) ?? null, plays: int(r.plays), watchedS: Math.round(int(r.watched)) }));
    // Requests by outcome, bucket by bucket.
    const requestDays = rows(`SELECT ${bucketOf("at")} AS d, outcome, COUNT(*) AS n FROM requests WHERE at >= @from AND at < @to GROUP BY d, outcome`)
      .map((r) => ({ day: int(r.d) * size, outcome: String(r.outcome), requests: int(r.n) }));

    return { days, lastHours, bucket, zone: zone.zone, from, to, totals, daily, hours, weekdays, titles,
      people: topPeople, sharers, pairs, servers, reasons, upload, reasonDays, heat, clients, problems: problemTitles,
      processing, processingDays, serverDays, requestDays };
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
      this.st(`DELETE FROM positions WHERE play_id IN (SELECT p.id FROM plays p WHERE ${OLD_PLAY})`).run({ before });
      this.st(`DELETE FROM play_flow WHERE play_id IN (SELECT p.id FROM plays p WHERE ${OLD_PLAY})`).run({ before });
      this.st(`DELETE FROM play_health WHERE play_id IN (SELECT p.id FROM plays p WHERE ${OLD_PLAY})`).run({ before });
      this.st("DELETE FROM processing WHERE at < @before").run({ before });
      this.st("DELETE FROM traffic WHERE minute < @minute").run({ minute: Math.floor(before / 60_000) });
      this.st("DELETE FROM system_load WHERE minute < @minute").run({ minute: Math.floor(before / 60_000) });
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

/** A title's preparation this long before its session began is the session's: a picture subtitle extracted ahead, previews. */
const PROCESSING_LEAD_MS = 15 * 60_000;

/** A viewer's player at one sample: see Recorder.play's `health`. */
export type HealthPoint = [number, number | null, number | null, number | null, number, number, number, number,
  number | null, number | null, number | null, number | null, number | null];

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
  /** What the bot's port sent, and its busiest minute, in kilobits a second. */
  sentBytes: number;
  peakKbps: number;
}

function emptyDay(day: number): GraphDay {
  return { day, plays: 0, playedS: 0, peakViewers: 0, people: 0, watchedS: 0, httpBytes: 0, edgeBytes: 0, edgeHitBytes: 0,
    botBytes: 0, p2pBytes: 0, stalls: 0, stalledMs: 0, errors: 0, streams: 0, copies: 0, reencodes: 0, requests: 0, launches: 0,
    sentBytes: 0, peakKbps: 0 };
}

/** The bot's upload over minutes: on average, at the 95th percentile and at its busiest. */
export interface UploadRates {
  minutes: number;
  avgKbps: number | null;
  p95Kbps: number | null;
  peakKbps: number | null;
  /** Over whole minutes of one stream: what was sent over that stream's bitrate, and how many such minutes. */
  perStream: number | null;
  perStreamMinutes: number;
}

export interface Graphs {
  /** How long each processing step took (services/admin-hooks.ts ProcessingKind), by transcode or not where that is said. */
  processing: Array<{ kind: string; encode: boolean | null; count: number; failed: number; avgMs: number | null; p50Ms: number | null;
    p95Ms: number | null; maxMs: number | null }>;
  /** The median time from ffmpeg starting to its first segment, bucket by bucket, for copies and transcodes. */
  processingDays: Array<{ day: number; way: "copy" | "transcode"; p50Ms: number; count: number }>;
  /** Sessions and watch time by Discord server, bucket by bucket. */
  serverDays: Array<{ day: number; guildId: string | null; plays: number; watchedS: number }>;
  /** Requests by outcome, bucket by bucket. */
  requestDays: Array<{ day: number; outcome: string; requests: number }>;
  /** Each transcode reason, bucket by bucket (the bucket's start, as GraphDay.day). */
  reasonDays: Array<{ day: number; reason: string; streams: number }>;
  /** Sessions by weekday (Sunday 0) and hour together, local time. */
  heat: Array<{ weekday: number; hour: number; plays: number; playedS: number }>;
  /** Viewers' sessions by the client they finished on (its user agent). */
  clients: Array<{ device: string | null; sessions: number; people: number; watchedS: number; stalls: number; stalledMs: number;
    ownStreams: number; transcoded: number }>;
  /** Titles whose streams needed a workaround, most recent first. */
  problems: Array<{ ratingKey: string; title: string | null; shortSound: number; earlyEnd: number; burned: number; toneMapped: number;
    sessions: number; lastAt: number; lastPlayId: number | null }>;
  /** The days it covers, or 0 for all time; and the hours it was asked for, if it was. */
  days: number;
  lastHours: number | null;
  /** What each of `daily` is: a day, or an hour for a period of three days or less. */
  bucket: "day" | "hour";
  /** The time zone its days, hours and weekdays are in. */
  zone: string;
  /** The instants it begins and ends. */
  from: number;
  to: number;
  totals: Omit<GraphDay, "day" | "peakViewers"> & { hitShare: number | null };
  /** By `bucket`: each one's start on the clock of the zone, written as UTC. */
  daily: GraphDay[];
  /** What the bot's port sent: since when it has been measured, and its rates over the minutes something played. */
  upload: UploadRates & {
    since: number | null;
    sentBytes: number;
    allMinutes: number;
    peakAt: number | null;
    /** The same, by how many were watching: 1, 2, 3, and 4 or more. */
    byViewers: Array<UploadRates & { viewers: number }>;
  };
  hours: Array<{ hour: number; plays: number; playedS: number }>;
  weekdays: Array<{ weekday: number; plays: number; playedS: number }>;
  titles: Array<{ ratingKey: string; title: string | null; plays: number; people: number; watchedS: number }>;
  people: Array<{ userId: string; username: string | null; plays: number; watchedS: number; bytes: number; p2pBytes: number; upBytes: number }>;
  /** Who sent other viewers the most, and what went between whom. */
  sharers: Array<{ userId: string; username: string | null; plays: number; upBytes: number; p2pBytes: number }>;
  pairs: Array<{ from: string; fromName: string | null; to: string; toName: string | null; bytes: number }>;
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
    COALESCE(v.p2p, 0) AS p2p, COALESCE(v.up, 0) AS up, COALESCE(v.edge, 0) AS edge, COALESCE(v.hit, 0) AS hit,
    COALESCE(v.stalls, 0) AS stalls, COALESCE(v.stalled_ms, 0) AS stalled_ms, COALESCE(v.errors, 0) AS errors,
    (SELECT COUNT(*) FROM plays p WHERE p.host_user_id = pe.user_id) AS hosted,
    (SELECT COUNT(*) FROM usage u WHERE u.user_id = pe.user_id AND u.kind = 'launch') AS launches,
    (SELECT COUNT(*) FROM requests r WHERE r.user_id = pe.user_id) AS requests,
    (SELECT p.title FROM play_viewers lv JOIN plays p ON p.id = lv.play_id WHERE lv.user_id = pe.user_id
      ORDER BY lv.last_seen DESC LIMIT 1) AS last_title
  FROM people pe
  LEFT JOIN (SELECT user_id, COUNT(*) AS plays, SUM(watched_s) AS watched_s, SUM(http_bytes) AS http,
      SUM(p2p_bytes) AS p2p, SUM(up_bytes) AS up, SUM(edge_bytes) AS edge, SUM(edge_hit_bytes) AS hit, SUM(stalls) AS stalls,
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
      watchedS: Number(r.watched_s), httpBytes: Number(r.http), p2pBytes: Number(r.p2p), upBytes: Number(r.up ?? 0),
      edgeBytes: Number(r.edge),
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

function viewerData(v: Omit<ViewerTotals, "joinedAt" | "streamAt">): ViewerData {
  return {
    watchedS: Math.round(v.watchedS),
    httpBytes: Math.round(v.httpBytes),
    p2pBytes: Math.round(v.p2pBytes),
    upBytes: Math.round(v.upBytes),
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
    endCause: (r.end_cause as string | null) ?? null,
    startPosS: (r.start_pos_s as number | null) ?? null,
    lastPosS: (r.last_pos_s as number | null) ?? null,
    playedS: Math.round(Number(r.played_s)),
    peakViewers: Number(r.peak_viewers),
  };
}

/** A play's shares as a list, most first. */
function sharesOf(m: Map<string, number>): Array<{ from: string; to: string; bytes: number }> {
  return [...m].map(([pair, bytes]) => {
    const [from, to] = pair.split("|");
    return { from, to, bytes: Math.round(bytes) };
  }).filter((s) => s.bytes > 0).sort((a, b) => b.bytes - a.bytes);
}

/** Where in the title, over time: [at, position in seconds, 1 if playing]. */
type Track = Array<[number, number, number]>;

/** A name as Discord gave it, on one line and not too long; null if there is none. */
function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 100);
  return s || null;
}

/**
 * Seconds as host, co-host and viewer between `from` and `to`, from one
 * person's joins, client switches, role changes and leaving in one room
 * (oldest first, those before `from` included for the role they came in with).
 */
export function roleTime(events: Array<{ at: number; kind: string; detail: Record<string, unknown> }>, from: number, to: number):
  Record<"host" | "co-host" | "viewer", number> {
  const out = { host: 0, "co-host": 0, viewer: 0 };
  let role: keyof typeof out | null = null;
  let since = from;
  const close = (t: number) => {
    const a = Math.max(since, from);
    const b = Math.min(t, to);
    if (role && b > a) out[role] += (b - a) / 1000;
  };
  for (const e of events) {
    if (e.at > to) break;
    const next = e.kind === "left" ? null : e.kind === "role" ? e.detail.to : e.detail.role;
    if (next !== null && !(typeof next === "string" && next in out)) continue;
    close(e.at);
    role = next as keyof typeof out | null;
    since = e.at;
  }
  close(to);
  return out;
}

/**
 * The room's position over a play from before it was written down, from the
 * position each of its events was at and whether the room was playing then.
 */
export function trackOfEvents(events: Array<{ at: number; kind: string; posS: number | null }>,
  play: { startedAt: number; endedAt: number | null; updatedAt: number; startPosS: number | null; lastPosS: number | null }): Track {
  const out: Track = [];
  let playing = true;
  if (play.startPosS !== null) out.push([play.startedAt, play.startPosS, 1]);
  for (const e of events) {
    if (e.kind === "pause" || e.kind === "stop" || e.kind === "ended") playing = false;
    else if (e.kind === "play" || e.kind === "resume") playing = true;
    if (e.posS !== null && Number.isFinite(e.posS)) out.push([e.at, e.posS, playing ? 1 : 0]);
  }
  if (play.lastPosS !== null) out.push([play.endedAt ?? play.updatedAt, play.lastPosS, 0]);
  return out.sort((a, b) => a[0] - b[0]);
}

/** When a viewer was in the play: from when first seen to each "left", and from each return. */
export function presenceOf(v: { userId: string; firstSeen: number; lastSeen: number },
  events: Array<{ at: number; kind: string; userId: string | null }>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let since: number | null = v.firstSeen;
  for (const e of events) {
    if (e.userId !== v.userId) continue;
    if (e.kind === "left" && since !== null) {
      out.push([since, e.at]);
      since = null;
    } else if ((e.kind === "came back" || e.kind === "joined") && since === null) since = e.at;
  }
  if (since !== null) out.push([since, Math.max(since, v.lastSeen)]);
  return out;
}

/** The room's track, cut to the times somebody was there. */
export function within(track: Track, spans: Array<[number, number]>): Track {
  const out: Track = [];
  for (const [from, to] of spans) {
    const inSpan = track.filter((p) => p[0] >= from && p[0] <= to);
    // Where the room was as they came and went, between the points either side.
    const at = (t: number): [number, number, number] | null => {
      let before: [number, number, number] | null = null;
      let after: [number, number, number] | null = null;
      for (const p of track) {
        if (p[0] <= t) before = p;
        else { after = p; break; }
      }
      if (!before) return null;
      if (!before[2] || !after) return [t, before[1], before[2]];
      const f = (t - before[0]) / Math.max(1, after[0] - before[0]);
      return [t, before[1] + (after[1] - before[1]) * f, before[2]];
    };
    const head = at(from);
    const tail = at(to);
    const pieces = [...(head ? [head] : []), ...inSpan, ...(tail ? [tail] : [])];
    // A break between spans: their positions are never joined up.
    if (out.length) out.push([from, -1, 0]);
    out.push(...pieces);
  }
  return out;
}

/**
 * The parts of the title a track passed through while playing, merged:
 * between two points it moved forward at about the speed of playing (a
 * quarter faster at most, as a player catching up does), not a seek.
 */
export function watchedParts(track: Track): Array<[number, number]> {
  const parts: Array<[number, number]> = [];
  for (let i = 1; i < track.length; i++) {
    const [t0, p0, playing] = track[i - 1];
    const [t1, p1] = track[i];
    if (!playing || p0 < 0 || p1 < 0) continue;
    const moved = p1 - p0;
    if (moved > 0 && moved <= ((t1 - t0) / 1000) * 1.25 + 2) parts.push([p0, p1]);
  }
  parts.sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of parts) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 3) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out.map(([a, b]) => [Math.round(a * 10) / 10, Math.round(b * 10) / 10]);
}

/**
 * The history as it should have been written, put right once by the
 * recorder of 17 November (user_version 2).
 *  - A viewer's player loading the start — as they joined, as the title or
 *    their stream started — was counted as buffering; loading after a seek
 *    was too when the seek reached them a moment before their player said.
 *  - Each viewer "switched stream" and "changed subtitles" as an episode
 *    began, from the stream and subtitles of the one before.
 */
export function mendHistory(db: Database.Database): { buffering: number; streams: number; subtitles: number } {
  const done = { buffering: 0, streams: 0, subtitles: 0 };
  const plays = db.prepare("SELECT id, started_at FROM plays").all() as Array<{ id: number; started_at: number }>;
  const eventsOf = db.prepare("SELECT id, at, kind, user_id, detail FROM events WHERE play_id = ? ORDER BY at, id");
  const keysOf = db.prepare("SELECT variant_key FROM play_streams WHERE play_id = ?");
  const firstSeen = db.prepare("SELECT user_id, first_seen FROM play_viewers WHERE play_id = ?");
  const setKind = db.prepare("UPDATE events SET kind = ? WHERE id = ?");
  const setDetail = db.prepare("UPDATE events SET detail = ? WHERE id = ?");
  const drop = db.prepare("DELETE FROM events WHERE id = ?");
  const uncount = db.prepare(`UPDATE play_viewers SET stalls = MAX(0, stalls - 1), stalled_ms = MAX(0, stalled_ms - ?)
    WHERE play_id = ? AND user_id = ?`);
  for (const play of plays) {
    const events = (eventsOf.all(play.id) as Array<{ id: number; at: number; kind: string; user_id: string | null; detail: string | null }>)
      .map((e) => ({ ...e, d: (parse(e.detail) ?? {}) as Record<string, unknown> }));
    const keys = new Set((keysOf.all(play.id) as Array<{ variant_key: string | null }>).map((k) => k.variant_key).filter(Boolean));
    const seen = new Map((firstSeen.all(play.id) as Array<{ user_id: string; first_seen: number }>).map((v) => [v.user_id, v.first_seen]));
    const carried = new Set<string>();
    for (const e of events) {
      if (e.kind !== "stream changed" || !e.d.from) continue;
      if (typeof e.d.to === "string") keys.add(e.d.to);
    }
    for (const e of events) {
      if (e.kind !== "stream changed") continue;
      if (typeof e.d.from === "string" && !keys.has(e.d.from)) {
        setDetail.run(json({ ...e.d, from: null }), e.id);
        carried.add(`${e.user_id}|${e.at}`);
        done.streams++;
      } else if (!e.d.from) {
        // Their first stream, and the subtitles that came with it.
        carried.add(`${e.user_id}|${e.at}`);
      }
    }
    for (const e of events) {
      if (e.kind === "subtitles" && carried.has(`${e.user_id}|${e.at}`)) {
        drop.run(e.id);
        done.subtitles++;
      }
    }
    for (const e of events) {
      if (e.kind !== "buffering" || !e.user_id) continue;
      const ms = Number(e.d.ms) || 0;
      const start = e.at - ms;
      const near = (t: number | undefined, before: number, after: number) => t !== undefined && start >= t - before && start - t <= after;
      const mine = (k: string[]) => events.filter((x) => k.includes(x.kind) && (x.user_id === e.user_id || x.kind === "play")).map((x) => x.at);
      const seek = events.some((x) => x.kind === "seek" && near(x.at, SEEK_LOAD_BEFORE_MS, SEEK_LOAD_AFTER_MS));
      const starts = [play.started_at, seen.get(e.user_id), ...mine(["play", "joined", "came back", "stream changed"])];
      const kind = seek ? "loaded after seek" : starts.some((t) => near(t, 2_000, START_LOAD_MS)) ? "loaded at start" : null;
      if (!kind) continue;
      setKind.run(kind, e.id);
      uncount.run(ms, play.id, e.user_id);
      done.buffering++;
    }
  }
  return done;
}
