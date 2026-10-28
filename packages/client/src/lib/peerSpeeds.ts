/**
 * How fast each other player has sent this one video, remembered across
 * streams and pages, so the segment the picture waits on can be taken from a
 * player proven fast from a stream's first seconds on — lib/takeFromPeer's
 * shouldTakeFromPeer takes only from a peer whose speed is known, since 68 of
 * 99 takes from unmeasured ones failed (17 to 23 October).
 *
 * Every stream is a swarm of its own — a start, a skip, another title — and
 * Discord's pop-out reloads the page, so each began with every peer's speed
 * unmeasured, and its first seconds came from the bot whatever the others
 * held: in run 25 (28 October), 253 of the 264 segments that came in during
 * a stream's first 20 seconds were the bot's, and the six taken from another
 * player were all from one already measured in that stream. The bot is the
 * slow part — each download through Discord's proxy runs at its own pace —
 * and the others were sending at 17 to 347 Mbps.
 *
 * A player is known again by the key in its peer id (peerIdPrefix): the same
 * Discord account on the same browser, through every stream and pop-out.
 */

/** "-PD", eight characters of a player's key, "-": the engine adds eight random ones. */
const PREFIX_RE = /^-PD([0-9A-Za-z]{8})-/;
const SYMBOLS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** How long a speed is counted on: a room's evening, not tomorrow's. */
export const REMEMBER_MS = 15 * 60_000;
/** Players remembered at most, the most recent kept. */
const MOST = 32;
const STORE = "pdt.peerSpeeds";
const DEVICE = "pdt.deviceKey";

interface Seen {
  bitsPerS: number;
  at: number;
}

let speeds: Map<string, Seen> | null = null;
let savedAt = 0;
let pageDevice: string | null = null;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** FNV-1a, then murmur3's finaliser — as takeFromPeer's ownerOf, which says why. */
function hash32(text: string, seed: number): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function base62(n: number, chars: number): string {
  let out = "";
  for (let i = 0; i < chars; i++) {
    out += SYMBOLS[n % 62];
    n = Math.floor(n / 62);
  }
  return out;
}

/** This browser's own key, kept across pages; one per page where nothing can be kept. */
function deviceKey(): string {
  const store = storage();
  try {
    const kept = store?.getItem(DEVICE);
    if (kept && /^[0-9A-Za-z]{12}$/.test(kept)) return kept;
  } catch { /* not kept: one for this page */ }
  if (!pageDevice) {
    pageDevice = Array.from({ length: 12 }, () => SYMBOLS[Math.floor(Math.random() * 62)]).join("");
    try {
      store?.setItem(DEVICE, pageDevice);
    } catch { /* this page's alone */ }
  }
  return pageDevice;
}

/** The start of this player's peer ids, the P2P engine's trackerClientVersionPrefix. */
export function peerIdPrefix(userId: string | null, device = deviceKey()): string {
  const who = `${userId ?? "?"}|${device}`;
  return `-PD${base62(hash32(who, 0), 4)}${base62(hash32(who, 0x9e3779b9), 4)}-`;
}

/** The player a peer id is, or null for one that isn't ours. */
export function playerKeyOf(peerId: string): string | null {
  return PREFIX_RE.exec(peerId)?.[1] ?? null;
}

function load(): Map<string, Seen> {
  if (speeds) return speeds;
  speeds = new Map();
  try {
    const raw = storage()?.getItem(STORE);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") {
      for (const [key, v] of Object.entries(parsed as Record<string, unknown>)) {
        const seen = v as Partial<Seen>;
        if (/^[0-9A-Za-z]{8}$/.test(key) && typeof seen.bitsPerS === "number" && seen.bitsPerS > 0 && typeof seen.at === "number") {
          speeds.set(key, { bitsPerS: seen.bitsPerS, at: seen.at });
        }
      }
    }
  } catch { /* nothing remembered */ }
  return speeds;
}

function save(now: number): void {
  if (now - savedAt < 2_000) return;
  savedAt = now;
  try {
    storage()?.setItem(STORE, JSON.stringify(Object.fromEntries(load())));
  } catch { /* kept for this page only */ }
}

/** How fast a peer is sending now, as the P2P engine measures it (bits per second). */
export function rememberPeerSpeed(peerId: string, bitsPerS: number, now = Date.now()): void {
  const key = playerKeyOf(peerId);
  if (!key || !(bitsPerS > 0) || !Number.isFinite(bitsPerS)) return;
  const all = load();
  all.delete(key);
  all.set(key, { bitsPerS, at: now });
  while (all.size > MOST) all.delete(all.keys().next().value as string);
  save(now);
}

/** A peer's speed from an earlier stream or page within REMEMBER_MS; 0 for none. */
export function rememberedPeerSpeed(peerId: string, now = Date.now()): number {
  const key = playerKeyOf(peerId);
  if (!key) return 0;
  const seen = load().get(key);
  return seen && now - seen.at <= REMEMBER_MS ? seen.bitsPerS : 0;
}

/** For the tests: forget everything, as a new page would with nothing kept. */
export function forgetPeerSpeedsForTests(): void {
  speeds = null;
  savedAt = 0;
  pageDevice = null;
}
