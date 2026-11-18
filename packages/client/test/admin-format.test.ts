/**
 * The dashboard's times, on the clock of whoever has it open, in 12-hour time.
 *
 * 12 November: every time on it was UTC, so someone in New York read a film
 * that started at 22:21 in the evening as starting at 03:21.
 * 18 November: the dashboard is to use a 12-hour clock: "6:36:04 PM", not "18:36:04".
 */
import { dateTime, dayDate, dayTime, duration, hourLabel, hoursMinutes, shortTime, timeOfDay, timeZone, zoneLabel } from "../admin/format";

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

check("in New York, five hours behind", seen("America/New_York"), ["2026-11-10 6:36:04 PM", "6:36:04 PM", "UTC−5", "America/New_York"]);
check("  and four in summer: a time is on the clock of its own day", [dateTime(summer), zoneLabel(new Date(summer))], ["2026-07-10 7:36:04 PM", "UTC−4"]);
check("in Kolkata, five and a half ahead, on the next day", seen("Asia/Kolkata").slice(0, 3), ["2026-11-11 5:06:04 AM", "5:06:04 AM", "UTC+5:30"]);
check("in Tokyo", seen("Asia/Tokyo").slice(0, 3), ["2026-11-11 8:36:04 AM", "8:36:04 AM", "UTC+9"]);
check("in UTC, as it is stored", seen("UTC").slice(0, 3), ["2026-11-10 11:36:04 PM", "11:36:04 PM", "UTC"]);
check("a time as text, as the server sends some", dateTime("2026-11-10T23:36:04.000Z"), "2026-11-10 11:36:04 PM");
check("midnight and noon on a 12-hour clock", [timeOfDay(Date.UTC(2026, 10, 10, 0, 5, 0)), timeOfDay(Date.UTC(2026, 10, 10, 12, 5, 0))], ["12:05:00 AM", "12:05:00 PM"]);
check("the short forms: a time, a day and a time, an hour", [shortTime(at), dayTime(at, at), hourLabel(0), hourLabel(13), hourLabel(12)],
  ["11:36 PM", "10 Nov, 11:36 PM", "12 AM", "1 PM", "12 PM"]);
check("  a day of another year says its year", [dayDate(at, Date.UTC(2027, 0, 5)), dayTime(at, Date.UTC(2027, 0, 5))], ["10 Nov 2026", "10 Nov 2026, 11:36 PM"]);
check("how long something took, in one form wherever it is shown", [duration(640), duration(6600), duration(38_000), duration(200_000), duration(3_725_000)],
  ["640 ms", "6.6 s", "38 s", "3:20", "1:02:05"]);
check("a whole number of seconds without a trailing .0", duration(6000), "6 s");
check("a total of time, in hours and minutes", [hoursMinutes(40), hoursMinutes(2700), hoursMinutes(60_747)], ["40 s", "45 min", "16 h 52 min"]);
check("no time, or not one", [dateTime(null), dateTime(undefined), dateTime("soon"), timeOfDay(null), timeOfDay("soon")], ["—", "—", "—", "—", "—"]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
