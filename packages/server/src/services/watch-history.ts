/**
 * Per-user watch history and resume positions, persisted in SQLite.
 *
 * History is attributed to the room's HOST, not to every participant. The host
 * is the one who chose the title and whose playback session the room is watching,
 * so theirs is the only history that means anything — a viewer who dropped in for
 * the last ten minutes shouldn't end up with a half-watched film in Continue
 * Watching. The sync service passes the host's Discord user id on every write.
 *
 * Positions arrive from the host's 5-second sync heartbeat, so throttling lives
 * here rather than at the call site: heartbeat writes coalesce to one row update
 * per PROGRESS_WRITE_INTERVAL_MS, while pause/seek/stop force an immediate write.
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { plexJSON } from "./plex.js";

/** Watched past this fraction of the runtime counts as finished. */
const COMPLETE_RATIO = 0.9;
/** Below this, there's nothing worth resuming — the entry stays out of Continue Watching. */
const MIN_RESUME_MS = 60_000;
/** A brand-new entry needs at least this much watched before it's worth remembering. */
const MIN_NEW_ENTRY_MS = 10_000;
/** Heartbeat writes coalesce to at most one per item per this interval. */
const PROGRESS_WRITE_INTERVAL_MS = 15_000;
/** Rows kept per user; the oldest beyond this are pruned after each insert. */
const MAX_ROWS_PER_USER = 500;
const META_CACHE_TTL_MS = 60 * 60 * 1000;

// Same data directory as the session/instance/thumb databases.
const dbDir = process.env.THUMB_CACHE_DIR
  ? path.resolve(process.env.THUMB_CACHE_DIR)
  : path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      "../../data",
    );
fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(path.join(dbDir, "watch-history.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS watch_history (
    user_id TEXT NOT NULL,
    rating_key TEXT NOT NULL,
    position_ms INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    watched INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    thumb TEXT,
    show_thumb TEXT,
    show_title TEXT,
    parent_title TEXT,
    parent_index INTEGER,
    item_index INTEGER,
    year INTEGER,
    parent_rating_key TEXT,
    grandparent_rating_key TEXT,
    dismissed INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, rating_key)
  );
  CREATE INDEX IF NOT EXISTS idx_watch_history_user_updated
    ON watch_history (user_id, updated_at DESC);
`);
// Idempotent migration for databases created before `dismissed` existed. New
// installs already have it from CREATE TABLE, where this fails harmlessly.
// (Same pattern as routes/discord.ts.)
try {
  db.exec(`ALTER TABLE watch_history ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (!message.includes("duplicate column")) throw err;
}

interface HistoryRow {
  rating_key: string;
  position_ms: number;
  duration_ms: number;
  watched: number;
  title: string;
  type: string;
  thumb: string | null;
  show_thumb: string | null;
  show_title: string | null;
  parent_title: string | null;
  parent_index: number | null;
  item_index: number | null;
  year: number | null;
  parent_rating_key: string | null;
  grandparent_rating_key: string | null;
  updated_at: number;
}

/**
 * One watched (or part-watched) item. Field names and the `/api/plex/thumb`
 * prefix on artwork match the client's PlexItem, so entries render through the
 * same card components as library items with no translation layer.
 */
export interface HistoryEntry {
  ratingKey: string;
  title: string;
  type: string;
  thumb: string | null;
  showThumb: string | null;
  showTitle: string | null;
  parentTitle: string | null;
  parentIndex: number | null;
  index: number | null;
  year: number | null;
  parentRatingKey: string | null;
  grandparentRatingKey: string | null;
  /** Resume position in milliseconds. */
  positionMs: number;
  /** Total runtime in milliseconds, or 0 when Plex didn't report one. */
  durationMs: number;
  watched: boolean;
  updatedAt: number;
}

const upsertStmt = db.prepare(`
  INSERT INTO watch_history (
    user_id, rating_key, position_ms, duration_ms, watched,
    title, type, thumb, show_thumb, show_title, parent_title,
    parent_index, item_index, year, parent_rating_key, grandparent_rating_key,
    updated_at
  ) VALUES (
    @user_id, @rating_key, @position_ms, @duration_ms, @watched,
    @title, @type, @thumb, @show_thumb, @show_title, @parent_title,
    @parent_index, @item_index, @year, @parent_rating_key, @grandparent_rating_key,
    @updated_at
  )
  ON CONFLICT(user_id, rating_key) DO UPDATE SET
    -- Playing something makes it current again: a title dismissed from Continue
    -- Watching and then watched some more belongs back in the row.
    dismissed = 0,
    position_ms = excluded.position_ms,
    duration_ms = excluded.duration_ms,
    watched = excluded.watched,
    title = excluded.title,
    type = excluded.type,
    thumb = excluded.thumb,
    show_thumb = excluded.show_thumb,
    show_title = excluded.show_title,
    parent_title = excluded.parent_title,
    parent_index = excluded.parent_index,
    item_index = excluded.item_index,
    year = excluded.year,
    parent_rating_key = excluded.parent_rating_key,
    grandparent_rating_key = excluded.grandparent_rating_key,
    updated_at = excluded.updated_at
`);

const SELECT_COLUMNS = `
  rating_key, position_ms, duration_ms, watched, title, type, thumb, show_thumb,
  show_title, parent_title, parent_index, item_index, year, parent_rating_key,
  grandparent_rating_key, updated_at
`;

const selectOneStmt = db.prepare(
  `SELECT ${SELECT_COLUMNS} FROM watch_history WHERE user_id = ? AND rating_key = ?`,
);
// Continue Watching is a strict subset of history: same rows, filtered to those
// still worth resuming and not dismissed from the row by hand.
const selectContinueStmt = db.prepare(`
  SELECT ${SELECT_COLUMNS} FROM watch_history
  WHERE user_id = ? AND watched = 0 AND position_ms >= ? AND dismissed = 0
  ORDER BY updated_at DESC LIMIT ?
`);
const selectHistoryStmt = db.prepare(`
  SELECT ${SELECT_COLUMNS} FROM watch_history
  WHERE user_id = ?
  ORDER BY updated_at DESC LIMIT ? OFFSET ?
`);
const countStmt = db.prepare("SELECT COUNT(*) AS count FROM watch_history WHERE user_id = ?");
const deleteOneStmt = db.prepare("DELETE FROM watch_history WHERE user_id = ? AND rating_key = ?");
const dismissStmt = db.prepare(
  "UPDATE watch_history SET dismissed = 1 WHERE user_id = ? AND rating_key = ?",
);
const deleteAllStmt = db.prepare("DELETE FROM watch_history WHERE user_id = ?");
const pruneStmt = db.prepare(`
  DELETE FROM watch_history
  WHERE user_id = ? AND rating_key NOT IN (
    SELECT rating_key FROM watch_history WHERE user_id = ?
    ORDER BY updated_at DESC LIMIT ?
  )
`);

function toEntry(row: HistoryRow): HistoryEntry {
  return {
    ratingKey: row.rating_key,
    title: row.title,
    type: row.type,
    thumb: row.thumb,
    showThumb: row.show_thumb,
    showTitle: row.show_title,
    parentTitle: row.parent_title,
    parentIndex: row.parent_index,
    index: row.item_index,
    year: row.year,
    parentRatingKey: row.parent_rating_key,
    grandparentRatingKey: row.grandparent_rating_key,
    positionMs: row.position_ms,
    durationMs: row.duration_ms,
    watched: row.watched === 1,
    updatedAt: row.updated_at,
  };
}

// ─── Plex metadata ──────────────────────────────────────────────

/** The subset of Plex metadata a history row needs to render itself. */
interface ItemSummary {
  title: string;
  type: string;
  thumb: string | null;
  showThumb: string | null;
  showTitle: string | null;
  parentTitle: string | null;
  parentIndex: number | null;
  index: number | null;
  year: number | null;
  parentRatingKey: string | null;
  grandparentRatingKey: string | null;
  durationMs: number;
}

const metaCache = new Map<string, { at: number; summary: ItemSummary }>();

interface PlexHistoryMetadata {
  title?: string;
  type?: string;
  thumb?: string;
  year?: number;
  duration?: number;
  index?: number;
  parentIndex?: number;
  parentTitle?: string;
  parentRatingKey?: string;
  grandparentTitle?: string;
  grandparentThumb?: string;
  grandparentRatingKey?: string;
}

/**
 * Item metadata for a history row, cached for an hour. Library metadata is
 * effectively static, and without the cache a single 5-second heartbeat loop
 * would re-hit Plex for the same item all evening.
 */
async function fetchItemSummary(ratingKey: string): Promise<ItemSummary | null> {
  const cached = metaCache.get(ratingKey);
  if (cached && Date.now() - cached.at < META_CACHE_TTL_MS) return cached.summary;

  const data = await plexJSON<{ MediaContainer: { Metadata?: PlexHistoryMetadata[] } }>(
    `/library/metadata/${ratingKey}`,
  );
  const m = data.MediaContainer.Metadata?.[0];
  if (!m) return null;

  const summary: ItemSummary = {
    title: m.title ?? "Untitled",
    type: m.type ?? "movie",
    // Same `/api/plex/thumb` prefix the library endpoints apply, so the client
    // treats these URLs exactly like any other poster.
    thumb: m.thumb ? `/api/plex/thumb${m.thumb}` : null,
    showThumb: m.grandparentThumb ? `/api/plex/thumb${m.grandparentThumb}` : null,
    showTitle: m.grandparentTitle ?? null,
    parentTitle: m.parentTitle ?? null,
    parentIndex: m.parentIndex ?? null,
    index: m.index ?? null,
    year: m.year ?? null,
    parentRatingKey: m.parentRatingKey ?? null,
    grandparentRatingKey: m.grandparentRatingKey ?? null,
    durationMs: m.duration ?? 0,
  };

  metaCache.set(ratingKey, { at: Date.now(), summary });
  if (metaCache.size > 500) {
    const oldest = metaCache.keys().next().value;
    if (oldest !== undefined) metaCache.delete(oldest);
  }
  return summary;
}

// ─── Writes ─────────────────────────────────────────────────────

/** Last DB write per `${userId}:${ratingKey}` — drives the heartbeat throttle. */
const lastWriteAt = new Map<string, number>();

/**
 * Record where a host has got to in an item.
 *
 * Unforced calls (heartbeats) are throttled; pause, seek, stop and host
 * disconnect pass `force` so the final position is never lost to the throttle.
 * Failures are the caller's to log — progress tracking must never break playback.
 */
export async function recordProgress(
  userId: string,
  ratingKey: string,
  positionSeconds: number,
  options: { force?: boolean } = {},
): Promise<void> {
  if (!userId || !ratingKey) return;
  if (!Number.isFinite(positionSeconds) || positionSeconds < 0) return;

  const throttleKey = `${userId}:${ratingKey}`;
  const now = Date.now();
  if (!options.force) {
    const last = lastWriteAt.get(throttleKey) ?? 0;
    if (now - last < PROGRESS_WRITE_INTERVAL_MS) return;
  }
  const positionMs = Math.round(positionSeconds * 1000);
  const existing = selectOneStmt.get(userId, ratingKey) as HistoryRow | undefined;
  // A play that was abandoned in the first few seconds isn't history, it's a
  // misclick. Existing entries still update, so a rewind to 0:00 is recorded.
  // Checked before the throttle is claimed, so an early heartbeat that declines
  // to create a row doesn't cost the next one its slot.
  if (!existing && positionMs < MIN_NEW_ENTRY_MS) return;

  // Claimed before the metadata await, not after it: two heartbeats arriving
  // while the first is still resolving metadata would otherwise both pass the
  // check and race to write, and the loser's stale position could land last.
  lastWriteAt.set(throttleKey, now);

  const summary = await fetchItemSummary(ratingKey);
  if (!summary && !existing) return;

  const durationMs = summary?.durationMs || existing?.duration_ms || 0;
  // Recomputed on every write rather than latched, so restarting a finished
  // title clears its watched flag and puts it back in Continue Watching.
  const watched = durationMs > 0 && positionMs >= durationMs * COMPLETE_RATIO ? 1 : 0;

  upsertStmt.run({
    user_id: userId,
    rating_key: ratingKey,
    position_ms: positionMs,
    duration_ms: durationMs,
    watched,
    title: summary?.title ?? existing!.title,
    type: summary?.type ?? existing!.type,
    thumb: summary?.thumb ?? existing?.thumb ?? null,
    show_thumb: summary?.showThumb ?? existing?.show_thumb ?? null,
    show_title: summary?.showTitle ?? existing?.show_title ?? null,
    parent_title: summary?.parentTitle ?? existing?.parent_title ?? null,
    parent_index: summary?.parentIndex ?? existing?.parent_index ?? null,
    item_index: summary?.index ?? existing?.item_index ?? null,
    year: summary?.year ?? existing?.year ?? null,
    parent_rating_key: summary?.parentRatingKey ?? existing?.parent_rating_key ?? null,
    grandparent_rating_key:
      summary?.grandparentRatingKey ?? existing?.grandparent_rating_key ?? null,
    updated_at: now,
  });

  if (!existing) pruneStmt.run(userId, userId, MAX_ROWS_PER_USER);
}

// ─── Reads ──────────────────────────────────────────────────────

/** In-progress items for a user, most recently watched first. */
export function getContinueWatching(userId: string, limit = 20): HistoryEntry[] {
  const rows = selectContinueStmt.all(userId, MIN_RESUME_MS, limit) as HistoryRow[];
  return rows.map(toEntry);
}

/** Everything a user has watched or part-watched, most recent first. */
export function getHistory(
  userId: string,
  limit = 100,
  offset = 0,
): { items: HistoryEntry[]; total: number } {
  const rows = selectHistoryStmt.all(userId, limit, offset) as HistoryRow[];
  const { count } = countStmt.get(userId) as { count: number };
  return { items: rows.map(toEntry), total: count };
}

/** A single item's saved progress, or null if this user has never played it. */
export function getProgress(userId: string, ratingKey: string): HistoryEntry | null {
  const row = selectOneStmt.get(userId, ratingKey) as HistoryRow | undefined;
  return row ? toEntry(row) : null;
}

/** Whether an entry is far enough in to be worth offering a resume for. */
export function isResumable(entry: HistoryEntry): boolean {
  return !entry.watched && entry.positionMs >= MIN_RESUME_MS;
}

// ─── Deletes ────────────────────────────────────────────────────

/**
 * Forget an item entirely. Continue Watching is a view over these same rows, so
 * this necessarily removes it from there too — the subset can't outlive the set.
 */
export function deleteHistoryEntry(userId: string, ratingKey: string): void {
  deleteOneStmt.run(userId, ratingKey);
  lastWriteAt.delete(`${userId}:${ratingKey}`);
}

/**
 * Drop an item from Continue Watching without forgetting it.
 *
 * The row and its position survive, so the title still appears in history and
 * the detail view still offers to resume it — this only stops it occupying the
 * row on Home. Watching any more of it clears the flag (see the upsert above),
 * which is what makes the dismissal recoverable rather than permanent.
 */
export function dismissFromContinueWatching(userId: string, ratingKey: string): void {
  dismissStmt.run(userId, ratingKey);
}

export function clearHistory(userId: string): void {
  deleteAllStmt.run(userId);
  for (const key of lastWriteAt.keys()) {
    if (key.startsWith(`${userId}:`)) lastWriteAt.delete(key);
  }
}

export function closeHistoryDb(): void {
  db.close();
}
