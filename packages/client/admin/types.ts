/** What the admin API sends (packages/server/src/admin/data.ts), as the page reads it. */

export type Notes = Record<string, string | number>;

/** A viewer's play so far (admin/recorder.ts). */
export interface ViewerData {
  watchedS: number;
  httpBytes: number;
  p2pBytes: number;
  /** What their player sent other viewers' players. */
  upBytes: number;
  edgeBytes: number;
  edgeHitBytes: number;
  botBytes: number;
  stalls: number;
  stalledMs: number;
  errors: number;
}

export interface Client {
  userId: string;
  username: string | null;
  role: "host" | "co-host" | "viewer";
  connected: boolean;
  watching: boolean;
  away: boolean;
  loading: boolean;
  joinedAt: number;
  variantKey: string | null;
  subtitleStreamId: number;
  quality: number;
  caps: string[];
  av1Encode: boolean;
  /** Its browser's user agent, as it gave it on joining (clients.ts clientName). */
  device?: string | null;
  /** While the admin page records. */
  data?: ViewerData;
  /**
   * What their player is doing, from its own log: stopped for data
   * ("buffering"), loading the start or after a seek, or playing (null).
   * Null when it hasn't said for half a minute.
   */
  player?: { stall: "buffering" | "start" | "seek" | null; sinceMs: number | null } | null;
}

export interface Stream {
  variantKey: string;
  hlsSessionId: string | null;
  audioStreamId: number;
  subtitleStreamId: number;
  quality: number;
  ownerUserId: string | null;
  sessionOffset: number;
  idleS: number | null;
  viewers: string[];
  isHostStream: boolean;
  engine: "ffmpeg" | "plex" | null;
  decision: "copy" | "transcode" | null;
  reason: string | null;
  summary: string;
  kbps: number | null;
  kbpsSource: string | null;
  plexTranscodeKey: string | null;
  plexClientId: string | null;
  notes: Notes;
  notesAt: number | null;
}

export interface Room {
  id: string;
  ratingKey: string | null;
  title: string | null;
  playing: boolean;
  positionS: number;
  waiting: boolean;
  /** While it waits for the host's picture: what for ("a stream is starting", "a seek"…), and the host's track change behind it. */
  waitingWhy?: string | null;
  switching?: string | null;
  hostWaiting: boolean;
  stateAgeS: number;
  hostHeartbeatAgeS: number | null;
  hostVariantKey: string | null;
  hostSubtitleId: number;
  coHostIds: string[];
  queue: Array<{ ratingKey: string; title: string; type: string }>;
  held: boolean;
  heldFor: { hostUserId: string; guildId: string | null; channelId: string | null } | null;
  clients: Client[];
  away: Array<{ userId: string; ratingKey: string | null; variantKey: string; quality: number }>;
  discord: { guildId: string | null; channelId: string | null; hostUserId: string | null; startedAt: number | null };
  streams: Stream[];
  playId?: number | null;
  /** Names of people it mentions who have left it. */
  names?: Record<string, string>;
  /** Delivery over the last minutes: [time, server, Discord cache, peers], bits a second. */
  flow?: { stepS: number; windowS: number; points: Array<[number, number, number, number]> } | null;
  /** What each viewer's player has sent another's in its session, most first. */
  shares?: Share[];
}

/** What one viewer's player sent another's, by user id. */
export interface Share {
  from: string;
  to: string;
  bytes: number;
}

/** One person's sharing with another, on a person's page. */
export interface SharePartner {
  userId: string;
  username: string | null;
  bytes: number;
  plays: number;
}

/** A title's poster and running time (admin/titles.ts). */
export interface TitleInfo {
  ratingKey: string;
  type: string | null;
  title: string | null;
  show: string | null;
  season: number | null;
  episode: number | null;
  year: number | null;
  durationS: number | null;
  poster: boolean;
  /** Its audio and subtitle tracks' names, by Plex stream id. */
  tracks?: Record<string, string>;
}

export interface Overview {
  at: number;
  totals: {
    rooms: number;
    people: number;
    watching: number;
    streams: number;
    copied: number;
    reencoded: number;
    feedKbps: number;
  };
  rooms: Room[];
}

export interface LogFile { name: string; bytes: number; modified: string }
export interface LogLine { n: number; at: string | null; level: "error" | "warn" | "info"; tag: string | null; client: string | null; text: string }
export interface LogResult { file: string | null; lines: LogLine[]; scanned: number; matched: number }

export interface Setting { name: string; set: boolean; value: string | null; secret: boolean }
export interface SettingsView { settings: Setting[]; system: Record<string, string | number | null> }

// ─── The history (packages/server/src/admin/recorder.ts) ─────────

export interface Play {
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
  /** How it ended, where known: "finished", "closed", "next episode", "co-host", … */
  endCause?: string | null;
  startPosS: number | null;
  lastPosS: number | null;
  playedS: number;
  peakViewers: number;
}

export interface PlaySummary extends Play {
  viewers: number;
  names: string[];
  streams: number;
  reencoded: number;
  bytes: number;
  botBytes: number;
  cacheBytes: number;
  p2pBytes: number;
  stalls: number;
}

export interface PlayViewer extends ViewerData {
  userId: string;
  username: string | null;
  role: string | null;
  firstSeen: number;
  lastSeen: number;
}

export interface PlayStream {
  id: number;
  hlsSessionId: string;
  variantKey: string | null;
  engine: string | null;
  decision: string | null;
  reason: string | null;
  summary: string | null;
  audioStreamId: number | null;
  subtitleStreamId: number | null;
  quality: number | null;
  ownerUserId: string | null;
  offsetS: number | null;
  kbps: number | null;
  notes: Notes;
  startedAt: number;
  endedAt: number | null;
  peakViewers: number;
}

export interface PlayEvent {
  id: number;
  at: number;
  kind: string;
  userId: string | null;
  username: string | null;
  posS: number | null;
  detail: Record<string, unknown> | null;
}

/** Where in the title the room was: [time, position in seconds (below 0: a break), playing 1 or 0]. */
export type TrackPoint = [number, number, number];

export interface PlayDetail {
  play: Play;
  viewers: PlayViewer[];
  streams: PlayStream[];
  events: PlayEvent[];
  /** Each viewer's last joins, client switches and role changes in the room before the session opened. */
  lead?: PlayEvent[];
  /** The room's position over the session. */
  track?: TrackPoint[];
  /** What of the title each viewer watched: [from, to] in seconds of it, by user id. */
  watched?: Record<string, Array<[number, number]>>;
  /** What each viewer's player sent another's, most first. */
  shares?: Share[];
}

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

export interface PersonPlay extends Play, ViewerData {
  role: string | null;
  firstSeen: number;
  lastSeen: number;
}

export interface TitleRequest {
  id: number;
  at: number;
  userId: string | null;
  username: string | null;
  mediaType: string;
  tmdbId: number;
  seasons: number[] | "all" | null;
  title: string | null;
  outcome: string;
  status: number | null;
  error: string | null;
  /** What Seerr says of it now; null when it couldn't be asked. */
  current?: { mediaStatus: number | null; requestStatus: number | null } | null;
}

export interface PersonPlace {
  guildId: string | null;
  channelId: string | null;
  launches: number;
  joins: number;
  first: number;
  last: number;
}

export interface PersonDetail {
  person: PersonSummary;
  plays: PersonPlay[];
  requests: TitleRequest[];
  places: PersonPlace[];
  /** Whom their player sent the most, and whose sent theirs the most. */
  sentTo?: SharePartner[];
  gotFrom?: SharePartner[];
}

export interface PlaceChannel {
  guildId: string | null;
  channelId: string | null;
  launches: number;
  joins: number;
  people: number;
  names: Array<{ userId: string; username: string | null }>;
  plays: number;
  playedS: number;
  first: number | null;
  last: number | null;
}

export interface PlaceGuild extends Omit<PlaceChannel, "channelId" | "names"> {
  channels: PlaceChannel[];
}

export interface UsageRow {
  id: number;
  at: number;
  kind: string;
  roomId: string | null;
  userId: string | null;
  username: string | null;
  guildId: string | null;
  channelId: string | null;
}

export interface CacheItem {
  name: string;
  title: string | null;
  ratingKey: string | null;
  bytes: number | null;
  at: number | null;
  detail?: string;
}

export interface CacheView {
  id: string;
  name: string;
  what: string;
  where: string;
  bytes: number;
  limitBytes: number | null;
  items: number;
  kept: string;
  list: CacheItem[];
  listNote: string | null;
}

export interface CacheSums {
  plays?: number;
  httpBytes: number;
  edgeBytes: number;
  edgeHitBytes: number;
  p2pBytes: number;
  botBytes: number;
  hitShare: number | null;
}

export interface CachesResult {
  at: number;
  caches: CacheView[];
  discord: {
    day: CacheSums;
    week: CacheSums;
    all: CacheSums;
    titles: Array<CacheSums & { ratingKey: string; title: string | null }>;
  } | null;
}

// ─── Graphs and the history file ────────────────────────────────

export interface GraphDay {
  /** The date, written as its midnight in UTC: a day in the time zone asked for, not an instant. */
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
  /** What the bot's port sent, and its busiest minute in kilobits a second. */
  sentBytes: number;
  peakKbps: number;
}

/** The bot's upload over minutes something played. */
export interface UploadRates {
  minutes: number;
  avgKbps: number | null;
  p95Kbps: number | null;
  peakKbps: number | null;
  /** Over whole minutes of one stream: what was sent over that stream's bitrate. */
  perStream: number | null;
  perStreamMinutes: number;
}

export interface Graphs {
  days: number;
  lastHours: number | null;
  /** What each of `daily` is: a day, or an hour for three days or less. */
  bucket: "day" | "hour";
  /** The time zone its days, hours and weekdays are in. */
  zone: string;
  from: number;
  to: number;
  totals: Omit<GraphDay, "day" | "peakViewers"> & { hitShare: number | null };
  daily: GraphDay[];
  hours: Array<{ hour: number; plays: number; playedS: number }>;
  weekdays: Array<{ weekday: number; plays: number; playedS: number }>;
  titles: Array<{ ratingKey: string; title: string | null; plays: number; people: number; watchedS: number }>;
  people: Array<{ userId: string; username: string | null; plays: number; watchedS: number; bytes: number; p2pBytes?: number; upBytes?: number }>;
  /** Who sent other viewers the most, and between whom the most went. */
  sharers?: Array<{ userId: string; username: string | null; plays: number; upBytes: number; p2pBytes: number }>;
  pairs?: Array<{ from: string; fromName: string | null; to: string; toName: string | null; bytes: number }>;
  servers: Array<{ guildId: string | null; plays: number; people: number; watchedS: number }>;
  reasons: Array<{ reason: string; streams: number }>;
  upload: UploadRates & {
    since: number | null;
    sentBytes: number;
    allMinutes: number;
    peakAt: number | null;
    byViewers: Array<UploadRates & { viewers: number }>;
  };
}

/** Discord servers' and channels' names, by id. */
export interface PlaceNames { guilds: Record<string, string>; channels: Record<string, string> }

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
