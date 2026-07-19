import { Router, type Request, type Response } from "express";
import { createSession, isValidSession, getSessionUserId } from "../middleware/auth.js";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const router = Router();

/** Comma-separated guild IDs that are allowed to use this activity */
const ALLOWED_GUILD_IDS = new Set(
  (process.env.ALLOWED_GUILD_IDS || "").split(",").map((s) => s.trim()).filter(Boolean),
);

const INSTANCE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_INSTANCES = 10_000;
export const instanceHosts = new Map<
  string,
  { hostUserId: string; guildId: string | null; channelId: string | null; createdAt: number }
>();
/**
 * Maps channelId → active instanceId. Scoped to the voice/DM channel, NOT
 * the guild — this is what lets two different voice channels in the same
 * Discord server run independent watch parties at once. (Previously this
 * was keyed by guildId, which meant registering a second party anywhere in
 * the same server silently evicted the first one's registration, orphaning
 * it until the next reconnect/join, which then failed with "Unknown
 * instance" / a misleading "Session expired" banner.)
 */
const channelInstances = new Map<string, string>();

// SQLite persistence for instance registrations
const dbDir = process.env.THUMB_CACHE_DIR
  ? path.resolve(process.env.THUMB_CACHE_DIR)
  : path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      "../../data",
    );
fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(path.join(dbDir, "instances.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS instances (
    instance_id TEXT PRIMARY KEY,
    host_user_id TEXT NOT NULL,
    guild_id TEXT,
    channel_id TEXT,
    created_at INTEGER NOT NULL
  )
`);
// Idempotent migration: adds channel_id for DBs created before this column
// existed. Safe to run on every startup — new installs already have the
// column from CREATE TABLE above, so this just fails harmlessly on those.
try {
  db.exec(`ALTER TABLE instances ADD COLUMN channel_id TEXT`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (!message.includes("duplicate column")) {
    throw err;
  }
}

const insertInstanceStmt = db.prepare(
  "INSERT OR REPLACE INTO instances (instance_id, host_user_id, guild_id, channel_id, created_at) VALUES (?, ?, ?, ?, ?)"
);
const updateHostStmt = db.prepare("UPDATE instances SET host_user_id = ? WHERE instance_id = ?");

export function updateInstanceHost(instanceId: string, newHostUserId: string): void {
  updateHostStmt.run(newHostUserId, instanceId);
}
const deleteInstanceStmt = db.prepare("DELETE FROM instances WHERE instance_id = ?");
const deleteExpiredInstancesStmt = db.prepare("DELETE FROM instances WHERE created_at < ?");

// Load existing valid instances into memory on startup
const validCutoff = Date.now() - INSTANCE_TTL_MS;
deleteExpiredInstancesStmt.run(validCutoff);
const existingInstances = db.prepare("SELECT instance_id, host_user_id, guild_id, channel_id, created_at FROM instances").all() as Array<{
  instance_id: string;
  host_user_id: string;
  guild_id: string | null;
  channel_id: string | null;
  created_at: number;
}>;
for (const row of existingInstances) {
  instanceHosts.set(row.instance_id, {
    hostUserId: row.host_user_id,
    guildId: row.guild_id || null,
    channelId: row.channel_id || null,
    createdAt: row.created_at,
  });
  if (row.channel_id) {
    channelInstances.set(row.channel_id, row.instance_id);
  }
}
console.log(`[Discord] Loaded ${existingInstances.length} instances from SQLite`);

export function closeInstanceDb(): void {
  db.close();
}

function pruneStaleInstances(): void {
  const now = Date.now();
  for (const [id, entry] of instanceHosts) {
    if (now - entry.createdAt > INSTANCE_TTL_MS) {
      instanceHosts.delete(id);
      deleteInstanceStmt.run(id);
      // Clean up channel mapping too
      if (entry.channelId && channelInstances.get(entry.channelId) === id) {
        channelInstances.delete(entry.channelId);
      }
    }
  }
}

// Periodic pruning every 5 minutes
setInterval(pruneStaleInstances, 5 * 60 * 1000).unref();

/**
 * POST /api/token
 * Exchange Discord OAuth2 authorization code for access token.
 */
router.post("/token", async (req: Request, res: Response) => {
  const { code } = req.body;
  if (!code || typeof code !== "string") {
    res.status(400).json({ error: "Missing authorization code" });
    return;
  }
  if (code.length > 256) {
    res.status(400).json({ error: "Invalid authorization code" });
    return;
  }

  try {
    const response = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID!,
        client_secret: process.env.DISCORD_CLIENT_SECRET!,
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.REDIRECT_URI!,
      }),
    });

    if (!response.ok) {
      console.error("Discord token exchange failed:", response.status);
      const clientStatus = response.status >= 500 ? 502 : 400;
      res.status(clientStatus).json({ error: "Token exchange failed" });
      return;
    }

    let data;
    try {
      data = await response.json();
    } catch {
      console.error("Failed to parse Discord token response");
      res.status(502).json({ error: "Invalid response from Discord" });
      return;
    }
    if (!data.access_token || typeof data.access_token !== "string") {
      console.error("Discord response missing access_token");
      res.status(502).json({ error: "Invalid response from Discord" });
      return;
    }

    // Fetch verified Discord userId to bind to the session
    let discordUserId: string | undefined;
    try {
      const meRes = await fetch("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${data.access_token}` },
      });
      if (meRes.ok) {
        const me = (await meRes.json()) as { id?: string };
        discordUserId = me.id;
      }
    } catch {
      // Non-fatal — session will work but userId won't be verified
    }

    const sessionToken = createSession(discordUserId);
    res.json({ access_token: data.access_token, session_token: sessionToken });
  } catch (err) {
    console.error("Token exchange error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/register
 * Register the first user per instanceId as the host.
 */
router.post("/register", (req: Request, res: Response) => {
  const { instanceId, userId, guildId, channelId } = req.body;

  // guildId is now OPTIONAL: Discord Activities can also run in a DM/group-DM
  // voice call, which has no guild at all — sdk.guildId is null there. The
  // old code hard-required guildId, so launching outside a server failed
  // immediately with "Missing instanceId, userId, or guildId".
  if (!instanceId || !userId) {
    res.status(400).json({ error: "Missing instanceId or userId" });
    return;
  }

  if (
    typeof instanceId !== "string" ||
    typeof userId !== "string" ||
    (guildId != null && typeof guildId !== "string") ||
    (channelId != null && typeof channelId !== "string")
  ) {
    res.status(400).json({ error: "Invalid parameter types" });
    return;
  }

  if (
    instanceId.length > 200 ||
    userId.length > 200 ||
    (typeof guildId === "string" && guildId.length > 200) ||
    (typeof channelId === "string" && channelId.length > 200)
  ) {
    res.status(400).json({ error: "Parameters too long" });
    return;
  }

  // Verify session token and that the claimed userId matches the authenticated identity
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token || !isValidSession(token)) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const verifiedUserId = getSessionUserId(token);
  if (!verifiedUserId) {
    res.status(403).json({ error: "Session has no verified identity" });
    return;
  }
  if (verifiedUserId !== userId) {
    res.status(403).json({ error: "userId does not match authenticated identity" });
    return;
  }

  pruneStaleInstances();

  const normalizedGuildId = typeof guildId === "string" && guildId.length > 0 ? guildId : "";
  const normalizedChannelId = typeof channelId === "string" && channelId.length > 0 ? channelId : null;

  // Reject guilds not in the allowlist. A DM (no guildId) can't be checked
  // against a guild allowlist, so it's only permitted when the allowlist
  // itself is disabled (ALLOWED_GUILD_IDS unset = open to everyone).
  if (ALLOWED_GUILD_IDS.size > 0) {
    if (!normalizedGuildId || !ALLOWED_GUILD_IDS.has(normalizedGuildId)) {
      res.status(403).json({ error: "This server is not authorized to use this activity." });
      return;
    }
  }

  // One active instance per CHANNEL, not per guild — this is what allows
  // multiple independent watch parties in different voice channels of the
  // same server. Only evict a stale registration in the SAME channel;
  // instances in other channels (or other guilds) are left untouched.
  // Clients that don't send channelId (older builds) get no scoped eviction
  // at all here, rather than falling back to the old guild-wide behavior.
  if (normalizedChannelId) {
    const existingInstanceId = channelInstances.get(normalizedChannelId);
    if (existingInstanceId && existingInstanceId !== instanceId && instanceHosts.has(existingInstanceId)) {
      deleteInstanceStmt.run(existingInstanceId);
      instanceHosts.delete(existingInstanceId);
      channelInstances.delete(normalizedChannelId);
    }
  }

  if (instanceHosts.size >= MAX_INSTANCES) {
    // Evict oldest 10% before rejecting
    const toEvict = Math.max(1, Math.floor(MAX_INSTANCES * 0.1));
    const oldest = [...instanceHosts.entries()]
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
      .slice(0, toEvict);
    for (const [id, entry] of oldest) {
      if (entry.channelId && channelInstances.get(entry.channelId) === id) {
        channelInstances.delete(entry.channelId);
      }
      deleteInstanceStmt.run(id);
      instanceHosts.delete(id);
    }
  }

  if (!instanceHosts.has(instanceId)) {
    const now = Date.now();
    instanceHosts.set(instanceId, {
      hostUserId: userId,
      guildId: normalizedGuildId || null,
      channelId: normalizedChannelId,
      createdAt: now,
    });
    if (normalizedChannelId) {
      channelInstances.set(normalizedChannelId, instanceId);
    }
    insertInstanceStmt.run(instanceId, userId, normalizedGuildId, normalizedChannelId, now);
  }

  const hostId = instanceHosts.get(instanceId)!.hostUserId;
  res.json({ isHost: hostId === userId, hostId });
});

/** Check if a userId is host for any active instance. */
export function isUserHost(userId: string): boolean {
  for (const entry of instanceHosts.values()) {
    if (entry.hostUserId === userId) return true;
  }
  return false;
}

export default router;
