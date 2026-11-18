/**
 * Where the admin page's recorder (admin/recorder.ts) hears what happens in
 * the rooms, the players and the title requests. Every call is a no-op until
 * a recorder registers, which it does only while the admin page is on, and a
 * recorder that throws is logged and never reaches the caller: recording is
 * for the admin, and must never cost a viewer their playback or a request.
 *
 * Kept free of imports so sync.ts and the routes can call it without pulling
 * the admin page in, and without a cycle.
 */

export type TransportType = "play" | "pause" | "resume" | "seek" | "stop";

/** A play, pause, resume, seek or stop the room acted on. */
export interface TransportEvent {
  at: number;
  roomId: string;
  type: TransportType;
  userId: string | null;
  username: string | null;
  role: "host" | "co-host" | "viewer";
  /** Where the room was when it came. */
  fromS: number;
  /** Where the room is after it. */
  toS: number;
  /** The title, after the command; for a stop, the title it stopped. */
  ratingKey: string | null;
  title: string | null;
  /**
   * What the command came from, as the player said (see sync.ts, CAUSES): a
   * seek's "skip intro" or "timeline", a stop's "finished" or "closed", a new
   * title's "next episode" or "picked". Null when it didn't say.
   */
  cause?: string | null;
  /** A play that only rebuilt the stream of the title already playing: not a start. */
  rebuild?: boolean;
  /** For a new title a co-host asked the host for: who asked. */
  askedBy?: string | null;
}

export interface ClientLogEntry {
  /** On the server's clock. */
  t: number;
  level: string;
  tag: string;
  msg: string;
  data: Record<string, unknown>;
}

/** A batch of a player's log lines, from POST /api/logs/client. */
export interface ClientLogEvent {
  at: number;
  userId: string | null;
  /** One page load of the player. */
  clientId: string;
  entries: ClientLogEntry[];
}

/** A title asked for through Seerr, and what came of it. */
export interface RequestEvent {
  at: number;
  userId: string | null;
  mediaType: string;
  tmdbId: number;
  seasons: number[] | "all" | null;
  outcome: "requested" | "already requested" | "failed";
  /** Seerr's media status for a request made; its HTTP status otherwise. */
  status: number | null;
  error: string | null;
  /** The title's name, looked up afterwards; null if it can't be. */
  title?: Promise<string | null>;
}

/** A Discord server's or channel's name, as somebody signing in saw it. */
export interface PlaceEvent {
  at: number;
  kind: "guild" | "channel";
  id: string;
  name: string;
  guildId?: string | null;
}

/** What the bot's port sent since the last one (services/upload-meter.ts). */
export interface SentEvent {
  at: number;
  bytes: number;
}

/**
 * A request for the host role that came to nothing of its own: asked, declined
 * by the host, or ended because who asked left or the role moved. One
 * accepted, or passed on unanswered, is a change of host (sync.ts RoleWhy).
 */
export interface HostRequestEvent {
  at: number;
  roomId: string;
  outcome: "asked" | "declined" | "ended";
  userId: string;
  username: string | null;
  hostId: string | null;
  hostName: string | null;
  /** Asked: whether the host was away from the Discord window, and how long they have to answer. */
  away?: boolean;
  waitS?: number;
  /** Ended: who asked left, or the host role moved first. */
  why?: "asker left" | "host changed";
}

/**
 * Something a title's stream needed to work around (routes/plex.ts): its sound
 * stopping before its picture.
 */
export interface StreamIssueEvent {
  at: number;
  hlsSessionId: string;
  ratingKey: string;
  kind: "short sound";
  detail: Record<string, unknown>;
}

/**
 * A step the server took to prepare a title or make its stream, and how long
 * it took: shown with the session it served (History) and in Statistics.
 *  - probe: ffprobe reading the file's streams (once per file).
 *  - stream setup: from the player's request to ffmpeg being started.
 *  - first segment: from ffmpeg starting to its first segment.
 *  - whole file: ffmpeg reaching the end of the file (remux or transcode complete).
 *  - stream failed: ffmpeg stopping with an error.
 *  - subtitle / subtitle window: an embedded text subtitle read out of the file,
 *    whole or around a position.
 *  - picture subtitle: a PGS, VobSub or DVB subtitle extracted for players to draw.
 *  - sidecar: an external subtitle file read and parsed.
 *  - previews: seek-preview thumbnails generated.
 */
export type ProcessingKind = "probe" | "stream setup" | "first segment" | "whole file" | "stream failed" | "subtitle"
  | "subtitle window" | "picture subtitle" | "sidecar" | "previews";

export interface ProcessingEvent {
  at: number;
  kind: ProcessingKind;
  /** The stream it was for, when it was for one. */
  hlsSessionId?: string | null;
  ratingKey?: string | null;
  ms: number;
  ok: boolean;
  detail?: Record<string, unknown>;
}

export interface AdminHooks {
  transport(e: TransportEvent): void;
  hostRequest(e: HostRequestEvent): void;
  streamIssue(e: StreamIssueEvent): void;
  clientLog(e: ClientLogEvent): void;
  request(e: RequestEvent): void;
  place(e: PlaceEvent): void;
  sent(e: SentEvent): void;
  processing(e: ProcessingEvent): void;
}

let current: Partial<AdminHooks> | null = null;

/** Register the recorder, or null to stop hearing anything. */
export function setAdminHooks(hooks: Partial<AdminHooks> | null): void {
  current = hooks;
}

function call<K extends keyof AdminHooks>(name: K, e: Parameters<AdminHooks[K]>[0]): void {
  const fn = current?.[name] as ((x: typeof e) => void) | undefined;
  if (!fn) return;
  try {
    fn.call(current, e);
  } catch (err) {
    console.warn(`[Admin] the recorder failed on a ${name}:`, err instanceof Error ? err.message : err);
  }
}

export const adminHooks = {
  /** Whether anything listens: callers skip building an event when not. */
  get on(): boolean {
    return current !== null;
  },
  transport: (e: TransportEvent) => call("transport", e),
  hostRequest: (e: HostRequestEvent) => call("hostRequest", e),
  streamIssue: (e: StreamIssueEvent) => call("streamIssue", e),
  clientLog: (e: ClientLogEvent) => call("clientLog", e),
  request: (e: RequestEvent) => call("request", e),
  place: (e: PlaceEvent) => call("place", e),
  sent: (e: SentEvent) => call("sent", e),
  processing: (e: ProcessingEvent) => call("processing", e),
};
