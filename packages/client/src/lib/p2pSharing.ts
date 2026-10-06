/**
 * Players dividing a stream between them instead of each fetching all of it.
 *
 * p2p-media-loader fetches every segment it calls high-demand — with this
 * player's window, everything the buffer can hold — from the bot, even when
 * another player already has it, or is fetching it right now. Two players
 * starting together therefore fetch the same segments in the same order, and
 * share next to nothing: a test with two players on a 30 Mbps film took 5% of
 * its data from the other player. The library has no setting for this, so its
 * queue is changed here, in one place:
 *
 *   - a segment another player already has is taken from them;
 *   - a segment another player is fetching is left to them, and this player's
 *     own downloads go to the next one nobody is fetching;
 *
 * unless it is URGENT_S or less from being played, or the very segment the
 * player is waiting on, when it is fetched from the bot as before — so a slow
 * peer delays nothing that is needed now. Everything
 * else is the library's own logic, copied as it stands in the installed
 * version; when a player isn't sharing (see setSharing), the library's own
 * method runs untouched.
 *
 * The change is made to the loader's prototype, and only if the installed
 * library still has the shape this was written against. If not, nothing is
 * changed and players fetch as the library decides — slower to share, never
 * broken.
 */

/** Closer to playback than this, a segment comes from the bot whoever else has it. */
export const URGENT_S = 15;

type AnyLoader = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Per stream config object (one per player's engine): whether it shares. */
const sharingFor = new WeakMap<object, boolean>();
/** Loader prototypes already looked at: changed, or found not to fit. */
const installed = new WeakMap<object, boolean>();

/** The members the copied queue below calls; checked before anything changes. */
const NEEDED = [
  "generateQueue", "processRequests", "loadThroughHttp", "loadThroughP2P",
  "abortLastHttpLoadingInQueueAfterItem", "abortLastP2PLoadingInQueueAfterItem",
] as const;

/**
 * Change the queue of the loader inside this engine, once it has one (after
 * its first segment request), and return the handle setSharing takes — null if
 * there is no loader yet, or the library isn't the shape expected.
 */
export function installSharing(engine: unknown): object | null {
  const core = (engine as AnyLoader | null)?.core;
  const loader = core?.mainStreamLoader as AnyLoader | undefined;
  const config = core?.mainStreamConfig as object | undefined;
  if (!loader || !config) return null;
  const proto = Object.getPrototypeOf(loader) as AnyLoader;
  if (installed.get(proto) === false) return null;
  if (!installed.has(proto)) {
    const original = proto.processQueue;
    const source = typeof original === "function" ? String(original) : "";
    const fits = NEEDED.every((name) => typeof proto[name] === "function")
      && ["executingHttpCount", "isSegmentLoadedBySomeone", "httpErrorRetries", "abortFromProcessQueue"]
        .every((name) => source.includes(name))
      && typeof loader.playback?.position === "number"
      && typeof loader.p2pLoaders?.currentLoader?.isSegmentLoadingOrLoadedBySomeone === "function";
    if (!fits) {
      installed.set(proto, false);
      return null;
    }
    proto.processQueue = function (this: AnyLoader) {
      return sharingFor.get(this.config) ? sharedProcessQueue.call(this) : original.call(this);
    };
    installed.set(proto, true);
  }
  return config;
}

/** Turn dividing the stream with other players on or off for one player. */
export function setSharing(handle: object, on: boolean): void {
  sharingFor.set(handle, on);
}

/**
 * The library's HybridLoader.processQueue (p2p-media-loader-core 2.3.2), with
 * the high-demand branch changed as described at the top. Marked "changed".
 */
function sharedProcessQueue(this: AnyLoader): void {
  const { queue, queueSegmentIds, queueDownloadRatio } = this.generateQueue();
  this.processRequests(queueSegmentIds, queueDownloadRatio);
  const { simultaneousHttpDownloads, simultaneousP2PDownloads, httpErrorRetries, httpDownloadInitialTimeoutMs } = this.config;
  const timeSinceStart = performance.now() - this.createdAt;
  const isInitialHttpWait = httpDownloadInitialTimeoutMs > 0 && timeSinceStart < httpDownloadInitialTimeoutMs;
  if (isInitialHttpWait) {
    this.initialHttpDelayTimeoutId ??= window.setTimeout(() => {
      this.initialHttpDelayTimeoutId = undefined;
      this.requestProcessQueueMicrotask();
    }, httpDownloadInitialTimeoutMs - timeSinceStart);
  }
  const { engineRequest } = this;
  if (engineRequest) {
    const { segment } = engineRequest;
    const request = this.requests.get(segment);
    const shouldStartLoadImmediatelyEngineRequest = engineRequest.shouldBeStartedImmediately
      && engineRequest.status === "pending"
      && (!request || request.status === "not-started" || request.status === "failed" || request.status === "aborted");
    if (shouldStartLoadImmediatelyEngineRequest) {
      const canLoadThroughHttp = !isInitialHttpWait
        && (request?.failedAttempts.httpAttemptsCount ?? 0) < httpErrorRetries
        && this.requests.executingHttpCount < simultaneousHttpDownloads;
      if (canLoadThroughHttp) {
        this.loadThroughHttp(segment);
      } else {
        const canLoadThroughP2P = this.p2pLoaders.currentLoader.isSegmentLoadedBySomeone(segment)
          && this.requests.executingP2PCount < simultaneousP2PDownloads;
        if (canLoadThroughP2P) this.loadThroughP2P(segment);
      }
    }
  }
  const peers = this.p2pLoaders.currentLoader;
  const position: number = this.playback.position;
  // What hls.js is waiting on right now: urgent whatever the clock says, since
  // the clock comes from the element, which can be wrong while a stream starts.
  const waitingOn = this.engineRequest?.status === "pending" ? this.engineRequest.segment : null;
  for (const item of queue) {
    const { statuses, segment } = item;
    const request = this.requests.get(segment);
    if (request?.status === "succeed") continue;
    if (statuses.isHighDemand) {
      const canLoadThroughHttp = !isInitialHttpWait
        && (request?.failedAttempts.httpAttemptsCount ?? 0) < httpErrorRetries;
      // Changed: how soon it plays decides whether another player may
      // provide it.
      const urgent = segment === waitingOn || segment.startTime - position <= URGENT_S;
      if (request?.status === "loading") {
        // Changed: a segment coming from another player is only taken over
        // by the bot once it's urgent, not whenever a download slot is free.
        const shouldSwitchFromP2PToHttp = urgent
          && canLoadThroughHttp
          && request.downloadSource === "p2p"
          && (this.requests.executingHttpCount < simultaneousHttpDownloads
            || this.abortLastHttpLoadingInQueueAfterItem(queue, segment));
        if (shouldSwitchFromP2PToHttp) {
          request.abortFromProcessQueue();
          this.loadThroughHttp(segment);
        }
        continue;
      }
      if (!urgent) {
        // Changed: another player has it — take it from them.
        if (peers.isSegmentLoadedBySomeone(segment)
          && this.requests.executingP2PCount < simultaneousP2PDownloads) {
          this.loadThroughP2P(segment);
          continue;
        }
        // Changed: another player is fetching it — leave it to them, and
        // fetch the next one nobody is.
        if (peers.isSegmentLoadingOrLoadedBySomeone(segment)) continue;
      }
      const shouldLoadThroughHttp = canLoadThroughHttp
        && (this.requests.executingHttpCount < simultaneousHttpDownloads
          || this.abortLastHttpLoadingInQueueAfterItem(queue, segment));
      if (shouldLoadThroughHttp) {
        this.loadThroughHttp(segment);
        continue;
      }
      const canLoadThroughP2P = peers.isSegmentLoadedBySomeone(segment)
        && (this.requests.executingP2PCount < simultaneousP2PDownloads
          || this.abortLastP2PLoadingInQueueAfterItem(queue, segment));
      if (canLoadThroughP2P) this.loadThroughP2P(segment);
    } else {
      const canLoadThroughP2P = statuses.isP2PDownloadable
        && request?.status !== "loading"
        && this.requests.executingP2PCount < simultaneousP2PDownloads;
      if (canLoadThroughP2P) this.loadThroughP2P(segment);
    }
  }
}
