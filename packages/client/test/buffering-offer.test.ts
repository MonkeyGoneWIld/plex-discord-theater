/**
 * The "Buffering a lot?" hint (lib/bufferingOffer): offered only when a
 * player plainly can't keep its buffer and won't without a lower quality, and
 * taken down soon after the buffering stops.
 */
import { connectionKbps, offerLower, starvedNow, takeOfferDown, type PlayerNow } from "../src/lib/bufferingOffer";

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
  bufferAheadS: 9, readyState: 4, waitingOutStall: false,
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
const waitingPast = { ...playing, paused: true, seeking: true, bufferAheadS: 0, readyState: 1 };
check("a wait past the room for the data a stall wanted is, seeking and paused",
  starvedNow({ ...waitingPast, waitingOutStall: true }), true);
check("and with its picture in, still waiting for the room",
  starvedNow({ ...waitingPast, waitingOutStall: true, seeking: false, bufferAheadS: 6, readyState: 4 }), true);
check("not a wait past the room on joining", starvedNow(waitingPast), null);
check("not with the room paused", starvedNow({ ...waitingPast, waitingOutStall: true, roomPlaying: false }), null);

console.log("\n— when it is offered —");
const now = 10_000_000;
check("not for one long stall: a join, a seek, a stream started again",
  offerLower(stalls([15], 0, now), now, 20000, 8000), false);
check("not for two short ones", offerLower(stalls([3, 3], 30, now), now, 20000, 8000), false);
check("not for a few short ones, under 12 s in all", offerLower(stalls([2, 2, 2, 2, 2], 20, now), now, 20000, 8000), false);
// 5 November, Pirates of the Caribbean: 26 s over two stretches before it
// came, 43 s after the stalls began.
check("for two that come back, 12 s in all", offerLower(stalls([6, 6], 15, now), now, 24693, 10500), true);
check("for stalls that keep coming, on a connection short of the stream",
  offerLower(stalls([7, 7, 7], 30, now), now, 20000, 8000), true);
check("and with nothing measured, on the stalls alone", offerLower(stalls([7, 7, 7], 30, now), now, 20000, null), true);
check("not when the connection carries more than the stream: the stalls are something else",
  offerLower(stalls([7, 7, 7], 30, now), now, 11686, 21657), false);

console.log("\n— 12 Angry Men, 5 November, the laptop —");
// Its own HEVC stream, 19953 kbps, came in at 8 to 15 Mbps. From the log, in
// seconds after 01:49:46: stalls while playing, and the waits past the room
// each stall went on to (the second-long seek after a wait counts neither way).
{
  const stalled: Array<[number, number]> = [[3.2, 4.8], [60.3, 61.1], [64.1, 65.4], [73.2, 73.4],
    [76.4, 77.4], [86.4, 86.5], [92.5, 93.9], [132.3, 132.7], [150.7, 151.5], [154.6, 155.7]];
  const waits: Array<[number, number]> = [[4.8, 18.5], [65.4, 69.7], [93.9, 99.7], [155.7, 159.7], [161.2, 177.7]];
  const seeking: Array<[number, number]> = [[69.7, 70.5], [159.7, 161.2]];
  const inside = (spans: Array<[number, number]>, t: number) => spans.some(([a, b]) => t >= a && t < b);
  const t0 = 20_000_000;
  const seconds: number[] = [];
  let offeredAt: number | null = null;
  for (let t = 0; t <= 180; t++) {
    const now = t0 + t * S;
    const state: PlayerNow = inside(waits, t) ? { ...waitingPast, waitingOutStall: true }
      : inside(seeking, t) ? { ...playing, seeking: true, bufferAheadS: 0, readyState: 1 }
      : inside(stalled, t) ? { ...playing, bufferAheadS: 0.06, readyState: 2 }
      : { ...playing, bufferAheadS: 3 };
    if (starvedNow(state) !== true) continue;
    seconds.push(now);
    if (offeredAt === null && offerLower(seconds, now, 19953, 12600)) offeredAt = t;
  }
  check("five stalls and their waits, 3 minutes: offered", offeredAt !== null, true);
  check("at its second stall, a minute in", offeredAt !== null && offeredAt >= 55 && offeredAt <= 65, true);
}

console.log("\n— what the connection brings in —");
{
  // Pirates of the Caribbean, 5 November: 10.5 Mbps over three minutes, in
  // ten-second stretches of 2 to 23, the last 8 s of them at 7.9.
  const t0 = 30_000_000;
  const samples: Array<[number, number]> = [];
  const earlierBytes = (10_500_000 * 180 - 7_900_000 * 8) / 172 / 8;
  for (let t = 0; t < 172; t++) samples.push([t0 + t * S, earlierBytes]);
  for (let t = 172; t < 180; t++) samples.push([t0 + t * S, 7_900_000 / 8]);
  check("over the last three minutes, not the last 8 s", connectionKbps(samples, t0 + 180 * S, t0 - 60 * S), 10500);
  const young: Array<[number, number]> = [];
  for (let t = 0; t < 30; t++) young.push([t0 + t * S, 12_000_000 / 8]);
  check("a stream 30 s old, over its 30 s", connectionKbps(young, t0 + 30 * S, t0), 12000);
  const old: Array<[number, number]> = [[t0, 50_000_000], [t0 + 200 * S, 1_000_000]];
  connectionKbps(old, t0 + 200 * S, t0 - 600 * S);
  check("what came in over three minutes ago is dropped", old.length, 1);
}

console.log("\n— when it goes —");
check("8 s after the last stall, with 6 s in hand", takeOfferDown(now - 8 * S, now, 6), true);
check("not 3 s after one, with little in hand", takeOfferDown(now - 3 * S, now, 4), false);
check("at once, with 16 s in hand", takeOfferDown(now - 1 * S, now, 16), true);
check("not with nothing in hand, however long since", takeOfferDown(now - 60 * S, now, 1), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
