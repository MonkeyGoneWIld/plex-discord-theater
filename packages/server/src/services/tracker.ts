import TrackerServer from "bittorrent-tracker/server";
import type { WebSocket } from "ws";
import { logEvent } from "./logger.js";

let tracker: InstanceType<typeof TrackerServer> | null = null;

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
  tracker.onWebSocketConnection(ws as any);
}

export function destroyTracker(): void {
  if (tracker) {
    tracker.close();
    tracker = null;
  }
}
