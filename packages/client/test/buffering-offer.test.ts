/**
 * The "Buffering a lot?" hint (lib/bufferingOffer): offered only when a
 * player plainly can't keep its buffer and won't without a lower quality, and
 * taken down soon after the buffering stops.
 */
import { offerLower, starvedNow, takeOfferDown, type PlayerNow } from "../src/lib/bufferingOffer";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

const S = 1000;
/** The seconds of stalls lasting `lengths` seconds, `gapS` apart, ending at `end`. */
function stalls(lengths: number[], gapS: number, end: number): number[] {
  const at: number[] = [];
  let t = end - (lengths.reduce((a, b) => a + b, 0) + gapS * (lengths.length - 1)) * S;
  for (const n of lengths) {
    for (let i = 0; i < n; i++) at.push(t + i * S);
    t += (n + gapS) * S;
  }
  return at;
}
const playing: PlayerNow = {
  isHost: false, hostHoldingRoom: false, roomPlaying: true, paused: false, seeking: false,
  bufferAheadS: 9, readyState: 4,
};

console.log("\n— a stalled second —");
// 4 November, 20:32: a viewer took over a stream while the room waited for its
// host, kept the host's "the room waits for me" from it, and every second it
// played after counted as a stall: offered a lower quality every 12 s.
check("a viewer playing, with the room's wait for its host left over, isn't stalled",
  starvedNow({ ...playing, hostHoldingRoom: true }), false);
check("the host whose picture holds the room is", starvedNow({ ...playing, isHost: true, hostHoldingRoom: true }), true);
check("nothing in hand and nothing to show is", starvedNow({ ...playing, bufferAheadS: 0.1, readyState: 2 }), true);
check("a pause counts neither way", starvedNow({ ...playing, paused: true }), null);

console.log("\n— when it is offered —");
const now = 10_000_000;
check("not for one long stall: a join, a seek, a stream started again",
  offerLower(stalls([15], 0, now), now, 20000, 8000), false);
check("not for two", offerLower(stalls([12, 12], 30, now), now, 20000, 8000), false);
check("not for a few short ones", offerLower(stalls([3, 3, 3, 3], 20, now), now, 20000, 8000), false);
check("for stalls that keep coming, on a connection short of the stream",
  offerLower(stalls([7, 7, 7], 30, now), now, 20000, 8000), true);
check("and with nothing measured, on the stalls alone", offerLower(stalls([7, 7, 7], 30, now), now, 20000, null), true);
check("not when the connection carries more than the stream: the stalls are something else",
  offerLower(stalls([7, 7, 7], 30, now), now, 11686, 21657), false);

console.log("\n— when it goes —");
check("8 s after the last stall, with 6 s in hand", takeOfferDown(now - 8 * S, now, 6), true);
check("not 3 s after one, with little in hand", takeOfferDown(now - 3 * S, now, 4), false);
check("at once, with 16 s in hand", takeOfferDown(now - 1 * S, now, 16), true);
check("not with nothing in hand, however long since", takeOfferDown(now - 60 * S, now, 1), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
