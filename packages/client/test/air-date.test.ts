/**
 * How an episode page writes the day it aired: "28th September 2026", the
 * suffix kept apart so the page can set it small.
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

const written = (iso: string) => {
  const d = formatAirDate(iso);
  return d && `${d.day}${d.suffix} ${d.rest}`;
};

check("parts", formatAirDate("2026-09-28"), { day: "28", suffix: "th", rest: "September 2026" });
check("1st", written("2017-04-01"), "1st April 2017");
check("2nd", written("2017-04-02"), "2nd April 2017");
check("3rd", written("2017-04-03"), "3rd April 2017");
check("4th", written("2017-04-04"), "4th April 2017");
check("11th, not 11st", written("2017-04-11"), "11th April 2017");
check("12th, not 12nd", written("2017-04-12"), "12th April 2017");
check("13th, not 13rd", written("2017-04-13"), "13th April 2017");
check("21st", written("2017-04-21"), "21st April 2017");
check("22nd", written("2017-04-22"), "22nd April 2017");
check("23rd", written("2017-04-23"), "23rd April 2017");
check("31st", written("2017-12-31"), "31st December 2017");
check("no leading zero on the day", written("2005-03-05"), "5th March 2005");
check("January is month one", written("2005-01-15"), "15th January 2005");
check("the day as written, whatever the time zone", written("2026-01-01"), "1st January 2026");
check("a timestamp after the date is ignored", written("2026-09-28T00:00:00Z"), "28th September 2026");
check("no date", formatAirDate(undefined), null);
check("empty", formatAirDate(""), null);
check("not a date", formatAirDate("September 2026"), null);
check("month 13", formatAirDate("2026-13-01"), null);
check("day 0", formatAirDate("2026-09-00"), null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
