/**
 * Plex's Now Playing for the FFmpeg engine's streams: the order its reports
 * reach Plex in. (What each report says is checked in ffmpeg-copy.test.ts.)
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

process.env.THUMB_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "plex-report-"));

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       expected ${e}\n       got      ${a}`); }
}

/** The states reported, in the order Plex got them. */
const arrived: string[] = [];
/** "stopped" reports Plex answers with a 500, as one it couldn't take. */
let refuseStops = 0;
const plex = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/:/timeline") arrived.push(url.searchParams.get("state") ?? "?");
  if (url.pathname === "/:/timeline" && url.searchParams.get("state") === "stopped" && refuseStops > 0) {
    refuseStops--;
    res.statusCode = 500;
    res.end();
    return;
  }
  res.setHeader("Content-Type", "application/json");
  res.end("{}");
});
await new Promise<void>((r) => plex.listen(0, "127.0.0.1", r));
process.env.PLEX_URL = `http://127.0.0.1:${(plex.address() as AddressInfo).port}`;
process.env.PLEX_TOKEN = "test-token";
process.env.PLAYBACK_ENGINE = "ffmpeg";

const report = await import("../src/services/ffmpeg/plex-report.js");
type Now = ReturnType<Parameters<typeof report.reportFrom>[0]>;
/** Holds the title's length until let go: a report slow on its way to Plex. */
let letGo: () => void = () => {};
let slow = false;
let now: Now = [];
report.reportFrom(() => now, async () => {
  if (slow) await new Promise<void>((r) => { letGo = r; });
  return 60_000;
});
const stream = (positionS: number): Now =>
  [{ key: "room:0:0:1", sessionId: "aaaaaaaa-0000-4000-8000-000000000001", ratingKey: "1", positionS, state: "playing" }];
const settle = () => new Promise((r) => setTimeout(r, 200));

console.log("\n— a stream that goes while its report is on the way —");
slow = true;
now = stream(12);
const playing = report.plexReportTick(1_000_000);
await settle();
slow = false;
now = [];
const stopped = report.plexReportTick(1_000_000 + 20_000);
await settle();
letGo();
await Promise.all([playing, stopped]);
await settle();
check("Plex hears it playing, then stopped: not playing after it stopped", arrived, ["playing", "stopped"]);

console.log("\n— the server going down while a report is on the way —");
arrived.length = 0;
slow = true;
now = stream(30);
const again = report.plexReportTick(2_000_000);
await settle();
slow = false;
const down = report.reportAllStopped();
await settle();
letGo();
await Promise.all([again, down]);
await settle();
check("the same", arrived, ["playing", "stopped"]);

console.log("\n— a stop Plex doesn't take —");
{
  // 8 November, Ali G: paused, then left, and in Now Playing for hours.
  report.STOP_RETRY_MS.splice(0, report.STOP_RETRY_MS.length, 50, 50);
  arrived.length = 0;
  refuseStops = 2;
  now = stream(40);
  await report.plexReportTick(3_000_000);
  now = [];
  await report.plexReportTick(3_000_000 + 20_000);
  await new Promise((r) => setTimeout(r, 400));
  check("sent again until Plex takes it", arrived, ["playing", "stopped", "stopped", "stopped"]);
  arrived.length = 0;
  refuseStops = 5;
  now = stream(50);
  await report.plexReportTick(4_000_000);
  now = [];
  await report.plexReportTick(4_000_000 + 20_000);
  await new Promise((r) => setTimeout(r, 400));
  check("  but not for ever", arrived, ["playing", "stopped", "stopped", "stopped"]);
  refuseStops = 0;
}

plex.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
