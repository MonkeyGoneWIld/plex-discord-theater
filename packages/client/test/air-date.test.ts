/**
 * How an episode page writes the day it aired: "June 3, 2005".
 */
import { formatAirDate } from "../src/lib/format";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

check("month, day, year", formatAirDate("2005-06-03"), "June 3, 2005");
check("no leading zero on the day", formatAirDate("2017-04-08"), "April 8, 2017");
check("two-digit day", formatAirDate("2026-09-28"), "September 28, 2026");
check("January is month one", formatAirDate("2005-01-15"), "January 15, 2005");
check("December is month twelve", formatAirDate("2017-12-31"), "December 31, 2017");
check("the day as written, whatever the time zone", formatAirDate("2026-01-01"), "January 1, 2026");
check("a timestamp after the date is ignored", formatAirDate("2026-09-28T00:00:00Z"), "September 28, 2026");
check("no date", formatAirDate(undefined), null);
check("empty", formatAirDate(""), null);
check("not a date", formatAirDate("September 2026"), null);
check("month 13", formatAirDate("2026-13-01"), null);
check("day 0", formatAirDate("2026-09-00"), null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
