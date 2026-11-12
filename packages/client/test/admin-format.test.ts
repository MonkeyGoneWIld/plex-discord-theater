/**
 * The dashboard's times, on the clock of whoever has it open.
 *
 * 12 November: every time on it was UTC, so someone in New York read a film
 * that started at 22:21 in the evening as starting at 03:21.
 */
import { dateTime, timeOfDay, timeZone, zoneLabel } from "../admin/format";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

const at = Date.UTC(2026, 10, 10, 23, 36, 4);
const summer = Date.UTC(2026, 6, 10, 23, 36, 4);
const seen = (zone: string) => {
  process.env.TZ = zone;
  return [dateTime(at), timeOfDay(at), zoneLabel(new Date(at)), timeZone()];
};

check("in New York, five hours behind", seen("America/New_York"), ["2026-11-10 18:36:04", "18:36:04", "UTC−5", "America/New_York"]);
check("  and four in summer: a time is on the clock of its own day", [dateTime(summer), zoneLabel(new Date(summer))], ["2026-07-10 19:36:04", "UTC−4"]);
check("in Kolkata, five and a half ahead, on the next day", seen("Asia/Kolkata").slice(0, 3), ["2026-11-11 05:06:04", "05:06:04", "UTC+5:30"]);
check("in Tokyo", seen("Asia/Tokyo").slice(0, 3), ["2026-11-11 08:36:04", "08:36:04", "UTC+9"]);
check("in UTC, as it is stored", seen("UTC").slice(0, 3), ["2026-11-10 23:36:04", "23:36:04", "UTC"]);
check("a time as text, as the server sends some", dateTime("2026-11-10T23:36:04.000Z"), "2026-11-10 23:36:04");
check("no time, or not one", [dateTime(null), dateTime(undefined), dateTime("soon"), timeOfDay(null), timeOfDay("soon")], ["—", "—", "—", "—", "—"]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
