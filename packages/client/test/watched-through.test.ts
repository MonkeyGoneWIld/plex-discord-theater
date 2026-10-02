/**
 * When a host pressing Back has finished the title.
 *
 * Past this point Back ends the stream outright — no PiP, no warning, even with
 * other people in the room — so it must not fire for someone mid-film. A title
 * with a credits marker is finished at the first one and nowhere else; only a
 * title without one falls back to the share of the runtime the server counts
 * as watched.
 */
import { isWatchedThrough } from "../src/lib/watchedThrough";
import type { SkipMarker } from "../src/lib/api";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

const film = 6000; // 100 minutes
const intro: SkipMarker = { type: "intro", start: 30, end: 90 };
const credits: SkipMarker = { type: "credits", start: 5200, end: 5700 };
const postCredits: SkipMarker = { type: "credits", start: 5800, end: 5990 };

console.log("threshold only (no credits markers)");
check("mid-film is not finished", isWatchedThrough(3000, film, []), false);
check("just short of the default 90%", isWatchedThrough(5399, film, []), false);
check("exactly the default 90%", isWatchedThrough(5400, film, []), true);
check("past it", isWatchedThrough(5900, film, []), true);
check("the server's own threshold is honoured", isWatchedThrough(5100, film, [], 0.85), true);
check("…in both directions", isWatchedThrough(5500, film, [], 0.95), false);

console.log("credits markers");
check("credits before the threshold finish it", isWatchedThrough(5200, film, [intro, credits]), true);
check("just before the credits", isWatchedThrough(5199, film, [intro, credits]), false);
check("the first credits marker, not a later one", isWatchedThrough(5250, film, [postCredits, credits]), true);
const lateCredits: SkipMarker = { type: "credits", start: 5700, end: 5900 };
check("past the threshold but before late credits is not finished", isWatchedThrough(5500, film, [lateCredits]), false);
check("…and is once the late credits start", isWatchedThrough(5700, film, [lateCredits]), true);
check("a lower threshold doesn't override the marker", isWatchedThrough(5100, film, [credits], 0.8), false);
check("an intro marker is not an ending", isWatchedThrough(100, film, [intro]), false);
check("intro-only titles fall back to the threshold", isWatchedThrough(5400, film, [intro]), true);

console.log("unknowns");
check("unknown runtime falls back to credits only", isWatchedThrough(5300, 0, [credits]), true);
check("unknown runtime and no credits is never finished", isWatchedThrough(5900, 0, []), false);
check("nothing played yet", isWatchedThrough(0, film, [{ type: "credits", start: 0, end: 10 }]), false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
