/**
 * Picture subtitles and seek-bar previews from other players when they have
 * them, as the film's segments are (the P2P engine), rather than every player
 * fetching all of them from the bot — asked for on 27 October. A made PGS
 * subtitle is 17 to 38 MB and a film's previews 5 to 7 MB; through Discord's
 * proxy Airplane II's subtitle took a minute to come in from the bot.
 *
 * Players on the same title join a swarm of their own for it on the bot's
 * tracker (joinSideSwarm), beside their stream's, and say what they hold: the
 * pieces of a made subtitle, the same bytes for as long as the file is (`v`),
 * the preview passes after the first, the same for as long as the part's
 * previews are (the server's X-Preview-Version), and since 27 October a
 * typeset ASS subtitle's script and the film's fonts, named by the hash of
 * their bytes — a fansub's fonts run to tens of MB, and every player fetched
 * them from the bot at the start. Only those: a subtitle still being cut
 * grows, and comes from the bot.
 *
 * A player wanting one asks a player that has it (get), the fastest it has
 * measured first, and goes to the bot when none has it or the one asked is
 * slow: no bytes in FIRST_BYTES_MS, or none for STALLED_MS. What the picture
 * needs now (`urgent`) is asked of the bot as well after RACE_MS, and the
 * first to finish is kept. What is named by its hash is checked against it,
 * and one that isn't it is asked for elsewhere. What a player has, from
 * either, it keeps (up to KEEP_BYTES) and sends on to whoever asks.
 *
 * What can wait is divided between the players that need it, as the stream's
 * segments are (awaitTurn): players starting together each fetched all of it
 * from the bot at once. Each says what it is going to fetch ("need"), one of
 * those that do is the one to fetch it (ownerOf), and the others wait for it.
 * A player that can't reach the others — no WebRTC, a router between that
 * won't let them through, the tracker gone — fetches it all from the bot.
 *
 * Each message over the connection is bytes, the first saying what it is: a
 * word (JSON — have, need, want, size, none, stop), or a chunk of an item
 * asked for, with the number of the asking.
 */
import TrackerClient from "bittorrent-tracker";
import { logEvent, logWarn } from "./log";
import { ownerOf } from "./takeFromPeer";

/** The part of a WebRTC connection (simple-peer's, as the tracker's client
 *  makes them) this uses. */
export interface SideConnection {
  /** The other player's peer id, as hex. */
  id?: string;
  /** False when the connection's buffer is full: wait for "drain". */
  write(data: Uint8Array): boolean;
  on(event: string, listener: (...args: never[]) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
  destroy(): void;
}

/** What a kind of item came in as, and went out as, bytes. */
export interface SideStats {
  fromPlayers: number;
  fromBot: number;
  sent: number;
}

/** Styled: a typeset ASS subtitle's script, and the film's fonts. */
export type SideKind = "pgs" | "previews" | "styled";

/** A chunk's bytes: well inside what every browser's data channel takes. */
const CHUNK_BYTES = 32 * 1024;
/** What is kept to send on, most recently used kept longest. */
const KEEP_BYTES = 96 * 1024 * 1024;
/** No subtitle piece or preview pass is near this; a CJK font, 15 to 20 MB, can be. */
const MAX_ITEM_BYTES = 32 * 1024 * 1024;
/**
 * Just after joining a title's swarm, the other players on it are still being
 * connected to — the tracker's answer, then WebRTC's, a few seconds — and
 * what can wait waits up to this long for them, unless the tracker says
 * nobody else is here.
 */
const SETTLE_MS = 6000;
/** A player connecting says what it has and needs straight after: given this long. */
const WORDS_MS = 500;
/** What another player is the one to fetch waits this long for it, then is fetched here. */
const OWNER_WAIT_MS = 20_000;
/** A player asked that hasn't started sending in this long is passed over. */
const FIRST_BYTES_MS = 3000;
/** Nor one that stops sending for this long. */
const STALLED_MS = 3000;
/** What the picture needs now is asked of the bot as well, after this. */
const RACE_MS = 1500;
/** Asked of one player at once, by this one. */
const PER_PLAYER = 2;
/** Players asked for one item before it is the bot's. */
const TRIES = 2;
/** What another player may say it has, at most: a film's pieces are 40 or so. */
const MAX_KEYS = 4096;
const MAX_KEY_LENGTH = 200;
/** Keys per "have": a word stays one message. */
const KEYS_PER_WORD = 200;
/** What one player may have asked of us and not had yet; past it, "none". */
const MAX_WANTED = 64;

const WORD = 1;
const CHUNK = 2;

type Word =
  | { t: "have"; keys: string[] }
  | { t: "need"; keys: string[] }
  | { t: "want"; id: number; key: string }
  | { t: "size"; id: number; bytes: number }
  | { t: "none"; id: number }
  | { t: "stop"; id: number };

interface Asking {
  key: string;
  /** Its size, when it is known before asking (a subtitle piece's). */
  expect: number | null;
  buf: Uint8Array | null;
  got: number;
  startedAt: number;
  lastAt: number;
  done(bytes: Uint8Array | null): void;
}

interface Player {
  id: string;
  conn: SideConnection;
  has: Set<string>;
  /** What it says it is going to fetch. */
  needs: Set<string>;
  /** What it has sent us at, bits a second, over a whole item; 0 until then. */
  bitsPerS: number;
  asked: Map<number, Asking>;
  /** What it asked of us, in turn, and the one being sent. */
  queue: number[];
  wanted: Map<number, string>;
  sending: number | null;
  stopped: Set<number>;
}

export function kindOf(key: string): SideKind {
  if (key.startsWith("pgs/")) return "pgs";
  return key.startsWith("ass/") || key.startsWith("font/") ? "styled" : "previews";
}

/** A picture subtitle's piece, made: the same bytes for as long as `v` is. */
export function pgsKey(streamId: number, v: string, piece: number): string {
  return `pgs/${streamId}/${v}/${piece}`;
}

/** A part's preview pass, for as long as the part's previews are `version`. */
export function previewKey(partId: number, version: string, pass: number): string {
  return `prev/${partId}/${version}/${pass}`;
}

/** A typeset ASS subtitle's script, by its `v`: the start of the SHA-1 of its text. */
export function assKey(streamId: number, v: string): string {
  return `ass/${streamId}/${v}`;
}

/** A font a film carries, by its id: the SHA-1 of its bytes, and its extension. */
export function fontKey(id: string): string {
  return `font/${id}`;
}

/** The SHA-1 of some bytes, as hex: what a font's id and a script's `v` are made of. */
export async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const sha = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes as Uint8Array<ArrayBuffer>));
  return Array.from(sha, (b) => b.toString(16).padStart(2, "0")).join("");
}

function wordBytes(word: Word): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(word));
  const out = new Uint8Array(body.length + 1);
  out[0] = WORD;
  out.set(body, 1);
  return out;
}

function chunkBytes(id: number, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 5);
  out[0] = CHUNK;
  new DataView(out.buffer).setUint32(1, id);
  out.set(bytes, 5);
  return out;
}

function readWord(data: Uint8Array): Word | null {
  try {
    const w = JSON.parse(new TextDecoder().decode(data.subarray(1))) as Word;
    return w && typeof w === "object" && typeof w.t === "string" ? w : null;
  } catch {
    return null;
  }
}

const okKey = (k: unknown): k is string => typeof k === "string" && k.length > 0 && k.length <= MAX_KEY_LENGTH;
const okId = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0 && n < 2 ** 32;

export class SideShare {
  private readonly kept = new Map<string, Uint8Array>();
  private keptBytes = 0;
  private readonly players = new Map<string, Player>();
  private nextId = 0;
  private readonly stats: Record<SideKind, SideStats> = {
    pgs: { fromPlayers: 0, fromBot: 0, sent: 0 },
    previews: { fromPlayers: 0, fromBot: 0, sent: 0 },
    styled: { fromPlayers: 0, fromBot: 0, sent: 0 },
  };
  /** What this player is going to fetch, as told to the others. */
  private readonly needing = new Set<string>();
  /** This player's id as the others know it, while it is on the title's swarm. */
  private myId: string | null = null;
  private joinedAt = 0;
  private lastConnectedAt = 0;
  /** How many other players the tracker says are on the title; null until it has said. */
  private others: number | null = null;
  /** How many others are in this player's room, all of them on the title; null until told. */
  private roomOthers: number | null = null;
  /** What is waiting on the players (waitFor), looked at again when they change. */
  private readonly waiters = new Set<() => void>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Another player connected. */
  addPlayer(id: string, conn: SideConnection): void {
    if (this.players.has(id)) {
      conn.destroy();
      return;
    }
    const p: Player = {
      id, conn, has: new Set(), needs: new Set(), bitsPerS: 0, asked: new Map(), queue: [], wanted: new Map(), sending: null,
      stopped: new Set(),
    };
    this.players.set(id, p);
    this.lastConnectedAt = this.now();
    const gone = () => this.removePlayer(id);
    conn.on("data", ((data: Uint8Array) => this.onData(p, data)) as (...args: never[]) => void);
    conn.on("close", gone);
    conn.on("error", gone);
    this.sendKeys(p, "have", [...this.kept.keys()]);
    this.sendKeys(p, "need", [...this.needing]);
    this.wake();
  }

  removePlayer(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    for (const a of [...p.asked.values()]) a.done(null);
    try {
      p.conn.destroy();
    } catch {
      // Gone already.
    }
    this.wake();
  }

  /** Every player, and everything kept: a new title. */
  clear(): void {
    this.dropPlayers();
    this.kept.clear();
    this.keptBytes = 0;
    this.needing.clear();
    for (const s of Object.values(this.stats)) Object.assign(s, { fromPlayers: 0, fromBot: 0, sent: 0 });
  }

  /** On the title's swarm, as `id`: the hex of the peer id the others know it by. */
  joinedSwarm(id: string): void {
    this.myId = id;
    this.joinedAt = this.now();
    this.others = null;
    this.wake();
  }

  /** Off it: nobody to divide anything with. */
  leftSwarm(): void {
    this.myId = null;
    this.others = null;
    this.wake();
  }

  /** The tracker's count of the other players on the title. */
  setOthers(n: number): void {
    this.others = Number.isFinite(n) ? Math.max(0, n) : null;
    this.wake();
  }

  /** The others in this player's room: nobody there, nobody to wait for until the tracker says otherwise. */
  setRoomOthers(n: number): void {
    this.roomOthers = Number.isFinite(n) ? Math.max(0, n) : null;
    this.wake();
  }

  /** Nobody else on the title, as far as is known: the tracker's count, and the room's. */
  private alone(): boolean {
    if (this.others === null) return this.roomOthers === 0;
    // Others in the room may not have joined the title's swarm yet.
    return this.others === 0 && !(this.roomOthers !== null && this.roomOthers > 0);
  }

  /** What this player is going to fetch: what can wait is divided between the players that need it. */
  need(keys: string[]): void {
    const fresh = keys.filter((k) => okKey(k) && !this.needing.has(k));
    if (!fresh.length) return;
    for (const k of fresh) this.needing.add(k);
    for (const k of this.needing) {
      if (this.needing.size <= MAX_KEYS) break;
      this.needing.delete(k);
    }
    for (const p of this.players.values()) this.sendKeys(p, "need", fresh);
  }

  /**
   * Before fetching from the bot what can wait. Just after joining the title's
   * swarm, until SETTLE_MS on, nobody else is on the title (alone), or all
   * there are have connected and said what they need, the other players may
   * have it. Then, when another player that needs it too is the one to fetch
   * it (ownerOf), it is left to them for up to OWNER_WAIT_MS. Over at once
   * when another player has it, this one is off the swarm, or `signal` is
   * aborted.
   */
  async awaitTurn(key: string, signal?: AbortSignal): Promise<void> {
    const settled = () => {
      if (this.myId === null || this.alone() || this.now() - this.joinedAt >= SETTLE_MS) return true;
      const expected = Math.max(this.others ?? 0, this.roomOthers ?? 0);
      return expected > 0 && this.players.size >= expected && this.now() - this.lastConnectedAt >= WORDS_MS;
    };
    await this.waitFor(() => settled() || this.othersHave(key), signal);
    const me = this.myId;
    if (me === null || signal?.aborted || this.othersHave(key)) return;
    const sharing = [...this.players.values()].filter((p) => p.needs.has(key)).map((p) => p.id);
    const owner = sharing.length ? ownerOf(key, [me, ...sharing]) : me;
    if (owner === me || owner === null) return;
    const from = this.now();
    await this.waitFor(() => this.myId === null || this.othersHave(key) || !this.players.has(owner) ||
      this.now() - from >= OWNER_WAIT_MS, signal);
  }

  private waitFor(done: () => boolean, signal?: AbortSignal): Promise<void> {
    if (done() || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const look = () => {
        if (!done() && !signal?.aborted) return;
        clearInterval(timer);
        this.waiters.delete(look);
        signal?.removeEventListener("abort", look);
        resolve();
      };
      // Time passing, as well as the players changing.
      const timer = setInterval(look, 250);
      this.waiters.add(look);
      signal?.addEventListener("abort", look);
    });
  }

  private wake(): void {
    for (const look of [...this.waiters]) look();
  }

  playerCount(): number {
    return this.players.size;
  }

  hasPlayer(id: string): boolean {
    return this.players.has(id);
  }

  /** Every player gone; what is kept stays. */
  dropPlayers(): void {
    for (const id of [...this.players.keys()]) this.removePlayer(id);
  }

  statsFor(kind: SideKind): SideStats {
    return { ...this.stats[kind] };
  }

  /** Kept, from the bot or the browser's cache: sent on to whoever asks.
   *  `from` the bot is counted as such. */
  put(key: string, bytes: Uint8Array, from?: "bot"): void {
    if (from === "bot") this.stats[kindOf(key)].fromBot += bytes.length;
    if (!okKey(key) || bytes.length === 0 || bytes.length > MAX_ITEM_BYTES) return;
    const was = this.kept.get(key);
    if (was) {
      this.kept.delete(key);
      this.kept.set(key, was);
      return;
    }
    this.kept.set(key, bytes);
    this.keptBytes += bytes.length;
    for (const [k, b] of this.kept) {
      if (this.keptBytes <= KEEP_BYTES) break;
      this.kept.delete(k);
      this.keptBytes -= b.length;
    }
    if (!this.kept.has(key)) return;
    for (const p of this.players.values()) this.sendKeys(p, "have", [key]);
  }

  /** Kept here: this player's own copy. */
  peek(key: string): Uint8Array | null {
    return this.kept.get(key) ?? null;
  }

  /** Whether another player says it has it. */
  othersHave(key: string): boolean {
    for (const p of this.players.values()) if (p.has.has(key)) return true;
    return false;
  }

  /**
   * An item: kept here, else from a player that has it, else from the bot
   * (`http`) — and from the bot beside the player after RACE_MS when it is
   * `urgent`. `bytes`, when known, is what it must be; `check`, when it is
   * named by its hash, says whether a player's is it.
   */
  async get(key: string, o: {
    bytes?: number | null;
    urgent?: boolean;
    check?: (bytes: Uint8Array) => boolean | Promise<boolean>;
    http: (signal: AbortSignal) => Promise<Uint8Array>;
  }): Promise<Uint8Array> {
    const kept = this.peek(key);
    if (kept) return kept;
    const fromBot = async (signal: AbortSignal) => {
      const bytes = await o.http(signal);
      this.put(key, bytes, "bot");
      return bytes;
    };
    if (!this.othersHave(key)) return fromBot(new AbortController().signal);
    if (!o.urgent) {
      return (await this.fromPlayers(key, o.bytes ?? null, undefined, o.check)) ?? fromBot(new AbortController().signal);
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      let settled = false;
      let playersDone = false;
      let botFailed: { err: unknown } | null = null;
      const stopPlayers = new AbortController();
      const stopBot = new AbortController();
      let botAsked = false;
      const askBot = () => {
        if (botAsked || settled) return;
        botAsked = true;
        fromBot(stopBot.signal).then((bytes) => {
          if (settled) return;
          settled = true;
          stopPlayers.abort();
          resolve(bytes);
        }, (err) => {
          botFailed = { err };
          if (!settled && playersDone) {
            settled = true;
            reject(err);
          }
        });
      };
      const race = setTimeout(askBot, RACE_MS);
      void this.fromPlayers(key, o.bytes ?? null, stopPlayers.signal, o.check).then((bytes) => {
        playersDone = true;
        if (settled) return;
        if (bytes) {
          settled = true;
          clearTimeout(race);
          stopBot.abort();
          resolve(bytes);
          return;
        }
        clearTimeout(race);
        if (botFailed) {
          settled = true;
          reject(botFailed.err);
        } else {
          askBot();
        }
      });
    });
  }

  /** From players that have it, the fastest first; null when none could. */
  async fromPlayers(
    key: string, expect: number | null, signal?: AbortSignal, check?: (bytes: Uint8Array) => boolean | Promise<boolean>,
  ): Promise<Uint8Array | null> {
    const tried = new Set<string>();
    for (let i = 0; i < TRIES; i++) {
      if (signal?.aborted) return null;
      // Every player that has it busy sending us others (PER_PLAYER): the
      // first to be free — ten fonts asked for at once went eight to the bot.
      // Others waiting may take it first: wait again.
      let p = this.pick(key, tried);
      while (!p && this.holds(key, tried) && !signal?.aborted) {
        await this.waitFor(() => this.pick(key, tried) !== null || !this.holds(key, tried), signal);
        p = this.pick(key, tried);
      }
      if (!p) return null;
      tried.add(p.id);
      const bytes = await this.ask(p, key, expect, signal);
      if (bytes && check && !(await Promise.resolve().then(() => check(bytes)).catch(() => false))) {
        logWarn("P2P", "a player sent a font or subtitle script that isn't the one it is named by; asking elsewhere", {
          key, bytes: bytes.length,
        });
        p.has.delete(key);
        continue;
      }
      if (bytes) {
        const kind = kindOf(key);
        this.stats[kind].fromPlayers += bytes.length;
        this.put(key, bytes);
        return bytes;
      }
    }
    return null;
  }

  private holds(key: string, tried: Set<string>): boolean {
    for (const p of this.players.values()) if (p.has.has(key) && !tried.has(p.id)) return true;
    return false;
  }

  private pick(key: string, tried: Set<string>): Player | null {
    const can = [...this.players.values()].filter((p) => p.has.has(key) && !tried.has(p.id) && p.asked.size < PER_PLAYER);
    if (!can.length) return null;
    const best = Math.max(...can.map((p) => p.bitsPerS));
    const fastest = can.filter((p) => p.bitsPerS === best);
    return fastest[Math.floor(Math.random() * fastest.length)];
  }

  private ask(p: Player, key: string, expect: number | null, signal?: AbortSignal): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      const id = (this.nextId = (this.nextId % 0xfffffffe) + 1);
      const startedAt = this.now();
      let watch: ReturnType<typeof setInterval> | undefined;
      const onAbort = () => finish(null, true);
      const finish = (bytes: Uint8Array | null, stop = false) => {
        if (!p.asked.has(id)) return;
        p.asked.delete(id);
        clearInterval(watch);
        signal?.removeEventListener("abort", onAbort);
        if (stop && this.players.get(p.id) === p) this.send(p, { t: "stop", id });
        resolve(bytes);
        // A free place with this player, for what waits on one.
        this.wake();
      };
      const asking: Asking = { key, expect, buf: null, got: 0, startedAt, lastAt: startedAt, done: (b) => finish(b) };
      p.asked.set(id, asking);
      watch = setInterval(() => {
        const t = this.now();
        if (asking.got === 0 ? t - startedAt > FIRST_BYTES_MS : t - asking.lastAt > STALLED_MS) {
          logEvent("P2P", "a player was slow to send a subtitle piece, font or preview pass; asking elsewhere", {
            key, gotKB: Math.round(asking.got / 1024), afterS: ((t - startedAt) / 1000).toFixed(1),
          });
          finish(null, true);
        }
      }, 250);
      signal?.addEventListener("abort", onAbort);
      this.send(p, { t: "want", id, key });
    });
  }

  private onData(p: Player, data: Uint8Array): void {
    if (!(data instanceof Uint8Array) || data.length === 0) return;
    if (data[0] === CHUNK) {
      if (data.length < 5) return;
      const id = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1);
      const a = p.asked.get(id);
      if (!a?.buf) return;
      const body = data.subarray(5);
      if (a.got + body.length > a.buf.length) {
        a.done(null);
        this.send(p, { t: "stop", id });
        return;
      }
      a.buf.set(body, a.got);
      a.got += body.length;
      a.lastAt = this.now();
      if (a.got === a.buf.length) {
        const ms = Math.max(1, a.lastAt - a.startedAt);
        p.bitsPerS = (a.got * 8 * 1000) / ms;
        a.done(a.buf);
      }
      return;
    }
    if (data[0] !== WORD) return;
    const w = readWord(data);
    if (!w) return;
    switch (w.t) {
      case "have":
      case "need": {
        if (!Array.isArray(w.keys)) return;
        const into = w.t === "have" ? p.has : p.needs;
        for (const k of w.keys) {
          if (into.size >= MAX_KEYS) break;
          if (okKey(k)) into.add(k);
        }
        this.wake();
        return;
      }
      case "want":
        if (!okId(w.id) || !okKey(w.key)) return;
        if (p.queue.length >= MAX_WANTED) {
          this.send(p, { t: "none", id: w.id });
          return;
        }
        p.wanted.set(w.id, w.key);
        p.queue.push(w.id);
        void this.pump(p);
        return;
      case "stop":
        if (!okId(w.id)) return;
        if (p.sending === w.id) p.stopped.add(w.id);
        p.queue = p.queue.filter((q) => q !== w.id);
        p.wanted.delete(w.id);
        return;
      case "none": {
        const a = okId(w.id) ? p.asked.get(w.id) : undefined;
        if (a) {
          p.has.delete(a.key);
          a.done(null);
        }
        return;
      }
      case "size": {
        const a = okId(w.id) ? p.asked.get(w.id) : undefined;
        if (!a || a.buf) return;
        const n = w.bytes;
        if (!Number.isInteger(n) || n <= 0 || n > MAX_ITEM_BYTES || (a.expect !== null && n !== a.expect)) {
          logWarn("P2P", "a player offered a subtitle piece, font or preview pass of the wrong size; asking elsewhere", {
            key: a.key, bytes: n, expected: a.expect,
          });
          p.has.delete(a.key);
          a.done(null);
          this.send(p, { t: "stop", id: w.id });
          return;
        }
        a.buf = new Uint8Array(n);
        a.lastAt = this.now();
        return;
      }
    }
  }

  /** What it asked of us, one item at a time, as fast as the connection takes it. */
  private async pump(p: Player): Promise<void> {
    if (p.sending !== null) return;
    while (p.queue.length && this.players.get(p.id) === p) {
      const id = p.queue.shift()!;
      const key = p.wanted.get(id);
      p.wanted.delete(id);
      if (key === undefined) continue;
      const bytes = this.kept.get(key);
      if (!bytes) {
        this.send(p, { t: "none", id });
        continue;
      }
      p.sending = id;
      try {
        this.send(p, { t: "size", id, bytes: bytes.length });
        for (let at = 0; at < bytes.length; at += CHUNK_BYTES) {
          if (p.stopped.has(id) || this.players.get(p.id) !== p) break;
          const part = bytes.subarray(at, at + CHUNK_BYTES);
          const drained = p.conn.write(chunkBytes(id, part));
          this.stats[kindOf(key)].sent += part.length;
          if (!drained) await this.drained(p);
        }
      } catch {
        // The connection went; removePlayer follows.
      } finally {
        p.sending = null;
        p.stopped.delete(id);
      }
    }
  }

  private drained(p: Player): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearInterval(gone);
        p.conn.off("drain", done);
        resolve();
      };
      // Or the player went, and no drain comes.
      const gone = setInterval(() => { if (this.players.get(p.id) !== p) done(); }, 1000);
      p.conn.on("drain", done);
    });
  }

  private sendKeys(p: Player, t: "have" | "need", keys: string[]): void {
    for (let i = 0; i < keys.length; i += KEYS_PER_WORD) this.send(p, { t, keys: keys.slice(i, i + KEYS_PER_WORD) });
  }

  private send(p: Player, word: Word): void {
    try {
      p.conn.write(wordBytes(word));
    } catch {
      // The connection went; removePlayer follows.
    }
  }
}

/** This page's: one title at a time. */
export const sideShare = new SideShare();

/** The bot's tracker, for the stream's swarm and the title's alike. */
export function trackerAnnounce(token: string | null): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/tracker${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

/** Several STUN servers improve the odds two players' routers let them
 *  through — every pair that fails to connect falls back to the bot. */
export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
  ],
};

let joined: { title: string; client: { destroy(): void } } | null = null;
/** The title what is kept is for: kept across leaving and joining it again. */
let keptFor: string | null = null;

/** A 20-byte tracker id for a swarm, as the P2P engine makes its own. */
async function swarmHash(name: string): Promise<Uint8Array> {
  const sha = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(name)));
  return new TextEncoder().encode(btoa(String.fromCharCode(...sha.slice(0, 15))));
}

function peerId(): Uint8Array {
  const symbols = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let id = "-PS0001-";
  while (id.length < 20) id += symbols[Math.floor(Math.random() * symbols.length)];
  return new TextEncoder().encode(id);
}

/**
 * Join the swarm for a title's subtitles, fonts and previews, leaving the last
 * one's; the function given back leaves it. `title` is the ratingKey: players
 * in other rooms, or on streams of their own, share the same files.
 */
export function joinSideSwarm(title: string, o: { announce: string[]; rtcConfig: RTCConfiguration }): () => void {
  if (joined?.title !== title) leaveSideSwarm();
  if (keptFor !== title) {
    sideShare.clear();
    keptFor = title;
  }
  if (joined) return leaveSideSwarm;
  const mine: { title: string; client: { destroy(): void } } = { title, client: { destroy: () => {} } };
  joined = mine;
  void (async () => {
    let infoHash: Uint8Array;
    try {
      if (typeof RTCPeerConnection === "undefined") throw new Error("no WebRTC");
      infoHash = await swarmHash(`pdt-side-${title}`);
    } catch (err) {
      logWarn("P2P", "can't join other players for subtitles, fonts and previews here", { why: String(err) });
      return;
    }
    if (joined !== mine) return;
    const id = peerId();
    const client = new TrackerClient({ infoHash, peerId: id, announce: o.announce, rtcConfig: o.rtcConfig });
    mine.client = client;
    // As the tracker's client names us to the others.
    sideShare.joinedSwarm(Array.from(id, (b) => b.toString(16).padStart(2, "0")).join(""));
    client.on("update", (d) => {
      if (joined === mine) sideShare.setOthers((d.complete ?? 0) + (d.incomplete ?? 0) - 1);
    });
    /** Offers to one player, until one connects. */
    const trying = new Map<string, Set<SideConnection>>();
    client.on("peer", (conn: SideConnection) => {
      const id = conn.id ?? "";
      if (!id || sideShare.hasPlayer(id)) {
        conn.destroy();
        return;
      }
      let offers = trying.get(id);
      if (!offers) trying.set(id, offers = new Set());
      offers.add(conn);
      conn.on("connect", () => {
        const others = trying.get(id);
        trying.delete(id);
        for (const c of others ?? []) if (c !== conn) c.destroy();
        if (joined !== mine) {
          conn.destroy();
          return;
        }
        sideShare.addPlayer(id, conn);
        logEvent("P2P", "connected to another player for subtitles, fonts and previews", {
          title, players: sideShare.playerCount(),
        });
      });
      conn.on("close", () => trying.get(id)?.delete(conn));
      conn.on("error", () => trying.get(id)?.delete(conn));
    });
    // The tracker away for a while, or a connection that won't: the bot sends
    // it all. One that can't be used at all: nobody to wait for.
    client.on("warning", () => {});
    client.on("error", () => {
      if (joined === mine) sideShare.setOthers(0);
    });
    client.start();
  })();
  return leaveSideSwarm;
}

/** Leave the title's swarm; what is kept stays, for the same title again. */
export function leaveSideSwarm(): void {
  const was = joined;
  joined = null;
  if (!was) return;
  try {
    was.client.destroy();
  } catch {
    // Gone already.
  }
  sideShare.leftSwarm();
  sideShare.dropPlayers();
}
