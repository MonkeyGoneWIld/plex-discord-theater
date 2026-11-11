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
