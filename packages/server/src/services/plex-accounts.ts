/**
 * Per-Discord-user Plex account links and bidirectional watch-state sync.
 *
 * The shared PLEX_TOKEN remains responsible for browsing and streaming. These
 * personal tokens are only used for the linked user's account details and
 * watch state, and never leave the server.
 */
import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { plexFetch, plexJSON } from "./plex.js";
import {
  clearHistory,
  getHistory,
  mergeExternalProgress,
  type HistoryEntry,
} from "./watch-history.js";

const PRODUCT = "Plex Discord Theater";
const VERSION = "1.0.0";
const MAX_SYNC_ITEMS = 500;
const LINK_TTL_MS = 10 * 60 * 1000;
const LIVE_PUSH_INTERVAL_MS = 15_000;
const PIN_FLOW_VERSION = 1;

const dbDir = process.env.THUMB_CACHE_DIR
  ? path.resolve(process.env.THUMB_CACHE_DIR)
  : path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      "../../data",
    );
fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(path.join(dbDir, "plex-accounts.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS plex_accounts (
    user_id TEXT PRIMARY KEY,
    token_encrypted TEXT NOT NULL,
    server_token_encrypted TEXT,
    plex_user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    email TEXT,
    thumb TEXT,
    linked_at INTEGER NOT NULL,
    last_sync_at INTEGER,
    last_sync_error TEXT
  );
  CREATE TABLE IF NOT EXISTS plex_link_pins (
    user_id TEXT PRIMARY KEY,
    pin_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    auth_url TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    flow_version INTEGER NOT NULL DEFAULT 1
  );
`);
// Accounts created by the first implementation stored only the plex.tv token.
// Legacy Plex auth requires a second, server-specific token from /resources.
try {
  db.exec("ALTER TABLE plex_accounts ADD COLUMN server_token_encrypted TEXT");
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (!message.includes("duplicate column")) throw err;
}
// Pending PINs from the original clients.plex.tv/JWT implementation cannot be
// polled through the legacy plex.tv flow. Existing rows receive version 0 and
// are discarded below; fresh databases already have version 1 from CREATE.
try {
  db.exec("ALTER TABLE plex_link_pins ADD COLUMN flow_version INTEGER NOT NULL DEFAULT 0");
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (!message.includes("duplicate column")) throw err;
}
db.prepare("DELETE FROM plex_link_pins WHERE flow_version != ?").run(PIN_FLOW_VERSION);
// Remember the account that owns each Discord user's current Activity history.
// Existing linked installations are seeded during upgrade; unlinking deliberately
// leaves this marker behind so a later different account can be detected.
db.exec(`
  INSERT OR IGNORE INTO settings (key, value)
  SELECT 'last_plex_account:' || user_id, plex_user_id FROM plex_accounts
`);

interface AccountRow {
  user_id: string;
  token_encrypted: string;
  server_token_encrypted: string | null;
  plex_user_id: string;
  username: string;
  email: string | null;
  thumb: string | null;
  linked_at: number;
  last_sync_at: number | null;
  last_sync_error: string | null;
}

interface PinRow {
  user_id: string;
  pin_id: number;
  code: string;
  auth_url: string;
  expires_at: number;
  flow_version: number;
}

const selectAccount = db.prepare("SELECT * FROM plex_accounts WHERE user_id = ?");
const selectPin = db.prepare("SELECT * FROM plex_link_pins WHERE user_id = ?");
const deletePin = db.prepare("DELETE FROM plex_link_pins WHERE user_id = ?");
const deleteAccount = db.prepare("DELETE FROM plex_accounts WHERE user_id = ?");
const updateSync = db.prepare(
  "UPDATE plex_accounts SET last_sync_at = ?, last_sync_error = ? WHERE user_id = ?",
);
const selectSetting = db.prepare("SELECT value FROM settings WHERE key = ?");
const upsertSetting = db.prepare(`
  INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

function lastAccountKey(userId: string): string {
  return `last_plex_account:${userId}`;
}

function instanceClientId(): string {
  const found = db.prepare("SELECT value FROM settings WHERE key = 'client_id'").get() as
    | { value: string }
    | undefined;
  if (found) return found.value;
  const value = crypto.randomUUID();
  db.prepare("INSERT INTO settings (key, value) VALUES ('client_id', ?)").run(value);
  return value;
}

const CLIENT_ID = instanceClientId();

function secretMaterial(): string {
  return process.env.PLEX_LINK_SECRET
    || process.env.DISCORD_CLIENT_SECRET
    || process.env.PLEX_TOKEN
    || "plex-discord-theater-development";
}

const encryptionKey = crypto
  .createHash("sha256")
  .update(`plex-account-link:${secretMaterial()}`)
  .digest();

function encryptToken(token: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(":");
}

function decryptToken(value: string): string {
  const [version, iv, tag, encrypted] = value.split(":");
  if (version !== "v1" || !iv || !tag || !encrypted) throw new Error("Invalid token envelope");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function plexTvHeaders(): Record<string, string> {
  return {
    Accept: "application/json",
    "X-Plex-Product": PRODUCT,
    "X-Plex-Version": VERSION,
    "X-Plex-Client-Identifier": CLIENT_ID,
    "X-Plex-Platform": "Web",
    "X-Plex-Device": "Discord Activity",
  };
}

const PLEX_CLOUD_TIMEOUT_MS = 15_000;

function plexCloudFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(PLEX_CLOUD_TIMEOUT_MS) });
}

export interface PlexAccountStatus {
  linked: boolean;
  account?: {
    id: string;
    username: string;
    email: string | null;
    thumb: string | null;
    linkedAt: number;
  };
  lastSyncAt: number | null;
  lastSyncError: string | null;
  pending?: { authUrl: string; expiresAt: number };
}

function accountStatus(row: AccountRow | undefined, pin?: PinRow): PlexAccountStatus {
  const linked = !!row?.server_token_encrypted;
  return {
    linked,
    ...(row && linked && {
      account: {
        id: row.plex_user_id,
        username: row.username,
        email: row.email,
        thumb: row.thumb,
        linkedAt: row.linked_at,
      },
    }),
    lastSyncAt: row?.last_sync_at ?? null,
    lastSyncError: row?.last_sync_error ?? null,
    ...(pin && pin.expires_at > Date.now() && {
      pending: { authUrl: pin.auth_url, expiresAt: pin.expires_at },
    }),
  };
}

export function getPlexAccountStatus(userId: string): PlexAccountStatus {
  const row = selectAccount.get(userId) as AccountRow | undefined;
  const pin = selectPin.get(userId) as PinRow | undefined;
  if (pin && pin.expires_at <= Date.now()) deletePin.run(userId);
  return accountStatus(row, pin && pin.expires_at > Date.now() ? pin : undefined);
}

export async function startPlexAccountLink(userId: string): Promise<PlexAccountStatus> {
  // This is the traditional token flow. The clients.plex.tv PIN endpoint is
  // for the newer JWK/JWT exchange and requires a signed deviceJWT when polled.
  const response = await plexCloudFetch("https://plex.tv/api/v2/pins?strong=true", {
    method: "POST",
    headers: plexTvHeaders(),
  });
  if (!response.ok) throw new Error(`Plex sign-in unavailable (${response.status})`);
  const pin = await response.json() as { id?: number; code?: string; expiresAt?: string };
  if (!Number.isInteger(pin.id) || !pin.code) throw new Error("Plex returned an invalid sign-in code");

  const auth = new URLSearchParams({
    clientID: CLIENT_ID,
    code: pin.code,
    "context[device][product]": PRODUCT,
    "context[device][version]": VERSION,
  });
  const authUrl = `https://app.plex.tv/auth#?${auth.toString()}`;
  const parsedExpiry = pin.expiresAt ? Date.parse(pin.expiresAt) : NaN;
  const expiresAt = Number.isFinite(parsedExpiry) ? parsedExpiry : Date.now() + LINK_TTL_MS;
  db.prepare(`
    INSERT OR REPLACE INTO plex_link_pins (
      user_id, pin_id, code, auth_url, expires_at, flow_version
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, pin.id, pin.code, authUrl, expiresAt, PIN_FLOW_VERSION);
  return getPlexAccountStatus(userId);
}

interface PlexUser {
  id?: number | string;
  username?: string;
  title?: string;
  email?: string;
  thumb?: string;
}

interface PlexResource {
  name?: string;
  provides?: string;
  clientIdentifier?: string;
  accessToken?: string;
}

async function serverTokenForAccount(accountToken: string): Promise<string> {
  const identity = await plexJSON<{
    MediaContainer: { machineIdentifier?: string };
  }>("/identity");
  const machineIdentifier = identity.MediaContainer.machineIdentifier;
  if (!machineIdentifier) throw new Error("The configured Plex server did not report its identity");

  const resourcesUrl = new URL("https://clients.plex.tv/api/v2/resources");
  resourcesUrl.searchParams.set("includeHttps", "1");
  resourcesUrl.searchParams.set("includeRelay", "1");
  resourcesUrl.searchParams.set("includeIPv6", "1");
  const response = await plexCloudFetch(resourcesUrl, {
    headers: { ...plexTvHeaders(), "X-Plex-Token": accountToken },
  });
  if (!response.ok) throw new Error(`Could not read this account's Plex servers (${response.status})`);
  const resources = await response.json() as PlexResource[];
  const server = resources.find((resource) =>
    resource.clientIdentifier === machineIdentifier
    && resource.provides?.split(",").includes("server"),
  );
  if (!server?.accessToken) {
    throw new Error("This Plex account does not have access to the configured server");
  }
  return server.accessToken;
}

export async function pollPlexAccountLink(userId: string): Promise<PlexAccountStatus> {
  const pin = selectPin.get(userId) as PinRow | undefined;
  if (!pin) return getPlexAccountStatus(userId);
  if (pin.expires_at <= Date.now()) {
    deletePin.run(userId);
    throw new Error("Plex sign-in expired. Start again.");
  }

  const url = new URL(`https://plex.tv/api/v2/pins/${pin.pin_id}`);
  const response = await plexCloudFetch(url, { headers: plexTvHeaders() });
  if (!response.ok) {
    if (response.status === 404 || response.status === 410) {
      deletePin.run(userId);
      throw new Error("That Plex sign-in is no longer valid. Start again.");
    }
    throw new Error(`Could not check Plex sign-in (${response.status})`);
  }
  const result = await response.json() as { authToken?: string | null };
  if (!result.authToken) return getPlexAccountStatus(userId);

  const userResponse = await plexCloudFetch("https://plex.tv/api/v2/user", {
    headers: { ...plexTvHeaders(), "X-Plex-Token": result.authToken },
  });
  if (!userResponse.ok) throw new Error("Plex did not accept the linked account");
  const plexUser = await userResponse.json() as PlexUser;
  if (plexUser.id == null) throw new Error("Plex account identity is missing");

  let serverToken: string;
  try {
    serverToken = await serverTokenForAccount(result.authToken);
    await plexJSON("/library/sections", undefined, serverToken);
  } catch (err) {
    // The PIN has already been claimed and cannot be usefully polled again.
    // Remove it so the UI stops looping on the same permanent failure.
    deletePin.run(userId);
    throw err;
  }

  const username = plexUser.username || plexUser.title || plexUser.email || "Plex user";
  const plexUserId = String(plexUser.id);
  const previous = selectSetting.get(lastAccountKey(userId)) as { value: string } | undefined;
  // Activity history belongs to the Plex identity that produced it. A different
  // account starts from a clean slate so old rows cannot be exported into it.
  // A first-ever link and a re-link of the same account keep their local state.
  if (previous && previous.value !== plexUserId) clearHistory(userId);
  db.prepare(`
    INSERT OR REPLACE INTO plex_accounts (
      user_id, token_encrypted, server_token_encrypted, plex_user_id, username, email, thumb,
      linked_at, last_sync_at, last_sync_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
  `).run(
    userId,
    encryptToken(result.authToken),
    encryptToken(serverToken),
    plexUserId,
    username,
    plexUser.email ?? null,
    plexUser.thumb ?? null,
    Date.now(),
  );
  upsertSetting.run(lastAccountKey(userId), plexUserId);
  deletePin.run(userId);
  return getPlexAccountStatus(userId);
}

export function unlinkPlexAccount(userId: string): void {
  deletePin.run(userId);
  deleteAccount.run(userId);
  for (const key of lastLivePush.keys()) {
    if (key.startsWith(`${userId}:`)) lastLivePush.delete(key);
  }
}

function accessToken(userId: string): {
  accountToken: string;
  serverToken: string;
  row: AccountRow;
} | null {
  const row = selectAccount.get(userId) as AccountRow | undefined;
  if (!row) return null;
  try {
    if (!row.server_token_encrypted) {
      updateSync.run(row.last_sync_at, "Plex authentication changed; relink this account", userId);
      return null;
    }
    return {
      accountToken: decryptToken(row.token_encrypted),
      serverToken: decryptToken(row.server_token_encrypted),
      row,
    };
  } catch {
    updateSync.run(row.last_sync_at, "Stored Plex credentials can no longer be decrypted; relink the account", userId);
    return null;
  }
}

interface RemoteMetadata {
  ratingKey?: string;
  viewOffset?: number;
  duration?: number;
  viewCount?: number;
  viewedAt?: number;
  lastViewedAt?: number;
  updatedAt?: number;
}

interface RemoteState {
  positionMs: number;
  durationMs: number;
  watched: boolean;
  updatedAt: number;
}

function putRemote(map: Map<string, RemoteState>, item: RemoteMetadata, watched: boolean): void {
  if (!item.ratingKey || !/^\d+$/.test(item.ratingKey)) return;
  const seconds = item.viewedAt || item.lastViewedAt || item.updatedAt || 0;
  const state: RemoteState = {
    positionMs: watched ? (item.duration || 0) : (item.viewOffset || 0),
    durationMs: item.duration || 0,
    watched,
    updatedAt: seconds > 0 ? seconds * 1000 : Date.now(),
  };
  const old = map.get(item.ratingKey);
  if (!old || old.updatedAt < state.updatedAt || (old.updatedAt === state.updatedAt && watched)) {
    map.set(item.ratingKey, state);
  }
}

async function readRemoteState(token: string, accountId: string): Promise<Map<string, RemoteState>> {
  const remote = new Map<string, RemoteState>();
  let start = 0;
  while (start < MAX_SYNC_ITEMS) {
    const data = await plexJSON<{
      MediaContainer: { Metadata?: RemoteMetadata[]; totalSize?: number };
    }>(
      "/status/sessions/history/all",
      {
        accountID: accountId,
        sort: "viewedAt:desc",
        "X-Plex-Container-Start": String(start),
        "X-Plex-Container-Size": "100",
      },
      token,
    );
    const items = data.MediaContainer.Metadata || [];
    for (const item of items) putRemote(remote, item, true);
    start += items.length;
    if (items.length === 0 || start >= (data.MediaContainer.totalSize ?? start)) break;
  }

  // Plex history contains completed plays. Its home hubs carry the user's
  // current partial positions, including an unfinished rewatch of an item that
  // also has older completed events.
  const hubs = await plexJSON<{
    MediaContainer: { Hub?: Array<{ hubIdentifier?: string; title?: string; Metadata?: RemoteMetadata[] }> };
  }>("/hubs", { count: "50" }, token);
  for (const hub of hubs.MediaContainer.Hub || []) {
    const isContinue = hub.hubIdentifier?.startsWith("home.continue")
      || hub.hubIdentifier?.startsWith("home.ondeck")
      || hub.title === "Continue Watching"
      || hub.title === "On Deck";
    if (!isContinue) continue;
    for (const item of hub.Metadata || []) putRemote(remote, item, false);
  }
  return remote;
}

function sessionIdentifier(userId: string): string {
  return crypto.createHmac("sha256", encryptionKey).update(userId).digest("hex").slice(0, 32);
}

export async function pushProgressToPlex(
  userId: string,
  entry: HistoryEntry,
  state: "playing" | "paused" = "playing",
  force = false,
  recordPlayback = true,
): Promise<boolean> {
  const linked = accessToken(userId);
  if (!linked) return false;
  const key = `${userId}:${entry.ratingKey}`;
  const now = Date.now();
  const last = lastLivePush.get(key) ?? 0;
  if (!force && now - last < LIVE_PUSH_INTERVAL_MS) return false;
  lastLivePush.set(key, now);

  // A live linked viewer gets a real timeline event before the watched-state
  // scrobble. That lets Plex treat the activity as playback rather than only a
  // manual "mark watched" action. Bulk reconciliation skips this step so a
  // relink cannot manufacture a fresh play event for every old local row.
  if (entry.watched && recordPlayback) {
    const timeline = await plexFetch(
      "/:/timeline",
      {
        ratingKey: entry.ratingKey,
        key: `/library/metadata/${entry.ratingKey}`,
        identifier: "com.plexapp.plugins.library",
        state,
        time: String(entry.positionMs),
        duration: String(entry.durationMs),
      },
      {
        "X-Plex-Client-Identifier": CLIENT_ID,
        "X-Plex-Session-Identifier": sessionIdentifier(userId),
      },
      "POST",
      linked.serverToken,
    );
    if (!timeline.ok) throw new Error(`Plex timeline update failed (${timeline.status})`);
  }

  if (entry.watched) {
    const response = await plexFetch(
      "/:/scrobble",
      { key: entry.ratingKey, identifier: "com.plexapp.plugins.library" },
      { "X-Plex-Client-Identifier": CLIENT_ID },
      "PUT",
      linked.serverToken,
    );
    if (!response.ok) throw new Error(`Plex watched-state update failed (${response.status})`);
    return true;
  }

  const response = await plexFetch(
    "/:/timeline",
    {
      ratingKey: entry.ratingKey,
      key: `/library/metadata/${entry.ratingKey}`,
      identifier: "com.plexapp.plugins.library",
      state,
      time: String(entry.positionMs),
      duration: String(entry.durationMs),
    },
    {
      "X-Plex-Client-Identifier": CLIENT_ID,
      "X-Plex-Session-Identifier": sessionIdentifier(userId),
    },
    "POST",
    linked.serverToken,
  );
  if (!response.ok) throw new Error(`Plex progress update failed (${response.status})`);
  return true;
}

const lastLivePush = new Map<string, number>();
const syncInFlight = new Map<string, Promise<{ imported: number; exported: number }>>();

async function runWithConcurrency<T>(items: T[], count: number, work: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(count, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await work(item);
    }
  });
  await Promise.all(workers);
}

export function syncPlexAccount(userId: string): Promise<{ imported: number; exported: number }> {
  const running = syncInFlight.get(userId);
  if (running) return running;
  const promise = (async () => {
    const linked = accessToken(userId);
    if (!linked) throw new Error("No Plex account is linked");
    try {
      const remote = await readRemoteState(linked.serverToken, linked.row.plex_user_id);
      let imported = 0;
      for (const [ratingKey, state] of remote) {
        const merged = await mergeExternalProgress(userId, ratingKey, state);
        if (merged.changed) imported++;
      }

      const local = getHistory(userId, MAX_SYNC_ITEMS, 0).items;
      const toExport = local.filter((entry) => {
        const there = remote.get(entry.ratingKey);
        return !there || entry.updatedAt > there.updatedAt;
      });
      let exported = 0;
      await runWithConcurrency(toExport, 4, async (entry) => {
        if (await pushProgressToPlex(userId, entry, "paused", true, false)) exported++;
      });
      updateSync.run(Date.now(), null, userId);
      return { imported, exported };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateSync.run(linked.row.last_sync_at, message.slice(0, 500), userId);
      throw err;
    }
  })().finally(() => syncInFlight.delete(userId));
  syncInFlight.set(userId, promise);
  return promise;
}

export function closePlexAccountsDb(): void {
  db.close();
}
