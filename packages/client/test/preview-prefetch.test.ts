/**
 * The first pass of a part's preview frames, fetched on the title's page
 * (lib/previewPrefetch) and taken from there by the seek bar — against a fake
 * bot that answers each part's first pass.
 */
import { forgetPreviewStarts, prefetchPreviewStart, previewPassPath, takePreviewStart } from "../src/lib/previewPrefetch";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Bot {
  fetch: typeof fetch;
  asked: string[];
  /** Answer with this status instead of the frames. */
  status: number;
  /** Throw instead of answering, as a dropped connection does. */
  throws: boolean;
  /** ms before each chunk. */
  paceMs: number;
}

/** A part's first pass: three chunks whose bytes say which part they are. */
const chunksOf = (partId: number) => [0, 1, 2].map((i) => Uint8Array.from({ length: 1000 + i }, (_, j) => (partId + i + j) & 0xff));

function bot(): Bot {
  const b: Bot = {
    asked: [], status: 200, throws: false, paceMs: 0,
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      b.asked.push(url);
      if (b.throws) throw new TypeError("network error");
      if (b.status !== 200) return new Response(null, { status: b.status });
      const partId = Number(url.match(/preview\/(\d+)\//)![1]);
      const chunks = chunksOf(partId);
      const paceMs = b.paceMs;
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (paceMs) await sleep(paceMs);
          const next = chunks.shift();
          if (next) controller.enqueue(next);
          else controller.close();
        },
      }), { headers: { "Content-Type": "application/x-plex-preview-v2" } });
    }) as typeof fetch,
  };
  return b;
}
const joined = (chunks: Uint8Array[]) => [...chunks.flatMap((c) => [...c])];

console.log("the path asked for");
check("pass 0 of part 42", previewPassPath(42, 0), "/api/plex/preview/42/index?progressive=2&pass=0");
check("pass 3 of part 42", previewPassPath(42, 3), "/api/plex/preview/42/index?progressive=2&pass=3");

console.log("fetched on the title's page, taken by the seek bar");
{
  forgetPreviewStarts();
  const b = bot();
  check("nothing to take before it is fetched", takePreviewStart(42), null);
  prefetchPreviewStart(42, b.fetch);
  prefetchPreviewStart(42, b.fetch);
  const got = await takePreviewStart(42);
  check("asked for once, the first pass", b.asked, ["/api/plex/preview/42/index?progressive=2&pass=0"]);
  check("as the bot sent it", got?.contentType, "application/x-plex-preview-v2");
  check("every byte of it", joined(got?.chunks ?? []), joined(chunksOf(42)));
  const again = await takePreviewStart(42);
  check("there again for the next player on the same part (a restart)", joined(again?.chunks ?? []), joined(chunksOf(42)));
  prefetchPreviewStart(42, b.fetch);
  check("and not asked for again", b.asked.length, 1);
  check("another part's is not this one's", takePreviewStart(43), null);
}

console.log("taken while still coming in");
{
  forgetPreviewStarts();
  const b = bot();
  b.paceMs = 40;
  prefetchPreviewStart(7, b.fetch);
  const startedAt = Date.now();
  const got = await takePreviewStart(7);
  check("waited for, whole", joined(got?.chunks ?? []), joined(chunksOf(7)));
  check("rather than handed over half", Date.now() - startedAt >= 100, true);
}

console.log("one that failed is asked for again");
{
  forgetPreviewStarts();
  const b = bot();
  b.status = 404;
  prefetchPreviewStart(9, b.fetch);
  check("no frames: nothing to take", await takePreviewStart(9), null);
  await sleep(0);
  check("and forgotten, so the seek bar asks itself", takePreviewStart(9), null);
  b.status = 200;
  prefetchPreviewStart(9, b.fetch);
  check("the title's page asks again next time", b.asked.length, 2);
  check("and has it", joined((await takePreviewStart(9))?.chunks ?? []), joined(chunksOf(9)));

  const c = bot();
  c.throws = true;
  prefetchPreviewStart(11, c.fetch);
  check("a dropped connection: nothing to take", await takePreviewStart(11), null);
  await sleep(0);
  check("and forgotten too", takePreviewStart(11), null);
}

console.log("a few parts kept, the last ones fetched");
{
  forgetPreviewStarts();
  const b = bot();
  for (const partId of [1, 2, 3, 4]) prefetchPreviewStart(partId, b.fetch);
  check("the first of four forgotten", takePreviewStart(1), null);
  check("the last three kept", [2, 3, 4].map((id) => takePreviewStart(id) !== null), [true, true, true]);
  check("each one its own", joined((await takePreviewStart(4))?.chunks ?? []), joined(chunksOf(4)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
