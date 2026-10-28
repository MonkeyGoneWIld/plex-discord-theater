/**
 * Nothing drawn over the picture blurs what is behind it.
 *
 * A backdrop blur is made of the picture under it, and while one is over the
 * video Chrome stops showing the video as an overlay of its own and draws it
 * itself (Chromium's dc_layer_overlay.cc turns a video away as an overlay
 * where a backdrop filter could read it), which can come out in other colours.
 * Whatever the blur was on changed colour a few seconds after it came up: the
 * Back button, taken off for it on 20 September, put back the same day, and
 * seen changing again in run 26 (28 October). These are the files whose
 * surfaces sit over the picture: the player and what it draws.
 */
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

const OVER_PICTURE = [
  "Player", "Controls", "StatsOverlay", "TrackSwitcher", "QueuePanel", "NextUpButton", "EndCard", "PeoplePanel",
  "SkipMarkerButton", "TransportRequestCard", "SubtitleLayer", "PictureSubtitleLayer", "StyledSubtitleLayer",
  "SubtitleOffset", "SubtitleLook", "ZoomPanel",
];

console.log("— over the picture —");
for (const name of OVER_PICTURE) {
  const code = readFileSync(new URL(`../src/components/${name}.tsx`, import.meta.url), "utf8")
    // What its comments say of blurs isn't one.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const blurs = code.split("\n").filter((line) => /backdrop-?filter/i.test(line)).map((line) => line.trim());
  check(`${name} blurs nothing behind it`, blurs, []);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
