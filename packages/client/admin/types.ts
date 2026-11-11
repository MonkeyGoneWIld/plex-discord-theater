/** What the admin API sends (packages/server/src/admin/data.ts), as the page reads it. */

export type Notes = Record<string, string | number>;

/** A viewer's play so far (admin/recorder.ts). */
export interface ViewerData {
  watchedS: number;
  httpBytes: number;
  p2pBytes: number;
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
  /** While the admin page records. */
  data?: ViewerData;
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
  hostWaiting: boolean;
  stateAgeS: number;
  hostHeartbeatAgeS: number | null;
  hostVariantKey: string | null;
  hostSubtitleId: number;
  coHostIds: string[];
  queue: Array<{ ratingKey: string; title: string; type: string }>;
  heldFor: { hostUserId: string; guildId: string | null; channelId: string | null } | null;
  clients: Client[];
  away: Array<{ userId: string; ratingKey: string | null; variantKey: string; quality: number }>;
  discord: { guildId: string | null; channelId: string | null; hostUserId: string | null; startedAt: number | null };
  streams: Stream[];
  playId?: number | null;
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

export interface PlayDetail {
  play: Play;
  viewers: PlayViewer[];
  streams: PlayStream[];
  events: PlayEvent[];
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
  /** Midnight UTC. */
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

export interface Graphs {
  days: number;
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
