/**
 * Two changes to how the P2P engine (p2p-media-loader-core 2.3) picks where a
 * segment comes from, made as it is bundled — the engine has no setting for
 * either.
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
 *  2. The queue is looked at every second or two even when nothing happens,
 *     so a download that is merely slow — which raises no event — is noticed.
 *
 * Applied to the engine's source as text: if a new version moves what this
 * looks for, the build fails here rather than quietly doing without.
 */
import { readFile } from "node:fs/promises";
import type { Plugin } from "vite";

const TARGET = /p2p-media-loader-core[\\/]lib[\\/]hybrid-loader\.js$/;
const MARK = "plex-discord-theater: p2pCorePatch";

const edits: Array<[string, string]> = [
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
