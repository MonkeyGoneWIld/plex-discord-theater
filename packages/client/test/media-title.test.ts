/**
 * How a title reads in the player bar, the room and Discord presence.
 *
 * A multi-episode file (S02E18-E19) plays every episode in it, so it names them
 * all — the range and each title — rather than whichever entry was clicked.
 */
import { formatMediaTitle } from "../src/lib/format";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

const e18 = { title: "First Half", showTitle: "The Show", parentIndex: 2, index: 18 };
const both = [{ index: 18, title: "First Half" }, { index: 19, title: "Second Half" }];

check("an ordinary episode", formatMediaTitle(e18), "The Show — S2E18 · First Half");
check("a multi-episode file names both", formatMediaTitle({ ...e18, fileEpisodes: both }),
  "The Show — S2E18–E19 · First Half / Second Half");
check("the same from its second entry", formatMediaTitle({ ...e18, index: 19, title: "Second Half", fileEpisodes: both }),
  "The Show — S2E18–E19 · First Half / Second Half");
check("three episodes give the whole range", formatMediaTitle({ ...e18, index: 1, fileEpisodes: [
  { index: 1, title: "A" }, { index: 2, title: "B" }, { index: 3, title: "C" },
] }), "The Show — S2E1–E3 · A / B / C");
check("a list of one is an ordinary episode", formatMediaTitle({ ...e18, fileEpisodes: [both[0]] }),
  "The Show — S2E18 · First Half");
check("an untitled episode still reads", formatMediaTitle({ ...e18, fileEpisodes: [both[0], { index: 19, title: "" }] }),
  "The Show — S2E18–E19 · First Half / Episode 19");
check("films are untouched", formatMediaTitle({ title: "A Film", year: 1999 }), "A Film (1999)");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
