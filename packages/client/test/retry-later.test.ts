/**
 * A failed request tried again (lib/retryLater): a picture subtitle is asked
 * for again after a moment's network failure rather than burned in.
 */
import { retryDelayMs } from "../src/lib/retryLater";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

/** What 2 Guns' subtitle failed on, on 5 November. */
const blip = new TypeError("Failed to fetch");

console.log("— a moment's failure —");
check("Failed to fetch: again in 1 s", retryDelayMs(blip, 0), 1_000);
check("  then 2 s", retryDelayMs(blip, 1), 2_000);
check("  then 4 s", retryDelayMs(blip, 2), 4_000);
check("  and a fourth in a row given up on", retryDelayMs(blip, 3), null);
check("a 502 from the proxy: again", retryDelayMs(new Error("API error 502: /api/plex/pgs/1"), 0), 1_000);
check("a 503: again", retryDelayMs(new Error("API error 503: /api/plex/pgs/1"), 1), 2_000);
check("429: again", retryDelayMs(new Error("API error 429: /api/plex/pgs/1"), 0), 1_000);

console.log("\n— one that will be the same next time —");
check("404 with no word from the server: given up on", retryDelayMs(new Error("API error 404: /api/plex/pgs/1/0"), 0), null);
check("the server's own error: given up on", retryDelayMs(new Error("Subtitle not available"), 0), null);
check("a stop asked for: not tried again", retryDelayMs(new DOMException("The user aborted a request.", "AbortError"), 0), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
