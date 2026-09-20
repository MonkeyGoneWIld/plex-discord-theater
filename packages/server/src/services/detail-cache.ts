/**
 * Persistent detail-page cache.
 *
 * The old caches lived only in Maps inside routes/plex.ts. Every container
 * restart therefore made the cache warmer rebuild the same hundreds of titles
 * against Plex. These rows live beside the other SQLite state in /data, so a
 * deployment can reuse them. The warmer records Plex's `updatedAt` after both
 * halves of a title have been rebuilt and only invalidates rows whose source
 * version has actually changed.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type DetailCacheKind = "meta" | "related";

export interface DetailCacheEntry<T> {
  payload: T;
  sourceUpdatedAt: number | null;
  cachedAt: number;
}

interface DetailCacheRow {
  payload_json: string;
  source_updated_at: number | null;
  cached_at: number;
}

const dbDir = process.env.THUMB_CACHE_DIR
  ? path.resolve(process.env.THUMB_CACHE_DIR)
  : path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      "../../data",
    );
fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(path.join(dbDir, "detail-cache.sqlite"));
const MAX_REUSE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS detail_cache (
    kind TEXT NOT NULL CHECK (kind IN ('meta', 'related')),
    rating_key TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    source_updated_at INTEGER,
    cached_at INTEGER NOT NULL,
    PRIMARY KEY (kind, rating_key)
  );
  CREATE INDEX IF NOT EXISTS idx_detail_cache_source
    ON detail_cache (rating_key, source_updated_at);
`);

const readStmt = db.prepare<[DetailCacheKind, string], DetailCacheRow>(`
  SELECT payload_json, source_updated_at, cached_at
  FROM detail_cache
  WHERE kind = ? AND rating_key = ?
`);
const writeStmt = db.prepare(`
  INSERT INTO detail_cache (kind, rating_key, payload_json, source_updated_at, cached_at)
  VALUES (?, ?, ?, NULL, ?)
  ON CONFLICT(kind, rating_key) DO UPDATE SET
    payload_json = excluded.payload_json,
    source_updated_at = NULL,
    cached_at = excluded.cached_at
`);
const versionsStmt = db.prepare<[string], { kind: DetailCacheKind; source_updated_at: number | null; cached_at: number }>(`
  SELECT kind, source_updated_at, cached_at
  FROM detail_cache
  WHERE rating_key = ?
`);
const markStmt = db.prepare(`
  UPDATE detail_cache
  SET source_updated_at = ?
  WHERE rating_key = ?
`);
const deleteStmt = db.prepare("DELETE FROM detail_cache WHERE rating_key = ?");

export function readDetailCache<T>(kind: DetailCacheKind, ratingKey: string): DetailCacheEntry<T> | null {
  const row = readStmt.get(kind, ratingKey);
  if (!row) return null;
  try {
    return {
      payload: JSON.parse(row.payload_json) as T,
      sourceUpdatedAt: row.source_updated_at,
      cachedAt: row.cached_at,
    };
  } catch {
    // A partial/corrupt row should cost one refetch, not break every detail page.
    db.prepare("DELETE FROM detail_cache WHERE kind = ? AND rating_key = ?").run(kind, ratingKey);
    return null;
  }
}

export function writeDetailCache(kind: DetailCacheKind, ratingKey: string, payload: unknown): void {
  writeStmt.run(kind, ratingKey, JSON.stringify(payload), Date.now());
}

/** True only after both detail-page halves were built from this Plex version. */
export function detailCacheMatches(ratingKey: string, sourceUpdatedAt: number): boolean {
  const rows = versionsStmt.all(ratingKey);
  const oldestAllowed = Date.now() - MAX_REUSE_AGE_MS;
  return rows.length === 2 && rows.every(
    (row) => row.source_updated_at === sourceUpdatedAt && row.cached_at >= oldestAllowed,
  );
}

/** Mark meta + related atomically after a complete warm succeeds. */
const markVersionTransaction = db.transaction((ratingKey: string, sourceUpdatedAt: number) => {
  markStmt.run(sourceUpdatedAt, ratingKey);
});

export function markDetailCacheVersion(ratingKey: string, sourceUpdatedAt: number): void {
  markVersionTransaction(ratingKey, sourceUpdatedAt);
}

export function invalidateDetailCache(ratingKey: string): void {
  deleteStmt.run(ratingKey);
}

export function closeDetailCache(): void {
  db.close();
}
