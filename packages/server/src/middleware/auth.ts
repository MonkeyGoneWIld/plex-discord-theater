import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_SESSIONS = 10_000;

/**
 * How much of the TTL may elapse before a still-active session's clock is
 * pushed forward. Renewing on literally every request would mean a SQLite write
 * per request; renewing once an hour costs nothing and means a session only
 * expires after 24h of genuine inactivity.
 */
const SESSION_RENEW_AFTER_MS = 60 * 60 * 1000; // 1 hour

interface SessionEntry {
  createdAt: number;
  userId: string | null;
  /** Guild ids Discord confirmed this user is a member of, from /users/@me/guilds
   *  at token-exchange time. Null when the lookup failed or the scope was denied,
   *  which callers must treat as "unverified", not as "no guilds". */
  guildIds: string[] | null;
}

// Hot cache — avoids SQLite reads on every request
const sessionCache = new Map<string, SessionEntry>();

// SQLite persistence — survives server restarts
const dbDir = process.env.THUMB_CACHE_DIR
  ? path.resolve(process.env.THUMB_CACHE_DIR)
  : path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      "../../data",
    );
fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(path.join(dbDir, "sessions.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT,
    created_at INTEGER NOT NULL
  )
`);
// Idempotent migration for databases created before guild verification existed.
// Same pattern as routes/discord.ts and services/watch-history.ts: new installs
// get the column from CREATE TABLE and this fails harmlessly on them.
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN guild_ids TEXT`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (!message.includes("duplicate column")) throw err;
}

// Prepared statements for performance
const insertStmt = db.prepare(
  "INSERT OR REPLACE INTO sessions (token, user_id, created_at, guild_ids) VALUES (?, ?, ?, ?)",
);
const selectStmt = db.prepare(
  "SELECT user_id, created_at, guild_ids FROM sessions WHERE token = ?",
);
const touchStmt = db.prepare("UPDATE sessions SET created_at = ? WHERE token = ?");
const deleteStmt = db.prepare("DELETE FROM sessions WHERE token = ?");
const deleteExpiredStmt = db.prepare("DELETE FROM sessions WHERE created_at < ?");
const countStmt = db.prepare("SELECT COUNT(*) as count FROM sessions");
const deleteOldestStmt = db.prepare(
  "DELETE FROM sessions WHERE token IN (SELECT token FROM sessions ORDER BY created_at ASC LIMIT ?)"
);
const selectAllStmt = db.prepare("SELECT token, user_id, created_at, guild_ids FROM sessions");

interface SessionRow {
  token: string;
  user_id: string | null;
  created_at: number;
  guild_ids: string | null;
}

/** Stored as JSON so the "we never found out" case stays distinct from "in no
 *  guilds" — the difference between unverified and verified-empty. */
function parseGuildIds(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === "string") : null;
  } catch {
    return null;
  }
}

// Load existing valid sessions into cache on startup
const validCutoff = Date.now() - SESSION_TTL_MS;
deleteExpiredStmt.run(validCutoff);
const existingRows = selectAllStmt.all() as SessionRow[];
for (const row of existingRows) {
  sessionCache.set(row.token, {
    createdAt: row.created_at,
    userId: row.user_id,
    guildIds: parseGuildIds(row.guild_ids),
  });
}
console.log(`[Auth] Loaded ${existingRows.length} sessions from SQLite`);

// Periodic cleanup every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [token, session] of sessionCache) {
    if (session.createdAt < cutoff) {
      sessionCache.delete(token);
    }
  }
  deleteExpiredStmt.run(cutoff);
}, 5 * 60 * 1000).unref();

/**
 * @param guildIds Guild ids Discord confirmed the user belongs to. Omit (or pass
 *   null) when the lookup failed — that records "unverified", which is not the
 *   same as "member of nothing" and is treated differently at /register.
 */
export function createSession(userId?: string, guildIds?: string[] | null): string {
  const { count } = countStmt.get() as { count: number };
  if (count >= MAX_SESSIONS) {
    const toDelete = Math.floor(MAX_SESSIONS * 0.1);
    deleteOldestStmt.run(toDelete);
    // Also evict from cache — re-query to get the tokens that were deleted
    // Since SQLite already deleted them, just rebuild cache from DB
    sessionCache.clear();
    for (const row of selectAllStmt.all() as SessionRow[]) {
      sessionCache.set(row.token, {
        createdAt: row.created_at,
        userId: row.user_id,
        guildIds: parseGuildIds(row.guild_ids),
      });
    }
  }

  const token = crypto.randomUUID();
  const now = Date.now();
  const guilds = guildIds ?? null;
  insertStmt.run(token, userId ?? null, now, guilds ? JSON.stringify(guilds) : null);
  sessionCache.set(token, { createdAt: now, userId: userId ?? null, guildIds: guilds });
  return token;
}

/**
 * Push a still-active session's expiry back.
 *
 * Without this the 24h TTL is absolute: a party that runs past the token's
 * birthday is cut off mid-film with "Session expired — please close and restart
 * the activity", which is a miserable thing to happen two hours into a movie.
 * Rate-limited to one write per SESSION_RENEW_AFTER_MS so this stays off the
 * per-request path.
 */
function renewIfStale(token: string, session: SessionEntry, now: number): void {
  if (now - session.createdAt < SESSION_RENEW_AFTER_MS) return;
  session.createdAt = now;
  try {
    touchStmt.run(now, token);
  } catch {
    // A failed renewal just means the session expires on its original schedule.
  }
}

function getSession(token: string): SessionEntry | null {
  const now = Date.now();

  // Check hot cache first
  const cached = sessionCache.get(token);
  if (cached) {
    if (now - cached.createdAt > SESSION_TTL_MS) {
      sessionCache.delete(token);
      deleteStmt.run(token);
      return null;
    }
    renewIfStale(token, cached, now);
    return cached;
  }

  // Fall back to SQLite (session created before this process, loaded lazily)
  const row = selectStmt.get(token) as Omit<SessionRow, "token"> | undefined;
  if (!row) return null;
  if (now - row.created_at > SESSION_TTL_MS) {
    deleteStmt.run(token);
    return null;
  }

  // Promote to cache
  const session: SessionEntry = {
    createdAt: row.created_at,
    userId: row.user_id,
    guildIds: parseGuildIds(row.guild_ids),
  };
  sessionCache.set(token, session);
  renewIfStale(token, session, now);
  return session;
}

export function getSessionUserId(token: string): string | null {
  const session = getSession(token);
  return session?.userId ?? null;
}

/**
 * Guilds Discord confirmed this session's user is in, or null when we never
 * found out (the /users/@me/guilds lookup failed, or the session predates
 * verification). Null must not be read as "no guilds" — see /register.
 */
export function getSessionGuildIds(token: string): string[] | null {
  return getSession(token)?.guildIds ?? null;
}

export function isValidSession(token: string): boolean {
  return getSession(token) !== null;
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // VPS relay key bypass — segments proxied from the VPS have ?key= instead
  // of a Bearer token.  Scoped to the segment proxy endpoint ONLY so the key
  // cannot be used to access other Plex API routes (library browsing, metadata,
  // search, etc.).  Uses constant-time comparison to prevent timing attacks.
  const vpsKey = process.env.VPS_RELAY_KEY;
  if (
    vpsKey &&
    typeof req.query.key === "string" &&
    req.originalUrl.startsWith("/api/plex/hls/seg")
  ) {
    const keyBuf = Buffer.from(req.query.key);
    const expectedBuf = Buffer.from(vpsKey);
    if (
      keyBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(keyBuf, expectedBuf)
    ) {
      next();
      return;
    }
  }

  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ")
    ? header.slice(7)
    : (typeof req.query.token === "string" ? req.query.token : undefined);

  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  if (!isValidSession(token)) {
    res.status(401).json({ error: "Invalid or expired session" });
    return;
  }

  next();
}

export function closeSessionDb(): void {
  db.close();
}
