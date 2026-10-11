/**
 * lib/subtitleCues: which lines are up, and what a player knows of a subtitle
 * still being read.
 */
import { activeCues, coveredAhead, longestCue, withStretch, type CoveredSpan, type TimedCue } from "../src/lib/subtitleCues";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

const line = (start: number, end: number, text = `${start}`): TimedCue => ({ start, end, text });

console.log("— where every line has come —");
{
  const spans: CoveredSpan[] = [[0, 120], [3570, 4200], [6000, null]];
  check("inside the read from the start: how far it goes on", coveredAhead(spans, 100), 20);
  check("at its very end, not inside it", coveredAhead(spans, 120), null);
  check("in a quiet stretch between: nothing known", coveredAhead(spans, 1000), null);
  check("inside a stretch read around somewhere", coveredAhead(spans, 3600), 600);
  check("in one that runs to the end", coveredAhead(spans, 7000), Infinity);
  check("nothing yet", coveredAhead([], 0), null);
}

console.log("\n— an answer for one stretch —");
{
  const known = [line(10, 12), line(100, 102, "old"), line(200, 205), line(590, 610, "spans the edge")];
  const merged = withStretch(known, 50, 600, [line(100, 102, "new"), line(300, 301)]);
  check("replaces what was known inside it — a line running out of it too — keeps what is outside, in order",
    merged.map((c) => c.text), ["10", "new", "300"]);
  check("a line running into it from before is the answer's to say", withStretch([line(40, 55, "into")], 50, 600, []).length, 0);
  check("one ending where it starts is kept", withStretch([line(40, 50, "before")], 50, 600, []).length, 1);
  check("and the answer's lines are drawn", activeCues(merged, 300.5, longestCue(merged)).map((c) => c.text), ["300"]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
