/**
 * Whether two players reach each other, and when they don't, why — for the log.
 *
 * Players are in different places, so a connection between two of them goes
 * through both their routers. A STUN server tells each player the address its
 * router shows the world (a "srflx" address), and with those most pairs of
 * routers let the two through. Some never do — a carrier's shared NAT, or a
 * router that gives every destination its own port — and then nothing gets
 * between them but a relay. On 8 October a viewer never connected to the host
 * once in a whole evening, nor had they on 5 October, and the log said nothing
 * but "peers=0".
 *
 * Every connection the P2P engine makes is watched: when it connects, by which
 * kind of address on each side; when it fails, or is given up on first, which
 * kinds each side had to offer, and so which side couldn't be reached.
 *
 * Through RTCPeerConnection's prototype rather than by replacing the class:
 * the engine's WebRTC library takes its own reference to the class as it is
 * loaded, before any player exists to replace it.
 */
import { logEvent, logWarn } from "./log";

/** Failures reported per page: the engine retries a peer that won't connect. */
const MAX_FAILURES_LOGGED = 6;
let failuresLogged = 0;

type Kinds = Record<string, number>;

interface Watch {
  ours: Kinds;
  theirs: Kinds;
  startedAt: number;
  settled: boolean;
  /** The other side answered. The engine offers a connection to whoever may
   *  turn up, and lets an offer nobody took expire: that is no failure. */
  heard: boolean;
}

const watches = new WeakMap<RTCPeerConnection, Watch>();

function countLine(line: string | undefined | null, into: Kinds): void {
  const kind = line?.match(/ typ (\w+)/)?.[1];
  if (kind) into[kind] = (into[kind] ?? 0) + 1;
}

function countSdp(sdp: string | undefined | null, into: Kinds): void {
  for (const line of (sdp ?? "").split(/\r?\n/)) {
    if (line.startsWith("a=candidate:")) countLine(line, into);
  }
}

function listed(kinds: Kinds): string {
  const parts = Object.entries(kinds).map(([kind, n]) => `${kind}×${n}`);
  return parts.length > 0 ? parts.join(" ") : "none";
}

/**
 * What a failed connection's addresses say about it. Without a public address
 * (srflx) a side can't be reached from another network at all: its STUN asks
 * went unanswered. With one on both sides and still no connection, one of the
 * routers lets nothing in that it hasn't sent to — only a relay gets past that.
 */
export function whyNoConnection(ours: Kinds, theirs: Kinds): string {
  const reachable = (k: Kinds) => (k.srflx ?? 0) + (k.prflx ?? 0) + (k.relay ?? 0) > 0;
  if (!reachable(ours) && !reachable(theirs)) return "neither player's network answered STUN";
  if (!reachable(ours)) return "this player's network didn't answer STUN, so it has no public address to be reached at";
  if (!reachable(theirs)) return "the other player's network didn't answer STUN, so it has no public address to be reached at";
  return "both have public addresses, but a router between them lets nothing in that it didn't send to first (it would take a relay)";
}

function failed(w: Watch, how: string): void {
  if (w.settled) return;
  w.settled = true;
  if (!w.heard || failuresLogged >= MAX_FAILURES_LOGGED) return;
  failuresLogged++;
  logWarn("P2P", "couldn't connect to another player", {
    how,
    afterS: Number(((performance.now() - w.startedAt) / 1000).toFixed(1)),
    ours: listed(w.ours),
    theirs: listed(w.theirs),
    why: whyNoConnection(w.ours, w.theirs),
  });
}

function connected(pc: RTCPeerConnection, w: Watch): void {
  if (w.settled) return;
  w.settled = true;
  const afterS = Number(((performance.now() - w.startedAt) / 1000).toFixed(1));
  pc.getStats().then((stats) => {
    let pair: Record<string, unknown> | undefined;
    stats.forEach((s: Record<string, unknown>) => {
      if (s.type === "candidate-pair" && s.state === "succeeded" && (s.nominated || !pair)) pair = s;
    });
    const local = pair ? stats.get(pair.localCandidateId as string) as Record<string, unknown> | undefined : undefined;
    const remote = pair ? stats.get(pair.remoteCandidateId as string) as Record<string, unknown> | undefined : undefined;
    logEvent("P2P", "connected to another player", {
      afterS,
      via: `${local?.candidateType ?? "?"} to ${remote?.candidateType ?? "?"}`,
      protocol: local?.protocol ?? "?",
      rttMs: typeof pair?.currentRoundTripTime === "number" ? Math.round((pair.currentRoundTripTime as number) * 1000) : "?",
    });
  }).catch(() => {
    logEvent("P2P", "connected to another player", { afterS });
  });
}

/** This connection's watch, begun the first time it is seen. */
function watchOf(pc: RTCPeerConnection): Watch {
  const known = watches.get(pc);
  if (known) return known;
  const w: Watch = { ours: {}, theirs: {}, startedAt: performance.now(), settled: false, heard: false };
  watches.set(pc, w);
  pc.addEventListener("icecandidate", (event) => countLine(event.candidate?.candidate, w.ours));
  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "connected") connected(pc, w);
    else if (pc.connectionState === "failed") failed(w, "the connection failed");
  });
  return w;
}

/** Watch every WebRTC connection that negotiates from here on. */
export function watchPeerConnections(target: { RTCPeerConnection?: typeof RTCPeerConnection } = window): void {
  const proto = target.RTCPeerConnection?.prototype as (RTCPeerConnection & { pdtWatched?: true }) | undefined;
  if (!proto || proto.pdtWatched) return;
  proto.pdtWatched = true;
  // Every connection describes itself before it gathers a single address, so
  // the first of these is early enough to hear all of them.
  const setLocal = proto.setLocalDescription;
  proto.setLocalDescription = function (this: RTCPeerConnection, ...args: unknown[]) {
    watchOf(this);
    return (setLocal as (...a: unknown[]) => Promise<void>).apply(this, args);
  } as typeof proto.setLocalDescription;
  const setRemote = proto.setRemoteDescription;
  proto.setRemoteDescription = function (this: RTCPeerConnection, ...args: unknown[]) {
    const w = watchOf(this);
    w.heard = true;
    countSdp((args[0] as RTCSessionDescriptionInit | undefined)?.sdp, w.theirs);
    return (setRemote as (...a: unknown[]) => Promise<void>).apply(this, args);
  } as typeof proto.setRemoteDescription;
  const addCandidate = proto.addIceCandidate;
  proto.addIceCandidate = function (this: RTCPeerConnection, ...args: unknown[]) {
    countLine((args[0] as RTCIceCandidateInit | null | undefined)?.candidate, watchOf(this).theirs);
    return (addCandidate as (...a: unknown[]) => Promise<void>).apply(this, args);
  } as typeof proto.addIceCandidate;
  // Given up on by the engine before it connected: close() raises no event.
  const close = proto.close;
  proto.close = function (this: RTCPeerConnection) {
    const w = watches.get(this);
    if (w) {
      if (this.connectionState !== "connected") failed(w, "given up on before it connected");
      w.settled = true;
    }
    return close.call(this);
  };
}
