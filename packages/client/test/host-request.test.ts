/**
 * Asking an away host for the role, as the People tab shows it
 * (lib/hostRequest), and when this player counts as away (lib/away).
 */
import { clock, fromMessage, requestButton, waitText } from "../src/lib/hostRequest";
import { isAway } from "../src/lib/away";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       expected ${e}\n       got      ${a}`); }
}

// This clock is 2 s behind the server's.
const local = 1_000_000;
const server = local + 2_000;
const view = (m: Record<string, unknown>) => fromMessage({ type: "host-request", on: true, now: server, ...m }, local);

console.log("\n— the People tab's button —");
check("may ask", requestButton(view({ blocked: null }), "me", local), { kind: "ask" });
check("asked by me: my countdown",
  requestButton(view({ active: { requesterId: "me", requesterName: "Me", endsAt: server + 90_000 }, blocked: { why: "asked", until: server + 90_000 } }), "me", local),
  { kind: "mine", leftMs: 90_000 });
check("asked by someone else: who, and the time left",
  requestButton(view({ active: { requesterId: "bea", requesterName: "Bea", endsAt: server + 61_000 }, blocked: { why: "asked" } }), "me", local),
  { kind: "theirs", name: "Bea", leftMs: 61_000 });
check("declined: a wait",
  requestButton(view({ blocked: { why: "you-declined", until: server + 3_600_000 } }), "me", local),
  { kind: "wait", why: "you-declined", leftMs: 3_600_000 });
check("  over: may ask", requestButton(view({ blocked: { why: "declined", until: server - 1 } }), "me", local), { kind: "ask" });
check("the host, or no host: none", [
  requestButton(view({ blocked: { why: "host" } }), "me", local),
  requestButton(view({ blocked: { why: "no-host" } }), "me", local),
], [null, null]);
check("off: none", requestButton(view({ on: false, blocked: { why: "off" } }), "me", local), null);
check("the role taken from me: take it back",
  requestButton(view({ blocked: { why: "protected", until: server + 900_000 }, reclaimUntil: server + 600_000 }), "me", local),
  { kind: "reclaim", leftMs: 600_000 });

console.log("\n— what it says —");
check("clock", [clock(61_000), clock(5 * 60_000), clock(2 * 3_600_000), clock(400)], ["1:01", "5:00", "2:00:00", "0:01"]);
check("a wait, once pressed", waitText("you-declined", 7_200_000),
  "The host declined your request. You can request again in 2:00:00.");

console.log("\n— away —");
check("here", isAway({ hiddenForMs: 0, idleForMs: 10 * 60_000, playing: true }), false);
check("hidden half a minute", isAway({ hiddenForMs: 30_000, idleForMs: 0, playing: true }), true);
check("nothing touched for 3 minutes, paused", isAway({ hiddenForMs: 0, idleForMs: 3 * 60_000, playing: false }), true);
check("  for 2", isAway({ hiddenForMs: 0, idleForMs: 2 * 60_000, playing: false }), false);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
