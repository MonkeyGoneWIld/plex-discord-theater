/**
 * When a segment should come from another player instead of the bot — the
 * calls the P2P engine patch makes (p2pCorePatch.ts, which says why): the one
 * the picture is waiting on, when our own download of it crawls.
 */
import { segmentProgress } from "./segmentParts";

/** A segment starting within this of the playhead is one playback waits on. */
export const URGENT_S = 6;
/** A download from the bot gets this long to show its pace before it is judged. */
const SETTLE_MS = 1500;
/** One finishing sooner than this is left to finish. */
const NEARLY_DONE_MS = 1500;
/** A peer nobody has measured yet is taken to manage this. */
const UNMEASURED_PEER_BITS_PER_S = 16_000_000;
/** How long a segment taken from a peer is left there before it is judged. */
const PEER_SETTLE_MS = 3000;
/** How our own download of a segment is going: all of its parts together. */
export interface HttpProgress {
  received: number;
  total?: number;
  /** performance.now() when it began. */
  startedAt: number;
}

/** What a peer would still have to send — it carries on from our last byte — and how fast it has sent before. */
export interface FromPeer {
  left?: number;
  /** Zero for a peer that hasn't sent us anything yet. */
  bitsPerS: number;
}

/** Our download is crawling, and the peer would be done sooner. */
export function shouldTakeFromPeer(http: HttpProgress, peer: FromPeer, now: number): boolean {
  const elapsed = now - http.startedAt;
  if (elapsed < SETTLE_MS) return false;
  const rate = http.received / elapsed;
  const httpLeftMs = http.total === undefined
    ? Infinity
    : rate > 0 ? (http.total - http.received) / rate : Infinity;
  if (httpLeftMs <= NEARLY_DONE_MS) return false;
  if (peer.left === undefined) return true;
  const peerRate = (peer.bitsPerS > 0 ? peer.bitsPerS : UNMEASURED_PEER_BITS_PER_S) / 8000;
  return peer.left / peerRate < httpLeftMs;
}

/** How a segment taken from a peer is going. */
export interface PeerProgress {
  received: number;
  remaining?: number;
  startedAt: number;
}

/** A segment taken from a peer stays there unless the peer is no faster. */
export function keepOnPeer(p2p: PeerProgress, now: number): boolean {
  const elapsed = now - p2p.startedAt;
  if (elapsed < PEER_SETTLE_MS) return true;
  if (p2p.remaining === undefined) return false;
  const rate = p2p.received / elapsed;
  return rate > 0 && p2p.remaining / rate <= PEER_SETTLE_MS;
}

export interface TookFromPeer {
  segment: number;
  received: number;
  total?: number;
  ms: number;
  left?: number;
  peerBitsPerS: number;
  /** False when no peer could start it after all, and the bot carries on. */
  started: boolean;
}

/** Hand the engine its answers; `onTook` hears each segment taken. */
export function installTakeFromPeer(
  onTook: (took: TookFromPeer) => void,
  target: object = globalThis,
): void {
  (target as { __pdtP2P?: unknown }).__pdtP2P = {
    urgentS: URGENT_S,
    progress: segmentProgress,
    shouldTakeFromPeer,
    keepOnPeer,
    tookFromPeer: onTook,
  };
}
