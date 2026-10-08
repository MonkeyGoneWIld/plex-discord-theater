/**
 * When a segment should come from another player instead of the bot — the
 * calls the P2P engine patch makes (p2pCorePatch.ts, which says why): the one
 * the picture is waiting on, when our own download of it crawls; and one well
 * ahead of the playhead that another player already has.
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

/**
 * Nearer the playhead than this, a segment comes from the bot first, as the
 * engine has it: playback may want it before another player could send it.
 */
export const SHARE_AFTER_S = 20;
/**
 * Further ahead than this, a segment another player has, is fetching from the
 * bot, or is the one to fetch (see ownerOf) is left to them rather than
 * fetched from the bot a second time. Nearer, it is fetched here: the buffer
 * never waits on another player for its next half-minute.
 */
export const LEAVE_AFTER_S = 30;
/** A shared segment still coming this near the playhead goes back to the bot. */
const SHARED_LAST_S = 10;
/** And sooner, if it wouldn't be in this long before it is needed. */
const SHARED_MARGIN_S = 5;

/** What the players we are connected to have of a segment. */
export interface PeersHold {
  /** How far ahead of the playhead it starts, seconds. */
  aheadS: number;
  /** A player has all of it and is sending us nothing else. */
  free: boolean;
  /** A player has all of it, and is sending us another. */
  busy: boolean;
  /** A player is fetching it from the bot. */
  fetching: boolean;
  /** Another player is the one to fetch it — see ownerOf. */
  theirs: boolean;
  /** We could take one more segment from a player now. */
  slotFree: boolean;
}

/**
 * Where a segment the engine would fetch from the bot comes from instead —
 * one it is fetching ahead, or one playback has asked for: another player
 * that has it ("peer"), nowhere yet because another player has it, is
 * fetching it, or is the one to ("wait"), or the bot after all.
 *
 * Players in different places, which they always are: a peer is only ever
 * relied on for what is far enough ahead to be fetched here if it doesn't
 * come. Waiting is what divides the work: when the bot is the slow part, and
 * through Discord's proxy it is, each player's downloads stay at the front of
 * its buffer, and every player fetched every segment there itself — so this
 * holds for playback's own asks too, and its downloads go on to its own share.
 */
export function shareChoice(p: PeersHold): "peer" | "wait" | "bot" {
  if (p.aheadS < SHARE_AFTER_S) return "bot";
  if (p.free && p.slotFree) return "peer";
  if (p.aheadS >= LEAVE_AFTER_S && (p.free || p.busy || p.fetching || p.theirs)) return "wait";
  return "bot";
}

/**
 * Which of the players watching a stream fetches a segment from the bot when
 * it is well ahead of all of them: the same answer from every one of them,
 * from nothing but their ids and the segment's, so the segments are divided
 * evenly without a word between them. Players watching together reach each
 * new segment at the same moment — neither has started it when the other
 * looks — and left to timing both fetched everything from the bot: two
 * players on one film shared 0 MB of 125.
 */
export function ownerOf(segment: string | number, players: readonly string[]): string | null {
  let owner: string | null = null;
  let lowest = Infinity;
  for (const player of players) {
    // FNV-1a over player and segment together, then mixed through (murmur3's
    // finaliser): FNV alone barely moves for a change in the last characters,
    // and one player was the lowest for nearly every segment.
    let hash = 0x811c9dc5;
    const key = `${player}|${segment}`;
    for (let i = 0; i < key.length; i++) {
      hash ^= key.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b) >>> 0;
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
    hash ^= hash >>> 16;
    hash >>>= 0;
    if (hash < lowest || (hash === lowest && owner !== null && player < owner)) {
      lowest = hash;
      owner = player;
    }
  }
  return owner;
}



/**
 * A segment shared from a peer stays there while it will be in before it is
 * needed, with a margin; otherwise it goes to the bot, from the byte it got to.
 */
export function keepSharedOnPeer(p2p: PeerProgress & { aheadS: number }, now: number): boolean {
  if (p2p.aheadS < SHARED_LAST_S) return false;
  const elapsed = now - p2p.startedAt;
  if (elapsed < PEER_SETTLE_MS) return true;
  if (p2p.remaining === undefined) return false;
  const rate = p2p.received / elapsed;
  return rate > 0 && p2p.remaining / rate < (p2p.aheadS - SHARED_MARGIN_S) * 1000;
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
    shareChoice,
    ownerOf,
    keepSharedOnPeer,
    tookFromPeer: onTook,
  };
}
