import fs from "node:fs";
import path from "node:path";
import { format } from "node:util";

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
 * Held append descriptor for `currentFile`.
 *
 * Every batch used to go through `fs.appendFileSync`, which opens, writes and
 * closes the file on each call — three syscalls, four times a second, forever,
 * plus a path resolution each time. Holding the descriptor makes a flush a
 * single `writeSync`.
 *
 * Deliberately still synchronous rather than a WriteStream. Ordering and
 * durability are the whole point of this file: shutdown and the crash handler
 * both write and then immediately end the process, and anything merely queued
 * on a stream at that moment is lost — which is exactly the log you most want.
 */
let fd: number | null = null;
let fdPath: string | null = null;

/**
 * Strip anything that would turn a shared log file into a credential leak.
 * Plex tokens ride in query strings on nearly every upstream URL we log, and
 * our own session tokens arrive as `?token=` on segment and ping requests.
 *
 * The leading boundary is load-bearing. Without it the bare `key` alternative
 * matched the tail of every field ending in "Key" — `ratingKey=`, `retryKey=`,
 * `plexKey=` all came out `<redacted>`, which quietly destroyed the diagnostic
 * fields the log exists for. Only match a name that starts at a delimiter.
 */
const SECRET_PARAM = /(^|[?&\s"'[{,])((?:x-plex-token|token|key|api_key|apikey)=)[^&\s"'`\]}]+/gi;

function redact(line: string): string {
  return line
    .replace(SECRET_PARAM, "$1$2<redacted>")
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

/** The append descriptor for `file`, reopening it when rotation moved us. */
function fdFor(file: string): number | null {
  if (fd !== null && fdPath === file) return fd;
  closeFd();
  try {
    fd = fs.openSync(file, "a");
    fdPath = file;
    return fd;
  } catch {
    return null; // read-only volume — stay console-only rather than crash
  }
}

function closeFd(): void {
  if (fd === null) return;
  try {
    fs.closeSync(fd);
  } catch {
    // Already gone; nothing to salvage.
  }
  fd = null;
  fdPath = null;
}

function flush(): void {
  if (buffer.length === 0) return;
  const lines = buffer;
  buffer = [];
  const file = resolveFile();
  if (!file) return;
  const payload = lines.join("");
  const target = fdFor(file);
  if (target === null) return;
  try {
    fs.writeSync(target, payload);
    currentBytes += Buffer.byteLength(payload);
  } catch {
    // Disk full, or the file was rotated out from under us. Drop the descriptor
    // so the next flush reopens, and drop the batch — losing a quarter second
    // of log beats throwing from inside a console.log.
    closeFd();
  }
}

/** Queue a pre-formatted line (already carrying its own timestamp). */
function enqueue(line: string): void {
  if (!ENABLED) return;
  buffer.push(redact(line.endsWith("\n") ? line : `${line}\n`));
  if (buffer.length >= MAX_BUFFER_LINES) flush();
}

/**
 * Render console arguments the way the console itself would.
 *
 * Joining them with spaces looked equivalent and wasn't: the codebase uses
 * printf-style calls like console.log("[Ping] %s pos=%ss", id, pos), and a plain
 * join left the specifiers and the values sitting next to each other unexpanded
 * — `[Ping] %s pos=%ss … a3cbf0ac 3565.1` — turning the most frequent
 * diagnostic line in the file into something you had to decode positionally.
 * util.format applies the substitutions and falls back to appending extras,
 * which is exactly console's own behaviour.
 */
function formatArgs(args: unknown[]): string {
  if (args.length === 1) {
    const [only] = args;
    if (typeof only === "string") return only;
    if (only instanceof Error) return only.stack || `${only.name}: ${only.message}`;
  }
  return format(...args);
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
      enqueue(`${new Date().toISOString()}${tag} ${formatArgs(args)}`);
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
    enqueue(`${new Date().toISOString()} [FATAL] unhandledRejection ${formatArgs([reason])}`);
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
  closeFd();
}

initLogger();
