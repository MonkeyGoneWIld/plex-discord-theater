/**
 * The play button after a press (lib/pressIntent.ts).
 *
 * 18 November, 10:12:13 UTC, the test bot: a co-host pressed pause; 120 ms
 * later their player followed a room state sent before the pause reached the
 * server ("following room into play"), and 150 ms after that the pause
 * ("following room into pause"). The button followed the element: pause,
 * play, pause. On a play pressed while the host's picture loads, the button
 * showed playing (held for the room), then paused for the moment between the
 * room's answer and the element starting, then playing.
 */
import { INTENT_MAX_MS, INTENT_SETTLE_MS, shownPlaying, type PressIntent } from "../src/lib/pressIntent";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; return; }
  fail++;
  console.log(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
}

/** The button through a run of the element's states: what it showed at each, and how many times it changed. */
function run(intent: PressIntent | null, steps: Array<[number, boolean, boolean]>, before: boolean) {
  const shown = steps.map(([at, element, held]) => shownPlaying(intent, element, held, at));
  let changes = 0;
  let last = before;
  for (const s of shown) { if (s !== last) changes++; last = s; }
  return { shown, changes };
}

// A co-host's pause, as the log has it: paused at once, played by a stale room state at +122 ms, paused at +268 ms.
{
  const t0 = 1_000_000;
  const pause = run({ playing: false, at: t0 }, [[t0, false, false], [t0 + 122, true, false], [t0 + 268, false, false], [t0 + INTENT_SETTLE_MS + 1, false, false]], true);
  check("a co-host's pause: the button shows paused throughout", pause.shown, [false, false, false, false]);
  check("a co-host's pause: one change of the button", pause.changes, 1);
}

// A play pressed while the host's picture loads: held for the room, then the moment before the element starts, then playing.
{
  const t0 = 2_000_000;
  const play = run({ playing: true, at: t0 }, [[t0, false, true], [t0 + 900, false, false], [t0 + 950, true, false], [t0 + INTENT_SETTLE_MS + 1, true, false]], false);
  check("a play while the host loads: the button shows playing throughout", play.shown, [true, true, true, true]);
  check("a play while the host loads: one change of the button", play.changes, 1);
}

// A press the room did not take (control taken away, the server refused): the button goes back to what the player does.
{
  const t0 = 3_000_000;
  check("a play not taken: shown as pressed at first", shownPlaying({ playing: true, at: t0 }, false, false, t0 + 2000), true);
  check("a play not taken: the player's state once the limit passes", shownPlaying({ playing: true, at: t0 }, false, false, t0 + INTENT_MAX_MS), false);
}

// Past the settle time, a press the player has not done yet still shows; once it has, Controls clears the press and the element decides.
{
  const t0 = 4_000_000;
  check("past the settle time, not yet done: still shown as pressed", shownPlaying({ playing: true, at: t0 }, false, false, t0 + INTENT_SETTLE_MS + 500), true);
  check("past the settle time, done: the element decides", shownPlaying({ playing: true, at: t0 }, true, false, t0 + INTENT_SETTLE_MS + 500), true);
  check("no press: the element decides", shownPlaying(null, false, false, t0), false);
  check("no press: held for the room shows playing", shownPlaying(null, false, true, t0), true);
}

console.log(`press-intent: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
