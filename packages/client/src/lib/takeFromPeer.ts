/**
 * When a segment should come from another player instead of the bot — the
 * calls the P2P engine patch makes (p2pCorePatch.ts, which says why): the one
 * the picture is waiting on, when our own download of it crawls; and any the
 * other player is already fetching, when we are cooperating with it.
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
/** A peer this fast is on the same network: fetching from the bot what it is
 *  fetching only splits one connection two ways. */
export const SAME_NETWORK_BITS_PER_S = 60_000_000;
/** How long a segment is left to a peer fetching it before we fetch it too. */
export const PEER_WAIT_MS = 8000;
/** How long a viewer joining a stream start waits for the host to appear as
 *  a peer before fetching from the bot itself, when the host has been on its
 *  network — see sameNetworkKnown. It stops waiting the moment the host does
 *  appear. */
export const PEER_CONNECT_WAIT_MS = 2000;

/**
 * Whether a peer has shown itself to be on this player's network, in this
 * stream or an earlier one. Each stream — every start, and every skip that
 * rebuilds one — has a new P2P engine that has measured nobody, and the start
 * is exactly when sharing counts most.
 */
let sameNetworkSeen = false;
export function sameNetworkKnown(): boolean {
  return sameNetworkSeen;
}

/** A round trip this short, seconds, is a peer on the same network. */
const SAME_NETWORK_RTT_S = 0.004;

/** A connection's own address on a private network, or a link-local one. */
function privateAddress(address: unknown): boolean {
  if (typeof address !== "string") return false;
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.|f[cd]|fe80:|::1$)/i.test(address);
}

/**
 * Whether a WebRTC connection runs inside one network: the pair of candidates
 * it settled on are both this side's and that side's own addresses, not ones
 * a router handed out. Null while it can't say yet.
 */
export async function samePlace(pc: RTCPeerConnection | undefined): Promise<boolean | null> {
  if (!pc || typeof pc.getStats !== "function") return null;
  const stats = await pc.getStats();
  let pair: Record<string, unknown> | undefined;
  stats.forEach((r: Record<string, unknown>) => {
    if (r.type === "transport" && typeof r.selectedCandidatePairId === "string") pair ??= stats.get(r.selectedCandidatePairId);
  });
  if (!pair) {
    stats.forEach((r: Record<string, unknown>) => {
      if (r.type === "candidate-pair" && r.state === "succeeded" && (r.nominated || r.selected)) pair ??= r;
    });
  }
  if (!pair) return null;
  const local = stats.get(pair.localCandidateId as string) as Record<string, unknown> | undefined;
  const remote = stats.get(pair.remoteCandidateId as string) as Record<string, unknown> | undefined;
  if (!local || !remote) return null;
  if (local.candidateType !== "host") return false;
  // Theirs is either one of their own addresses, or one learned from them on
  // the wire — which, private, is the same thing. The browser often won't say
  // what that address is; a round trip of a few milliseconds says it for it.
  if (remote.candidateType === "host") return true;
  if (remote.candidateType !== "prflx") return false;
  const address = remote.address ?? remote.ip;
  if (typeof address === "string" && address) return privateAddress(address);
  return typeof pair.currentRoundTripTime === "number" && pair.currentRoundTripTime <= SAME_NETWORK_RTT_S;
}

/**
 * Leave segments to the other player rather than fetch them from the bot too:
 * only one on the same network. Two players in one house share one connection
 * to the bot, and fetching every segment twice through it halves both; a
 * segment from the other player costs a moment. A peer elsewhere is another
 * matter — waiting on its download is waiting on a connection nobody here can
 * see, and when the host's own downloads crawled, a viewer that left the
 * first segment to it held the room up eight seconds. Known from the
 * connection itself (samePlace), or from segments coming over it faster than
 * any connection out of a house; otherwise remembered from the last stream.
 * A slower peer proves nothing — a browser's data channel often runs under
 * 60 Mbps inside one network — so only the connections themselves say a peer
 * is elsewhere: `allElsewhere`, every connected peer's saying so.
 */
export function cooperating(peerBitsPerS: number, onSameNetwork = false, allElsewhere = false): boolean {
  if (onSameNetwork || peerBitsPerS >= SAME_NETWORK_BITS_PER_S) {
    sameNetworkSeen = true;
    return true;
  }
  if (allElsewhere) {
    // Whoever was on this network has gone.
    sameNetworkSeen = false;
    return false;
  }
  return sameNetworkSeen;
}

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

/**
 * Hand the engine its answers; `onTook` hears each segment taken, and
 * `onSameNetwork` each peer found on this player's network.
 *
 * `holdForPeer` says when to fetch nothing from the bot at all and take it all
 * from a peer on the same network: a viewer, while the room waits on the
 * host's picture. Leaving the host only what it is already fetching wasn't
 * enough — the viewer went on to the next segment, and the host fetched the
 * one everybody was waiting for with half the connection.
 */
export function installTakeFromPeer(
  onTook: (took: TookFromPeer) => void,
  onSameNetwork: () => void = () => {},
  holdForPeer: () => boolean = () => false,
  target: object = globalThis,
): void {
  (target as { __pdtP2P?: unknown }).__pdtP2P = {
    urgentS: URGENT_S,
    progress: segmentProgress,
    shouldTakeFromPeer,
    keepOnPeer,
    tookFromPeer: onTook,
    cooperating: (info: { peerBitsPerS: number; samePlace?: boolean; elsewhere?: boolean }) =>
      cooperating(info.peerBitsPerS, info.samePlace, info.elsewhere),
    // Remembered the moment it is known, for this stream's decisions and the
    // next stream's start alike — not only once a segment is in question.
    samePlace: async (pc: RTCPeerConnection | undefined) => {
      const same = await samePlace(pc);
      if (same) {
        sameNetworkSeen = true;
        onSameNetwork();
      }
      return same;
    },
    peerWaitMs: PEER_WAIT_MS,
    holdForPeer,
  };
}
