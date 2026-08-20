import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Server } from "http";
import { isValidSession, getSessionUserId } from "../middleware/auth.js";
import { instanceHosts, updateInstanceHost, touchInstance } from "../routes/discord.js";
import { plexFetch } from "./plex.js";
import { getPlexTranscodeKey, getSessionClientId, getSessionRatingKey, markTranscodeStopped, notifyPlexStopped, isSessionStopping, markSessionStopping, clearSessionStopping, terminatePlexSession, pingPlexTranscode, stopTranscodeSession, protectSession, releaseSession } from "../routes/plex.js";
import { createTracker, handleTrackerSocket, destroyTracker } from "./tracker.js";
import { recordProgress } from "./watch-history.js";
import { pushProgressToPlex } from "./plex-accounts.js";
import { logEvent } from "./logger.js";

/** Interval between WebSocket pings to detect dead connections. */
const WS_PING_INTERVAL_MS = 30_000;

/** Messages one connection may send per MSG_WINDOW_MS before the rest are
 *  dropped. Sized well above anything a person can produce — see the budget
 *  check in the connection handler. */
const MSG_BUDGET = 120;
const MSG_WINDOW_MS = 10_000;

/**
 * Stop a Plex transcode using the mapped Plex internal key.
 * Our session UUID differs from Plex's internal transcode key, so we use
 * the mapping populated when the manifest was first fetched.
 */
async function killPlexTranscode(hlsSessionId: string | null): Promise<void> {
  if (!hlsSessionId) return;

  if (isSessionStopping(hlsSessionId)) {
    console.log("[Sync] Stop skipped for", hlsSessionId.substring(0, 8), "(already stopping via HTTP)");
    return;
  }

  markSessionStopping(hlsSessionId);

  try {
    const plexKey = getPlexTranscodeKey(hlsSessionId);
    const clientId = getSessionClientId(hlsSessionId);
    const ratingKey = getSessionRatingKey(hlsSessionId) || null;
    try {
      // Which identifier `stop` wants is not a settled question — see
      // transcodeControl in routes/plex.ts. This tries ours and falls back to
      // the Plex transcode key, because keying it on ours alone was answered
      // with a 404 every single time in a day of real traffic, which means
      // nothing here was stopping anything.
      const res = await stopTranscodeSession(hlsSessionId, clientId);
      console.log("[Sync] Stop transcode", hlsSessionId.substring(0, 8),
        plexKey ? "(plex key known)" : "(no plex key mapping)",
        "→", res.status);
    } catch (err) {
      console.error("[Sync] Stop transcode error:", err);
    }

    markTranscodeStopped(hlsSessionId);
    await notifyPlexStopped(ratingKey, hlsSessionId);
    if (plexKey) {
      await terminatePlexSession(plexKey);
    }
  } finally {
    clearSessionStopping(hlsSessionId);
  }
}

interface QueueItem {
  ratingKey: string;
  title: string;
  type: string;
  thumb: string | null;
  subtitles: boolean;
  parentTitle?: string;
  /** Show name for server-sourced items — see client lib/format.ts on the two
   *  conventions. Type-level only here; queue items are stored opaquely. */
  showTitle?: string;
  parentIndex?: number;
  index?: number;
  year?: number;
}

/**
 * One stream, and the audio + subtitle pair it exists for.
 *
 * A room used to be one Plex transcode that everybody watched. It is now one
 * *timeline* — position, playing, seeks, all still room-wide — with a transcode
 * per combination of tracks anyone has chosen. Everyone starts on the host's;
 * choosing different subtitles forks you onto another; choosing a combination
 * somebody already has puts you on theirs rather than starting a third.
 *
 * Only the tracks vary. Position never does, which is what keeps a room in sync
 * across several streams: a seek is a room command, and each variant's owner
 * applies it to its own transcode.
 */
interface Variant {
  /** `audio:subtitle` — see variantKeyOf. */
  key: string;
  /** Plex stream ids. 0 means "whatever the file defaults to" for audio, and
   *  "none" for subtitles, which is what the client sends before it knows. */
  audioStreamId: number;
  subtitleStreamId: number;
  hlsSessionId: string | null;
  /** Where this transcode was started — per stream, since two variants forked at
   *  different moments have transcoded from different points. */
  sessionOffset: number;
  /**
   * Whoever drives this stream: starts the transcode, restarts it for a seek it
   * can't serve in place, and keeps it alive.
   *
   * The host owns the host's variant, which is the old arrangement exactly. A
   * viewer who forks owns theirs. Ownership is about the transcode and nothing
   * else — it grants no control over the room.
   */
  ownerUserId: string | null;
  /**
   * When everyone watching this stream stepped out of the player, or null while
   * somebody still has it open. See IDLE_STREAM_GRACE_MS.
   */
  idleSince: number | null;
}

/** Tracks identify a stream, so they are its key. */
function variantKeyOf(audioStreamId: number, subtitleStreamId: number): string {
  return `${audioStreamId}:${subtitleStreamId}`;
}

/** A stream id from a client message, or null when it isn't one. */
function trackId(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1e9 ? v : null;
}

interface RoomClient {
  ws: WebSocket;
  userId: string;
  username: string | null;
  isHost: boolean;
  /** Granted by the host; allows transport control (pause/resume/seek) only. */
  isCoHost: boolean;
  /**
   * Whether this client currently has the player open.
   *
   * Reported by the client on entering and leaving playback — the room's
   * `ratingKey` says something is playing, not who is actually watching it.
   * Used to order host succession: handing the room to someone sitting on the
   * library, while people are mid-film, stops the film for all of them.
   */
  isWatching: boolean;
  /** When this connection joined — the last tie-break in succession, so the
   *  successor is at least predictable rather than whatever the Set yields. */
  joinedAt: number;
  /** Which stream this client is watching. Null before playback starts. */
  variantKey: string | null;
}

/**
 * Messages a co-host may send. Everything else — starting a title, stopping,
 * queue changes, role changes — stays host-only. Deliberately narrow: a co-host
 * can steer playback but never change what is playing or who controls the room.
 *
 * "play-item" is a request, not an action: starting a title is host-only, so the
 * host is the one that performs the work.
 *
 * Track selection is deliberately absent, and is not host-only either — it is
 * handled before this check, as something anyone may do, because it now changes
 * only the sender's own stream. A co-host used to be able to change the
 * subtitles for the entire room; they can change their own, and the host's
 * change carries only to the people actually watching the host's stream.
 */
const CO_HOST_ALLOWED_TYPES = new Set(["pause", "resume", "seek", "play-item"]);

/**
 * Who inherits the room when the host goes, best first.
 *
 * The order is co-host → someone watching → everyone else, and within each band
 * whoever joined earliest. It used to be "any co-host, otherwise
 * `clients.values().next().value`" — the first entry of a Set, which is
 * insertion order and therefore effectively arbitrary from the room's point of
 * view: the successor could be the person who joined thirty seconds ago and is
 * still browsing the library, while three people sat watching the film. A host
 * who isn't in the player is a host who can't pause, seek or answer a stall, and
 * whose next action is likely to end the stream for everyone.
 */
function successionRank(c: RoomClient, hostVariantKey: string | null): number {
  // Three independent bits, most significant first, so the bands come out in
  // the order the room wants:
  //   same stream as the outgoing host  >  co-host  >  watching  >  joined first
  //
  // Same stream outranks co-host deliberately. Whoever inherits the room keeps
  // watching what they were already watching, and a host whose stream is the
  // one most of the room is on can change tracks for that group — a host parked
  // on a stream of their own can only ever change their own. Handing the role to
  // a co-host in another language would quietly strand everybody else.
  const sameStream = hostVariantKey != null && c.variantKey === hostVariantKey ? 0 : 4;
  return sameStream + (c.isCoHost ? 0 : 2) + (c.isWatching ? 0 : 1);
}

function pickSuccessor(
  clients: Iterable<RoomClient>,
  hostVariantKey: string | null,
): RoomClient | null {
  let best: RoomClient | null = null;
  for (const c of clients) {
    if (!best) { best = c; continue; }
    const d = successionRank(c, hostVariantKey) - successionRank(best, hostVariantKey);
    if (d < 0 || (d === 0 && c.joinedAt < best.joinedAt)) best = c;
  }
  return best;
}

interface RoomState {
  ratingKey: string | null;
  title: string | null;
  subtitles: boolean;
  playing: boolean;
  position: number;
  /**
   * Whether a real playhead has confirmed `position` since it was last set.
   *
   * `play` announces where a transcode was *asked* to begin, seconds before any
   * frame of it exists. Treating that as a running clock and extrapolating from
   * it means the room advances through a load the host hasn't finished — and if
   * nothing ever reconciles the two, the room stays ahead of the host by
   * however long that load took, for the rest of the film. Measured at 12.7s in
   * one session, with viewers glued to the clock and the host alone behind it.
   *
   * So an announced position is provisional: the room sits on it until the
   * host's first heartbeat says a playhead is really there. Everything that
   * carries an observed or chosen position — a heartbeat, a seek, the host's
   * own pause — confirms it.
   */
  positionConfirmed: boolean;
  updatedAt: number;
  hlsSessionId: string | null;
  /**
   * The offset the current transcode was started at.
   *
   * Plex transcodes linearly from here, so nothing before it exists — which is
   * what tells a client whether a backward seek can be served in place or needs
   * a restart. The host knows this because it asked for the offset; anyone who
   * joins mid-stream or inherits the session on a handover does not, and used to
   * assume 0 and sit out a six-second stall on every backward seek.
   */
  sessionOffset: number;
  browseContext: string | null;
  queue: QueueItem[];
  /**
   * Every stream the room is running, by track pair. Empty when nothing plays.
   *
   * `hlsSessionId` and `sessionOffset` above stay the *host's* stream: they are
   * what a fresh joiner starts on and what the room announces, and keeping them
   * meaningful means nothing that only cares about "the room's stream" had to
   * learn about variants.
   */
  variants: Map<string, Variant>;
  /** The stream the host is watching — the one their track changes carry to. */
  hostVariantKey: string | null;
}

interface Room {
  clients: Set<RoomClient>;
  state: RoomState;
  /**
   * Co-host grants, by Discord user id.
   *
   * Deliberately not on RoomClient alone: that object dies with the socket, so
   * a co-host who blinked — a dropped WebSocket, a tab reload, Discord
   * backgrounding the activity — came back a plain viewer with their controls
   * silently gone, and nothing on screen said why. The role belongs to the
   * person, not to the connection.
   */
  coHostIds: Set<string>;
  /** Last forced history write for this room — see persistProgress. */
  lastForcedPersistAt: number;
}

/** Ceiling on remembered co-host grants, so a room can't accumulate them without
 *  bound across a long session with many joiners. */
const MAX_CO_HOSTS = 50;

const rooms = new Map<string, Room>();

/**
 * Keep-alive timers, one per *stream* rather than one per room.
 *
 * A room can be running several transcodes at once — one per set of tracks
 * somebody chose — and Plex reaps any of them that stops being pinged. Keying
 * this by room kept exactly one alive and let the rest die under whoever was
 * watching them.
 */
const sessionPingIntervals = new Map<string, ReturnType<typeof setInterval>>();

/** Consecutive "no such session" answers before the room stops pinging. Two,
 *  not one, so a single odd response can't silence a live session's keep-alive. */
const PING_GONE_LIMIT = 2;

/** Shape of the session ids this server mints — see crypto.randomUUID on the
 *  client. Used to reject anything else before it reaches a Plex query param. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function startSessionPing(instanceId: string, hlsSessionId: string): void {
  stopSessionPing(hlsSessionId);
  let gone = 0;
  const interval = setInterval(() => {
    pingPlexTranscode(hlsSessionId)
      .then((alive) => {
        // Plex has discarded this transcode. Nothing will bring it back, so the
        // timer is only generating rejected round trips and misleading warnings
        // — one evening's log had 36 of them across four dead sessions.
        gone = alive ? 0 : gone + 1;
        if (gone < PING_GONE_LIMIT) return;
        logEvent("Sync", "stopping keep-alive for a session Plex has dropped", {
          room: instanceId.substring(0, 8),
          session: hlsSessionId.substring(0, 8),
        });
        stopSessionPing(hlsSessionId);
      })
      .catch(() => {});
  }, 30_000);
  interval.unref();
  sessionPingIntervals.set(hlsSessionId, interval);
}

function stopSessionPing(hlsSessionId: string): void {
  const interval = sessionPingIntervals.get(hlsSessionId);
  if (interval) {
    clearInterval(interval);
    sessionPingIntervals.delete(hlsSessionId);
  }
}

/**
 * The Discord user currently hosting whichever room is streaming `sessionId`,
 * or null when no room is using it.
 *
 * Exists so the transcode-stop endpoint can refuse a teardown from someone who
 * is no longer the host. Handing over the host role and closing the tab in the
 * same breath used to kill the stream for everyone: the outgoing host's tab
 * unmounted while it still believed it owned the session — the demotion message
 * had not arrived yet — and its cleanup DELETEd a transcode the new host had
 * just adopted.
 */
/**
 * Is anyone else still watching this stream?
 *
 * A stream can now have an audience of its own, so "the person who started it is
 * leaving" is no longer a reason to stop it. Someone who forks onto the dub and
 * then closes the player would otherwise take every other viewer of that dub
 * down with them — and so would a host handing over the role and closing the tab,
 * with the new host still on the stream they were both watching.
 */
export function sessionHasOtherWatchers(sessionId: string, userId: string | null): boolean {
  for (const room of rooms.values()) {
    for (const v of room.state.variants.values()) {
      if (v.hlsSessionId !== sessionId) continue;
      return membersOf(room, v.key).some((c) => c.userId !== userId);
    }
  }
  return false;
}

export function sessionHostUserId(sessionId: string): string | null {
  for (const room of rooms.values()) {
    // Whoever drives this particular stream. With one transcode per set of
    // tracks, "the host" is no longer the answer: a viewer watching in another
    // language owns their own stream and is the only client entitled to tear it
    // down — while having no claim at all on the host's.
    for (const v of room.state.variants.values()) {
      if (v.hlsSessionId === sessionId) return v.ownerUserId;
    }
    if (room.state.hlsSessionId !== sessionId) continue;
    for (const c of room.clients) if (c.isHost) return c.userId;
    return null;
  }
  return null;
}

let wss: WebSocketServer | null = null;
let trackerWss: WebSocketServer | null = null;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

function getOrCreateRoom(instanceId: string): Room {
  let room = rooms.get(instanceId);
  if (!room) {
    room = {
      clients: new Set(),
      state: {
        ratingKey: null,
        title: null,
        subtitles: false,
        playing: false,
        position: 0,
        positionConfirmed: false,
        updatedAt: Date.now(),
        hlsSessionId: null,
        sessionOffset: 0,
        browseContext: null,
        queue: [],
        variants: new Map(),
        hostVariantKey: null,
      },
      coHostIds: new Set(),
      lastForcedPersistAt: 0,
    };
    rooms.set(instanceId, room);
  }
  return room;
}

/**
 * Write to one socket, swallowing a failure.
 *
 * readyState is checked first, but it can change between that check and the
 * write — the peer closing mid-loop is ordinary. An unhandled throw here
 * escapes the ws emitter as an uncaughtException, and the logger deliberately
 * rethrows those, so one dead socket would end the process and every watch
 * party on it.
 */
function safeSend(ws: WebSocket, data: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(data);
  } catch {
    // The socket died underneath us; its close handler does the cleanup.
  }
}

function broadcast(room: Room, sender: WebSocket, msg: object): void {
  const data = JSON.stringify(msg);
  for (const client of room.clients) {
    if (client.ws !== sender) safeSend(client.ws, data);
  }
}

/** Send to every client in the room, including the one that triggered it. */
function sendToAll(room: Room, msg: object): void {
  const data = JSON.stringify(msg);
  for (const client of room.clients) safeSend(client.ws, data);
}

function participantsOf(room: Room) {
  return [...room.clients].map((c) => ({
    userId: c.userId,
    username: c.username,
    isHost: c.isHost,
    isCoHost: c.isCoHost,
  }));
}

/** Push the roster to everyone — call after any membership or role change. */
function broadcastParticipants(room: Room): void {
  sendToAll(room, { type: "participants", participants: participantsOf(room) });
}

function sendTo(ws: WebSocket, msg: object): void {
  safeSend(ws, JSON.stringify(msg));
}

/** Everyone currently watching one stream. */
function membersOf(room: Room, key: string): RoomClient[] {
  return [...room.clients].filter((c) => c.variantKey === key);
}

/** What a client needs to play a stream: which one, and whether they drive it. */
function variantMessage(v: Variant, isOwner: boolean) {
  return {
    type: "variant",
    variantKey: v.key,
    audioStreamId: v.audioStreamId,
    subtitleStreamId: v.subtitleStreamId,
    hlsSessionId: v.hlsSessionId,
    sessionOffset: v.sessionOffset,
    isOwner,
  };
}

/** Tell each member of a stream what it is now — including who drives it. */
function announceVariant(room: Room, v: Variant): void {
  for (const c of membersOf(room, v.key)) {
    sendTo(c.ws, variantMessage(v, c.userId === v.ownerUserId));
  }
}

/**
 * Make sure a stream still has someone driving it.
 *
 * Ownership is not a role anyone asked for, so it goes to whoever has been in
 * the room longest — the same tie-break succession uses, and for the same
 * reason: it has to be predictable rather than whatever the Set happens to yield.
 */
function ensureVariantOwner(room: Room, v: Variant): void {
  const members = membersOf(room, v.key);
  if (v.ownerUserId && members.some((c) => c.userId === v.ownerUserId)) return;
  let next: RoomClient | null = null;
  for (const c of members) if (!next || c.joinedAt < next.joinedAt) next = c;
  v.ownerUserId = next?.userId ?? null;
}

/** Tear a stream down: stop pinging it, stop protecting it, kill the transcode. */
function destroyVariant(room: Room, key: string): void {
  const v = room.state.variants.get(key);
  if (!v) return;
  room.state.variants.delete(key);
  if (room.state.hostVariantKey === key) room.state.hostVariantKey = null;
  if (!v.hlsSessionId) return;
  stopSessionPing(v.hlsSessionId);
  releaseSession(v.hlsSessionId);
  killPlexTranscode(v.hlsSessionId).catch(() => {});
}

function destroyAllVariants(room: Room): void {
  for (const key of [...room.state.variants.keys()]) destroyVariant(room, key);
  room.state.hostVariantKey = null;
}

/** Adopt a session as a stream's live transcode, replacing any previous one. */
function attachSession(room: Room, v: Variant, sessionId: string, offset: number, instanceId: string): void {
  const previous = v.hlsSessionId;
  if (previous && previous !== sessionId) {
    stopSessionPing(previous);
    releaseSession(previous);
    killPlexTranscode(previous).catch(() => {});
  }
  v.hlsSessionId = sessionId;
  v.sessionOffset = offset;
  protectSession(sessionId);
  startSessionPing(instanceId, sessionId);
  if (v.key === room.state.hostVariantKey) {
    // The room's own session stays the host's, so a fresh joiner and anything
    // that only knows about "the room's stream" still get the right answer.
    room.state.hlsSessionId = sessionId;
    room.state.sessionOffset = offset;
  }
}

/**
 * Put a client on a set of tracks, joining the stream that already serves them
 * or creating one if nobody has it.
 *
 * Joining rather than starting is the whole point of keying streams by their
 * tracks: a second person choosing the dub watches the first person's transcode
 * instead of asking Plex for an identical one.
 */
function assignVariant(
  room: Room,
  client: RoomClient,
  audioStreamId: number,
  subtitleStreamId: number,
): Variant {
  const key = variantKeyOf(audioStreamId, subtitleStreamId);
  const previousKey = client.variantKey;
  let v = room.state.variants.get(key);
  if (!v) {
    v = {
      key,
      audioStreamId,
      subtitleStreamId,
      hlsSessionId: null,
      // A fork inherits the room's clock and nothing else: the new transcode
      // starts where playback is, not where the stream it forked from began.
      sessionOffset: room.state.position,
      ownerUserId: client.userId,
      idleSince: null,
    };
    room.state.variants.set(key, v);
  }
  client.variantKey = key;
  ensureVariantOwner(room, v);

  if (previousKey && previousKey !== key) {
    const old = room.state.variants.get(previousKey);
    if (old) {
      if (membersOf(room, previousKey).length === 0) {
        destroyVariant(room, previousKey);
      } else {
        // The leaver may have been the one driving it. Only worth telling the
        // people still on it when that is what happened — their stream is
        // otherwise exactly as it was, and a re-announcement of it reads on the
        // client as a reason to rebuild.
        const before = old.ownerUserId;
        ensureVariantOwner(room, old);
        if (old.ownerUserId !== before) announceVariant(room, old);
      }
    }
  }
  return v;
}

/**
 * How far the room position may be advanced past its last report.
 *
 * The host heartbeats every 5s, so a gap much beyond that means it isn't
 * reporting — stalled, buffering, or gone — and the elapsed wall time no longer
 * describes playback. Extrapolating anyway sent a joiner to a position minutes
 * past anything transcoded: they seek into nothing, stall, and are then dragged
 * back by the next heartbeat. Past this bound the last confirmed position is
 * the more honest answer, and the next heartbeat corrects it within seconds.
 */
const MAX_EXTRAPOLATION_S = 30;

/**
 * How long a stream is held for someone who has stepped out of the player.
 *
 * Leaving the player is not leaving the room: people come out to browse the
 * queue or check what else is on, and going back in used to cost a whole fresh
 * transcode — ten to fifteen seconds of loading for something that had been
 * running seconds earlier. The stream is kept so the walk back is instant.
 *
 * Bounded, because "kept" would otherwise mean "forever": somebody who wanders
 * off leaves a transcode running on the server for the rest of the evening. Long
 * enough to cover any real detour, short enough that a forgotten tab costs a few
 * minutes of CPU rather than a night of it.
 */
const IDLE_STREAM_GRACE_MS = 5 * 60 * 1000;

/**
 * A playback position from a client message, or the fallback if it is unusable.
 *
 * `msg.position ?? state.position` was not enough: `??` only rejects null and
 * undefined, so NaN, Infinity, a negative number and a string all passed
 * straight into room state — and room state is broadcast to everyone. One
 * malformed message from any client with transport rights poisoned the position
 * for the whole room, and NaN in particular propagates through every later
 * interpolation and drift check.
 */
function safePosition(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Longest queue the server will hold. The client can only add one at a time;
 *  this bounds a malformed or hostile `queue-reorder`, which replaces the lot. */
const MAX_QUEUE = 100;

/**
 * Rebuild a queue entry from scratch, keeping only known fields at sane sizes.
 *
 * The queue is echoed to every client, so an unvalidated object here is a
 * broadcast of whatever was sent — the same reasoning that already applies to
 * "suggest". Returns null when the entry can't be trusted at all.
 */
function sanitizeQueueItem(raw: unknown): QueueItem | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown, max: number) =>
    typeof v === "string" && v.length <= max ? v : undefined;
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;

  const ratingKey = str(o.ratingKey, 50);
  const title = str(o.title, 500);
  if (!ratingKey || !title) return null;

  return {
    ratingKey,
    title,
    type: str(o.type, 30) ?? "movie",
    thumb: str(o.thumb, 500) ?? null,
    subtitles: Boolean(o.subtitles),
    parentTitle: str(o.parentTitle, 500),
    showTitle: str(o.showTitle, 500),
    parentIndex: num(o.parentIndex),
    index: num(o.index),
    year: num(o.year),
  };
}

function interpolatedPosition(state: RoomState): number {
  if (!state.playing) return state.position;
  // Nothing is known to be playing at `position` yet — see positionConfirmed.
  // Running the clock through a load the host hasn't finished is how the room
  // ends up permanently ahead of the person it is supposed to be following.
  if (!state.positionConfirmed) return state.position;
  const elapsed = (Date.now() - state.updatedAt) / 1000;
  if (elapsed > MAX_EXTRAPOLATION_S) return state.position;
  return state.position + Math.max(0, elapsed);
}

/**
 * Shortest gap between two *forced* history writes for the same room.
 *
 * Forcing bypasses the history service's own throttle, which is right for the
 * final position of a watch and wrong as a response to every transport command:
 * pause, seek and stop each force one, and a co-host holding the scrub bar (or a
 * client sending seeks in a loop) turned that into a SQLite write per message.
 * Teardown paths pass `always` so the last position is still never lost.
 */
const FORCED_PERSIST_MIN_INTERVAL_MS = 2_000;

/**
 * Save the room's position for everyone who is actually watching.
 *
 * The host's playhead is still the single room timeline, but every unique
 * Discord user with the player open gets that progress in their own history.
 * `extraUserId` preserves the departing host's final position after their
 * socket has already been removed from room.clients.
 *
 * Unforced calls are throttled inside the history service; pause, seek, stop and
 * disconnect force a write so the final position always lands. Fire-and-forget:
 * a history failure must never interfere with playback.
 */
function persistProgress(
  room: Room,
  extraUserId: string | undefined,
  force: boolean | "always",
): void {
  const ratingKey = room.state.ratingKey;
  if (!ratingKey) return;
  let forced = force !== false;
  if (force === true) {
    const now = Date.now();
    if (now - room.lastForcedPersistAt < FORCED_PERSIST_MIN_INTERVAL_MS) forced = false;
    else room.lastForcedPersistAt = now;
  } else if (force === "always") {
    room.lastForcedPersistAt = Date.now();
  }
  const userIds = new Set(
    [...room.clients].filter((c) => c.isWatching).map((c) => c.userId),
  );
  if (extraUserId) userIds.add(extraUserId);
  const state = room.state.playing ? "playing" : "paused";
  for (const userId of userIds) {
    recordProgress(userId, ratingKey, interpolatedPosition(room.state), { force: forced })
      .then((entry) => {
        if (!entry) return;
        return pushProgressToPlex(userId, entry, state, forced).catch((err) => {
          console.warn("[Plex Account] Live progress sync failed for", userId.substring(0, 8), err);
        });
      })
      .catch((err) => console.error("[History] Failed to record progress:", err));
  }
}

/**
 * Where the room actually is, for a transport command that carries a position
 * from someone who is not the host.
 *
 * A co-host's `position` is *their* playhead, which is not the room's. It lags
 * by whatever their buffer is behind, and if their stream has stalled it can lag
 * by minutes. Writing it into room state broadcast that number to everyone: a
 * co-host pressing pause dragged every viewer backwards to wherever the co-host
 * happened to be, and the host's next heartbeat then dragged them forward again.
 * That is the "it jumped back in time" report, and the yo-yo after it.
 *
 * A *seek* is different and keeps the sender's number — it is a deliberate
 * target, not an observation. Only pause and resume, which are about *whether*
 * rather than *where*, fall back to the room's own interpolated position.
 */
function positionForCommand(
  room: Room,
  client: RoomClient,
  raw: unknown,
): number {
  if (client.isHost) return safePosition(raw, room.state.position);
  return interpolatedPosition(room.state);
}

export function attachWebSocketServer(server: Server): void {
  wss = new WebSocketServer({ noServer: true });

  // Dedicated WSS for the P2P tracker — keeps tracker traffic isolated
  trackerWss = new WebSocketServer({ noServer: true });
  createTracker();

  trackerWss.on("connection", (ws) => {
    handleTrackerSocket(ws);
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname === "/tracker") {
      const token = url.searchParams.get("token");
      if (!token || !isValidSession(token)) {
        socket.destroy();
        return;
      }
      trackerWss!.handleUpgrade(req, socket, head, (ws) => {
        trackerWss!.emit("connection", ws, req);
      });
      return;
    }
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    // Validate session token at upgrade time (mirrors /tracker auth).
    // The join message also validates, but rejecting early avoids allocating
    // a WebSocket for unauthenticated connections.
    const wsToken = url.searchParams.get("token");
    if (!wsToken || !isValidSession(wsToken)) {
      socket.destroy();
      return;
    }
    wss!.handleUpgrade(req, socket, head, (ws) => {
      wss!.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    let client: RoomClient | null = null;
    let roomId: string | null = null;

    let alive = true;

    // Per-connection message budget.
    //
    // Nothing bounded how fast one client could send, and the handlers behind
    // this are not free: a seek writes to SQLite and broadcasts to the whole
    // room, a queue-reorder rebuilds and re-broadcasts up to 100 items. One
    // authenticated client in a loop was enough to saturate a room's traffic
    // and the history database with it. Real use is nowhere near this — a
    // heartbeat every 5s, and a burst of scrub commands at worst — so the
    // budget is generous and only a machine will ever reach it.
    let msgTokens = MSG_BUDGET;
    let msgWindowAt = Date.now();
    let throttleLoggedAt = 0;
    const withinBudget = (): boolean => {
      const now = Date.now();
      const elapsed = now - msgWindowAt;
      if (elapsed >= MSG_WINDOW_MS) {
        msgWindowAt = now;
        msgTokens = MSG_BUDGET;
      }
      if (msgTokens > 0) {
        msgTokens--;
        return true;
      }
      if (now - throttleLoggedAt > 10_000) {
        throttleLoggedAt = now;
        logEvent("Sync", "client exceeded message budget, dropping", {
          user: client?.userId ?? "unauthenticated",
          room: roomId?.substring(0, 8) ?? "none",
          budget: MSG_BUDGET,
          windowMs: MSG_WINDOW_MS,
        });
      }
      return false;
    };

    const pingTimer = setInterval(() => {
      if (!alive) {
        console.log("[Sync] Terminating unresponsive WebSocket",
          client?.userId?.substring(0, 8) ?? "(unauthenticated)");
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, WS_PING_INTERVAL_MS);

    ws.on("pong", () => {
      alive = true;
    });

    const handleMessage = (raw: RawData) => {
      if (!withinBudget()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // JSON.parse succeeds on `null`, `5` and `"hi"` as readily as on an
      // object. Reading `.type` off the first of those throws a TypeError —
      // which, before the wrapper below, meant any authenticated client could
      // end the whole server (and every watch party on it) by sending the four
      // characters `null`.
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const msg = parsed as Record<string, unknown>;

      const type = typeof msg.type === "string" ? msg.type : "";

      // First message must be join
      if (type === "join") {
        // Typed rather than asserted: everything below indexes maps and slices
        // strings with these, and a non-string that happened to survive the
        // truthiness check would throw inside the handler rather than be
        // refused here.
        const token = typeof msg.sessionToken === "string" ? msg.sessionToken : "";
        const instanceId = typeof msg.instanceId === "string" ? msg.instanceId : "";
        const userId = typeof msg.userId === "string" ? msg.userId : "";
        const rawUsername = msg.username;
        const username =
          typeof rawUsername === "string" && rawUsername.length > 0 && rawUsername.length <= 100
            ? rawUsername
            : null;

        if (!token || !instanceId || !userId) {
          sendTo(ws, { type: "error", message: "Missing join fields" });
          ws.close(1008, "Missing join fields");
          return;
        }

        if (!isValidSession(token)) {
          sendTo(ws, { type: "error", message: "Invalid session" });
          ws.close(1008, "Invalid session");
          return;
        }

        // Verify userId matches the authenticated Discord identity
        const verifiedUserId = getSessionUserId(token);
        if (!verifiedUserId || verifiedUserId !== userId) {
          sendTo(ws, { type: "error", message: "userId mismatch" });
          ws.close(1008, "userId mismatch");
          return;
        }

        const instance = instanceHosts.get(instanceId);
        if (!instance) {
          sendTo(ws, { type: "error", message: "Unknown instance" });
          ws.close(1008, "Unknown instance");
          return;
        }

        // Someone is using this instance, so it isn't stale. Without this the
        // 24h TTL counted from first registration and reaped live parties.
        touchInstance(instanceId);

        const isHost = instance.hostUserId === userId;
        const room = getOrCreateRoom(instanceId);

        // Evict stale connection from the same user (e.g. browser reconnected
        // before Node processed the close event for the old socket)
        for (const existing of room.clients) {
          if (existing.userId === userId) {
            existing.isHost = false; // prevent close handler from triggering host-left logic
            room.clients.delete(existing);
            existing.ws.close(1000, "Replaced by new connection");
            break;
          }
        }

        // Roles are restored from the room, not defaulted: see Room.coHostIds.
        // Host supersedes co-host, so the two are never both set.
        client = {
          ws,
          userId,
          username,
          isHost,
          isCoHost: !isHost && room.coHostIds.has(userId),
          // Assume not watching until the client says otherwise. It sends
          // "watching" as soon as the player mounts, which for someone joining
          // a live room is immediately after this.
          isWatching: false,
          joinedAt: Date.now(),
          // A joiner watches what the host watches. Choosing otherwise is a
          // deliberate act ("set-tracks"), never the starting position.
          variantKey: room.state.hostVariantKey,
        };
        roomId = instanceId;
        room.clients.add(client);

        // If the host is (re)joining and there are other clients, clear their disconnect banner
        // and refresh their view of who the host is (covers host reconnecting on a new device,
        // or joining after other clients already have a stale/missing hostUsername).
        if (isHost && room.clients.size > 1) {
          broadcast(room, ws, { type: "host-reconnected" });
          broadcast(room, ws, { type: "host-info", hostUsername: username });
        }

        // Send current state to newly joined client
        const hostClient = [...room.clients].find((c) => c.isHost);
        sendTo(ws, {
          type: "state",
          ratingKey: room.state.ratingKey,
          title: room.state.title,
          subtitles: room.state.subtitles,
          playing: room.state.playing,
          position: interpolatedPosition(room.state),
          hlsSessionId: room.state.hlsSessionId,
          sessionOffset: room.state.sessionOffset,
          lastCommandAt: room.state.updatedAt,
          browseContext: room.state.browseContext,
          queue: room.state.queue,
          hostUsername: hostClient?.username ?? null,
          participants: participantsOf(room),
          // Which stream to play and which tracks it is for. Null when nothing
          // is playing; an older client ignores it and behaves exactly as before.
          variant: room.state.hostVariantKey
            ? variantMessage(
                room.state.variants.get(room.state.hostVariantKey)!,
                // A joiner never drives the host's stream — the host does.
                false,
              )
            : null,
        });

        // Everyone else needs to see the new arrival in their roster
        broadcastParticipants(room);

        return;
      }

      // All subsequent messages require a joined client
      if (!client || !roomId) {
        sendTo(ws, { type: "error", message: "Must join first" });
        return;
      }

      const room = rooms.get(roomId);
      if (!room) return;

      // Am I in the player? Allowed for anyone, and deliberately not part of
      // the roster broadcast — it exists to order host succession, and pushing
      // a roster update every time somebody opened or closed the player would
      // be a lot of traffic for something nobody sees.
      if (type === "watching") {
        client.isWatching = msg.value !== false;
        // Back in the player: whatever countdown was running on their stream
        // stops. See IDLE_STREAM_GRACE_MS.
        if (client.isWatching && client.variantKey) {
          const v = room.state.variants.get(client.variantKey);
          if (v) v.idleSince = null;
        }
        return;
      }

      /**
       * "I want these tracks."
       *
       * Allowed for anyone, because it no longer speaks for the room: it moves
       * the sender onto the stream that serves those tracks, starting one only
       * if nobody has it. The host is the exception, and only in scope — their
       * change carries to everyone watching *their* stream, which is what makes
       * the host's choice the room's default without making it a decree. A
       * co-host's change moves the co-host and nobody else.
       */
      if (type === "set-tracks") {
        const audioStreamId = trackId(msg.audioStreamId);
        const subtitleStreamId = trackId(msg.subtitleStreamId);
        if (audioStreamId === null || subtitleStreamId === null) return;
        if (!room.state.ratingKey) return;

        const targetKey = variantKeyOf(audioStreamId, subtitleStreamId);
        const hostKey = room.state.hostVariantKey;
        // The host takes their audience with them; everyone else moves alone.
        const movers =
          client.isHost && hostKey ? membersOf(room, hostKey) : [client];
        if (!movers.includes(client)) movers.push(client);
        if (movers.every((m) => m.variantKey === targetKey)) return;

        const fromKey = client.variantKey;
        for (const m of movers) assignVariant(room, m, audioStreamId, subtitleStreamId);
        const target = room.state.variants.get(targetKey)!;

        if (client.isHost) {
          room.state.hostVariantKey = targetKey;
          room.state.subtitles = subtitleStreamId !== 0;
          if (target.hlsSessionId) {
            room.state.hlsSessionId = target.hlsSessionId;
            room.state.sessionOffset = target.sessionOffset;
          }
        }

        logEvent("Sync", "tracks changed", {
          room: roomId.substring(0, 8),
          by: client.username ?? client.userId,
          role: client.isHost ? "host" : client.isCoHost ? "cohost" : "viewer",
          from: fromKey ?? "none",
          to: targetKey,
          moved: movers.length,
          joinedExisting: target.hlsSessionId !== null,
          streams: room.state.variants.size,
        });

        announceVariant(room, target);
        return;
      }

      /**
       * "Put me back on whatever the host is watching."
       *
       * The tracks are the host's, and only the server knows what they are — a
       * client is told its own stream and nobody else's. Offered when someone's
       * own stream can't keep up: the host's is, by definition, already running,
       * so joining it costs nothing and starts nothing.
       */
      if (type === "rejoin-host") {
        const hostKey = room.state.hostVariantKey;
        if (!hostKey || client.variantKey === hostKey) return;
        const hostVariant = room.state.variants.get(hostKey);
        if (!hostVariant) return;
        const from = client.variantKey;
        assignVariant(room, client, hostVariant.audioStreamId, hostVariant.subtitleStreamId);
        logEvent("Sync", "client rejoined the host's stream", {
          room: roomId.substring(0, 8),
          who: client.username ?? client.userId,
          from: from ?? "none",
          to: hostKey,
        });
        // Only the client that moved. Nothing changed for the people already on
        // this stream, and a re-announcement of a stream they are already
        // playing is noise they have to reason about.
        sendTo(client.ws, variantMessage(hostVariant, hostVariant.ownerUserId === client.userId));
        return;
      }

      /**
       * A stream's driver reporting the transcode it just brought up.
       *
       * Sent on every start and restart of a stream that isn't the host's
       * opening one (which arrives as "play"), so the people following it can
       * move onto the new session rather than fetching segments from a
       * transcode that no longer exists.
       */
      if (type === "variant-session") {
        const key = client.variantKey;
        if (!key) return;
        const v = room.state.variants.get(key);
        // Only the driver may repoint a stream. Anyone else claiming to have
        // started one is either confused or malicious, and the cost of
        // believing them is everybody on that stream losing their picture.
        if (!v || v.ownerUserId !== client.userId) return;
        const sid =
          typeof msg.hlsSessionId === "string" && UUID_RE.test(msg.hlsSessionId)
            ? msg.hlsSessionId
            : null;
        if (!sid) return;
        const offset = safePosition(msg.sessionOffset, room.state.position);
        attachSession(room, v, sid, offset, roomId);
        logEvent("Sync", "stream restarted", {
          room: roomId.substring(0, 8),
          by: client.username ?? client.userId,
          variant: key,
          session: sid.substring(0, 8),
          offsetS: offset,
        });
        announceVariant(room, v);
        return;
      }

      // Viewer → host: suggest a title. Allowed for any joined client (host
      // or viewer), unlike the rest of the control messages below.
      if (type === "suggest") {
        const item = msg.item as
          | {
              ratingKey?: string; title?: string; type?: string; thumb?: string | null;
              year?: number; showTitle?: string; parentTitle?: string;
              parentIndex?: number; index?: number;
            }
          | undefined;
        if (!item || typeof item.ratingKey !== "string" || typeof item.title !== "string") return;
        if (item.ratingKey.length > 50 || item.title.length > 500) return;

        // Whitelisted rebuild, so nothing the client sends reaches the host
        // unvalidated. The episode fields are carried so the host can tell which
        // show a suggested episode belongs to.
        const str = (v: unknown, max: number) =>
          typeof v === "string" && v.length <= max ? v : undefined;
        const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

        const suggestion = {
          ratingKey: item.ratingKey,
          title: item.title,
          type: typeof item.type === "string" ? item.type : "movie",
          thumb: typeof item.thumb === "string" ? item.thumb : null,
          year: num(item.year),
          showTitle: str(item.showTitle, 500),
          parentTitle: str(item.parentTitle, 500),
          parentIndex: num(item.parentIndex),
          index: num(item.index),
          fromUsername: client.username ?? "Someone",
        };
        for (const c of room.clients) {
          if (c.isHost) {
            sendTo(c.ws, { type: "suggestion", item: suggestion });
          }
        }
        return;
      }

      // Remaining messages are host-only, except that a co-host may also send
      // transport commands. This is the single authority for control rights —
      // client-side gating is UX only and must never be trusted.
      if (!client.isHost && !(client.isCoHost && CO_HOST_ALLOWED_TYPES.has(type))) return;

      // Every transport command, with the position the sender attached *and* the
      // room's current one. A command whose position lags the room is the exact
      // shape of the bug where a stale value reached the host and restarted its
      // transcode — invisible unless both numbers are recorded side by side.
      if (type === "play" || type === "pause" || type === "resume" || type === "seek" || type === "stop") {
        const sent = typeof msg.position === "number" ? msg.position : null;
        logEvent("Sync", `command ${type}`, {
          room: roomId.substring(0, 8),
          from: client.username ?? client.userId ?? "?",
          role: client.isHost ? "host" : client.isCoHost ? "cohost" : "viewer",
          sentPosS: sent === null ? "none" : sent,
          roomPosS: room.state.position,
          driftS: sent === null ? "n/a" : sent - room.state.position,
          roomPlaying: room.state.playing,
          session: room.state.hlsSessionId?.substring(0, 8) ?? "none",
        });
      }

      switch (type) {
        case "play": {
          // The transcode may start at an offset — resuming from watch history,
          // or a seek that needed a restart. Carrying it here means viewers
          // joining on this announcement land at the right place immediately
          // instead of starting at 0:00 until the next heartbeat corrects them.
          const startPosition =
            typeof msg.position === "number" && Number.isFinite(msg.position) && msg.position > 0
              ? msg.position
              : 0;
          // Validated like every other handler in this file. It's host-only
          // so this isn't an escalation, but the title is echoed to the whole
          // room and hlsSessionId ends up in a Plex query parameter, and this
          // was the one place taking either on trust.
          //
          // A malformed message is DROPPED rather than applied with nulls.
          // Writing null into room state here is indistinguishable from a stop:
          // it clears what everyone is watching and broadcasts a "play" with
          // nothing to play, which is a worse outcome than ignoring the message
          // and leaving the room exactly as it was.
          const rk = typeof msg.ratingKey === "string" && /^\d+$/.test(msg.ratingKey)
            ? msg.ratingKey : null;
          const itemChanged = rk !== room.state.ratingKey;
          // Captured before `playing` is overwritten below — a restart is only a
          // restart if the room was already running this title.
          const wasPlaying = room.state.playing;
          const sid = typeof msg.hlsSessionId === "string" && UUID_RE.test(msg.hlsSessionId)
            ? msg.hlsSessionId : null;
          if (!rk || !sid) {
            logEvent("Sync", "ignoring malformed play", {
              room: roomId.substring(0, 8),
              from: client.username ?? client.userId,
              badRatingKey: !rk,
              badSessionId: !sid,
            });
            break;
          }
          room.state.ratingKey = rk;
          room.state.title =
            typeof msg.title === "string" ? msg.title.slice(0, 500) : null;
          room.state.subtitles = Boolean(msg.subtitles);
          room.state.hlsSessionId = sid;
          room.state.playing = true;
          // A restart of something the room is already watching must not move
          // the clock. `startPosition` is where the restarting client was when
          // it *began* loading, seconds ago — writing it back rewinds everyone
          // else by the length of that load, which is the whole reason a track
          // change used to cost the room five seconds. Re-anchoring on the
          // clock's own current value keeps it running across the gap.
          //
          // A different title, or a room that wasn't playing, is a real start
          // and does set the clock.
          const restartOfLiveItem = !itemChanged && wasPlaying;
          room.state.position = restartOfLiveItem
            ? interpolatedPosition(room.state)
            : startPosition;
          // A restart carries the clock forward, so whatever confirmed it still
          // does. A genuine start is only a request: `startPosition` is where a
          // transcode was asked to begin, and no frame of it exists yet. The
          // host's first heartbeat confirms it, within five seconds.
          room.state.positionConfirmed = restartOfLiveItem && room.state.positionConfirmed;
          // Where Plex was asked to start transcoding. Usually the same as the
          // position, and deliberately a separate field because it isn't when a
          // host re-announces a session it has already played some of: the room
          // should land on the playhead, but nothing below the *offset* exists
          // to seek to. Everyone who joins or inherits this session needs the
          // latter — see RoomState.sessionOffset.
          room.state.sessionOffset =
            typeof msg.sessionOffset === "number" &&
            Number.isFinite(msg.sessionOffset) &&
            msg.sessionOffset >= 0
              ? msg.sessionOffset
              : startPosition;
          room.state.updatedAt = Date.now();
          room.state.browseContext = null;

          // A different title replaces every stream the room was running; the
          // same title is the host restarting its own (a seek that needed a new
          // transcode), and must leave everyone else's alone.
          if (itemChanged) destroyAllVariants(room);

          const audioStreamId = trackId(msg.audioStreamId) ?? 0;
          const subtitleStreamId = trackId(msg.subtitleStreamId) ?? 0;
          const hostKey = variantKeyOf(audioStreamId, subtitleStreamId);
          let hostVariant = room.state.variants.get(hostKey);
          if (!hostVariant) {
            hostVariant = {
              key: hostKey,
              audioStreamId,
              subtitleStreamId,
              hlsSessionId: null,
              sessionOffset: room.state.sessionOffset,
              ownerUserId: client.userId,
              idleSince: null,
            };
            room.state.variants.set(hostKey, hostVariant);
          }
          hostVariant.ownerUserId = client.userId;
          client.variantKey = hostKey;
          room.state.hostVariantKey = hostKey;
          if (itemChanged) {
            // Everyone lands on the host's stream for a new title, whatever
            // they were listening to during the last one.
            for (const c of room.clients) c.variantKey = hostKey;
          }
          attachSession(room, hostVariant, sid, room.state.sessionOffset, roomId);

          broadcast(room, ws, {
            type: "play",
            ratingKey: room.state.ratingKey,
            title: room.state.title,
            subtitles: room.state.subtitles,
            hlsSessionId: room.state.hlsSessionId,
            // The room's clock, which for a restart is unchanged — so nobody
            // acts on this beyond picking up the new session id.
            position: room.state.position,
            sessionOffset: room.state.sessionOffset,
          });
          // Everyone on the host's stream — which for a new title is everyone —
          // needs the session as well as the announcement.
          announceVariant(room, hostVariant);
          break;
        }
        case "pause": {
          room.state.playing = false;
          room.state.position = positionForCommand(room, client, msg.position);
          // Only the host's pause carries an observed playhead; a co-host's is
          // served from the room's own clock and so confirms nothing.
          if (client.isHost) room.state.positionConfirmed = true;
          room.state.updatedAt = Date.now();
          persistProgress(room, undefined, true);
          broadcast(room, ws, { type: "pause", position: room.state.position });
          break;
        }
        case "resume": {
          room.state.playing = true;
          room.state.position = positionForCommand(room, client, msg.position);
          if (client.isHost) room.state.positionConfirmed = true;
          room.state.updatedAt = Date.now();
          broadcast(room, ws, { type: "resume", position: room.state.position });
          break;
        }
        case "seek": {
          // The one command that keeps a non-host's number: a seek target is a
          // decision, not an observation. See positionForCommand.
          room.state.position = safePosition(msg.position, room.state.position);
          // A seek target is a decision about where the room is, so it is the
          // truth by construction — nothing has to observe it first.
          room.state.positionConfirmed = true;
          room.state.updatedAt = Date.now();
          persistProgress(room, undefined, true);
          broadcast(room, ws, { type: "seek", position: room.state.position });
          break;
        }
        case "play-item": {
          // A co-host asking the host to switch to a specific item — used for
          // both next and previous episode. Sent only to the host, not
          // broadcast: a request nobody else can act on has no business reaching
          // viewers (same reasoning as "suggest"). No room state changes here —
          // the host's follow-up "play" does that.
          const ratingKey = msg.ratingKey;
          if (typeof ratingKey !== "string" || ratingKey.length > 50 || !/^\d+$/.test(ratingKey)) break;
          for (const c of room.clients) {
            if (c.isHost) sendTo(c.ws, { type: "play-item", ratingKey });
          }
          break;
        }
        case "stop": {
          // Save where we got to before the state is torn down — this is the
          // moment most resumes are created from. "always", because this is a
          // teardown and the final position must not lose to the forced-write
          // floor after a pause a moment earlier.
          persistProgress(room, undefined, "always");
          // Capture before clearing so we can kill the exact Plex transcode.
          // Every other stream the room was running goes with it — see
          // destroyAllVariants below.
          const stoppingSessionId = room.state.hlsSessionId;
          for (const c of room.clients) c.variantKey = null;
          destroyAllVariants(room);
          room.state.ratingKey = null;
          room.state.title = null;
          room.state.hlsSessionId = null;
          room.state.sessionOffset = 0;
          room.state.playing = false;
          room.state.position = 0;
          room.state.updatedAt = Date.now();
          // The queue deliberately survives.
          //
          // It used to be cleared here, which discarded everything the room had
          // lined up the moment one title ended — and the host never saw it
          // happen, because the server excludes the sender from its own
          // broadcast: their panel still listed items the server had already
          // thrown away. A queue is what to watch *next*; finishing the current
          // thing is the moment it matters most.
          broadcast(room, ws, { type: "stop" });
          // Kill the Plex transcode server-side so it dies even if viewers
          // are still fetching segments (their hls.js takes a moment to tear down)
          if (stoppingSessionId) {
            killPlexTranscode(stoppingSessionId).catch(() => {});
          }
          break;
        }
        case "heartbeat": {
          if (!room.state.ratingKey) break;
          /**
           * The room's position is the host's playhead, in both directions.
           *
           * Only the host heartbeats, and the host is not a client the room is
           * checking up on — it is the thing everyone else is watching. So a
           * report that is *behind* is not a client falling behind the room, it
           * is the room being wrong.
           *
           * This was once second-guessed: reports more than a few seconds
           * behind were discarded, on the theory that a client mid-load
           * shouldn't drag everybody back. The theory was right and the subject
           * was wrong — the client mid-load is never the one heartbeating,
           * because the heartbeat is gated on the element having media. What it
           * discarded instead was the host having stalled, and every stall then
           * became a permanent gap between the host and the room. One session
           * logged the room sitting exactly 12.73s ahead of its own host for
           * the length of a film, with a viewer who switched subtitles landing
           * neatly on the clock and therefore 12.73s ahead of the host too.
           *
           * A host mid-restart doesn't reach here at all: it has no media, so it
           * sends nothing, and the clock free-runs across the gap — which is the
           * case that rule was reaching for, and it is handled where it belongs,
           * by the restarting client landing on the clock once its manifest is
           * ready.
           */
          const reported = safePosition(msg.position, room.state.position);
          // Silent while playback is ordinary — the room and the host agree to
          // within the half-second of network between them. A gap this size is
          // the host having restarted, stalled or seeked, and it is the first
          // thing worth knowing when the evening goes wrong.
          const gap = reported - interpolatedPosition(room.state);
          if (Math.abs(gap) > 5) {
            logEvent("Sync", "room moving to meet the host", {
              room: roomId.substring(0, 8),
              from: client.username ?? client.userId,
              byS: Number(gap.toFixed(2)),
              toS: Number(reported.toFixed(2)),
            });
          }
          room.state.position = reported;
          room.state.positionConfirmed = true;
          room.state.playing = msg.playing !== false;
          room.state.updatedAt = Date.now();
          // Throttled inside the history service — this fires every 5s per room.
          persistProgress(room, undefined, false);
          broadcast(room, ws, {
            type: "heartbeat",
            position: room.state.position,
            playing: room.state.playing,
            // Carry the "what's playing" snapshot so a viewer whose ratingKey
            // got cleared (e.g. a stray stop during a host handoff) can self-heal
            // from the next heartbeat instead of being stuck with no way to rejoin.
            ratingKey: room.state.ratingKey,
            title: room.state.title,
            subtitles: room.state.subtitles,
            hlsSessionId: room.state.hlsSessionId,
            sessionOffset: room.state.sessionOffset,
          });
          break;
        }
        case "browse": {
          // Broadcast verbatim to every client, so it gets the same length cap
          // as every other free-text field that crosses the room.
          room.state.browseContext =
            typeof msg.context === "string" && msg.context.length <= 300 ? msg.context : null;
          broadcast(room, ws, { type: "browse", context: room.state.browseContext });
          break;
        }
        // Every queue mutation answers with the server's copy, to everyone
        // including the sender — the sender most of all. A rejected item (bad
        // shape, duplicate, queue full) used to produce no reply at all, so a
        // client that had already drawn it optimistically kept showing an entry
        // the server never accepted.
        case "queue-add": {
          const item = sanitizeQueueItem(msg.item);
          if (item) {
            // Prevent duplicate items in the queue
            const alreadyQueued = room.state.queue.some((q) => q.ratingKey === item.ratingKey);
            if (!alreadyQueued && room.state.queue.length < MAX_QUEUE) {
              room.state.queue.push(item);
            }
          }
          sendToAll(room, { type: "queue-updated", queue: room.state.queue });
          break;
        }
        case "queue-remove": {
          const ratingKey = typeof msg.ratingKey === "string" ? msg.ratingKey : "";
          if (!ratingKey) break;
          room.state.queue = room.state.queue.filter((q) => q.ratingKey !== ratingKey);
          sendToAll(room, { type: "queue-updated", queue: room.state.queue });
          break;
        }
        case "queue-clear": {
          room.state.queue = [];
          sendToAll(room, { type: "queue-updated", queue: room.state.queue });
          break;
        }
        case "queue-reorder": {
          // Rebuilt rather than trusted: this replaces the whole queue, so an
          // unchecked array is an arbitrary payload echoed to every client.
          room.state.queue = Array.isArray(msg.queue)
            ? msg.queue
                .slice(0, MAX_QUEUE)
                .map(sanitizeQueueItem)
                .filter((q): q is QueueItem => q !== null)
            : [];
          sendToAll(room, { type: "queue-updated", queue: room.state.queue });
          break;
        }
        case "promote-host": {
          // Host only — a co-host must never be able to seize or reassign the role.
          if (!client.isHost) break;
          const targetId = msg.userId as string;
          const target = [...room.clients].find((c) => c.userId === targetId);
          if (!target || target === client) break;

          // Bank the outgoing host's position before the roles swap. Their
          // close handler won't do it — by then `isHost` is false, so the
          // branch that persists progress is skipped and the watch they were
          // in the middle of would resume from wherever they last happened to
          // be written, or not at all.
          persistProgress(room, undefined, "always");

          // Hand over: the old host drops to a plain viewer, and the target
          // clears any co-host flag since host already supersedes it.
          client.isHost = false;
          client.isCoHost = false;
          target.isHost = true;
          target.isCoHost = false;
          // Host outranks co-host, so the grant is spent rather than remembered
          // — otherwise handing the role back would silently restore it.
          room.coHostIds.delete(target.userId);

          // "The host's stream" follows the host. Without this the room went on
          // treating the *previous* host's stream as the one a host track change
          // carries to, so the new host's next change reached straight into an
          // audience they had nothing to do with — while leaving the people
          // actually watching with them untouched.
          if (target.variantKey) {
            room.state.hostVariantKey = target.variantKey;
            const hv = room.state.variants.get(target.variantKey);
            if (hv) {
              room.state.subtitles = hv.subtitleStreamId !== 0;
              if (hv.hlsSessionId) {
                room.state.hlsSessionId = hv.hlsSessionId;
                room.state.sessionOffset = hv.sessionOffset;
              }
            }
          }

          const instance = instanceHosts.get(roomId);
          if (instance) instance.hostUserId = target.userId;
          updateInstanceHost(roomId, target.userId);

          // Handover is a prime suspect for a stream dying: the promoted client
          // adopts a transcode it didn't start, and its idea of the position
          // comes from room state rather than its own playhead.
          logEvent("Sync", "host transferred", {
            room: roomId.substring(0, 8),
            from: client.username ?? client.userId,
            to: target.username ?? target.userId,
            roomPosS: room.state.position,
            session: room.state.hlsSessionId?.substring(0, 8) ?? "none",
          });

          sendTo(target.ws, { type: "host-promoted", hostUsername: target.username });
          for (const c of room.clients) {
            if (c !== target) sendTo(c.ws, { type: "host-changed", hostUsername: target.username });
          }
          broadcastParticipants(room);
          break;
        }
        case "set-cohost": {
          if (!client.isHost) break;
          const targetId = typeof msg.userId === "string" ? msg.userId : "";
          const target = [...room.clients].find((c) => c.userId === targetId);
          // The host is already above co-host, so toggling it on themself is a no-op.
          if (!target || target.isHost) break;

          const value = Boolean(msg.value);
          // Recorded on the room as well as the connection, so the grant
          // survives the socket — see Room.coHostIds.
          if (value) {
            if (room.coHostIds.size >= MAX_CO_HOSTS && !room.coHostIds.has(targetId)) break;
            room.coHostIds.add(targetId);
          } else {
            room.coHostIds.delete(targetId);
          }
          target.isCoHost = value;
          sendTo(target.ws, { type: "cohost-changed", isCoHost: target.isCoHost });
          broadcastParticipants(room);
          break;
        }
        case "suggest-dismiss": {
          // Suggestions aren't persisted in room state (ephemeral, host-only) —
          // just echo back to the host so their client can drop it from the list.
          const ratingKey = msg.ratingKey as string;
          if (ratingKey) {
            sendTo(ws, { type: "suggestion-dismissed", ratingKey });
          }
          break;
        }
      }
    };

    /**
     * Nothing thrown while handling one client's message may be allowed to
     * reach the emitter.
     *
     * `ws` emits synchronously, so an exception in the handler above escapes as
     * an uncaughtException — and services/logger.ts deliberately rethrows those
     * to preserve Node's default crash behaviour. One malformed message, or one
     * socket dying at an awkward moment, would therefore take down every room
     * on the server rather than the one connection that caused it.
     */
    ws.on("message", (raw: RawData) => {
      try {
        handleMessage(raw);
      } catch (err) {
        logEvent("Sync", "message handler threw", {
          room: roomId?.substring(0, 8) ?? "none",
          user: client?.userId ?? "unauthenticated",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    ws.on("close", () => {
      clearInterval(pingTimer);
      if (!client || !roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;

      room.clients.delete(client);

      // The stream they were watching may now be empty, or may have just lost
      // the client that was driving it. Done before succession so the successor
      // is chosen against an accurate picture of who is on what.
      const leftVariantKey = client.variantKey;
      client.variantKey = null;
      if (leftVariantKey && room.clients.size > 0) {
        const left = room.state.variants.get(leftVariantKey);
        if (left) {
          if (membersOf(room, leftVariantKey).length === 0) {
            // Nobody is left watching it. Never the host's own stream while the
            // room lives on — a successor inherits that below.
            if (leftVariantKey !== room.state.hostVariantKey || !client.isHost) {
              destroyVariant(room, leftVariantKey);
            }
          } else if (left.ownerUserId === client.userId) {
            ensureVariantOwner(room, left);
            announceVariant(room, left);
            logEvent("Sync", "stream driver left, promoting a watcher", {
              room: roomId.substring(0, 8),
              variant: leftVariantKey,
              to: left.ownerUserId ?? "none",
            });
          }
        }
      }

      if (client.isHost) {
        // Attribute the position to the host who is leaving, before a successor
        // takes over the instance record. Closing the tab is the other common
        // way a watch ends, so this is as important as the explicit stop path.
        persistProgress(room, client.isWatching ? client.userId : undefined, "always");

        if (room.clients.size > 0) {
          // Co-host, then whoever is actually watching, then anyone — see
          // pickSuccessor.
          // Same stream first, then co-host, then whoever is watching — see
          // pickSuccessor. The outgoing host's stream is the one to match,
          // since that is what the room is mostly on.
          const newHost = pickSuccessor(room.clients, leftVariantKey)!;
          newHost.isHost = true;
          newHost.isCoHost = false;
          room.coHostIds.delete(newHost.userId);

          // "The host's stream" is by definition the one the host is watching.
          // A successor who was on another stream keeps it, and nobody is moved
          // to join them: their tracks are their own choice, and reaching for
          // everyone else's picture on the way in would be the opposite of
          // inheriting the room.
          const inheritedKey = newHost.variantKey ?? leftVariantKey;
          if (inheritedKey) {
            room.state.hostVariantKey = inheritedKey;
            const hv = room.state.variants.get(inheritedKey);
            if (hv) {
              ensureVariantOwner(room, hv);
              if (hv.hlsSessionId) {
                room.state.hlsSessionId = hv.hlsSessionId;
                room.state.sessionOffset = hv.sessionOffset;
              }
              room.state.subtitles = hv.subtitleStreamId !== 0;
              announceVariant(room, hv);
            }
          }
          // The stream the outgoing host was driving, if they were the only one
          // on it and it isn't the one inherited above, has nobody left.
          if (leftVariantKey && leftVariantKey !== inheritedKey &&
              membersOf(room, leftVariantKey).length === 0) {
            destroyVariant(room, leftVariantKey);
          }

          const instance = instanceHosts.get(roomId);
          if (instance) {
            instance.hostUserId = newHost.userId;
          }
          updateInstanceHost(roomId, newHost.userId);

          logEvent("Sync", "host left, promoting successor", {
            room: roomId.substring(0, 8),
            left: client.username ?? client.userId,
            promoted: newHost.username ?? newHost.userId,
            // Which band they came from, so a surprising successor can be
            // explained rather than guessed at.
            because: newHost.variantKey === leftVariantKey ? "same-stream"
              : newHost.isCoHost ? "co-host"
              : newHost.isWatching ? "watching" : "only-candidate",
            variant: newHost.variantKey ?? "none",
            streams: room.state.variants.size,
            remaining: room.clients.size,
            roomPosS: room.state.position,
            session: room.state.hlsSessionId?.substring(0, 8) ?? "none",
          });

          sendTo(newHost.ws, { type: "host-promoted", hostUsername: newHost.username });

          for (const c of room.clients) {
            if (c !== newHost) {
              sendTo(c.ws, { type: "host-disconnected" });
              sendTo(c.ws, { type: "host-changed", hostUsername: newHost.username });
            }
          }
        } else {
          const disconnectedSessionId = room.state.hlsSessionId;
          logEvent("Sync", "last client left, killing transcode", {
            room: roomId.substring(0, 8),
            left: client.username ?? client.userId,
            session: disconnectedSessionId?.substring(0, 8) ?? "none",
            roomPosS: room.state.position,
          });
          room.state.playing = false;
          room.state.hlsSessionId = null;
          room.state.sessionOffset = 0;
          // Every stream, not only the host's — anyone watching in another
          // language had a transcode of their own, and it outlives them
          // otherwise.
          destroyAllVariants(room);
          killPlexTranscode(disconnectedSessionId).catch(() => {});
        }
      }

      if (room.clients.size === 0) {
        // Paired with rooms.delete everywhere, not just on the host's exit: a
        // duplicate-connection eviction clears isHost, so the last client out
        // isn't always flagged as one, and the interval then pinged Plex every
        // 30s for a room that no longer existed.
        destroyAllVariants(room);
        rooms.delete(roomId);
      } else {
        // Someone left — refresh everyone's roster
        broadcastParticipants(room);
      }
    });
  });

  // Cleanup rooms whose instance has expired every 5 minutes
  cleanupInterval = setInterval(() => {
    // Streams nobody has had open for a while. A variant survives its watchers
    // stepping out of the player on purpose — see IDLE_STREAM_GRACE_MS — but not
    // indefinitely.
    const now = Date.now();
    for (const [instanceId, room] of rooms) {
      for (const [key, variant] of [...room.state.variants]) {
        const members = membersOf(room, key);
        const watching = members.some((c) => c.isWatching);
        if (members.length === 0 || watching) {
          variant.idleSince = null;
          continue;
        }
        if (variant.idleSince === null) {
          variant.idleSince = now;
          continue;
        }
        if (now - variant.idleSince < IDLE_STREAM_GRACE_MS) continue;
        logEvent("Sync", "dropping a stream nobody came back to", {
          room: instanceId.substring(0, 8),
          variant: key,
          idleMinutes: Math.round((now - variant.idleSince) / 60000),
        });
        for (const c of members) c.variantKey = null;
        destroyVariant(room, key);
      }
    }
    for (const [instanceId, room] of rooms) {
      if (!instanceHosts.has(instanceId) && room.clients.size === 0) {
        // Same reasoning as the close handler: the intervals outlive the room
        // otherwise, pinging Plex for something that is gone.
        destroyAllVariants(room);
        rooms.delete(instanceId);
      }
    }
  }, 5 * 60 * 1000);
  cleanupInterval.unref();
}

export function closeWebSocketServer(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  if (wss) {
    for (const client of wss.clients) {
      client.close(1001, "Server shutting down");
    }
    wss.close();
    wss = null;
  }
  if (trackerWss) {
    for (const client of trackerWss.clients) {
      client.close(1001, "Server shutting down");
    }
    trackerWss.close();
    trackerWss = null;
  }
  destroyTracker();
  for (const sessionId of [...sessionPingIntervals.keys()]) {
    stopSessionPing(sessionId);
  }
  rooms.clear();
}
