/**
 * Players dividing a stream: which segments a player fetches from the bot,
 * which it takes from another player, and which it leaves to them — and that
 * the installed p2p-media-loader is still the shape the change was made for.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

(globalThis as unknown as { window: unknown }).window = globalThis;
const { installSharing, setSharing, URGENT_S } = await import("../src/lib/p2pSharing");

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

type Seg = { id: string; startTime: number };
type Req = { status: string; downloadSource?: string; failedAttempts: { httpAttemptsCount: number }; abortFromProcessQueue: () => void };

/** A loader as the library has it, reduced to what its queue touches. */
function makeLoader(opts: { position: number; segments: Seg[]; peerHas: string[]; peerLoading: string[]; loading?: Record<string, "http" | "p2p"> }) {
  const actions: string[] = [];
  const requests = new Map<string, Req>();
  for (const [id, source] of Object.entries(opts.loading ?? {})) {
    requests.set(id, {
      status: "loading", downloadSource: source, failedAttempts: { httpAttemptsCount: 0 },
      abortFromProcessQueue: () => actions.push(`abort ${id}`),
    });
  }
  const count = (source: string) => [...requests.values()].filter((r) => r.status === "loading" && r.downloadSource === source).length;
  const start = (seg: Seg, source: string) => {
    actions.push(`${source} ${seg.id}`);
    requests.set(seg.id, { status: "loading", downloadSource: source, failedAttempts: { httpAttemptsCount: 0 }, abortFromProcessQueue: () => {} });
  };
  class HybridLoader {
    config = { simultaneousHttpDownloads: 2, simultaneousP2PDownloads: 3, httpErrorRetries: 3, httpDownloadInitialTimeoutMs: 0 };
    createdAt = 0;
    engineRequest = undefined;
    playback = { position: opts.position, rate: 1 };
    requests = {
      get: (s: Seg) => requests.get(s.id),
      get executingHttpCount() { return count("http"); },
      get executingP2PCount() { return count("p2p"); },
    };
    p2pLoaders = {
      currentLoader: {
        isSegmentLoadedBySomeone: (s: Seg) => opts.peerHas.includes(s.id),
        isSegmentLoadingOrLoadedBySomeone: (s: Seg) => opts.peerHas.includes(s.id) || opts.peerLoading.includes(s.id),
      },
    };
    generateQueue() {
      return {
        queue: opts.segments.map((segment) => ({ segment, statuses: { isHighDemand: true, isHttpDownloadable: true, isP2PDownloadable: false } })),
        queueSegmentIds: new Set(), queueDownloadRatio: 1,
      };
    }
    processRequests() {}
    loadThroughHttp(s: Seg) { start(s, "http"); }
    loadThroughP2P(s: Seg) { start(s, "p2p"); }
    abortLastHttpLoadingInQueueAfterItem() { return false; }
    abortLastP2PLoadingInQueueAfterItem() { return false; }
    requestProcessQueueMicrotask() {}
    // The library's own, as far as these checks need: every high-demand
    // segment from the bot while a slot is free, else from a peer that has it.
    // (Names the shape check looks for: executingHttpCount,
    // isSegmentLoadedBySomeone, httpErrorRetries, abortFromProcessQueue.)
    processQueue() {
      const { httpErrorRetries } = this.config;
      void httpErrorRetries;
      for (const { segment } of this.generateQueue().queue) {
        const r = this.requests.get(segment);
        if (r?.status === "loading") { void r.abortFromProcessQueue; continue; }
        if (this.requests.executingHttpCount < this.config.simultaneousHttpDownloads) this.loadThroughHttp(segment);
        else if (this.p2pLoaders.currentLoader.isSegmentLoadedBySomeone(segment)) this.loadThroughP2P(segment);
      }
    }
  }
  const loader = new HybridLoader();
  const engine = { core: { mainStreamLoader: loader, mainStreamConfig: loader.config } };
  return { loader, engine, actions };
}

// Playing from 100s: 100 and 105 are about to play; the rest are further out.
const segments = [100, 105, 120, 125, 130, 135].map((t) => ({ id: `s${t}`, startTime: t }));

console.log("— dividing the stream —");
{
  const { loader, engine, actions } = makeLoader({ position: 100, segments, peerHas: ["s125"], peerLoading: ["s120"] });
  const handle = installSharing(engine);
  check("the library is changed once it has a loader", handle !== null, true);
  setSharing(handle!, true);
  loader.processQueue();
  check("what is about to play comes from the bot; what another player has comes from them; what they're fetching is left to them",
    actions, ["http s100", "http s105", "p2p s125"]);
}
{
  const { loader, engine, actions } = makeLoader({ position: 100, segments: segments.slice(2), peerHas: [], peerLoading: ["s120"] });
  setSharing(installSharing(engine)!, true);
  loader.processQueue();
  check("this player's downloads go to the segments nobody is fetching", actions, ["http s125", "http s130"]);
}
{
  const { loader, engine, actions } = makeLoader({ position: 100, segments, peerHas: ["s105"], peerLoading: ["s100"] });
  setSharing(installSharing(engine)!, true);
  loader.processQueue();
  check(`within ${URGENT_S}s of playing, the bot, whoever else has it`, actions.slice(0, 2), ["http s100", "http s105"]);
}
{
  const { loader, engine, actions } = makeLoader({ position: 100, segments: segments.slice(0, 1).concat(segments.slice(4)), peerHas: [], peerLoading: [], loading: { s100: "p2p", s130: "p2p" } });
  setSharing(installSharing(engine)!, true);
  loader.processQueue();
  check("a segment coming from another player is taken over by the bot once it's about to play, and not before",
    actions, ["abort s100", "http s100", "http s135"]);
}
{
  const { loader, engine, actions } = makeLoader({ position: 100, segments, peerHas: ["s125"], peerLoading: ["s120"] });
  setSharing(installSharing(engine)!, false);
  loader.processQueue();
  check("not sharing: the library's own choices, untouched", actions, ["http s100", "http s105", "p2p s125"]);
  check("which fetch the segment another player is fetching too, given a free slot",
    (() => {
      const second = makeLoader({ position: 100, segments: segments.slice(2), peerHas: [], peerLoading: ["s120"] });
      setSharing(installSharing(second.engine)!, false);
      second.loader.processQueue();
      return second.actions;
    })(), ["http s120", "http s125"]);
}

console.log("\n— the installed library —");
{
  // Its package exports nothing but its entry, so it is found on disk: the
  // client's own node_modules, or the workspace's.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const core = [path.join(here, "..", "node_modules"), path.join(here, "..", "..", "..", "node_modules")]
    .map((dir) => path.join(dir, "p2p-media-loader-core"))
    .find((dir) => fs.existsSync(path.join(dir, "package.json")))!;
  const version = JSON.parse(fs.readFileSync(path.join(core, "package.json"), "utf8")).version;
  const source = fs.readFileSync(path.join(core, "lib", "hybrid-loader.js"), "utf8");
  const method = (name: string) => new RegExp(`\\n    ${name}\\(`).test(source);
  check("is the version the queue was copied from", version, "2.3.2");
  check("has every method the copied queue calls",
    ["processQueue", "generateQueue", "processRequests", "loadThroughHttp", "loadThroughP2P",
      "abortLastHttpLoadingInQueueAfterItem", "abortLastP2PLoadingInQueueAfterItem"].filter((m) => !method(m)), []);
  const from = source.indexOf("\n    processQueue() {");
  const queue = source.slice(from, source.indexOf("\n    // api method for engines", from));
  check("and a queue with the names the shape check looks for",
    ["executingHttpCount", "isSegmentLoadedBySomeone", "httpErrorRetries", "abortFromProcessQueue"].filter((n) => !queue.includes(n)), []);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
