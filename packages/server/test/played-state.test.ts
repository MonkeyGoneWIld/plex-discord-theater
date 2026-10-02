/**
 * When a title counts as watched.
 *
 * A credits marker, when Plex found one, is the only thing that decides it —
 * the percentage must not mark a title watched early because it happens to come
 * first. Only a title without credits falls back to the server's "Video played
 * threshold". Pinned down both for the rule itself and for the history row it
 * feeds, since that flag is what gets scrobbled to linked Plex accounts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.THUMB_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "played-state-"));
process.env.PLEX_URL = "http://plex.test";
process.env.PLEX_TOKEN = "server-token";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

const DURATION_MS = 100_000;
/** ratingKey → where its first credits marker starts, or null for none. */
const credits = new Map<string, number | null>([
  ["1", null],
  ["2", null],
  ["3", 95_000],
  ["4", 95_000],
  ["5", 70_000],
]);
let markersRequested = false;

globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
  if (url.pathname === "/:/prefs") {
    return Response.json({
      MediaContainer: { Setting: [{ id: "LibraryVideoPlayedThreshold", value: 85 }] },
    });
  }
  const match = url.pathname.match(/^\/library\/metadata\/(\d+)$/);
  if (match) {
    if (url.searchParams.get("includeMarkers") === "1") markersRequested = true;
    const start = credits.get(match[1]) ?? null;
    return Response.json({
      MediaContainer: {
        Metadata: [{
          ratingKey: match[1], title: `Title ${match[1]}`, type: "movie", duration: DURATION_MS,
          Marker: [
            { type: "intro", startTimeOffset: 1_000, endTimeOffset: 5_000 },
            ...(start === null ? [] : [
              // Out of order on purpose: the earliest one counts, not the first listed.
              { type: "credits", startTimeOffset: start + 3_000, endTimeOffset: DURATION_MS },
              { type: "credits", startTimeOffset: start, endTimeOffset: start + 2_000 },
            ]),
          ],
        }],
      },
    });
  }
  return new Response("not mocked", { status: 404 });
};

const { isWatchedThrough, firstCreditsStartMs, playedThreshold } = await import("../src/services/played-state.js");

console.log("— the rule —");
check("no credits: short of the threshold", isWatchedThrough(89_000, DURATION_MS, null, 0.9), false);
check("no credits: at the threshold", isWatchedThrough(90_000, DURATION_MS, null, 0.9), true);
check("credits: the threshold is ignored before them", isWatchedThrough(94_000, DURATION_MS, 95_000, 0.9), false);
check("credits: watched once they start", isWatchedThrough(95_000, DURATION_MS, 95_000, 0.9), true);
check("credits: early credits finish it before the threshold", isWatchedThrough(70_000, DURATION_MS, 70_000, 0.9), true);
check("no runtime and no credits is never watched", isWatchedThrough(90_000, 0, null, 0.9), false);
check("nothing played is never watched", isWatchedThrough(0, DURATION_MS, 0, 0.9), false);

console.log("— reading markers —");
check("no markers", firstCreditsStartMs(undefined), null);
check("intro only", firstCreditsStartMs([{ type: "intro", startTimeOffset: 1_000 }]), null);
check("the earliest credits marker", firstCreditsStartMs([
  { type: "credits", startTimeOffset: 98_000 },
  { type: "intro", startTimeOffset: 1_000 },
  { type: "credits", startTimeOffset: 95_000 },
]), 95_000);

console.log("— the server's threshold —");
check("read from Plex's prefs", await playedThreshold(), 0.85);

console.log("— history rows —");
const history = await import("../src/services/watch-history.js");
const watchedAt = async (ratingKey: string, seconds: number) =>
  (await history.recordProgress("user", ratingKey, seconds, { force: true }))?.watched;
check("no credits: below the server's 85%", await watchedAt("1", 84), false);
check("no credits: past the server's 85%", await watchedAt("2", 86), true);
check("credits at 95%: past the threshold is still not watched", await watchedAt("3", 90), false);
check("credits at 95%: watched once they start", await watchedAt("4", 95), true);
check("credits at 70%: watched well before the threshold", await watchedAt("5", 75), true);
check("markers are asked for with the item", markersRequested, true);
check("rewinding out of the credits clears it again", await watchedAt("4", 50), false);

history.closeHistoryDb();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
