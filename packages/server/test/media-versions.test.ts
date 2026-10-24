/**
 * Which of a title's files are offered, and which one is the default.
 */
import { playableVersionOrder } from "../src/services/media-versions.js";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

console.log("\n— a title's files, best first —");
const uhd = { videoResolution: "4k", width: 3840, height: 1608, bitrate: 60000 };
const fhd = { videoResolution: "1080", width: 1920, height: 804, bitrate: 12000 };
const hd = { videoResolution: "720", width: 1280, height: 536, bitrate: 4000 };
check("a 4K copy beside a 1080p one is offered, after it", playableVersionOrder([uhd, fhd]), [1, 0]);
check("after every lower one: the default stays 1080p", playableVersionOrder([uhd, hd, fhd]), [2, 1, 0]);
check("two 4K copies go best first, after the 1080p", playableVersionOrder([uhd, fhd, { ...uhd, bitrate: 80000 }]), [1, 2, 0]);
check("only 4K (Andor): it is the default", playableVersionOrder([uhd]), [0]);
check("nothing in 4K: best first, as before", playableVersionOrder([hd, fhd]), [1, 0]);
check("no files, nothing", playableVersionOrder([]), []);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
