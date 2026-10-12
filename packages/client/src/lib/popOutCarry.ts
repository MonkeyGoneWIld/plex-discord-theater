/**
 * What a player carries across Discord reloading the activity — popping it out
 * of its window, and back in.
 *
 * A reload starts the page from nothing: the picture just ahead and the seek
 * bar's preview frames were fetched from the bot all over again, and a player
 * coming back waited for its next segment as if it had never been there. So
 * as the page goes, the stretch of picture just ahead of the playhead and the
 * preview frames are handed to a service worker (public/pdt-carry-sw.js),
 * which holds them in memory until the page that replaces this one asks for
 * them — and for a minute at most. Only for a reload: a page that is only
 * hidden, and shown again, has the worker let its copy go; and a carry for
 * another stream is never used.
 *
 * Not the page's own storage: anything written to IndexedDB as a page unloads
 * is dropped with it. A message to the worker is out of the page the moment
 * it is sent.
 */
import type { PreviewFramesCarry } from "./previewFrames";
import { logEvent } from "./log";

/** A segment of picture, as the P2P engine holds it. */
export interface EngineSegment {
  data: ArrayBuffer;
  segmentId: number;
  streamId: string;
  startTime: number;
  endTime: number;
  streamType: string;
}

export interface Carry {
  savedAt: number;
  /** The stream its segments belong to. */
  sessionId: string | null;
  ratingKey: string | null;
  positionS: number | null;
  segments: EngineSegment[];
  preview: (PreviewFramesCarry & { partId: number }) | null;
}

/** How long a carry is any good: a reload takes seconds. */
export const CARRY_FOR_MS = 60_000;
/** The stretch of picture carried: from a moment before the playhead… */
export const CARRY_BEHIND_S = 2;
/** …to this far after it — past where a player coming back lands. */
export const CARRY_AHEAD_S = 30;
/** And no more than this of it: half a minute of a copied Blu-ray. */
export const CARRY_MAX_BYTES = 96 * 1024 * 1024;

/**
 * Which of what the engine holds is carried: the main stream's segments from
 * a moment before `atS` to `aheadS` after it, in order, until `maxBytes` —
 * the stretch a player coming back plays first, without a gap in it.
 */
export function segmentsToCarry<T extends { startTime: number; endTime: number; bytes: number; main: boolean }>(
  held: Iterable<T>,
  atS: number,
  aheadS = CARRY_AHEAD_S,
  behindS = CARRY_BEHIND_S,
  maxBytes = CARRY_MAX_BYTES,
): T[] {
  const wanted = [...held]
    .filter((s) => s.main && s.endTime > atS - behindS && s.startTime < atS + aheadS)
    .sort((a, b) => a.startTime - b.startTime);
  const out: T[] = [];
  let total = 0;
  for (const s of wanted) {
    if (total + s.bytes > maxBytes) break;
    out.push(s);
    total += s.bytes;
  }
  return out;
}

const WORKER_URL = "/pdt-carry-sw.js";
/** How long the worker is waited on for what it holds — it waits a moment itself
 *  for what the page before is still sending, and answers at once otherwise. */
const ASK_MS = 4_000;
/** How often the worker is told the page is there: it stops after half a minute without a word. */
const ALIVE_MS = 20_000;

let worker: ServiceWorker | null = null;
/** What the page before this one left, taken up once — see startCarry. */
let taken: Promise<Carry | null> | null = null;
/** The same, once it is in, for what has to be answered there and then. */
let held: Carry | null = null;
/** Whether that is known: nothing was left, or this was. */
let settled = false;
const sources = new Map<string, () => Partial<Carry> | null>();

const sizeMB = (carry: Carry) =>
  Number((carry.segments.reduce((n, s) => n + s.data.byteLength, 0) / 1e6).toFixed(1));

function ask(target: ServiceWorker): Promise<Carry | null> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), ASK_MS);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve((event.data as { carry?: Carry | null })?.carry ?? null);
    };
    target.postMessage({ type: "take" }, [channel.port2]);
  });
}

/**
 * Take up whatever the page before this one left, and from now on leave what
 * this one has as it goes. Once per page.
 */
export function startCarry(): void {
  if (taken || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const container = navigator.serviceWorker;
  // Registered every time, in the background: that is how a new version of the
  // worker arrives. Nothing waits on it — it fetches the worker's script.
  const registering = container.register(WORKER_URL, { scope: "/" })
    .then(() => container.ready)
    .then((registration) => { useWorker(registration.active); })
    .catch((err) => {
      logEvent("Carry", "no service worker to keep anything across a reload", { error: String(err) });
    });
  void registering;
  taken = (async () => {
    // The worker a page before this one had, found here without the network:
    // only it can be holding anything. None, and there is nothing to wait for.
    const existing = await container.getRegistration("/");
    if (!existing?.active) return null;
    useWorker(existing.active);
    const carry = await ask(existing.active);
    if (!carry) return null;
    const ageMs = Date.now() - carry.savedAt;
    if (ageMs > CARRY_FOR_MS) return null;
    held = carry;
    logEvent("Carry", "the page before this one kept some of the film", {
      ageMs,
      session: carry.sessionId?.substring(0, 8) ?? "none",
      segments: carry.segments.length,
      MB: sizeMB(carry),
      previewFrames: carry.preview?.frames.length ?? 0,
    });
    // Not kept for ever: what nothing takes up in a minute is let go.
    setTimeout(() => { if (held === carry) held = null; }, CARRY_FOR_MS);
    return carry;
  })().catch(() => null).then((carry) => {
    settled = true;
    return carry;
  });
  // Shown again after being hidden, it wasn't a reload. But once the page is
  // going, nothing it sees is a page coming back: Chrome tells a frame it is
  // visible again after it has been told it is going.
  let going = false;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") keep("hidden");
    else if (!going) drop();
  });
  window.addEventListener("pagehide", () => {
    going = true;
    keep("pagehide");
  });
  // Back from the browser's own cache of the page: it is all still here.
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    going = false;
    drop();
  });
}

let alive: ReturnType<typeof setInterval> | null = null;

/** The worker this page hands things to, kept running while the page is here. */
function useWorker(active: ServiceWorker | null): void {
  if (!active) return;
  worker = active;
  // Kept running: a worker stopped for want of anything to do is started
  // again by a page's message, and the page that replaces this one can ask
  // before what this one sent as it went has arrived.
  alive ??= setInterval(() => worker?.postMessage({ type: "alive" }), ALIVE_MS);
}

/** Something this page has to carry: called as it goes, for what it has then. */
export function carrySource(name: string, source: () => Partial<Carry> | null): () => void {
  sources.set(name, source);
  return () => { if (sources.get(name) === source) sources.delete(name); };
}

let keptAt = 0;

/** Hand the worker what this page has, for the page that replaces it. */
function keep(why: string): void {
  if (!worker) return;
  // Hidden, then gone: the one from a moment ago is the same.
  if (why === "pagehide" && Date.now() - keptAt < 2_000) return;
  const parts = [...sources.values()].map((source) => {
    try { return source(); } catch { return null; }
  }).filter((p): p is Partial<Carry> => !!p);
  const carry: Carry = Object.assign(
    { savedAt: Date.now(), sessionId: null, ratingKey: null, positionS: null, segments: [], preview: null },
    ...parts,
  );
  if (carry.segments.length === 0 && !carry.preview) return;
  try {
    // Word first, so a page asking before the rest has arrived waits for it.
    worker.postMessage({ type: "keeping" });
    worker.postMessage({ type: "keep", carry });
    keptAt = Date.now();
  } catch {
    return;
  }
  logEvent("Carry", "handed some of the film to keep in case this is a reload", {
    why,
    session: carry.sessionId?.substring(0, 8) ?? "none",
    atS: carry.positionS === null ? "none" : Number(carry.positionS.toFixed(2)),
    segments: carry.segments.length,
    MB: sizeMB(carry),
    previewFrames: carry.preview?.frames.length ?? 0,
  });
}

/** Shown again: it wasn't a reload, and this page still has it all. */
function drop(): void {
  if (!worker || !keptAt) return;
  keptAt = 0;
  try {
    worker.postMessage({ type: "drop" });
  } catch {
    // The worker is gone, and what it held with it.
  }
}

/** Waited on for no longer than this: a stream doesn't start late for it.
 *  With nothing coming, the worker answers at once. */
const TAKE_WAIT_MS = 3_000;

/** Whether it is known yet what the page before this one left — see carryReady. */
export function carrySettled(): boolean {
  return !taken || settled;
}

/** Once it is known what the page before this one left, or `waitMs` has gone by. */
export function carryReady(waitMs = TAKE_WAIT_MS): Promise<void> {
  if (carrySettled()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, waitMs);
    void taken!.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function carryNow(waitMs: number): Promise<Carry | null> {
  if (!taken) return held;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs); });
  const carry = await Promise.race([taken, late]);
  clearTimeout(timer);
  return carry && held === carry ? carry : null;
}

/** The segments carried for `sessionId`, once, as the engine holds them. */
export async function takeCarriedSegments(sessionId: string, waitMs = TAKE_WAIT_MS): Promise<EngineSegment[]> {
  const carry = await carryNow(waitMs);
  if (!carry || carry.sessionId !== sessionId || carry.segments.length === 0) return [];
  const segments = carry.segments;
  carry.segments = [];
  return segments;
}

/** Where the carried picture for `sessionId` runs, for landing on it. */
export function carriedRanges(sessionId: string | null): Array<[number, number]> {
  if (!held || !sessionId || held.sessionId !== sessionId) return [];
  return held.segments.map((s) => [s.startTime, s.endTime]);
}

/** The stream this page plays now — see takeCarriedPreview. */
let session: string | null = null;
const sessionWaiters = new Set<() => void>();

/** The player has started on `sessionId`. */
export function carrySession(sessionId: string | null): void {
  session = sessionId;
  if (!sessionId) return;
  for (const wake of [...sessionWaiters]) wake();
}

/** The stream this page plays, once the player has said — or null after `waitMs`. */
function sessionNow(waitMs: number): Promise<string | null> {
  if (session) return Promise.resolve(session);
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      sessionWaiters.delete(wake);
      resolve(session);
    };
    const timer = setTimeout(wake, waitMs);
    sessionWaiters.add(wake);
  });
}

/**
 * The preview frames carried for `partId`, once — for a page on the stream
 * the one before was on, as a pop-out leaves it. Another stream of the same
 * file is another viewing, whatever was left over from the last one.
 */
export async function takeCarriedPreview(partId: number, waitMs = TAKE_WAIT_MS): Promise<PreviewFramesCarry | null> {
  const carry = await carryNow(waitMs);
  if (!carry?.preview || carry.preview.partId !== partId) return null;
  // The seek bar can ask before the player has started on its stream.
  const current = await sessionNow(waitMs);
  if (!current || carry.sessionId !== current || !carry.preview) return null;
  const preview = carry.preview;
  carry.preview = null;
  return preview;
}
