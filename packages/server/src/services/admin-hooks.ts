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

export interface AdminHooks {
  transport(e: TransportEvent): void;
  clientLog(e: ClientLogEvent): void;
  request(e: RequestEvent): void;
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
  clientLog: (e: ClientLogEvent) => call("clientLog", e),
  request: (e: RequestEvent) => call("request", e),
};
