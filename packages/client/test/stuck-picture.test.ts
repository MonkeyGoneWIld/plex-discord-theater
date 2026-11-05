/**
 * A decoder that has stopped giving pictures (lib/stuckPicture): the laptop
 * of 5 November, with the video in hand and no picture, or a frame in 2.5 s,
 * is found out in 10 s; a picture that is only waiting for its video, hidden,
 * paused, or slow to decode a seek is not.
 */
import { lookVerdict, stuckLongEnough, stuckSince, STUCK_TICK_S, type PictureLook } from "../src/lib/stuckPicture";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

const base: PictureLook = {
  at: 0, hidden: false, paused: false, seeking: false, readyState: 4, hasVideo: true,
  aheadS: 20, time: 100, shown: 1000, dropped: 0,
};
/** Looks every STUCK_TICK_S, each from `step` of the one before. */
function looks(n: number, step: (prev: PictureLook, i: number) => Partial<PictureLook>, first: Partial<PictureLook> = {}): PictureLook[] {
  const out: PictureLook[] = [{ ...base, ...first }];
  for (let i = 1; i < n; i++) {
    const prev = out[i - 1];
    out.push({ ...prev, at: prev.at + STUCK_TICK_S, ...step(prev, i) });
  }
  return out;
}
/** When, if ever, the looks say it is stuck long enough: seconds from the first. */
function stuckAt(all: PictureLook[]): number | null {
  let since: number | null = null;
  for (let i = 1; i < all.length; i++) {
    since = stuckSince(since, all[i - 1], all[i]);
    if (stuckLongEnough(since, all[i])) return all[i].at - all[0].at;
  }
  return null;
}

console.log("— the laptop of 5 November —");
// 00:30:20: seeking=true readyState=1, 655.03–675.93 in hand at 657.96, for 16 s.
const seekStuck = looks(10, () => ({}), { seeking: true, readyState: 1, aheadS: 17.97, time: 657.96 });
check("a seek with 18 s in hand and no picture: no picture", lookVerdict(seekStuck[0], seekStuck[1]), "no picture");
check("  found out after 10 s", stuckAt(seekStuck), 10);
// 00:33:36: Hot Fuzz playing, 4 frames in 10 s, the page painting 60 a second.
const hotFuzz = looks(10, (p, i) => ({ time: p.time + 2, shown: p.shown + (i % 2) }), { aheadS: 13.75 });
check("playing, a frame in 4 s: barely moving", lookVerdict(hotFuzz[0], hotFuzz[1]), "barely moving");
check("  found out after 10 s", stuckAt(hotFuzz), 10);
// 00:02: 3 from Hell, H.264 on the same Discord: paused at 0, readyState 1, 45 s in hand.
const neverStarted = looks(10, () => ({}), { paused: true, readyState: 1, aheadS: 45.2, time: 0, shown: 0 });
check("paused at the start with 45 s in hand and no picture: found out after 10 s", stuckAt(neverStarted), 10);

console.log("\n— a picture that is fine —");
const smooth = looks(30, (p) => ({ time: p.time + 2, shown: p.shown + 48 }));
check("24 frames a second: moving", lookVerdict(smooth[0], smooth[1]), "moving");
check("  never stuck", stuckAt(smooth), null);
const slowFilm = looks(30, (p) => ({ time: p.time + 2, shown: p.shown + 30 }));
check("a page held to 15 frames a second (29 October): moving", stuckAt(slowFilm), null);
const paused = looks(30, () => ({}), { paused: true });
check("paused, a picture up: never stuck", stuckAt(paused), null);

console.log("\n— no picture that isn't the decoder's —");
const starved = looks(30, () => ({}), { seeking: true, readyState: 1, aheadS: 0.5 });
check("seeking with half a second in hand: waiting for video, never stuck", stuckAt(starved), null);
const hidden = looks(30, () => ({}), { hidden: true, readyState: 1 });
check("no picture on a page not shown: never stuck", stuckAt(hidden), null);
const slowSeek = looks(30, (p, i) => (i < 4 ? {} : { seeking: false, readyState: 4, time: p.time + 2, shown: p.shown + 48 }), { seeking: true, readyState: 1 });
check("a seek that decodes for 6 s, then plays: never stuck", stuckAt(slowSeek), null);
const sound = looks(30, (p) => ({ time: p.time + 2 }), { hasVideo: false });
check("a stream with no picture: never stuck", stuckAt(sound), null);
const rebuilt = looks(30, (p, i) => ({ readyState: i % 4 === 0 ? 0 : 1 }), { readyState: 1, seeking: true });
check("a stream rebuilt every 8 s, nothing in between: never stuck", stuckAt(rebuilt), null);
const afterPlaying = looks(12, (p, i) => (i === 1 ? { shown: 0, dropped: 0 } : {}), { readyState: 1, seeking: true });
check("a new stream counting from 0 starts the stretch again: found out 10 s after it", stuckAt(afterPlaying), 12);
const lateTimer = looks(30, (p) => ({ at: p.at + 5 }), { readyState: 1, seeking: true });
check("a timer 5 s late each time (a page in the background): never stuck", stuckAt(lateTimer), null);
const tabbedAway = looks(30, (p, i) => ({ hidden: i % 4 === 0 }), { readyState: 1, seeking: true });
check("hidden every 8 s: each stretch starts again, never stuck", stuckAt(tabbedAway), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
