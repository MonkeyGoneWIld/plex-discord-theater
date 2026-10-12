/**
 * Changes to how the P2P engine (p2p-media-loader-core 2.3) picks where a
 * segment comes from, made as it is bundled — the engine has no setting for
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
 *     and freeing that peer from a later segment if it has to — and goes back
 *     to the bot if the peer turns out no faster. Whether it is crawling, and
 *     whether a peer download is doing better, is for the player to say:
 *     globalThis.__pdtP2P (src/lib/takeFromPeer.ts). Without that, the engine
 *     behaves as it always has.
 *  2. The queue is looked at every second or two even when nothing happens,
 *     so a download that is merely slow — which raises no event — is noticed.
 *  3. What has been watched stays in memory until the memory limit is
 *     reached, for a copied film as for a re-encoded one (segment storage, not
 *     the loader). A copy's playlist grows as the bot measures it, so the
 *     engine takes it for a live stream, and let go of everything more than
 *     150 seconds behind the playhead whatever room there was: a rewind past
 *     that loaded again from the bot.
 *  4. A segment well ahead of the playhead that another player already has
 *     comes from that player — whether the engine is fetching ahead or
 *     playback has asked for it — and one half a minute or more ahead that
 *     another player has, is fetching, or is the one to fetch (the players
 *     divide such segments between them, each knowing which are whose without
 *     a word said) is left to them, instead of every player fetching
 *     everything from the bot. The engine itself goes to another player only
 *     when all its downloads from the bot are busy — about one segment in
 *     twenty — and two players starting together shared nothing at all.
 *     Nothing playback needs soon waits on another player: within 20 seconds
 *     of the playhead the bot comes first, within 30 nothing is left to
 *     anybody, and a shared segment that wouldn't be in well before it is
 *     needed goes back to the bot, from the byte it got to (lib/takeFromPeer:
 *     shareChoice, ownerOf, keepSharedOnPeer).
 *
 * There used to be a third: a player on the same network as its peer left
 * segments to it rather than fetch them from the bot too, and a viewer fetched
 * nothing from the bot while the room waited on the host. A transfer from the
 * host that never came then had nothing behind it: in Spider-Man: Far from
 * Home on 8 October a viewer waited 38 seconds on a skip's first segment the
 * host had had for thirty of them. Players are in different places; it went.
 *
 * Applied to the engine's source as text: if a new version moves what this
 * looks for, the build fails here rather than quietly doing without.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Plugin } from "vite";

const TARGET = /p2p-media-loader-core[\\/]lib[\\/]hybrid-loader\.js$/;
const STORAGE_TARGET = /p2p-media-loader-core[\\/]lib[\\/]segment-storage[\\/]segment-memory-storage\.js$/;
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
                        request.downloadSource === "p2p" && !this.pdtKeepOnPeer(request, segment) &&`,
  ],
  [
    `                if (canLoadThroughHttp) {
                    this.loadThroughHttp(segment);
                }
                else {
                    const canLoadThroughP2P = this.p2pLoaders.currentLoader.isSegmentLoadedBySomeone(segment) &&`,
    `                // ${MARK}
                if (this.pdtShareFromPeer(request, segment)) {
                    // From another player, or left to the one whose it is.
                }
                else if (canLoadThroughHttp) {
                    this.loadThroughHttp(segment);
                }
                else {
                    const canLoadThroughP2P = this.p2pLoaders.currentLoader.isSegmentLoadedBySomeone(segment) &&`,
  ],
  [
    `                // High-demand request is not loading
                const shouldLoadThroughHttp = canLoadThroughHttp &&`,
    `                // High-demand request is not loading
                // ${MARK}
                if (this.pdtShareFromPeer(request, segment)) continue;
                const shouldLoadThroughHttp = canLoadThroughHttp &&`,
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
    pdtKeepOnPeer(request, segment) {
        const hooks = globalThis.__pdtP2P;
        if (!hooks || !request.progress) return false;
        const progress = {
            received: request.progress.loadedBytes,
            remaining: request.totalBytes === undefined ? undefined : request.totalBytes - request.loadedBytes,
            startedAt: request.progress.startTimestamp,
        };
        if (request.pdtFromPeer) return hooks.keepOnPeer(progress, performance.now());
        if (!request.pdtShared || !hooks.keepSharedOnPeer) return false;
        const keep = hooks.keepSharedOnPeer({ ...progress, aheadS: segment.startTime - this.playback.position }, performance.now());
        // Back to the bot, and not offered to a player again.
        if (!keep) request.pdtNoShare = true;
        return keep;
    }
    // ${MARK}: a segment another player has, from them, or left to the one
    // whose it is — see change 4. True when the bot isn't to be asked now.
    pdtShareFromPeer(request, segment) {
        const hooks = globalThis.__pdtP2P;
        if (!hooks?.shareChoice) return false;
        if (request && (request.pdtNoShare || request.failedAttempts.p2pAttemptsCount > 0)) return false;
        let free = false;
        let busy = false;
        let fetching = false;
        const ids = [];
        const trackerClient = this.p2pLoaders.currentLoader.trackerClient;
        for (const peer of trackerClient.peers()) {
            ids.push(peer.id);
            const status = peer.getSegmentStatus(segment);
            if (status === "loaded") {
                if (peer.downloadingSegment) busy = true;
                else free = true;
            } else if (status === "http-loading") {
                fetching = true;
            }
        }
        // Whose it is to fetch, of everybody watching — see ownerOf.
        let theirs = false;
        const ownHex = trackerClient.client?.peerId;
        if (hooks.ownerOf && typeof ownHex === "string" && ids.length > 0) {
            const self = Utils.hexToUtf8(ownHex);
            const owner = hooks.ownerOf(segment.externalId, [self, ...ids]);
            theirs = owner !== null && owner !== self;
        }
        if (!free && !busy && !fetching && !theirs) return false;
        const choice = hooks.shareChoice({
            aheadS: segment.startTime - this.playback.position,
            free,
            busy,
            fetching,
            theirs,
            slotFree: this.requests.executingP2PCount < this.config.simultaneousP2PDownloads,
        });
        if (choice === "wait") return true;
        if (choice !== "peer") return false;
        this.loadThroughP2P(segment);
        const started = this.requests.get(segment);
        if (started?.status !== "loading" || started.downloadSource !== "p2p") return false;
        started.pdtShared = true;
        return true;
    }
    loadThroughHttp(segment) {`,
  ],
];

const storageEdits: Array<[string, string]> = [
  [
    `    clear(isLiveStream, newSegmentSize) {`,
    `    // ${MARK}: every stream is kept like a recorded one — see change 3.
    clear(_isLiveStream, newSegmentSize) {
        const isLiveStream = false;`,
  ],
];

/** The engine's hybrid-loader.js with its changes made; throws if it doesn't fit. */
export function patchHybridLoader(code: string): string {
  return applyEdits(code, edits, "hybrid-loader.js");
}

/** The engine's segment-memory-storage.js with its change made; throws if it doesn't fit. */
export function patchSegmentStorage(code: string): string {
  return applyEdits(code, storageEdits, "segment-memory-storage.js");
}

function applyEdits(code: string, list: Array<[string, string]>, file: string): string {
  if (code.includes(MARK)) return code;
  let out = code;
  for (const [from, to] of list) {
    const at = out.indexOf(from);
    if (at < 0 || out.indexOf(from, at + 1) >= 0) {
      throw new Error(
        `p2pCorePatch: p2p-media-loader-core's ${file} isn't the one this patch was written ` +
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
          define: { __PDT_P2P_CORE_PATCH__: JSON.stringify(createHash("sha256").update(JSON.stringify([edits, storageEdits])).digest("hex").slice(0, 12)) },
          plugins: [{
            name: "p2p-core-patch",
            setup(build) {
              build.onLoad({ filter: TARGET }, async (args) => ({
                contents: patchHybridLoader(await readFile(args.path, "utf8")),
                loader: "js",
              }));
              build.onLoad({ filter: STORAGE_TARGET }, async (args) => ({
                contents: patchSegmentStorage(await readFile(args.path, "utf8")),
                loader: "js",
              }));
            },
          }],
        },
      },
    }),
    transform(code, id) {
      const file = id.split("?")[0];
      if (TARGET.test(file)) return { code: patchHybridLoader(code), map: null };
      if (STORAGE_TARGET.test(file)) return { code: patchSegmentStorage(code), map: null };
      return null;
    },
  };
}
