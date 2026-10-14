/**
 * A copied segment fetched in parts at once, and handed on as one response
 * (lib/segmentParts) — against a fake bot that splits a segment the way the
 * server's segmentPart does, at a pace per download.
 */
import {
  MAX_PARTS, fetchInParts, fetchInPartsLater, inBrowserCache, installSegmentParts, partBounds, partUrl, partsFor, pumpSegmentParts,
  segmentBytesOf, segmentProgress,
} from "../src/lib/segmentParts";
import { keepOnPeer, keepSharedOnPeer, ownerOf, shareChoice, shouldTakeFromPeer } from "../src/lib/takeFromPeer";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SEGMENT = Uint8Array.from({ length: 2_500_003 }, (_, i) => (i * 7 + (i >> 9)) & 0xff);
const URL0 = `https://bot.test/api/plex/hls/seg?p=%2Fbase%2F00428.ts&n=${SEGMENT.length}`;

interface Bot {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  asked: string[];
  /** Per download, ms between chunks of 64 KB. */
  paceMs: number;
  /** Answer every part with the whole segment, as a server that ignores parts would. */
  ignoresParts: boolean;
  /** Parts that fail halfway. */
  breaks: Set<number>;
  /** When each part finished, ms since the fake started. */
  finished: Map<number, number>;
  /** Downloads running now, and the most there have been at once. */
  running: number;
  mostAtOnce: number;
}

function bot(): Bot {
  const started = Date.now();
  const b: Bot = {
    asked: [], paceMs: 0, ignoresParts: false, breaks: new Set(), finished: new Map(), running: 0, mostAtOnce: 0,
    fetch: async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      b.asked.push(url);
      b.running++;
      b.mostAtOnce = Math.max(b.mostAtOnce, b.running);
      let over = false;
      const end = () => { if (!over) { over = true; b.running--; } };
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const q = new URL(url).searchParams;
      const parts = q.has("parts") ? Number(q.get("parts")) : 1;
      const part = q.has("part") ? Number(q.get("part")) : 0;
      const [from, to] = b.ignoresParts || parts === 1
        ? [0, SEGMENT.length]
        : [Math.floor((SEGMENT.length * part) / parts), Math.floor((SEGMENT.length * (part + 1)) / parts)];
      const bytes = SEGMENT.subarray(from, to);
      if (signal?.aborted) { end(); throw new DOMException("aborted", "AbortError"); }
      let at = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          if (b.paceMs) await sleep(b.paceMs);
          if (signal?.aborted) { end(); c.error(new DOMException("aborted", "AbortError")); return; }
          if (b.breaks.has(part) && at >= bytes.length / 2) { end(); c.error(new TypeError("network error")); return; }
          if (at >= bytes.length) { end(); b.finished.set(part, Date.now() - started); c.close(); return; }
          c.enqueue(bytes.slice(at, at + 65_536));
          at += 65_536;
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "video/mp2t" } });
    },
  };
  return b;
}

async function readAll(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

console.log("\n— how a segment is split —");
check("a 7 MB segment goes in eight parts", partsFor(7_200_400), 8);
check("a 2.4 MB one in three", partsFor(2_400_000), 3);
check("never more than the bot splits one into, eight", [partsFor(28_000_000), MAX_PARTS], [8, 8]);
check("a small one in one", partsFor(600_000), 1);
check("nothing known, one", partsFor(NaN), 1);
check("the parts cover it end to end, the server's split",
  partBounds(10, 3), [[0, 3], [3, 6], [6, 10]]);
check("the size comes off the URL", segmentBytesOf(URL0), SEGMENT.length);
check("a URL without one has none", segmentBytesOf("https://bot.test/api/plex/hls/seg?p=%2F00001.ts"), null);
check("a part's URL keeps the segment's", partUrl(URL0, 1, 4), `${URL0}&part=1&parts=4`);

console.log("\n— fetched in parts, handed on whole —");
{
  const b = bot();
  const res = await fetchInParts(b.fetch, new Request(URL0), SEGMENT.length, 3);
  check("one answer, the size of the segment", [res.status, res.headers.get("Content-Length")], [200, String(SEGMENT.length)]);
  check("every byte, in order", same(await readAll(res), SEGMENT), true);
  check("three parts were asked for at once", b.asked.map((u) => new URL(u).searchParams.get("part")), ["0", "1", "2"]);
}

console.log("\n— the parts run side by side —");
{
  // Each download at its own pace: a part is a third of the segment, so in
  // parts it arrives in about a third of the time one download takes.
  const one = bot();
  one.paceMs = 4;
  let t = Date.now();
  await readAll(await one.fetch(URL0));
  const alone = Date.now() - t;
  const b = bot();
  b.paceMs = 4;
  t = Date.now();
  const got = await readAll(await fetchInParts(b.fetch, new Request(URL0), SEGMENT.length, 4));
  const inParts = Date.now() - t;
  check("all of it", same(got, SEGMENT), true);
  check(`in parts it takes well under half as long (${inParts}ms against ${alone}ms)`, inParts < alone / 2, true);
}

console.log("\n— a few parts at a time —");
{
  // Beside the segment the picture needs, a segment's parts go one or four
  // at a time; its URLs are the same either way (see the top of segmentParts).
  const b = bot();
  b.paceMs = 1;
  const got = await readAll(await fetchInParts(b.fetch, new Request(URL0), SEGMENT.length, 4, URL0, () => 1));
  check("all of it, in order", same(got, SEGMENT), true);
  check("one part at a time", b.mostAtOnce, 1);
  check("every part asked for, in order, under the URLs four at once would use",
    b.asked, [0, 1, 2, 3].map((i) => partUrl(URL0, i, 4)));
  const two = bot();
  two.paceMs = 1;
  await readAll(await fetchInParts(two.fetch, new Request(URL0), SEGMENT.length, 4, URL0, () => 2));
  check("two at a time", two.mostAtOnce, 2);
}

console.log("\n— more at once, once it may —");
{
  // A segment beside the one the picture needed, that has become the one it
  // needs: the rest of its parts start at once, not one by one.
  const b = bot();
  b.paceMs = 3;
  let atOnce = 1;
  const reading = readAll(await fetchInParts(b.fetch, new Request(URL0), SEGMENT.length, 4, URL0, () => atOnce));
  await sleep(20);
  check("one under way to begin with", [b.asked.length, b.running], [1, 1]);
  atOnce = 4;
  pumpSegmentParts();
  check("and the other three asked for the moment it may have four", b.asked.length, 4);
  check("all of it, in order", same(await reading, SEGMENT), true);
  pumpSegmentParts();
  check("and nothing asked for again once it is in", b.asked.length, 4);
}

console.log("\n— a server that ignores the parts —");
{
  const b = bot();
  b.ignoresParts = true;
  const got = await readAll(await fetchInParts(b.fetch, new Request(URL0), SEGMENT.length, 4));
  check("the first answer is taken as the whole, once", same(got, SEGMENT), true);
  const slow = bot();
  slow.ignoresParts = true;
  const one = await readAll(await fetchInParts(slow.fetch, new Request(URL0), SEGMENT.length, 4, URL0, () => 1));
  check("a part at a time, the rest are never asked for", [same(one, SEGMENT), slow.asked.length], [true, 1]);
}

console.log("\n— a part that fails —");
{
  const b = bot();
  b.paceMs = 1;
  b.breaks.add(2);
  const res = await fetchInParts(b.fetch, new Request(URL0), SEGMENT.length, 4);
  let error: unknown = null;
  try { await readAll(res); } catch (err) { error = err; }
  check("the whole response fails, for the engine to try again", error !== null, true);
  check("and nothing is left counted as under way", segmentProgress(URL0), undefined);
}

console.log("\n— the engine calling it off —");
{
  const b = bot();
  b.paceMs = 5;
  const abort = new AbortController();
  const res = await fetchInParts(b.fetch, new Request(URL0, { signal: abort.signal }), SEGMENT.length, 4);
  const reading = readAll(res).then(() => "finished", () => "stopped");
  await sleep(30);
  check("while it runs, its progress is all the parts together", (segmentProgress(URL0)?.received ?? 0) > 65_536, true);
  abort.abort();
  check("stops every part", await reading, "stopped");
  await sleep(40);
  check("none of them finishes after", b.finished.size, 0);
  const one = bot();
  one.paceMs = 5;
  const stop = new AbortController();
  const res1 = await fetchInParts(one.fetch, new Request(URL0, { signal: stop.signal }), SEGMENT.length, 4, URL0, () => 1);
  const reading1 = readAll(res1).then(() => "finished", () => "stopped");
  await sleep(30);
  stop.abort();
  check("a part at a time, it stops too", await reading1, "stopped");
  const asked = one.asked.length;
  pumpSegmentParts();
  await sleep(40);
  check("and asks for nothing more after", [one.asked.length === asked, one.running], [true, 0]);
}

console.log("\n— a bad answer to the first part —");
{
  const b = bot();
  const gone: typeof b.fetch = async (input, init) => {
    if (String(input).includes("part=0")) return new Response(null, { status: 410 });
    return b.fetch(input, init);
  };
  const res = await fetchInParts(gone, new Request(URL0), SEGMENT.length, 4);
  check("is the answer, for the engine to read", res.status, 410);
}

console.log("\n— fetch, wrapped —");
{
  const b = bot();
  const target = { fetch: b.fetch };
  installSegmentParts(target);
  installSegmentParts(target);
  const marked = fetchInPartsLater(new Request(URL0), URL0, SEGMENT.length);
  check("a marked request goes in parts", same(await readAll(await target.fetch(marked)), SEGMENT), true);
  check("as many as its size calls for", b.asked.length, partsFor(SEGMENT.length));
  b.asked.length = 0;
  await readAll(await target.fetch(new Request(URL0)));
  check("anything else goes as it is", b.asked, [URL0]);
  b.asked.length = 0;
  const small = fetchInPartsLater(new Request("https://bot.test/x?n=100"), "x", 100);
  await target.fetch(small);
  check("a segment too small to split goes as it is", b.asked.length, 1);
}

console.log("\n— what the browser's cache holds of a segment —");
{
  /** A cache holding these URLs, as the browser's answers only-if-cached. */
  const cache = (held: Map<string, number>, asks: Array<RequestInit | undefined>) =>
    async (input: RequestInfo | URL, init?: RequestInit) => {
      asks.push(init);
      const at = held.get(String(input));
      if (at === undefined) throw new TypeError("Failed to fetch");
      return new Response("x", { status: 200, headers: { Date: new Date(at).toUTCString() } });
    };
  const parts = partsFor(SEGMENT.length);
  const all = (at: number) => new Map(Array.from({ length: parts }, (_, i) => [partUrl(URL0, i, parts), at]));
  const asks: Array<RequestInit | undefined> = [];
  check("every part of it, as this page would fetch them: held", await inBrowserCache(URL0, cache(all(Date.now()), asks)), true);
  check("asked of the cache alone, never the bot", asks.every((o) => o?.cache === "only-if-cached" && o?.mode === "same-origin"), true);
  const missing = all(Date.now());
  missing.delete(partUrl(URL0, parts - 1, parts));
  check("a part let go: not held", await inBrowserCache(URL0, cache(missing, [])), false);
  check("kept past the five minutes the bot allows: not held, it would be asked for again",
    await inBrowserCache(URL0, cache(all(Date.now() - 6 * 60_000), [])), false);
  check("a segment not fetched in parts: the segment itself",
    await inBrowserCache("https://bot.test/seg/00001.ts", cache(new Map([["https://bot.test/seg/00001.ts", Date.now()]]), [])), true);
}

console.log("\n— the segment the picture waits on, from another player or the bot —");
{
  const MB = 1_000_000;
  // Monte Cristo's host: 7.2 MB, 2.6 MB of it in after nine seconds.
  const crawling = { received: 2.6 * MB, total: 7.2 * MB, startedAt: 0 };
  check("a crawl that has nine seconds to go is taken from a peer that has it",
    shouldTakeFromPeer(crawling, { left: 4.6 * MB, bitsPerS: 20_000_000 }, 9000), true);
  check("even one nobody has measured yet",
    shouldTakeFromPeer(crawling, { left: 4.6 * MB, bitsPerS: 0 }, 9000), true);
  check("but not in its first moments, before its pace shows",
    shouldTakeFromPeer({ received: 0, total: 7.2 * MB, startedAt: 0 }, { left: 7.2 * MB, bitsPerS: 0 }, 1000), false);
  check("nor when it is about to finish",
    shouldTakeFromPeer({ received: 7 * MB, total: 7.2 * MB, startedAt: 0 }, { left: 0.2 * MB, bitsPerS: 0 }, 4000), false);
  check("nor from a peer that would take longer than it",
    shouldTakeFromPeer({ received: 3 * MB, total: 7.2 * MB, startedAt: 0 }, { left: 6 * MB, bitsPerS: 2_000_000 }, 3000), false);
  check("a download that has sent nothing at all is a crawl",
    shouldTakeFromPeer({ received: 0, total: 7.2 * MB, startedAt: 0 }, { left: 7.2 * MB, bitsPerS: 0 }, 3000), true);
  check("one taken from a peer stays there while it settles",
    keepOnPeer({ received: 0, remaining: 7 * MB, startedAt: 0 }, 1000), true);
  check("and while it is doing well",
    keepOnPeer({ received: 4 * MB, remaining: 1 * MB, startedAt: 0 }, 4000), true);
  check("but goes back to the bot if the peer is no faster",
    keepOnPeer({ received: 0.5 * MB, remaining: 6 * MB, startedAt: 0 }, 4000), false);
}

console.log("\n— a segment well ahead, from another player that has it —");
{
  const MB = 1_000_000;
  const holds = { aheadS: 45, free: true, busy: false, fetching: false, theirs: false, slotFree: true };
  check("one another player has, 45 seconds ahead, comes from them",
    shareChoice(holds), "peer");
  check("but never one playback needs within 20 seconds",
    shareChoice({ ...holds, aheadS: 15 }), "bot");
  check("nor, under half a minute ahead, when we are already taking as many as we can from players",
    shareChoice({ ...holds, aheadS: 25, slotFree: false }), "bot");
  check("one the player is busy sending another, half a minute and more ahead, is left to them",
    shareChoice({ ...holds, aheadS: 40, free: false, busy: true }), "wait");
  check("as is one a player is fetching from the bot",
    shareChoice({ ...holds, aheadS: 40, free: false, fetching: true }), "wait");
  check("or another player's to fetch, before anyone has started it",
    shareChoice({ ...holds, aheadS: 140, free: false, theirs: true }), "wait");
  check("or that we can take no more from players just now",
    shareChoice({ ...holds, aheadS: 40, slotFree: false }), "wait");
  check("but nothing under half a minute ahead is left to anybody",
    [shareChoice({ ...holds, aheadS: 28, free: false, theirs: true }), shareChoice({ ...holds, aheadS: 28, free: false, fetching: true })],
    ["bot", "bot"]);
  check("and with nobody having it nor anybody's it is, the bot",
    shareChoice({ ...holds, aheadS: 140, free: false }), "bot");

  // Two players, and every segment of a film: each is somebody's, the same
  // somebody's whoever asks, and they get about half each.
  const players = ["-PDT10-a8Kx3m2Q9z", "-PDT10-Zq81LbW0cY"];
  const owners = Array.from({ length: 200 }, (_, i) => ownerOf(i, players));
  check("every segment is one player's to fetch", owners.every((o) => o !== null && players.includes(o)), true);
  check("the same one whichever order the players are listed in",
    Array.from({ length: 200 }, (_, i) => ownerOf(i, [...players].reverse())), owners);
  const first = owners.filter((o) => o === players[0]).length;
  check("about half each", first > 70 && first < 130, true);
  check("alone, every one is your own", ownerOf(7, ["-PDT10-solo"]), "-PDT10-solo");
  check("with nobody at all, nobody's", ownerOf(7, []), null);
  check("a shared segment stays with the player while it settles",
    keepSharedOnPeer({ received: 0, remaining: 9 * MB, startedAt: 0, aheadS: 40 }, 1000), true);
  check("and while it will be in well before it is needed",
    keepSharedOnPeer({ received: 3 * MB, remaining: 6 * MB, startedAt: 0, aheadS: 40 }, 4000), true);
  check("but goes to the bot when it wouldn't be",
    keepSharedOnPeer({ received: 0.3 * MB, remaining: 9 * MB, startedAt: 0, aheadS: 40 }, 4000), false);
  check("and when playback is about to reach it, however it is going",
    keepSharedOnPeer({ received: 8 * MB, remaining: 1 * MB, startedAt: 0, aheadS: 8 }, 4000), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
