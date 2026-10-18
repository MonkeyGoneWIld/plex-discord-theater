/**
 * Which segment the picture needs next (lib/nextNeeded), on the shapes hls.js
 * gives an ffmpeg engine stream: a parsed segment ending at its video, after
 * its audio; the unparsed ones after it moved on to match at a reload; what is
 * held ending at the audio.
 */
import { NEXT_NEEDED_SLACK_S, nextNeededSegment } from "../src/lib/nextNeeded";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

const url = (i: number) => `https://bot.test/api/plex/hls/seg?p=%2Fbase%2F0000${i}.ts&n=4500000`;
// f5ed2f59 on 18 October: segments from 4186.02, 2.99 s each; seg2 parsed,
// ending at its video, 4195.02, where its audio, and the buffer, end at
// 4194.96; seg3 and seg4, unparsed, start from seg2's video end.
const segs = [
  { start: 4186.02, duration: 2.97, url: url(0) },
  { start: 4188.99, duration: 2.97, url: url(1) },
  { start: 4191.96, duration: 3.06, url: url(2) },
  { start: 4195.02, duration: 2.99, url: url(3) },
  { start: 4198.01, duration: 2.99, url: url(4) },
];
const none = new Set<string>();

console.log("\n— the segment the picture needs next —");
{
  const oldRule = segs.find((s) => s.start + s.duration > 4194.96 + 0.05)?.url;
  check("the old rule named seg2, already in, for its video ending 0.06 s past the buffer", oldRule, url(2));
  check("now: seg3, the one the picture waits on", nextNeededSegment(segs, 4194.96, none), url(3));
  check("and so whatever the gap, for a segment the engine has", nextNeededSegment(segs, 4194.5, new Set([url(0), url(1), url(2)])), url(3));
  check("a segment not in yet is the one, held to the end of the one before", nextNeededSegment(segs, 4191.96, new Set([url(0), url(1)])), url(2));
  check("and one half in, that the engine hasn't got", nextNeededSegment(segs, 4193.5, new Set([url(0), url(1)])), url(2));
  check("a gap in the playlist is never it", nextNeededSegment([{ ...segs[3], gap: true }, segs[4]], 4194.96, none), url(4));
  check("nothing past what is held: none", nextNeededSegment(segs, 4201, none), null);
  check("the slack is the 0.3 s the rest of the player allows", NEXT_NEEDED_SLACK_S, 0.3);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
