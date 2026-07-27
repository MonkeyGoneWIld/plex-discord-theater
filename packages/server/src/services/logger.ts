import fs from "node:fs";
import path from "node:path";

/**
 * File-backed logging.
 *
 * Everything the server writes to the console is teed into the data directory
 * so a stream that dies at 3am can still be reconstructed the next morning —
 * container logs roll away, these don't. Client-side events are shipped up and
 * folded into the same file (see routes/logs.ts), because the interesting half
 * of "why did the stream stop" only exists in the browser: the server just sees
 * a DELETE arrive.
 *
 * Layout: <data>/logs/theater-YYYY-MM-DD.log, rotated by size within the day
 * (…-1.log, …-2.log) and pruned by age. Pull them off a running container with
 * `docker cp plex-discord-theater:/data/logs ./logs` — there's deliberately no
 * HTTP route to read them back.
 */

const dataDir = process.env.THUMB_CACHE_DIR
  ? path.resolve(process.env.THUMB_CACHE_DIR)
  : path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      "../../data",
    );

export const LOG_DIR = process.env.LOG_DIR
  ? path.resolve(process.env.LOG_DIR)
  : path.join(dataDir, "logs");

const ENABLED = process.env.LOG_TO_FILE !== "0";
const MAX_FILE_BYTES = Math.max(1, Number(process.env.LOG_MAX_FILE_MB) || 64) * 1024 * 1024;
const RETENTION_DAYS = Math.max(1, Number(process.env.LOG_RETENTION_DAYS) || 7);
// Flush cadence. Lines are batched so the HLS segment firehose doesn't turn
// into one syscall per fetch, but the window stays short enough that a crash
// loses at most a quarter second of context.
const FLUSH_MS = 250;
const MAX_BUFFER_LINES = 2000;

let buffer: string[] = [];
let currentFile: string | null = null;
let currentDay: string | null = null;
let currentBytes = 0;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let installed = false;

/**
 * Strip anything that would turn a shared log file into a credential leak.
 * Plex tokens ride in query strings on nearly every upstream URL we log, and
 * our own session tokens arrive as `?token=` on segment and ping requests.
 */
function redact(line: string): string {
  return line
    .replace(/((?:X-Plex-Token|token|key|api_key|apikey)=)[^&\s"'`]+/gi, "$1<redacted>")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, "$1<redacted>");
}

function dayStamp(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Pick the file to append to, rolling over on a new day or a full file. */
function resolveFile(): string | null {
  if (!ENABLED) return null;
  const day = dayStamp();
  if (currentFile && day === currentDay && currentBytes < MAX_FILE_BYTES) {
    return currentFile;
  }

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    return null; // read-only volume — stay console-only rather than crash
  }

  if (day !== currentDay) {
    currentDay = day;
    pruneOldLogs();
  }

  // Find the highest un-full index for today.
  let index = 0;
  for (;;) {
    const candidate = path.join(LOG_DIR, index === 0 ? `theater-${day}.log` : `theater-${day}-${index}.log`);
    let size = 0;
    try {
      size = fs.statSync(candidate).size;
    } catch {
      size = 0; // doesn't exist yet
    }
    if (size < MAX_FILE_BYTES) {
      currentFile = candidate;
      currentBytes = size;
      return candidate;
    }
    index++;
    if (index > 999) {
      // Pathological — stop searching and reuse the last one.
      currentFile = candidate;
      currentBytes = 0;
      return candidate;
    }
  }
}

function pruneOldLogs(): void {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let names: string[];
  try {
    names = fs.readdirSync(LOG_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith("theater-") || !name.endsWith(".log")) continue;
    const full = path.join(LOG_DIR, name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    } catch {
      // Racing another prune, or the file is locked — leave it.
    }
  }
}

function flush(): void {
  if (buffer.length === 0) return;
  const lines = buffer;
  buffer = [];
  const file = resolveFile();
  if (!file) return;
  const payload = lines.join("");
  try {
    fs.appendFileSync(file, payload);
    currentBytes += Buffer.byteLength(payload);
  } catch {
    // Disk full or permissions — dropping the batch beats crashing the stream.
  }
}

/** Queue a pre-formatted line (already carrying its own timestamp). */
function enqueue(line: string): void {
  if (!ENABLED) return;
  buffer.push(redact(line.endsWith("\n") ? line : `${line}\n`));
  if (buffer.length >= MAX_BUFFER_LINES) flush();
}

function formatArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/**
 * Tee console output into the log file. Invoked at the bottom of this module
 * rather than by the caller: ESM hoists imports, so anything index.ts calls in
 * its own body already runs after every other module has initialised (and
 * logged). Importing this module first is what gets the tee in early.
 */
export function initLogger(): void {
  if (installed || !ENABLED) return;
  installed = true;

  const levels = ["log", "info", "warn", "error", "debug"] as const;
  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      const tag = level === "log" || level === "info" ? "" : ` [${level.toUpperCase()}]`;
      enqueue(`${new Date().toISOString()}${tag} ${args.map(formatArg).join(" ")}`);
    };
  }

  flushTimer = setInterval(flush, FLUSH_MS);
  flushTimer.unref();

  // Last-ditch capture — a crash is exactly when the log matters most.
  process.on("uncaughtException", (err) => {
    enqueue(`${new Date().toISOString()} [FATAL] uncaughtException ${err.stack || err.message}`);
    flush();
    throw err;
  });
  process.on("unhandledRejection", (reason) => {
    enqueue(`${new Date().toISOString()} [FATAL] unhandledRejection ${formatArg(reason)}`);
    flush();
  });

  resolveFile();
  console.log(`[Log] Writing to ${LOG_DIR} (retention ${RETENTION_DAYS}d, rotate at ${MAX_FILE_BYTES / 1024 / 1024}MB)`);
}

/**
 * Structured event. Goes through console so it lands in both the container log
 * and the file, and renders as `[Tag] message key=value key=value` — greppable
 * without pulling in a JSON log pipeline.
 */
export function logEvent(tag: string, message: string, fields?: Record<string, unknown>): void {
  let line = `[${tag}] ${message}`;
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      const rendered =
        typeof value === "number" && !Number.isInteger(value) ? value.toFixed(2) : String(value);
      line += ` ${key}=${rendered}`;
    }
  }
  console.log(line);
}

/** Append an already-formatted line from a client, bypassing the console tee. */
export function writeClientLine(line: string): void {
  enqueue(line);
}

export function closeLogger(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  flush();
}

initLogger();
