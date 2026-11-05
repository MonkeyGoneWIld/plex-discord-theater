/**
 * Where a stream this player drives starts with nothing pending
 * (lib/ownStreamStart).
 */
import { ownStreamStart } from "../src/lib/ownStreamStart";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

// 5 November, 02:30: the laptop's own stream of 12 Angry Men, the room at
// 1188.72, started from 0:00 seven times over.
check("a viewer that has shown nothing of it: where the room is",
  ownStreamStart(0, false, 1188.72), { atS: 1188.72, from: "room" });
check("its last picture, when it has one", ownStreamStart(1205.6, false, 1220), { atS: 1205.6, from: "last picture" });
check("a host: nothing, its title starts or resumes as it would", ownStreamStart(0, true, 1188.72), null);
check("the room on another title: nothing", ownStreamStart(0, false, null), null);
check("the room at its start: nothing", ownStreamStart(0, false, 0), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
