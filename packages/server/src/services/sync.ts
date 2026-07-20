import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Server } from "http";
import { isValidSession, getSessionUserId } from "../middleware/auth.js";
import { instanceHosts, updateInstanceHost } from "../routes/discord.js";
import { plexFetch } from "./plex.js";
import { getPlexTranscodeKey, getSessionClientId, getSessionRatingKey, markTranscodeStopped, notifyPlexStopped, isSessionStopping, markSessionStopping, clearSessionStopping, terminatePlexSession, pingPlexTranscode } from "../routes/plex.js";
import { createTracker, handleTrackerSocket, destroyTracker } from "./tracker.js";

/** Interval between WebSocket pings to detect dead connections. */
const WS_PING_INTERVAL_MS = 30_000;

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
    const stopKey = plexKey || hlsSessionId;

    try {
      const res = await plexFetch(
        "/video/:/transcode/universal/stop",
        { transcodeSessionId: stopKey },
        {
          "X-Plex-Session-Identifier": stopKey,
          "X-Plex-Client-Identifier": clientId,
        },
      );
      console.log("[Sync] Stop transcode", stopKey.substring(0, 8),
        plexKey ? "(mapped plex key)" : "(our UUID, no mapping)",
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

interface RoomClient {
  ws: WebSocket;
  userId: string;
  username: string | null;
  isHost: boolean;
  /** Granted by the host; allows transport control (pause/resume/seek) only. */
  isCoHost: boolean;
}

/**
 * Messages a co-host may send. Everything else — starting a title, stopping,
 * queue changes, role changes — stays host-only. Deliberately narrow: a co-host
 * can steer playback but never change what is playing or who controls the room.
 *
 * "set-subtitle" and "play-item" are requests, not actions: subtitles are burned
 * into the transcode and starting a title is host-only, so in both cases the
 * host is the one that actually performs the work. Audio selection stays
 * host-only entirely.
 */
const CO_HOST_ALLOWED_TYPES = new Set(["pause", "resume", "seek", "set-subtitle", "play-item"]);

interface RoomState {
  ratingKey: string | null;
  title: string | null;
  subtitles: boolean;
  playing: boolean;
  position: number;
  updatedAt: number;
  hlsSessionId: string | null;
  browseContext: string | null;
  queue: QueueItem[];
}

interface Room {
  clients: Set<RoomClient>;
  state: RoomState;
}

const rooms = new Map<string, Room>();

/** Server-side ping intervals per room — keeps transcode alive independent of client connectivity. */
const roomPingIntervals = new Map<string, ReturnType<typeof setInterval>>();

function startRoomPing(instanceId: string, hlsSessionId: string): void {
  stopRoomPing(instanceId);
  const interval = setInterval(() => {
    pingPlexTranscode(hlsSessionId).catch(() => {});
  }, 30_000);
  interval.unref();
  roomPingIntervals.set(instanceId, interval);
}

function stopRoomPing(instanceId: string): void {
  const interval = roomPingIntervals.get(instanceId);
  if (interval) {
    clearInterval(interval);
    roomPingIntervals.delete(instanceId);
  }
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
        updatedAt: Date.now(),
        hlsSessionId: null,
        browseContext: null,
        queue: [],
      },
    };
    rooms.set(instanceId, room);
  }
  return room;
}

function broadcast(room: Room, sender: WebSocket, msg: object): void {
  const data = JSON.stringify(msg);
  for (const client of room.clients) {
    if (client.ws !== sender && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
    }
  }
}

/** Send to every client in the room, including the one that triggered it. */
function sendToAll(room: Room, msg: object): void {
  const data = JSON.stringify(msg);
  for (const client of room.clients) {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(data);
  }
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
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function interpolatedPosition(state: RoomState): number {
  if (!state.playing) return state.position;
  const elapsed = (Date.now() - state.updatedAt) / 1000;
  return state.position + elapsed;
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

    ws.on("message", (raw: RawData) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const type = msg.type as string;

      // First message must be join
      if (type === "join") {
        const token = msg.sessionToken as string;
        const instanceId = msg.instanceId as string;
        const userId = msg.userId as string;
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

        client = { ws, userId, username, isHost, isCoHost: false };
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
          lastCommandAt: room.state.updatedAt,
          browseContext: room.state.browseContext,
          queue: room.state.queue,
          hostUsername: hostClient?.username ?? null,
          participants: participantsOf(room),
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

      switch (type) {
        case "play": {
          room.state.ratingKey = (msg.ratingKey as string) || null;
          room.state.title = (msg.title as string) || null;
          room.state.subtitles = Boolean(msg.subtitles);
          room.state.hlsSessionId = (msg.hlsSessionId as string) || null;
          room.state.playing = true;
          room.state.position = 0;
          room.state.updatedAt = Date.now();
          room.state.browseContext = null;
          if (room.state.hlsSessionId) startRoomPing(roomId, room.state.hlsSessionId);
          broadcast(room, ws, {
            type: "play",
            ratingKey: room.state.ratingKey,
            title: room.state.title,
            subtitles: room.state.subtitles,
            hlsSessionId: room.state.hlsSessionId,
          });
          break;
        }
        case "pause": {
          room.state.playing = false;
          room.state.position = (msg.position as number) ?? room.state.position;
          room.state.updatedAt = Date.now();
          broadcast(room, ws, { type: "pause", position: room.state.position });
          break;
        }
        case "resume": {
          room.state.playing = true;
          room.state.position = (msg.position as number) ?? room.state.position;
          room.state.updatedAt = Date.now();
          broadcast(room, ws, { type: "resume", position: room.state.position });
          break;
        }
        case "seek": {
          room.state.position = (msg.position as number) ?? room.state.position;
          room.state.updatedAt = Date.now();
          broadcast(room, ws, { type: "seek", position: room.state.position });
          break;
        }
        case "set-subtitle": {
          // Relay only — the host's client applies it by restarting the
          // transcode with the new burn-in, then re-announces the session via
          // "play". Nothing to persist here: room.state.subtitles tracks whether
          // burn-in is on at all, not which track was picked.
          const partId = msg.partId;
          const subtitleStreamID = msg.subtitleStreamID;
          if (typeof partId !== "number" || typeof subtitleStreamID !== "number") break;
          broadcast(room, ws, { type: "set-subtitle", partId, subtitleStreamID });
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
          // Capture before clearing so we can kill the exact Plex transcode
          const stoppingSessionId = room.state.hlsSessionId;
          room.state.ratingKey = null;
          room.state.title = null;
          room.state.hlsSessionId = null;
          room.state.playing = false;
          room.state.position = 0;
          room.state.updatedAt = Date.now();
          room.state.queue = [];
          stopRoomPing(roomId);
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
          room.state.position = (msg.position as number) ?? room.state.position;
          room.state.playing = msg.playing !== false;
          room.state.updatedAt = Date.now();
          broadcast(room, ws, {
            type: "heartbeat",
            position: room.state.position,
            playing: room.state.playing,
          });
          break;
        }
        case "browse": {
          room.state.browseContext = (msg.context as string) || null;
          broadcast(room, ws, { type: "browse", context: room.state.browseContext });
          break;
        }
        case "queue-add": {
          const item = msg.item as QueueItem;
          if (item?.ratingKey) {
            // Prevent duplicate items in the queue
            const alreadyQueued = room.state.queue.some((q) => q.ratingKey === item.ratingKey);
            if (!alreadyQueued) {
              room.state.queue.push(item);
            }
            broadcast(room, ws, { type: "queue-updated", queue: room.state.queue });
            sendTo(ws, { type: "queue-updated", queue: room.state.queue });
          }
          break;
        }
        case "queue-remove": {
          const ratingKey = msg.ratingKey as string;
          room.state.queue = room.state.queue.filter((q) => q.ratingKey !== ratingKey);
          broadcast(room, ws, { type: "queue-updated", queue: room.state.queue });
          sendTo(ws, { type: "queue-updated", queue: room.state.queue });
          break;
        }
        case "queue-clear": {
          room.state.queue = [];
          broadcast(room, ws, { type: "queue-updated", queue: room.state.queue });
          sendTo(ws, { type: "queue-updated", queue: room.state.queue });
          break;
        }
        case "queue-reorder": {
          room.state.queue = (msg.queue as QueueItem[]) || [];
          broadcast(room, ws, { type: "queue-updated", queue: room.state.queue });
          sendTo(ws, { type: "queue-updated", queue: room.state.queue });
          break;
        }
        case "promote-host": {
          // Host only — a co-host must never be able to seize or reassign the role.
          if (!client.isHost) break;
          const targetId = msg.userId as string;
          const target = [...room.clients].find((c) => c.userId === targetId);
          if (!target || target === client) break;

          // Hand over: the old host drops to a plain viewer, and the target
          // clears any co-host flag since host already supersedes it.
          client.isHost = false;
          client.isCoHost = false;
          target.isHost = true;
          target.isCoHost = false;

          const instance = instanceHosts.get(roomId);
          if (instance) instance.hostUserId = target.userId;
          updateInstanceHost(roomId, target.userId);

          console.log("[Sync] Host transferred to", target.userId.substring(0, 8));

          sendTo(target.ws, { type: "host-promoted", hostUsername: target.username });
          for (const c of room.clients) {
            if (c !== target) sendTo(c.ws, { type: "host-changed", hostUsername: target.username });
          }
          broadcastParticipants(room);
          break;
        }
        case "set-cohost": {
          if (!client.isHost) break;
          const targetId = msg.userId as string;
          const target = [...room.clients].find((c) => c.userId === targetId);
          // The host is already above co-host, so toggling it on themself is a no-op.
          if (!target || target.isHost) break;

          target.isCoHost = Boolean(msg.value);
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
    });

    ws.on("close", () => {
      clearInterval(pingTimer);
      if (!client || !roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;

      room.clients.delete(client);

      if (client.isHost) {
        if (room.clients.size > 0) {
          // Prefer a co-host as successor — the host already trusted them with
          // control, so it's a less surprising handover than picking arbitrarily.
          const newHost =
            [...room.clients].find((c) => c.isCoHost) ?? room.clients.values().next().value!;
          newHost.isHost = true;
          newHost.isCoHost = false;

          const instance = instanceHosts.get(roomId);
          if (instance) {
            instance.hostUserId = newHost.userId;
          }
          updateInstanceHost(roomId, newHost.userId);

          console.log("[Sync] Host left, promoting", newHost.userId.substring(0, 8), "to host");

          sendTo(newHost.ws, { type: "host-promoted", hostUsername: newHost.username });

          for (const c of room.clients) {
            if (c !== newHost) {
              sendTo(c.ws, { type: "host-disconnected" });
              sendTo(c.ws, { type: "host-changed", hostUsername: newHost.username });
            }
          }
        } else {
          const disconnectedSessionId = room.state.hlsSessionId;
          room.state.playing = false;
          room.state.hlsSessionId = null;
          stopRoomPing(roomId);
          killPlexTranscode(disconnectedSessionId).catch(() => {});
        }
      }

      if (room.clients.size === 0) {
        rooms.delete(roomId);
      } else {
        // Someone left — refresh everyone's roster
        broadcastParticipants(room);
      }
    });
  });

  // Cleanup rooms whose instance has expired every 5 minutes
  cleanupInterval = setInterval(() => {
    for (const [instanceId, room] of rooms) {
      if (!instanceHosts.has(instanceId) && room.clients.size === 0) {
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
  for (const instanceId of roomPingIntervals.keys()) {
    stopRoomPing(instanceId);
  }
  rooms.clear();
}
