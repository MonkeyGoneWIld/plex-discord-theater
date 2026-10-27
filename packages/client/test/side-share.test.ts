/**
 * Picture subtitle pieces and preview passes shared between the players on a
 * title (lib/sideShare): two or three players joined by in-memory
 * connections, and a fake player that says what a test needs it to.
 */
import { SideShare, assKey, fontKey, kindOf, pgsKey, previewKey, sha1Hex, type SideConnection } from "../src/lib/sideShare";
import { ownerOf } from "../src/lib/takeFromPeer";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Listener = (...args: never[]) => void;

/** One end of a connection: what is written reaches the other end's "data". */
class FakeConn implements SideConnection {
  readonly listeners = new Map<string, Set<Listener>>();
  other: FakeConn | null = null;
  readonly written: Uint8Array[] = [];
  /** What is written goes nowhere, as to a player that went quiet. */
  silent = false;
  /** write() says the buffer is full: "drain" is up to the test. */
  full = false;
  destroyed = false;
  constructor(readonly id?: string) {}
  write(data: Uint8Array): boolean {
    this.written.push(data);
    const o = this.other;
    if (!this.silent && o && !this.destroyed) {
      const copy = data.slice();
      setTimeout(() => o.emit("data", copy), 0);
    }
    return !this.full;
  }
  on(event: string, listener: Listener) {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, set = new Set());
    set.add(listener);
    return this;
  }
  off(event: string, listener: Listener) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const l of [...this.listeners.get(event) ?? []]) (l as (...a: unknown[]) => void)(...args);
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
    this.other?.destroy();
  }
}

function join(a: SideShare, aId: string, b: SideShare, bId: string) {
  const ab = new FakeConn(bId);
  const ba = new FakeConn(aId);
  ab.other = ba;
  ba.other = ab;
  a.addPlayer(bId, ab);
  b.addPlayer(aId, ba);
  return { ab, ba };
}

const words = (c: FakeConn) => c.written.filter((d) => d[0] === 1)
  .map((d) => JSON.parse(new TextDecoder().decode(d.subarray(1))) as { t: string; id?: number; key?: string; keys?: string[]; bytes?: number });
const chunks = (c: FakeConn) => c.written.filter((d) => d[0] === 2);
const word = (w: object) => {
  const body = new TextEncoder().encode(JSON.stringify(w));
  const out = new Uint8Array(body.length + 1);
  out[0] = 1;
  out.set(body, 1);
  return out;
};
const chunk = (id: number, bytes: Uint8Array) => {
  const out = new Uint8Array(bytes.length + 5);
  out[0] = 2;
  new DataView(out.buffer).setUint32(1, id);
  out.set(bytes, 5);
  return out;
};
const bytesOf = (n: number, seed = 0) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 0xff);
const same = (a: Uint8Array | null, b: Uint8Array) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);
/** A bot that mustn't be asked, counting when it is. */
const botFor = (bytes: Uint8Array, ms = 0) => {
  const bot = {
    asked: 0,
    http: async (signal: AbortSignal) => {
      bot.asked++;
      if (ms) await sleep(ms);
      if (signal.aborted) throw new Error("aborted");
      return bytes;
    },
  };
  return bot;
};

async function main() {
  console.log("A subtitle piece from another player");
  {
    const a = new SideShare();
    const b = new SideShare();
    const { ab } = join(a, "a", b, "b");
    const key = pgsKey(7, "v1", 3);
    const piece = bytesOf(100_000);
    a.put(key, piece, "bot");
    await sleep(5);
    check("the other player hears it has it", b.othersHave(key), true);
    const bot = botFor(bytesOf(10));
    const got = await b.get(key, { bytes: piece.length, http: bot.http });
    check("the same bytes", same(got, piece), true);
    check("the bot isn't asked", bot.asked, 0);
    check("sent in 32 KB chunks", chunks(ab).length, 4);
    check("counted where it came from", [b.statsFor("pgs").fromPlayers, a.statsFor("pgs").fromBot, a.statsFor("pgs").sent], [100_000, 100_000, 100_000]);
    check("previews counted apart", b.statsFor("previews"), { fromPlayers: 0, fromBot: 0, sent: 0 });
    check("kept here after", same(b.peek(key), piece), true);

    // A third player joining the second hears all it has at once.
    const c = new SideShare();
    join(b, "b", c, "c");
    await sleep(5);
    check("a player joining hears what is kept", c.othersHave(key), true);
    const fromB = await c.get(key, { bytes: piece.length, http: bot.http });
    check("and has it from there", same(fromB, piece), true);
  }

  console.log("Kept here first; nobody has it: the bot");
  {
    const a = new SideShare();
    const key = previewKey(55, "0-12", 2);
    const pass2 = bytesOf(5000, 3);
    const bot = botFor(pass2);
    check("from the bot", same(await a.get(key, { http: bot.http }), pass2), true);
    check("counted as the bot's", a.statsFor("previews").fromBot, 5000);
    check("kept, and not asked again", [same(await a.get(key, { http: bot.http }), pass2), bot.asked], [true, 1]);
  }

  console.log("Wrong size");
  {
    const a = new SideShare();
    const b = new SideShare();
    join(a, "a", b, "b");
    const key = pgsKey(7, "v1", 4);
    a.put(key, bytesOf(1000));
    await sleep(5);
    const right = bytesOf(999, 1);
    const bot = botFor(right);
    const got = await b.get(key, { bytes: 999, http: bot.http });
    check("a piece of another size is the bot's", [same(got, right), bot.asked], [true, 1]);
    check("not asked of that player again", b.othersHave(key), false);
    check("nothing counted from players", b.statsFor("pgs").fromPlayers, 0);
  }

  console.log("A player gone quiet");
  {
    let clock = 0;
    const a = new SideShare();
    const b = new SideShare(() => clock);
    const { ba } = join(a, "a", b, "b");
    const key = pgsKey(9, "v2", 0);
    a.put(key, bytesOf(2000));
    await sleep(5);
    ba.silent = true;
    const fromBot = bytesOf(2000, 9);
    const bot = botFor(fromBot);
    const got = b.get(key, { bytes: 2000, http: bot.http });
    await sleep(300);
    check("not given up on too soon", bot.asked, 0);
    clock += 3100;
    check("after 3 s with nothing, the bot's", same(await got, fromBot), true);
    check("told to stop", words(ba).some((w) => w.t === "stop"), true);
  }

  console.log("What the picture needs now");
  {
    const a = new SideShare();
    const b = new SideShare();
    const { ba } = join(a, "a", b, "b");
    const key = pgsKey(9, "v2", 1);
    a.put(key, bytesOf(2000));
    await sleep(5);
    const fast = botFor(bytesOf(10));
    check("a player that answers is used", same(await b.get(key, { bytes: 2000, urgent: true, http: fast.http }), bytesOf(2000)), true);
    check("and the bot isn't asked", fast.asked, 0);

    const key2 = pgsKey(9, "v2", 2);
    a.put(key2, bytesOf(3000));
    await sleep(5);
    ba.silent = true;
    const fromBot = bytesOf(3000, 5);
    const bot = botFor(fromBot, 50);
    const t0 = Date.now();
    const got = await b.get(key2, { bytes: 3000, urgent: true, http: bot.http });
    const took = Date.now() - t0;
    check("a quiet player: the bot's after 1.5 s", [same(got, fromBot), took >= 1400 && took < 2500], [true, true]);
    check("the player told to stop", words(ba).filter((w) => w.t === "stop").length, 1);
  }

  console.log("A player that hasn't it after all, or sends too much, or goes");
  {
    const b = new SideShare();
    const x = new FakeConn("x");
    b.addPlayer("x", x);
    const key = pgsKey(1, "v", 0);
    x.emit("data", word({ t: "have", keys: [key, 5, "", "k".repeat(500)] }));
    check("only proper keys are taken", b.othersHave(key), true);
    const fromBot = bytesOf(100, 2);
    const asking = b.get(key, { http: botFor(fromBot).http });
    await sleep(0);
    const want = words(x).find((w) => w.t === "want")!;
    x.emit("data", word({ t: "none", id: want.id }));
    check("\"none\": the bot's", same(await asking, fromBot), true);

    const key2 = pgsKey(1, "v", 1);
    x.emit("data", word({ t: "have", keys: [key2] }));
    const asking2 = b.get(key2, { http: botFor(fromBot).http });
    await sleep(0);
    const want2 = words(x).filter((w) => w.t === "want")[1];
    x.emit("data", word({ t: "size", id: want2.id, bytes: 10 }));
    x.emit("data", chunk(want2.id!, bytesOf(20)));
    check("more than it said: the bot's", same(await asking2, fromBot), true);
    check("and told to stop", words(x).some((w) => w.t === "stop" && w.id === want2.id), true);

    const key3 = pgsKey(1, "v", 2);
    x.emit("data", word({ t: "have", keys: [key3] }));
    const asking3 = b.get(key3, { http: botFor(fromBot).http });
    await sleep(0);
    x.destroy();
    check("a player that goes: the bot's", same(await asking3, fromBot), true);
    check("and it is gone", b.playerCount(), 0);
  }

  console.log("Sending as fast as the connection takes it");
  {
    const a = new SideShare();
    const x = new FakeConn("x");
    a.addPlayer("x", x);
    const key = pgsKey(2, "v", 0);
    a.put(key, bytesOf(100_000));
    x.full = true;
    x.emit("data", word({ t: "want", id: 1, key }));
    await sleep(5);
    check("waits for drain after a full write", chunks(x).length, 1);
    x.full = false;
    x.emit("drain");
    await sleep(5);
    check("then sends the rest", chunks(x).length, 4);

    x.full = true;
    x.emit("data", word({ t: "want", id: 2, key }));
    await sleep(5);
    x.emit("data", word({ t: "stop", id: 2 }));
    x.emit("drain");
    await sleep(5);
    check("stopped part way", chunks(x).length, 5);

    // Stuck on one; asked for 70 more.
    x.emit("data", word({ t: "want", id: 3, key }));
    await sleep(5);
    for (let i = 0; i < 70; i++) x.emit("data", word({ t: "want", id: 100 + i, key }));
    check("asked for too much: \"none\" past 64", words(x).filter((w) => w.t === "none").length, 6);
    check("an unknown item: \"none\"", (() => {
      const y = new FakeConn("y");
      a.addPlayer("y", y);
      y.emit("data", word({ t: "want", id: 1, key: "pgs/0/v/0" }));
      return words(y).some((w) => w.t === "none" && w.id === 1);
    })(), true);
    a.dropPlayers();
  }

  console.log("A styled subtitle's script and fonts, checked against their hash");
  {
    const font = bytesOf(50_000, 4);
    const id = `${await sha1Hex(font)}.ttf`;
    const key = fontKey(id);
    const script = new TextEncoder().encode("[Script Info]\nTitle: x\n");
    const v = (await sha1Hex(script)).slice(0, 16);
    check("a script and a font are styled, apart from the rest", [kindOf(key), kindOf(assKey(5, v)), kindOf(pgsKey(5, v, 0)),
      kindOf(previewKey(1, "v", 1))], ["styled", "styled", "pgs", "previews"]);
    const named = async (b: Uint8Array) => (await sha1Hex(b)) === id.slice(0, 40);
    const a = new SideShare();
    const b = new SideShare();
    join(a, "a", b, "b");
    a.put(key, font, "bot");
    await sleep(5);
    const bot = botFor(bytesOf(10));
    const got = await b.get(key, { urgent: true, check: named, http: bot.http });
    check("one from a player whose hash is its name is taken", [same(got, font), bot.asked, b.statsFor("styled").fromPlayers],
      [true, 0, 50_000]);

    // A player that sends something else under its name.
    const c = new SideShare();
    const x = new FakeConn("x");
    c.addPlayer("x", x);
    const key2 = fontKey(`${"0".repeat(40)}.otf`);
    x.emit("data", word({ t: "have", keys: [key2] }));
    const right = bytesOf(300, 8);
    const asking = c.get(key2, { check: async (bytes) => same(bytes, right), http: botFor(right).http });
    await sleep(0);
    const want = words(x).find((w) => w.t === "want")!;
    x.emit("data", word({ t: "size", id: want.id, bytes: 300 }));
    x.emit("data", chunk(want.id!, bytesOf(300, 1)));
    check("one that isn't what it is named by: the bot's", same(await asking, right), true);
    check("  that player not asked for it again, nothing counted from it", [c.othersHave(key2), c.statsFor("styled").fromPlayers],
      [false, 0]);
  }

  console.log("What can wait, divided between the players that need it");
  {
    const a = new SideShare();
    const b = new SideShare();
    const ids = ["aa", "bb"];
    a.joinedSwarm("aa");
    b.joinedSwarm("bb");
    join(a, "aa", b, "bb");
    a.setOthers(1);
    b.setOthers(1);
    const keys = Array.from({ length: 12 }, (_, i) => pgsKey(4, "v", i));
    a.need(keys);
    b.need(keys);
    await sleep(5);
    const bots = new Map<string, number>();
    const fetchFor = (s: SideShare, key: string) => async () => {
      await s.awaitTurn(key);
      return s.get(key, { http: async () => { bots.set(key, (bots.get(key) ?? 0) + 1); await sleep(20); return bytesOf(1000, key.length); } });
    };
    const t0 = Date.now();
    // Both players near the start of the title's swarm: past SETTLE_MS on the clock given.
    const both = await Promise.all(keys.flatMap((k) => [fetchFor(a, k)(), fetchFor(b, k)()]));
    check("each fetched from the bot once, by the one whose it is", keys.map((k) => bots.get(k) ?? 0), keys.map(() => 1));
    check("  and both have all of it", both.every((x) => x.length === 1000), true);
    check("  each its share: some of it from the other",
      [a.statsFor("pgs").fromPlayers > 0, b.statsFor("pgs").fromPlayers > 0, Date.now() - t0 < 4000], [true, true, true]);
    check("  the one whose it is, the same for both", keys.every((k) => ownerOf(k, ids) === ownerOf(k, [...ids].reverse())), true);
  }

  console.log("Waiting for the others, and not");
  {
    let clock = 0;
    const a = new SideShare(() => clock);
    const key = previewKey(9, "v", 1);
    let done = false;
    void a.awaitTurn(key).then(() => { done = true; });
    await sleep(300);
    check("off the title's swarm: nothing to wait for", done, true);

    a.joinedSwarm("aa");
    done = false;
    void a.awaitTurn(key).then(() => { done = true; });
    await sleep(300);
    check("just joined, nobody heard from yet: waits", done, false);
    clock += 6100;
    await sleep(300);
    check("  until the players have had time to connect", done, true);

    const b = new SideShare(() => clock);
    b.joinedSwarm("bb");
    b.setRoomOthers(0);
    done = false;
    void b.awaitTurn(key).then(() => { done = true; });
    await sleep(300);
    check("alone in the room, before the tracker says: at once", done, true);
    b.setRoomOthers(2);
    b.setOthers(0);
    done = false;
    void b.awaitTurn(key).then(() => { done = true; });
    await sleep(300);
    check("others in the room not yet on the title's swarm: waits for them", done, false);
    b.setRoomOthers(0);
    await sleep(300);
    check("  the room emptied: on at once", done, true);

    // Another player is the one to fetch it, and goes.
    const c = new SideShare(() => clock);
    c.joinedSwarm("cc");
    c.setOthers(1);
    clock += 7000;
    const x = new FakeConn("xx");
    c.addPlayer("xx", x);
    const theirs = Array.from({ length: 40 }, (_, i) => pgsKey(6, "v", i)).find((k) => ownerOf(k, ["cc", "xx"]) === "xx")!;
    x.emit("data", word({ t: "need", keys: [theirs] }));
    c.need([theirs]);
    done = false;
    void c.awaitTurn(theirs).then(() => { done = true; });
    await sleep(300);
    check("another player's to fetch: left to it", done, false);
    x.emit("data", word({ t: "have", keys: [theirs] }));
    await sleep(10);
    check("  until it has it", done, true);
    const later = Array.from({ length: 40 }, (_, i) => pgsKey(7, "v", i)).find((k) => ownerOf(k, ["cc", "xx"]) === "xx")!;
    x.emit("data", word({ t: "need", keys: [later] }));
    done = false;
    void c.awaitTurn(later).then(() => { done = true; });
    await sleep(300);
    clock += 20_100;
    await sleep(300);
    check("  or for 20 s at most", done, true);
    const gone = Array.from({ length: 40 }, (_, i) => pgsKey(8, "v", i)).find((k) => ownerOf(k, ["cc", "xx"]) === "xx")!;
    x.emit("data", word({ t: "need", keys: [gone] }));
    done = false;
    void c.awaitTurn(gone).then(() => { done = true; });
    await sleep(300);
    x.destroy();
    await sleep(10);
    check("  or until it goes", done, true);
    const mine = Array.from({ length: 40 }, (_, i) => pgsKey(9, "v", i)).find((k) => ownerOf(k, ["cc", "yy"]) === "cc")!;
    const y = new FakeConn("yy");
    c.addPlayer("yy", y);
    y.emit("data", word({ t: "need", keys: [mine] }));
    done = false;
    void c.awaitTurn(mine).then(() => { done = true; });
    await sleep(300);
    check("this player's to fetch: at once", done, true);
    check("what it needs, said to a player joining", words(y).some((w) => w.t === "need" && w.keys?.includes(theirs)), true);
    const stop = new AbortController();
    const z = new FakeConn("zz");
    c.addPlayer("zz", z);
    const zs = Array.from({ length: 40 }, (_, i) => pgsKey(10, "v", i)).find((k) => ownerOf(k, ["cc", "yy", "zz"]) === "zz")!;
    z.emit("data", word({ t: "need", keys: [zs] }));
    done = false;
    void c.awaitTurn(zs, stop.signal).then(() => { done = true; });
    await sleep(300);
    stop.abort();
    await sleep(10);
    check("  and stopped when what wanted it goes", done, true);
    c.dropPlayers();
  }

  console.log("What is kept");
  {
    const a = new SideShare();
    const big = 16 * 1024 * 1024;
    for (let i = 0; i < 7; i++) a.put(pgsKey(3, "v", i), new Uint8Array(big));
    check("up to 96 MB, the oldest going first", [a.peek(pgsKey(3, "v", 0)), !!a.peek(pgsKey(3, "v", 6))], [null, true]);
    a.put(pgsKey(3, "v", 9), new Uint8Array(2 * big + 1), "bot");
    check("nothing over 32 MB is kept", [a.peek(pgsKey(3, "v", 9)), a.statsFor("pgs").fromBot], [null, 2 * big + 1]);
    const x = new FakeConn("x");
    a.addPlayer("x", x);
    const dup = new FakeConn("x");
    a.addPlayer("x", dup);
    check("the same player twice: the second connection closed", [dup.destroyed, a.playerCount()], [true, 1]);
    a.clear();
    check("a new title: nothing kept, nobody joined", [a.peek(pgsKey(3, "v", 6)), a.playerCount(), a.statsFor("pgs").fromBot], [null, 0, 0]);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

void main();
