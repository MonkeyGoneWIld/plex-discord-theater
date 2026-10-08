/**
 * Three changes to how the P2P engine (p2p-media-loader-core 2.3) picks where
 * a segment comes from, made as it is bundled — the engine has no setting for
 * any of them.
 *
 * Left to itself it fetches every segment near the playhead from the bot, and
 * from another player only when its own downloads are all busy; and it moves
 * any such segment back to the bot the moment a download frees up. So a player
 * whose own downloads crawl waits on them even when another player already has
 * the segment it is stuck on. The Count of Monte Cristo started that way: the
 * viewer had the first segment in seven seconds, and the host, whose three
 * downloads from the bot ran at 2 Mbps together, sat on it for twenty-eight
 * while the whole room waited for the host.
 *
 *  1. The segment playback is waiting on (the engine's current request, within
 *     a few seconds of the playhead), crawling in from the bot while a peer has
 *     all of it, is taken from the peer — resuming from the bytes already in,
 *     and freeing that peer from a later segment if it has to. Whether it is
 *     crawling, and whether a peer download is doing better, is for the player
 *     to say: globalThis.__pdtP2P (src/lib/takeFromPeer.ts). Without that, the
 *     engine behaves as it always has.
 *  2. A player on the same network as its peer — which its WebRTC connection
 *     says — leaves a segment to the peer already fetching it, and takes it
 *     from the peer once it's in, rather than fetching it from the bot too;
 *     and while the room waits on the host's picture, a viewer fetches nothing
 *     from the bot at all (holdForPeer). That covers the engine's own random
 *     fetches as well. Two players in one house fetched every segment twice
 *     through the same connection: Backrooms, copied at 28-36 MB a segment,
 *     took 22s to start with each player getting half of it, the other player
 *     225 Mbps away.
 *  3. The queue is looked at every second or two even when nothing happens,
 *     so a download that is merely slow — which raises no event — is noticed,
 *     and each peer's connection is asked where it is.
 *
 * Applied to the engine's source as text: if a new version moves what this
 * looks for, the build fails here rather than quietly doing without.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Plugin } from "vite";

const TARGET = /p2p-media-loader-core[\\/]lib[\\/]hybrid-loader\.js$/;
const MARK = "plex-discord-theater: p2pCorePatch";

const edits: Array<[string, string]> = [
  [
    `            if (!statuses.isHttpDownloadable ||
                statuses.isP2PDownloadable ||
                this.segmentStorage.hasSegment(swarmId, streamSwarmId, segment.externalId)) {
                continue;
            }`,
    `            if (!statuses.isHttpDownloadable ||
                statuses.isP2PDownloadable ||
                this.segmentStorage.hasSegment(swarmId, streamSwarmId, segment.externalId)) {
                continue;
            }
            // ${MARK}: what is left to a peer isn't fetched at random either.
            if (this.requests.get(segment)?.status !== "loading" && this.pdtLeaveToPeer(segment)) continue;`,
  ],
  [
    `            if (shouldStartLoadImmediatelyEngineRequest) {
                // Don't abort requests when processing engine request`,
    `            // ${MARK}
            if (shouldStartLoadImmediatelyEngineRequest && !this.pdtLeaveToPeer(segment)) {
                // Don't abort requests when processing engine request`,
  ],
  [
    `                // High-demand request is not loading
                const shouldLoadThroughHttp = canLoadThroughHttp &&`,
    `                // High-demand request is not loading
                // ${MARK}
                if (this.pdtLeaveToPeer(segment)) continue;
                const shouldLoadThroughHttp = canLoadThroughHttp &&`,
  ],
  [
    `                if (request?.status === "loading") {
                    // High-demand request is loading
                    const shouldSwitchFromP2PToHttp = canLoadThroughHttp &&
                        request.downloadSource === "p2p" &&`,
    `                if (request?.status === "loading") {
                    // High-demand request is loading
                    // ${MARK}
                    if (this.pdtTakeFromPeer(request, segment)) continue;
                    const shouldSwitchFromP2PToHttp = canLoadThroughHttp &&
                        request.downloadSource === "p2p" && !this.pdtKeepOnPeer(request) &&`,
  ],
  [
    `        this.randomHttpDownloadTimeout = window.setTimeout(() => {
            this.loadRandomThroughHttp();
            this.setIntervalLoading();`,
    `        this.randomHttpDownloadTimeout = window.setTimeout(() => {
            this.loadRandomThroughHttp();
            // ${MARK}
            for (const peer of this.p2pLoaders.currentLoader.trackerClient.peers()) this.pdtSamePlace(peer);
            this.requestProcessQueueMicrotask(false);
            this.setIntervalLoading();`,
  ],
  [
    `    loadThroughHttp(segment) {`,
    `    // ${MARK}: the segment playback waits on, from a peer that has it all.
    pdtTakeFromPeer(request, segment) {
        const hooks = globalThis.__pdtP2P;
        if (!hooks || request.pdtFromPeer || request.downloadSource !== "http") return false;
        if (this.engineRequest?.segment !== segment) return false;
        if (segment.startTime > this.playback.position + hooks.urgentS) return false;
        let holder;
        let busyHolder;
        for (const peer of this.p2pLoaders.currentLoader.trackerClient.peers()) {
            if (peer.getSegmentStatus(segment) !== "loaded") continue;
            if (!peer.downloadingSegment) { holder = peer; break; }
            busyHolder ??= peer;
        }
        if (!holder && !busyHolder) return false;
        const now = performance.now();
        const http = hooks.progress(segment.url) ?? {
            received: request.progress?.loadedBytes ?? 0,
            total: request.totalBytes === undefined ? undefined : request.totalBytes - (request.progress?.startFromByte ?? 0),
            startedAt: request.progress?.startTimestamp ?? now,
        };
        const peer = holder ?? busyHolder;
        const fromPeer = {
            left: request.totalBytes === undefined ? undefined : request.totalBytes - request.loadedBytes,
            bitsPerS: peer.downloadBandwidth,
        };
        if (!hooks.shouldTakeFromPeer(http, fromPeer, now)) return false;
        if (!holder) {
            // Playback waits on this one, not on whatever later segment that peer is sending.
            const later = this.requests.get(busyHolder.downloadingSegment);
            if (later?.status === "loading") later.abortFromProcessQueue();
            if (busyHolder.downloadingSegment) return false;
        }
        request.pdtFromPeer = true;
        request.abortFromProcessQueue();
        this.loadThroughP2P(segment);
        hooks.tookFromPeer({
            segment: segment.externalId,
            received: http.received,
            total: http.total,
            ms: now - http.startedAt,
            left: fromPeer.left,
            peerBitsPerS: fromPeer.bitsPerS,
            started: request.status === "loading" && request.downloadSource === "p2p",
        });
        if (request.status !== "loading") this.loadThroughHttp(segment);
        return true;
    }
    // ${MARK}: a segment a peer is fetching, or has, is left to that peer.
    pdtLeaveToPeer(segment) {
        const hooks = globalThis.__pdtP2P;
        if (!hooks?.cooperating) return false;
        let holder;
        let fetching = false;
        let best = 0;
        let samePlace = false;
        let peers = 0;
        let elsewhere = 0;
        for (const peer of this.p2pLoaders.currentLoader.trackerClient.peers()) {
            peers++;
            best = Math.max(best, peer.downloadBandwidth);
            const place = this.pdtSamePlace(peer);
            if (place === true) samePlace = true;
            else if (place === false) elsewhere++;
            const status = peer.getSegmentStatus(segment);
            if (status === "loaded" && !peer.downloadingSegment) holder ??= peer;
            else if (status) fetching = true;
        }
        // Nobody has it or is fetching it: ours to fetch — unless the player
        // is holding everything for the peer, as a viewer does while the room
        // waits on the host's picture (holdForPeer).
        if (!holder && !fetching && !(peers > 0 && hooks.holdForPeer?.())) return false;
        if (!hooks.cooperating({ peerBitsPerS: best, samePlace, elsewhere: peers > 0 && elsewhere === peers })) return false;
        const now = performance.now();
        this.pdtWaitSince ??= new Map();
        if (holder && this.requests.executingP2PCount < this.config.simultaneousP2PDownloads) {
            this.pdtWaitSince.delete(segment.externalId);
            const request = this.requests.getOrCreateRequest(segment);
            request.pdtFromPeer = true;
            this.loadThroughP2P(segment);
            if (request.status === "loading" || request.status === "succeed") return true;
        }
        // Held for the peer, which nobody is fetching it from yet: for as long
        // as the room waits, which ends it.
        if (!holder && !fetching) return true;
        // Waited on so long and no longer: a peer whose download has died says nothing.
        const since = this.pdtWaitSince.get(segment.externalId) ?? now;
        this.pdtWaitSince.set(segment.externalId, since);
        if (this.pdtWaitSince.size > 200) this.pdtWaitSince.clear();
        return now - since < hooks.peerWaitMs;
    }
    // ${MARK}: whether a peer is on this player's network, as its connection says.
    // True, false, or undefined while it can't say yet.
    pdtSamePlace(peer) {
        const hooks = globalThis.__pdtP2P;
        if (!hooks?.samePlace) return undefined;
        // Asked again every few seconds until it says so: just after it
        // connects, a connection is still trying out routes, and its first
        // answer can be no.
        const now = performance.now();
        if (peer.pdtSamePlace !== true && !peer.pdtSamePlaceAsking && now - (peer.pdtSamePlaceAt ?? -Infinity) >= 3000) {
            peer.pdtSamePlaceAsking = true;
            peer.pdtSamePlaceAt = now;
            hooks.samePlace(peer.connection?._pc).then((same) => {
                if (same === true || same === false) peer.pdtSamePlace = same;
            }, () => {}).finally(() => { peer.pdtSamePlaceAsking = false; });
        }
        return peer.pdtSamePlace;
    }
    // ${MARK}: a segment taken from a peer stays there while it is doing well.
    pdtKeepOnPeer(request) {
        const hooks = globalThis.__pdtP2P;
        if (!hooks || !request.pdtFromPeer || !request.progress) return false;
        return hooks.keepOnPeer({
            received: request.progress.loadedBytes,
            remaining: request.totalBytes === undefined ? undefined : request.totalBytes - request.loadedBytes,
            startedAt: request.progress.startTimestamp,
        }, performance.now());
    }
    loadThroughHttp(segment) {`,
  ],
];

/** The engine's hybrid-loader.js with both changes made; throws if it doesn't fit. */
export function patchHybridLoader(code: string): string {
  if (code.includes(MARK)) return code;
  let out = code;
  for (const [from, to] of edits) {
    const at = out.indexOf(from);
    if (at < 0 || out.indexOf(from, at + 1) >= 0) {
      throw new Error(
        "p2pCorePatch: p2p-media-loader-core's hybrid-loader.js isn't the one this patch was written " +
        `for (looked for:\n${from.trim().split("\n")[0]}\n). Check the patch against the new version.`,
      );
    }
    out = out.slice(0, at) + to + out.slice(at + from.length);
  }
  return out;
}

/** The patch, for the build and for the dev server's pre-bundling alike. */
export function p2pCorePatch(): Plugin {
  return {
    name: "p2p-core-patch",
    enforce: "pre",
    config: () => ({
      optimizeDeps: {
        esbuildOptions: {
          // Part of what the dev server names its pre-bundled engine by, so a
          // change to this patch is a new file to the browser rather than the
          // old one from its cache.
          define: { __PDT_P2P_CORE_PATCH__: JSON.stringify(createHash("sha256").update(JSON.stringify(edits)).digest("hex").slice(0, 12)) },
          plugins: [{
            name: "p2p-core-patch",
            setup(build) {
              build.onLoad({ filter: TARGET }, async (args) => ({
                contents: patchHybridLoader(await readFile(args.path, "utf8")),
                loader: "js",
              }));
            },
          }],
        },
      },
    }),
    transform(code, id) {
      if (TARGET.test(id.split("?")[0])) return { code: patchHybridLoader(code), map: null };
      return null;
    },
  };
}
