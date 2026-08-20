/**
 * Per-user watch history and resume positions, persisted in SQLite.
 *
 * History is attributed to every unique participant who currently has the
 * player open. The room still has one host-authoritative timeline, but each
 * active viewer owns an independent history row and (when opted in) an
 * independent linked Plex account.
 *
 * Positions arrive from the host's 5-second sync heartbeat, so throttling lives
 * here rather than at the call site: heartbeat writes coalesce to one row update
 * per PROGRESS_WRITE_INTERVAL_MS, while pause/seek/stop force an immediate write.
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { plexJSON } from "./plex.js";
import { LruMap } from "./lru.js";

/** Watched past this fraction of the runtime counts as finished. */
const COMPLETE_RATIO = 0.9;
/** Below this, there's nothing worth resuming — the entry stays out of Continue Watching. */
const MIN_RESUME_MS = 60_000;
/** A brand-new entry needs at least this much watched before it's worth remembering. */
const MIN_NEW_ENTRY_MS = 10_000;
/** Heartbeat writes coalesce to at most one per item per this interval. */
const PROGRESS_WRITE_INTERVAL_MS = 15_000;
const META_CACHE_TTL_MS = 60 * 60 * 1000;
/** Shorter than the metadata TTL: an airing show gains episodes, and a stale
 *  list is what would stop a newly available episode becoming "next up". */
const LEAVES_CACHE_TTL_MS = 10 * 60 * 1000;
/** How many history rows to consider when assembling the Continue Watching row.
 *  Bounds the Plex lookups a single request can trigger (one per distinct show). */
const CANDIDATE_SCAN_LIMIT = 100;

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
  dismissed: number;
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
  grandparent_rating_key, dismissed, updated_at
`;

const selectOneStmt = db.prepare(
  `SELECT ${SELECT_COLUMNS} FROM watch_history WHERE user_id = ? AND rating_key = ?`,
);
// Rows that can put something in the Continue Watching row: anything still
// worth resuming, plus finished episodes, which contribute their successor
// rather than themselves. Both exclude anything dismissed by hand.
const selectContinueCandidatesStmt = db.prepare(`
  SELECT ${SELECT_COLUMNS} FROM watch_history
  WHERE user_id = ? AND dismissed = 0
    AND (
      (watched = 0 AND position_ms >= ?)
      OR (watched = 1 AND type = 'episode')
    )
  ORDER BY updated_at DESC LIMIT ?
`);
// A row at position 0 that's been dismissed was never actually watched — it's
// the marker left by dismissing a "next up" suggestion (see
// dismissFromContinueWatching). It exists to keep that suggestion suppressed,
// so it has no business appearing in a list of what someone has watched.
const NOT_A_DISMISSAL_MARKER = `NOT (dismissed = 1 AND position_ms = 0)`;

const selectHistoryStmt = db.prepare(`
  SELECT ${SELECT_COLUMNS} FROM watch_history
  WHERE user_id = ? AND ${NOT_A_DISMISSAL_MARKER}
  ORDER BY updated_at DESC LIMIT ? OFFSET ?
`);
const selectAllHistoryStmt = db.prepare(`
  SELECT ${SELECT_COLUMNS} FROM watch_history
  WHERE user_id = ? AND ${NOT_A_DISMISSAL_MARKER}
  ORDER BY updated_at DESC
`);
const countStmt = db.prepare(
  `SELECT COUNT(*) AS count FROM watch_history WHERE user_id = ? AND ${NOT_A_DISMISSAL_MARKER}`,
);
const deleteOneStmt = db.prepare("DELETE FROM watch_history WHERE user_id = ? AND rating_key = ?");
const dismissStmt = db.prepare(
  "UPDATE watch_history SET dismissed = 1 WHERE user_id = ? AND rating_key = ?",
);
const insertDismissalMarkerStmt = db.prepare(`
  INSERT OR IGNORE INTO watch_history (
    user_id, rating_key, position_ms, duration_ms, watched,
    title, type, thumb, show_thumb, show_title, parent_title,
    parent_index, item_index, year, parent_rating_key, grandparent_rating_key,
    dismissed, updated_at
  ) VALUES (
    @user_id, @rating_key, 0, @duration_ms, 0,
    @title, @type, @thumb, @show_thumb, @show_title, @parent_title,
    @parent_index, @item_index, @year, @parent_rating_key, @grandparent_rating_key,
    1, @updated_at
  )
`);
const deleteAllStmt = db.prepare("DELETE FROM watch_history WHERE user_id = ?");

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

export interface PlexHistoryMetadata {
  ratingKey?: string;
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

function toSummary(m: PlexHistoryMetadata): ItemSummary {
  return {
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

  const summary = toSummary(m);

  metaCache.set(ratingKey, { at: Date.now(), summary });
  if (metaCache.size > 500) {
    const oldest = metaCache.keys().next().value;
    if (oldest !== undefined) metaCache.delete(oldest);
  }
  return summary;
}

// ─── Next episode ───────────────────────────────────────────────

const leavesCache = new Map<string, { at: number; episodes: PlexHistoryMetadata[] }>();

/**
 * Every episode of a show, ordered by season then episode.
 *
 * /allLeaves returns them already in that order, so "the element after mine"
 * gives season rollover (S1E10 → S2E1) for free, with no boundary case and no
 * second request — the same approach as the /siblings route. Cached briefly
 * rather than for the full metadata TTL, since an airing show gains episodes
 * and a stale list is what would hold back a new "next up".
 */
async function fetchShowEpisodes(showRatingKey: string): Promise<PlexHistoryMetadata[]> {
  const cached = leavesCache.get(showRatingKey);
  if (cached && Date.now() - cached.at < LEAVES_CACHE_TTL_MS) return cached.episodes;

  const data = await plexJSON<{ MediaContainer: { Metadata?: PlexHistoryMetadata[] } }>(
    `/library/metadata/${showRatingKey}/allLeaves`,
  );
  const episodes = (data.MediaContainer.Metadata || []).filter(
    (e) => e.type === "episode" && e.ratingKey,
  );

  leavesCache.set(showRatingKey, { at: Date.now(), episodes });
  if (leavesCache.size > 200) {
    const oldest = leavesCache.keys().next().value;
    if (oldest !== undefined) leavesCache.delete(oldest);
  }
  return episodes;
}

/**
 * What to offer for a show once its most recent episode is finished: the next
 * episode the user hasn't already seen, or null when there's nothing left.
 *
 * Scans forward from the finished episode rather than taking the immediate
 * successor, so an out-of-order rewatch doesn't offer something already
 * watched. Hitting a dismissed episode stops the scan and returns null — the
 * user removed this show from the row, and walking past that to suggest the
 * episode after it would defeat the dismissal.
 *
 * `after` carries the finished episode's timestamp so the suggestion sorts by
 * when the show was last watched, like every other entry in the row.
 */
async function resolveNextUp(
  userId: string,
  after: HistoryEntry,
  options: { respectDismissals?: boolean } = {},
): Promise<HistoryEntry | null> {
  // Dismissals are about the Continue Watching row, not the show itself. Someone
  // opening the show's own page has asked about it directly, so the resume
  // button there ignores them — the same reasoning that keeps a dismissed film
  // resumable from its detail view.
  const respectDismissals = options.respectDismissals !== false;
  const showKey = after.grandparentRatingKey
    ?? (await fetchItemSummary(after.ratingKey))?.grandparentRatingKey;
  if (!showKey) return null;

  const episodes = await fetchShowEpisodes(showKey);
  const i = episodes.findIndex((e) => e.ratingKey === after.ratingKey);
  // -1 covers merged/split shows whose leaf list doesn't contain our key.
  if (i === -1) return null;

  for (const episode of episodes.slice(i + 1)) {
    const existing = selectOneStmt.get(userId, episode.ratingKey!) as HistoryRow | undefined;
    if (respectDismissals && existing?.dismissed === 1) return null;
    if (existing?.watched === 1) continue;
    // Part-watched already: hand back the real row so its resume position shows.
    if (existing) return toEntry(existing);
    // Never played — synthesize an entry to start from the beginning.
    const summary = toSummary(episode);
    return {
      ratingKey: episode.ratingKey!,
      title: summary.title,
      type: summary.type,
      thumb: summary.thumb,
      showThumb: summary.showThumb,
      showTitle: summary.showTitle,
      parentTitle: summary.parentTitle,
      parentIndex: summary.parentIndex,
      index: summary.index,
      year: summary.year,
      parentRatingKey: summary.parentRatingKey,
      grandparentRatingKey: summary.grandparentRatingKey ?? showKey,
      positionMs: 0,
      durationMs: summary.durationMs,
      watched: false,
      updatedAt: after.updatedAt,
    };
  }
  // Ran off the end of the show — everything after this point is watched.
  return null;
}

// ─── Writes ─────────────────────────────────────────────────────

/**
 * Last DB write per `${userId}:${ratingKey}` — drives the heartbeat throttle.
 *
 * Bounded, because the key pairs a user with an item: it grew with every
 * (viewer, title) combination the server had ever seen and was only ever pruned
 * for a user who explicitly deleted history. Evicting an entry costs at most one
 * extra write for an item nobody has touched in a very long time.
 */
const lastWriteAt = new LruMap<string, number>(10_000);

/**
 * Record where a participant has got to in an item.
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
): Promise<HistoryEntry | null> {
  if (!userId || !ratingKey) return null;
  if (!Number.isFinite(positionSeconds) || positionSeconds < 0) return null;

  const throttleKey = `${userId}:${ratingKey}`;
  const now = Date.now();
  if (!options.force) {
    const last = lastWriteAt.get(throttleKey) ?? 0;
    if (now - last < PROGRESS_WRITE_INTERVAL_MS) return null;
  }
  const positionMs = Math.round(positionSeconds * 1000);
  const existing = selectOneStmt.get(userId, ratingKey) as HistoryRow | undefined;
  // A play that was abandoned in the first few seconds isn't history, it's a
  // misclick. Existing entries still update, so a rewind to 0:00 is recorded.
  // Checked before the throttle is claimed, so an early heartbeat that declines
  // to create a row doesn't cost the next one its slot.
  if (!existing && positionMs < MIN_NEW_ENTRY_MS) return null;

  // Claimed before the metadata await, not after it: two heartbeats arriving
  // while the first is still resolving metadata would otherwise both pass the
  // check and race to write, and the loser's stale position could land last.
  lastWriteAt.set(throttleKey, now);

  const summary = await fetchItemSummary(ratingKey);
  if (!summary && !existing) return null;

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

  return getProgress(userId, ratingKey);
}

/** Merge newer progress imported from a linked Plex account. */
export async function mergeExternalProgress(
  userId: string,
  ratingKey: string,
  progress: {
    positionMs: number;
    durationMs?: number;
    watched: boolean;
    updatedAt: number;
  },
  metadata?: PlexHistoryMetadata,
): Promise<{ entry: HistoryEntry | null; changed: boolean }> {
  if (!userId || !/^\d+$/.test(ratingKey)) return { entry: null, changed: false };
  if (!Number.isFinite(progress.positionMs) || progress.positionMs < 0) {
    return { entry: null, changed: false };
  }

  const existing = selectOneStmt.get(userId, ratingKey) as HistoryRow | undefined;
  const sourceAt = Number.isFinite(progress.updatedAt) && progress.updatedAt > 0
    ? Math.round(progress.updatedAt)
    : Date.now();
  if (
    existing &&
    (existing.updated_at > sourceAt ||
      (existing.updated_at === sourceAt && (existing.watched === 1 || !progress.watched)))
  ) {
    return { entry: toEntry(existing), changed: false };
  }

  // Bulk season/show actions already receive every episode's metadata from
  // Plex. Reuse it instead of turning one click into another request per leaf.
  const summary = metadata ? toSummary(metadata) : await fetchItemSummary(ratingKey);
  if (!summary && !existing) return { entry: null, changed: false };
  const durationMs = Math.max(
    0,
    Math.round(progress.durationMs || summary?.durationMs || existing?.duration_ms || 0),
  );
  const watched = progress.watched ? 1 : 0;
  const positionMs = watched && durationMs > 0
    ? durationMs
    : Math.max(0, Math.round(progress.positionMs));

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
    updated_at: sourceAt,
  });
  return { entry: getProgress(userId, ratingKey), changed: true };
}

// ─── Reads ──────────────────────────────────────────────────────

/**
 * What a user should watch next, most recently active first.
 *
 * Films appear only while part-watched — a finished film has nothing to follow
 * it. Shows appear as one card each: the episode in progress, or, once that
 * episode is finished, the next one (rolling into the following season at a
 * season boundary). A show watched to its last episode drops out entirely.
 *
 * One card per show, decided by the most recent activity, so finishing an
 * episode replaces it in the row rather than adding to it.
 */
export async function getContinueWatching(userId: string, limit = 20): Promise<HistoryEntry[]> {
  const rows = selectContinueCandidatesStmt.all(
    userId,
    MIN_RESUME_MS,
    CANDIDATE_SCAN_LIMIT,
  ) as HistoryRow[];

  const out: HistoryEntry[] = [];
  const seenShows = new Set<string>();

  for (const row of rows) {
    if (out.length >= limit) break;
    const entry = toEntry(row);

    if (entry.type !== "episode") {
      // The candidate query already excluded finished films; this is belt and
      // braces for a row whose type was recorded before that filter existed.
      if (!entry.watched) out.push(entry);
      continue;
    }

    // Fall back to the episode's own key for a show whose ancestry Plex didn't
    // report, so it still gets deduped against itself rather than every other
    // orphan episode.
    const showKey = entry.grandparentRatingKey ?? entry.ratingKey;
    // Rows are newest-first, so the first one seen for a show is the current
    // one; older episodes of the same show are already superseded.
    if (seenShows.has(showKey)) continue;
    seenShows.add(showKey);

    if (!entry.watched) {
      out.push(entry);
      continue;
    }

    // Finished: offer what comes after it, or nothing if the show is done.
    // A Plex failure here drops one show from the row rather than failing the
    // whole request — the rest of someone's Continue Watching still renders.
    try {
      const next = await resolveNextUp(userId, entry);
      if (next) out.push(next);
    } catch (err) {
      console.error("[History] Failed to resolve next episode after", entry.ratingKey, err);
    }
  }

  return out;
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

/** Every retained row for internal account reconciliation; HTTP reads stay paginated. */
export function getAllHistory(userId: string): HistoryEntry[] {
  return (selectAllHistoryStmt.all(userId) as HistoryRow[]).map(toEntry);
}

const selectLatestForShowStmt = db.prepare(`
  SELECT ${SELECT_COLUMNS} FROM watch_history
  WHERE user_id = ? AND grandparent_rating_key = ? AND ${NOT_A_DISMISSAL_MARKER}
  ORDER BY updated_at DESC LIMIT 1
`);

/**
 * Where to pick a show back up: the episode in progress, or the next one after
 * the last one finished. Null when the user has never played any of it (there's
 * nothing to resume) or has watched it through to the end.
 *
 * Unlike the Continue Watching row, this ignores dismissals — see resolveNextUp.
 */
export async function getShowNextUp(
  userId: string,
  showRatingKey: string,
): Promise<HistoryEntry | null> {
  const row = selectLatestForShowStmt.get(userId, showRatingKey) as HistoryRow | undefined;
  if (!row) return null;

  const entry = toEntry(row);
  if (!entry.watched) return entry;
  return resolveNextUp(userId, entry, { respectDismissals: false });
}

/** A single item's saved progress, or null if this user has never played it. */
export function getProgress(userId: string, ratingKey: string): HistoryEntry | null {
  const row = selectOneStmt.get(userId, ratingKey) as HistoryRow | undefined;
  return row ? toEntry(row) : null;
}

// One prepared statement per IN-list size, reused across calls. Episode counts
// repeat heavily (every season of a show is usually the same length), so this
// stays tiny while avoiding a re-prepare on each request.
const manyStmtCache = new Map<number, ReturnType<typeof db.prepare>>();

function progressManyStmt(count: number) {
  let stmt = manyStmtCache.get(count);
  if (!stmt) {
    const placeholders = new Array(count).fill("?").join(",");
    stmt = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM watch_history
       WHERE user_id = ? AND rating_key IN (${placeholders})`,
    );
    manyStmtCache.set(count, stmt);
  }
  return stmt;
}

/**
 * Saved progress for several items at once, keyed by rating key. Items the user
 * has never played are simply absent, so the caller checks for a key rather than
 * a null. Lets an episode list mark itself up in one request instead of one per
 * episode.
 */
export function getProgressMany(
  userId: string,
  ratingKeys: string[],
): Record<string, HistoryEntry> {
  const out: Record<string, HistoryEntry> = {};
  if (ratingKeys.length === 0) return out;
  // Bound values go as a single array rather than spread arguments — the arity
  // varies with the episode count, which a spread can't express to the types.
  const rows = progressManyStmt(ratingKeys.length).all([userId, ...ratingKeys]) as HistoryRow[];
  for (const row of rows) out[row.rating_key] = toEntry(row);
  return out;
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
 *
 * A "next up" suggestion has no row of its own, since the user has never played
 * it. Dismissing one records a marker so the suggestion stays suppressed —
 * resolveNextUp stops there, which is what makes dismissing the card mean "stop
 * offering me this show" rather than "skip to the episode after".
 */
export async function dismissFromContinueWatching(
  userId: string,
  ratingKey: string,
): Promise<void> {
  const { changes } = dismissStmt.run(userId, ratingKey);
  if (changes > 0) return;

  const summary = await fetchItemSummary(ratingKey);
  if (!summary) return;
  insertDismissalMarkerStmt.run({
    user_id: userId,
    rating_key: ratingKey,
    duration_ms: summary.durationMs,
    title: summary.title,
    type: summary.type,
    thumb: summary.thumb,
    show_thumb: summary.showThumb,
    show_title: summary.showTitle,
    parent_title: summary.parentTitle,
    parent_index: summary.parentIndex,
    item_index: summary.index,
    year: summary.year,
    parent_rating_key: summary.parentRatingKey,
    grandparent_rating_key: summary.grandparentRatingKey,
    updated_at: Date.now(),
  });
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
