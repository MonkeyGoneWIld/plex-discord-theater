/**
 * The client's five-minute cache of Plex metadata (cachedGet in api.ts): a
 * request that fails is dropped from it, so the next one asks again.
 */
let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

/** Every request, answered when the test says. */
const asked: Array<{ url: string; resolve: (r: Response) => void; reject: (e: unknown) => void }> = [];
globalThis.fetch = ((url: string) =>
  new Promise<Response>((resolve, reject) => { asked.push({ url: String(url), resolve, reject }); })) as typeof fetch;
let clock = 1_000_000;
Date.now = () => clock;

const { fetchMeta } = await import("../src/lib/api");
const answer = (n: number, body: unknown) => asked[n].resolve(new Response(JSON.stringify(body)));

console.log("\n— a request that fails after it was replaced —");
{
  // Slow enough to outlast the cache's five minutes, then failing.
  const slow = fetchMeta("1").catch(() => "failed");
  clock += 6 * 60_000;
  const replacement = fetchMeta("1");
  answer(1, { title: "Heat" });
  await replacement;
  asked[0].reject(new TypeError("Failed to fetch"));
  check("the first fails", await slow, "failed");
  const before = asked.length;
  void fetchMeta("1");
  check("its replacement is still kept: asked again, nothing is fetched", asked.length - before, 0);
}

console.log("\n— a request that fails —");
{
  const failing = fetchMeta("2").catch(() => "failed");
  asked[asked.length - 1].reject(new TypeError("Failed to fetch"));
  check("fails", await failing, "failed");
  const before = asked.length;
  void fetchMeta("2").catch(() => {});
  check("and isn't kept: asked again, it is fetched again", asked.length - before, 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
