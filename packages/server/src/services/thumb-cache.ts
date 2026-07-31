import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_MAX_MB = 500;

const TTL_MS = parseInt(process.env.THUMB_CACHE_TTL_MS || "", 10) || DEFAULT_TTL_MS;
const MAX_BYTES =
  (parseInt(process.env.THUMB_CACHE_MAX_MB || "", 10) || DEFAULT_MAX_MB) * 1024 * 1024;

const dbDir = process.env.THUMB_CACHE_DIR
  ? path.resolve(process.env.THUMB_CACHE_DIR)
  : path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      "../../data",
    );
fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(path.join(dbDir, "thumb-cache.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS thumbs (
    path TEXT PRIMARY KEY,
    content_type TEXT NOT NULL,
    data BLOB NOT NULL,
    cached_at INTEGER NOT NULL
  )
`);

const stmtGet = db.prepare<[string], { content_type: string; data: Buffer; cached_at: number }>(
  "SELECT content_type, data, cached_at FROM thumbs WHERE path = ?",
);

const stmtSet = db.prepare(
  "INSERT OR REPLACE INTO thumbs (path, content_type, data, cached_at) VALUES (?, ?, ?, ?)",
);

const stmtDeleteExpired = db.prepare<[number], { freed: number }>(
  "DELETE FROM thumbs WHERE cached_at < ? RETURNING LENGTH(data) AS freed",
);

const stmtSizeOf = db.prepare<[string], { len: number }>(
  "SELECT LENGTH(data) AS len FROM thumbs WHERE path = ?",
);

const stmtDeleteOne = db.prepare("DELETE FROM thumbs WHERE path = ?");

// Eviction and the expiry sweep both order by cached_at, and `get` deletes by
// primary key. Without this index every write scanned the whole table — up to
// 500 MB of BLOBs — twice.
db.exec("CREATE INDEX IF NOT EXISTS idx_thumbs_cached_at ON thumbs (cached_at)");

const stmtEvictOldest = db.prepare<[number], { freed: number }>(
  `DELETE FROM thumbs WHERE path IN (
     SELECT path FROM thumbs ORDER BY cached_at ASC LIMIT ?
   ) RETURNING LENGTH(data) AS freed`,
);

/**
 * Running total of cached bytes, seeded once at startup.
 *
 * The alternative — `SELECT SUM(LENGTH(data))` — is a full scan of every BLOB
 * in the table, and it ran on every single write. better-sqlite3 is synchronous,
 * so that was happening on the event loop of a server whose main job is
 * proxying video segments, roughly 200 times over while a library page loads.
 */
let totalBytes = (
  db.prepare<[], { total: number }>(
    "SELECT COALESCE(SUM(LENGTH(data)), 0) AS total FROM thumbs",
  ).get() ?? { total: 0 }
).total;

/** How often expired rows are swept. Was once per write; nothing about expiry
 *  is urgent enough to justify that, and `get` rejects stale rows anyway. */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

interface CacheEntry {
  contentType: string;
  data: Buffer;
}

export function get(thumbPath: string): CacheEntry | null {
  const row = stmtGet.get(thumbPath);
  if (!row) return null;

  // Check TTL
  if (Date.now() - row.cached_at > TTL_MS) {
    stmtDeleteOne.run(thumbPath);
    totalBytes = Math.max(0, totalBytes - row.data.length);
    return null;
  }

  return { contentType: row.content_type, data: row.data };
}

export function set(thumbPath: string, contentType: string, data: Buffer): void {
  // INSERT OR REPLACE, so an overwrite has to discount whatever it displaced —
  // otherwise the running total drifts up and evicts far more than it should.
  const existing = stmtSizeOf.get(thumbPath);
  stmtSet.run(thumbPath, contentType, data, Date.now());
  totalBytes += data.length - (existing?.len ?? 0);

  // Evict oldest first, in batches, counting the bytes each batch actually
  // freed rather than re-summing the table.
  while (totalBytes > MAX_BYTES) {
    const freed = stmtEvictOldest.all(50);
    if (freed.length === 0) break; // nothing left to evict
    for (const row of freed) totalBytes -= row.freed;
  }
}

/** Drop expired rows. On a timer rather than on every write — see SWEEP_INTERVAL_MS. */
function sweepExpired(): void {
  const gone = stmtDeleteExpired.all(Date.now() - TTL_MS);
  for (const row of gone) totalBytes -= row.freed;
  if (totalBytes < 0) totalBytes = 0;
}

const sweepTimer = setInterval(sweepExpired, SWEEP_INTERVAL_MS);
// Never hold the process open for a cache sweep.
sweepTimer.unref();

export function close(): void {
  clearInterval(sweepTimer);
  db.close();
}
