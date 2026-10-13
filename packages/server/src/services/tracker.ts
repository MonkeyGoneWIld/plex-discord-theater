import TrackerServer from "bittorrent-tracker/server";
import type { WebSocket } from "ws";
import { logEvent } from "./logger.js";

let tracker: InstanceType<typeof TrackerServer> | null = null;

/**
 * How often the bot looks in on each player's connection to the tracker.
 *
 * Nothing else goes over it between a player's announces, two minutes apart,
 * and a connection that quiet gets dropped on the way from the player to the
 * bot: on 13 October blah0391's went within two minutes of joining a stream's
 * swarm, and monkey26, joining in that time, found nobody to share with — the
 * two met 85 seconds later, when it came back. So every TRACKER_PING_MS it
 * gets a ping, which the browser answers on its own, and a message its
 * tracker library reads and puts aside (KEEP_ALIVE): something going over it
 * both ways, whatever on the way answers a ping itself. A player that answers
 * no ping in two is gone, and comes out of the swarms it was in, rather than
 * being offered to everybody joining as somebody to connect to.
 */
const TRACKER_PING_MS = Number(process.env.PDT_TRACKER_PING_MS) || 20_000;
/**
 * An announce for no stream: the tracker library compares the stream it names
 * with its own, finds it isn't, and does nothing (websocket-tracker.js,
 * _onAnnounceResponse) — unlike anything else it doesn't expect, which it
 * takes for the tracker failing, and drops the connection over.
 */
const KEEP_ALIVE = JSON.stringify({ action: "announce", info_hash: "pdt:keep-alive" });

/**
 * Create a bittorrent-tracker Server with all built-in transports disabled.
 * We pipe WebSocket connections to it manually via `onWebSocketConnection`.
 */
export function createTracker(): void {
  tracker = new TrackerServer({
    http: false,
    udp: false,
    ws: false,
    trustProxy: true,
  });

  tracker.on("error", (err: Error) => {
    console.error("[Tracker] error:", err.message);
  });

  tracker.on("warning", (err: Error) => {
    console.warn("[Tracker] warning:", err.message);
  });

  // Who is in a stream's swarm. Two players in one, each saying peers=0, is a
  // connection between them that failed — their own logs say why (the
  // client's lib/peerConnections) — rather than a player that never asked.
  const swarmSize = (infoHash: unknown) => {
    const swarm = typeof infoHash === "string"
      ? (tracker as unknown as { torrents?: Record<string, { peers?: { length?: number } }> }).torrents?.[infoHash]
      : undefined;
    return swarm?.peers?.length ?? 0;
  };
  tracker.on("start", (_peerId: unknown, params: { info_hash?: unknown }) => {
    logEvent("Tracker", "a player joined a stream's swarm", {
      swarm: String(params?.info_hash ?? "?").substring(0, 8),
      players: swarmSize(params?.info_hash),
    });
  });
  tracker.on("stop", (_peerId: unknown, params: { info_hash?: unknown }) => {
    logEvent("Tracker", "a player left a stream's swarm", {
      swarm: String(params?.info_hash ?? "?").substring(0, 8),
      players: swarmSize(params?.info_hash),
    });
  });

  console.log("[Tracker] P2P signaling tracker ready");
}

/**
 * Hand an already-upgraded WebSocket to the tracker for signaling.
 */
export function handleTrackerSocket(ws: WebSocket): void {
  if (!tracker) {
    console.error("[Tracker] not initialized, closing socket");
    ws.close(1011, "Tracker not ready");
    return;
  }
  const openedAt = Date.now();
  let heardAt = openedAt;
  let answered = true;
  let ended: "the bot, no answer" | null = null;
  ws.on("message", () => { heardAt = Date.now(); });
  ws.on("pong", () => { answered = true; });
  const timer = setInterval(() => {
    if (!answered) {
      ended = "the bot, no answer";
      ws.terminate();
      return;
    }
    answered = false;
    try {
      ws.ping();
      ws.send(KEEP_ALIVE);
    } catch { /* closing */ }
  }, TRACKER_PING_MS);
  timer.unref?.();
  // Before the tracker's own: by the time that has run, the swarms this
  // player was in have been forgotten.
  ws.on("close", (code: number) => {
    clearInterval(timer);
    const swarms = (ws as unknown as { infoHashes?: string[] | null }).infoHashes ?? [];
    if (swarms.length === 0) return;
    logEvent("Tracker", "a player's connection to the tracker closed", {
      swarms: swarms.map((hash) => String(hash).substring(0, 8)).join(","),
      openS: Math.round((Date.now() - openedAt) / 1000),
      quietS: Math.round((Date.now() - heardAt) / 1000),
      code,
      by: ended ?? "the player or the way to it",
    });
  });
  tracker.onWebSocketConnection(ws as any);
}

export function destroyTracker(): void {
  if (tracker) {
    tracker.close();
    tracker = null;
  }
}
