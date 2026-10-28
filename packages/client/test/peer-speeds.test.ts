/**
 * Other players' speeds, remembered across streams and pages (lib/peerSpeeds),
 * so the segment the picture waits on can be taken from one proven fast from
 * a stream's first seconds on.
 */
const kept = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => kept.get(k) ?? null,
  setItem: (k: string, v: string) => { kept.set(k, v); },
  removeItem: (k: string) => { kept.delete(k); },
};

const { REMEMBER_MS, forgetPeerSpeedsForTests, peerIdPrefix, playerKeyOf, rememberPeerSpeed, rememberedPeerSpeed } =
  await import("../src/lib/peerSpeeds");
const { installTakeFromPeer, shouldTakeFromPeer } = await import("../src/lib/takeFromPeer");

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

/** A whole peer id, as the engine makes one from the prefix: 20 characters. */
const idOf = (prefix: string, rest = "abcdefgh") => (prefix + rest).slice(0, 20);

console.log("\n— a player's peer ids —");
const mine = peerIdPrefix("111", "deviceAAAAAA");
check("twelve characters, leaving the engine eight of its own", [mine.length, /^-PD[0-9A-Za-z]{8}-$/.test(mine)], [12, true]);
check("the same for the same account on the same browser, every stream and page", peerIdPrefix("111", "deviceAAAAAA"), mine);
check("another account's differs", peerIdPrefix("222", "deviceAAAAAA") !== mine, true);
check("so does the same account on another browser", peerIdPrefix("111", "deviceBBBBBB") !== mine, true);
check("the key is read back from a whole id", playerKeyOf(idOf(mine, "Zz9Zz9Zz")), mine.slice(3, 11));
check("an id of the engine's own making is nobody's", playerKeyOf("-PM0232-abcdefghijkl"), null);
const kept1 = peerIdPrefix("333");
check("without a browser key given, one is made and kept", [kept.has("pdt.deviceKey"), peerIdPrefix("333")], [true, kept1]);

console.log("\n— speeds, from one stream to the next —");
const peer = idOf(peerIdPrefix("444", "deviceCCCCCC"));
const t0 = 1_000_000;
check("nothing known of a player never seen", rememberedPeerSpeed(peer, t0), 0);
rememberPeerSpeed(peer, 40e6, t0);
check("a speed measured is known again — under another id in the next stream, the same key",
  rememberedPeerSpeed(idOf(peerIdPrefix("444", "deviceCCCCCC"), "QQQQQQQQ"), t0 + 60_000), 40e6);
rememberPeerSpeed(peer, 0, t0 + 1);
check("an unmeasured moment doesn't wipe it", rememberedPeerSpeed(peer, t0 + 2), 40e6);
check("counted on for a quarter of an hour", rememberedPeerSpeed(peer, t0 + REMEMBER_MS), 40e6);
check("  and no longer", rememberedPeerSpeed(peer, t0 + REMEMBER_MS + 1), 0);
rememberPeerSpeed("-PM0232-abcdefghijkl", 90e6, t0);
check("a peer that isn't one of ours isn't remembered", rememberedPeerSpeed("-PM0232-abcdefghijkl", t0), 0);
rememberPeerSpeed(peer, 25e6, t0 + 5_000);
check("the latest measure is the one kept", rememberedPeerSpeed(peer, t0 + 6_000), 25e6);

console.log("\n— across a pop-out's reload —");
forgetPeerSpeedsForTests();
check("a page back from a pop-out still knows it", rememberedPeerSpeed(peer, t0 + 7_000), 25e6);
kept.set("pdt.peerSpeeds", "{not json");
forgetPeerSpeedsForTests();
check("and one that can't read what was kept knows nothing, without failing", rememberedPeerSpeed(peer, t0 + 7_000), 0);
for (let i = 0; i < 40; i++) rememberPeerSpeed(idOf(peerIdPrefix(`p${i}`, "deviceDDDDDD")), 10e6 + i, t0 + 10_000 + i * 3_000);
const stored = JSON.parse(kept.get("pdt.peerSpeeds") ?? "{}") as Record<string, unknown>;
check("at most 32 players kept, the most recent", [Object.keys(stored).length <= 32,
  rememberedPeerSpeed(idOf(peerIdPrefix("p0", "deviceDDDDDD")), t0 + 200_000),
  rememberedPeerSpeed(idOf(peerIdPrefix("p39", "deviceDDDDDD")), t0 + 200_000)], [true, 0, 10e6 + 39]);

console.log("\n— what the engine is given —");
const target: { __pdtP2P?: Record<string, unknown> } = {};
installTakeFromPeer(() => {}, target);
check("the engine can ask for a remembered speed, and tell what it measures",
  [typeof target.__pdtP2P?.rememberedSpeed, typeof target.__pdtP2P?.sawSpeed], ["function", "function"]);
// The take itself is unchanged: a crawling download, a peer known to be faster.
const crawling = { received: 100_000, total: 4_000_000, startedAt: 0 };
rememberPeerSpeed(peer, 25e6, t0 + 130_000);
check("our download crawling, a peer remembered at 25 Mbps is taken from",
  shouldTakeFromPeer(crawling, { left: 3_900_000, bitsPerS: rememberedPeerSpeed(peer, t0 + 131_000) }, 2_000), true);
check("one with nothing remembered still isn't",
  shouldTakeFromPeer(crawling, { left: 3_900_000, bitsPerS: rememberedPeerSpeed(idOf(peerIdPrefix("never")), t0) }, 2_000), false);
check("and a download doing well is left alone",
  shouldTakeFromPeer({ received: 3_000_000, total: 4_000_000, startedAt: 0 }, { left: 1_000_000, bitsPerS: 25e6 }, 2_000), false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
