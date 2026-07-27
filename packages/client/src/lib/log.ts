import { getSessionToken } from "./api";

/**
 * Client-side diagnostics, shipped to the server so they persist alongside its
 * own log.
 *
 * The server can only ever see the *consequences* of a player decision — a
 * DELETE arrives, a new manifest is requested at a surprising offset. Which
 * branch of Player.tsx made that call, what the playhead and buffer looked like
 * at the time, and what sync command preceded it all live in the browser. This
 * gets them into the same file, in the same clock, as the server's lines.
 */

const ENDPOINT = "/api/logs/client";
const FLUSH_MS = 3000;
const MAX_QUEUE = 400;
// Matches the server's per-batch cap.
const MAX_BATCH = 200;

export interface LogEntry {
  t: number;
  level: "log" | "warn" | "error";
  tag: string;
  msg: string;
  data?: Record<string, unknown>;
}

// Short, stable per-tab id so a room's clients can be told apart in one file.
const clientId = Math.random().toString(36).slice(2, 10);

let queue: LogEntry[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let installed = false;
let shipping = false;

export function getLogClientId(): string {
  return clientId;
}

function drain(): LogEntry[] {
  const batch = queue.slice(0, MAX_BATCH);
  queue = queue.slice(batch.length);
  return batch;
}

async function flush(): Promise<void> {
  if (shipping || queue.length === 0) return;
  shipping = true;
  const batch = drain();
  try {
    const token = getSessionToken();
    await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ clientId, entries: batch }),
      keepalive: true,
    });
  } catch {
    // Server unreachable — put the batch back at the front so a transient
    // failure doesn't silently erase the window we most want to look at.
    // Bounded by MAX_QUEUE below, so a long outage still can't grow forever.
    queue = [...batch, ...queue].slice(-MAX_QUEUE);
  } finally {
    shipping = false;
  }
}

/**
 * Best-effort flush when the tab is going away. `sendBeacon` can't set an
 * Authorization header, hence the `?token=` form the auth middleware accepts
 * for exactly these cases.
 */
function flushOnUnload(): void {
  if (queue.length === 0) return;
  const batch = drain();
  const token = getSessionToken();
  const url = token ? `${ENDPOINT}?token=${encodeURIComponent(token)}` : ENDPOINT;
  const payload = JSON.stringify({ clientId, entries: batch });
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([payload], { type: "application/json" }));
      return;
    }
  } catch {
    // fall through
  }
  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {});
}

function enqueue(entry: LogEntry): void {
  queue.push(entry);
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
}

/**
 * Record an event. Also prints to the console, so live debugging in devtools
 * shows the same thing that lands in the file.
 */
export function logEvent(tag: string, msg: string, data?: Record<string, unknown>): void {
  enqueue({ t: Date.now(), level: "log", tag, msg, data });
  if (data) console.log(`[${tag}] ${msg}`, data);
  else console.log(`[${tag}] ${msg}`);
}

// Set while a helper below is calling console, so the console patch installed by
// initClientLogging knows the structured version is already queued and skips it.
let selfLogging = false;

export function logWarn(tag: string, msg: string, data?: Record<string, unknown>): void {
  enqueue({ t: Date.now(), level: "warn", tag, msg, data });
  selfLogging = true;
  try {
    if (data) console.warn(`[${tag}] ${msg}`, data);
    else console.warn(`[${tag}] ${msg}`);
  } finally {
    selfLogging = false;
  }
}

export function logError(tag: string, msg: string, data?: Record<string, unknown>): void {
  enqueue({ t: Date.now(), level: "error", tag, msg, data });
  selfLogging = true;
  try {
    if (data) console.error(`[${tag}] ${msg}`, data);
    else console.error(`[${tag}] ${msg}`);
  } finally {
    selfLogging = false;
  }
}

function stringifyArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/**
 * Start shipping. Also captures anything already going through console.warn /
 * console.error and any uncaught error, so pre-existing warnings scattered
 * through the player (hls.js recovery notices, autoplay rejections) come along
 * without having to rewrite every call site.
 */
export function initClientLogging(): void {
  if (installed) return;
  installed = true;

  for (const level of ["warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      if (selfLogging) return; // logWarn/logError already queued the structured form
      enqueue({ t: Date.now(), level, tag: "Console", msg: args.map(stringifyArg).join(" ") });
    };
  }

  window.addEventListener("error", (e) => {
    enqueue({
      t: Date.now(),
      level: "error",
      tag: "WindowError",
      msg: e.message,
      data: { source: e.filename, line: e.lineno, col: e.colno },
    });
  });

  window.addEventListener("unhandledrejection", (e) => {
    enqueue({
      t: Date.now(),
      level: "error",
      tag: "UnhandledRejection",
      msg: stringifyArg(e.reason),
    });
  });

  // A backgrounded tab is a prime suspect for stalls — record the transition and
  // get the queue out while we still can.
  document.addEventListener("visibilitychange", () => {
    enqueue({
      t: Date.now(),
      level: "log",
      tag: "Page",
      msg: `visibility ${document.visibilityState}`,
    });
    if (document.visibilityState === "hidden") flushOnUnload();
  });

  window.addEventListener("pagehide", flushOnUnload);

  timer = setInterval(() => { void flush(); }, FLUSH_MS);

  logEvent("Client", "logging started", {
    clientId,
    ua: navigator.userAgent.slice(0, 180),
    screen: `${window.screen.width}x${window.screen.height}`,
  });
}

export function stopClientLogging(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  void flush();
}
