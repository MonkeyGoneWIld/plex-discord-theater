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
  deleteHistoryEntry,
  getAllHistory,
  getProgress,
  mergeExternalProgress,
  type HistoryEntry,
} from "./watch-history.js";

const PRODUCT = "Plex Discord Theater";
const VERSION = "1.0.0";
const HISTORY_PAGE_SIZE = 100;
const HISTORY_SYNC_VERSION = 1;
const INCREMENTAL_SYNC_OVERLAP_MS = 5 * 60 * 1000;
const LINK_TTL_MS = 10 * 60 * 1000;
const LIVE_PUSH_INTERVAL_MS = 15_000;
const PIN_FLOW_VERSION = 1;
const WATCHLIST_PAGE_SIZE = 100;
const PLEX_DISCOVER = "https://discover.provider.plex.tv";

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
    last_sync_error TEXT,
    history_sync_version INTEGER NOT NULL DEFAULT 1
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
// Accounts linked before full-history sync existed need one uncapped backfill.
// New rows already default to the current version from CREATE TABLE.
try {
  db.exec("ALTER TABLE plex_accounts ADD COLUMN history_sync_version INTEGER NOT NULL DEFAULT 0");
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
  history_sync_version: number;
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
const markSyncSuccess = db.prepare(`
  UPDATE plex_accounts
  SET last_sync_at = ?, last_sync_error = NULL, history_sync_version = ?
  WHERE user_id = ?
`);
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

function requireAccessToken(userId: string): NonNullable<ReturnType<typeof accessToken>> {
  const linked = accessToken(userId);
  if (!linked) throw new Error("No Plex account is linked");
  return linked;
}

interface AccountMediaMetadata {
  ratingKey?: string;
  title?: string;
  year?: number;
  type?: string;
  thumb?: string;
  summary?: string;
  duration?: number;
  guid?: string;
  Guid?: Array<{ id?: string }>;
  index?: number;
  parentIndex?: number;
  parentTitle?: string;
  parentRatingKey?: string;
  grandparentRatingKey?: string;
  grandparentTitle?: string;
  grandparentThumb?: string;
  leafCount?: number;
  childCount?: number;
}

export interface PlexWatchlistItem {
  ratingKey: string;
  title: string;
  year?: number;
  type: string;
  thumb: string | null;
  summary?: string;
  duration?: number;
  guid?: string;
  tmdbId?: number;
  inLibrary: boolean;
  index?: number;
  parentIndex?: number;
  parentTitle?: string;
  parentRatingKey?: string;
  grandparentRatingKey?: string;
  showTitle?: string;
  showThumb?: string | null;
  leafCount?: number;
  childCount?: number;
}

function providerId(guid: string | undefined): string | null {
  const match = /^plex:\/\/(?:movie|show)\/([^/?#]+)$/.exec(guid ?? "");
  return match?.[1] ?? null;
}

function tmdbId(guids: Array<{ id?: string }> | undefined): number | undefined {
  const value = guids?.find((entry) => entry.id?.startsWith("tmdb://"))?.id?.slice(7);
  if (!value || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}

function externalThumb(thumb: string | undefined): string | null {
  return thumb ? `/api/plex/thumb/photo/:/transcode?url=${encodeURIComponent(thumb)}` : null;
}

function mapLocalWatchlistItem(item: AccountMediaMetadata): PlexWatchlistItem {
  return {
    ratingKey: item.ratingKey!,
    title: item.title || "Untitled",
    ...(item.year != null && { year: item.year }),
    type: item.type || "movie",
    thumb: item.thumb ? `/api/plex/thumb${item.thumb}` : null,
    ...(item.summary != null && { summary: item.summary }),
    ...(item.duration != null && { duration: item.duration }),
    ...(item.index != null && { index: item.index }),
    ...(item.parentIndex != null && { parentIndex: item.parentIndex }),
    ...(item.parentTitle != null && { parentTitle: item.parentTitle }),
    ...(item.parentRatingKey != null && { parentRatingKey: item.parentRatingKey }),
    ...(item.grandparentRatingKey != null && { grandparentRatingKey: item.grandparentRatingKey }),
    ...(item.grandparentTitle != null && { showTitle: item.grandparentTitle }),
    ...(item.grandparentThumb != null && { showThumb: `/api/plex/thumb${item.grandparentThumb}` }),
    ...(item.leafCount != null && { leafCount: item.leafCount }),
    ...(item.childCount != null && { childCount: item.childCount }),
    inLibrary: true,
  };
}

function mapOnlineWatchlistItem(item: AccountMediaMetadata): PlexWatchlistItem | null {
  if (!item.guid || !providerId(item.guid) || !item.title || (item.type !== "movie" && item.type !== "show")) {
    return null;
  }
  const externalId = tmdbId(item.Guid);
  return {
    ratingKey: item.ratingKey || item.guid,
    title: item.title,
    ...(item.year != null && { year: item.year }),
    type: item.type,
    thumb: externalThumb(item.thumb),
    ...(item.summary != null && { summary: item.summary }),
    ...(item.duration != null && { duration: item.duration }),
    guid: item.guid,
    ...(externalId != null && { tmdbId: externalId }),
    inLibrary: false,
  };
}

async function readWatchlist(accountToken: string): Promise<AccountMediaMetadata[]> {
  const items: AccountMediaMetadata[] = [];
  let start = 0;
  while (true) {
    const url = new URL(`${PLEX_DISCOVER}/library/sections/watchlist/all`);
    url.searchParams.set("includeCollections", "1");
    url.searchParams.set("includeExternalMedia", "1");
    url.searchParams.set("includeGuids", "1");
    url.searchParams.set("sort", "watchlistedAt:desc");
    url.searchParams.set("X-Plex-Container-Start", String(start));
    url.searchParams.set("X-Plex-Container-Size", String(WATCHLIST_PAGE_SIZE));
    const response = await plexCloudFetch(url, {
      headers: { ...plexTvHeaders(), "X-Plex-Token": accountToken },
    });
    if (!response.ok) throw new Error(`Could not read your Plex Watchlist (${response.status})`);
    const data = await response.json() as {
      MediaContainer?: { Metadata?: AccountMediaMetadata[]; totalSize?: number };
    };
    const page = data.MediaContainer?.Metadata || [];
    items.push(...page);
    start += page.length;
    const total = data.MediaContainer?.totalSize;
    if (page.length === 0 || page.length < WATCHLIST_PAGE_SIZE || (total != null && start >= total)) break;
  }
  return items;
}

async function localMatchForGuid(guid: string, serverToken: string): Promise<AccountMediaMetadata | null> {
  try {
    const data = await plexJSON<{ MediaContainer: { Metadata?: AccountMediaMetadata[] } }>(
      "/library/all",
      { guid },
      serverToken,
    );
    return data.MediaContainer.Metadata?.find((item) => item.type === "movie" || item.type === "show") ?? null;
  } catch {
    return null;
  }
}

/** The linked account's Universal Watchlist, mapped back to playable local items where possible. */
export async function getPlexWatchlist(userId: string): Promise<PlexWatchlistItem[]> {
  const linked = requireAccessToken(userId);
  const online = await readWatchlist(linked.accountToken);
  const resolved: Array<PlexWatchlistItem | null> = new Array(online.length).fill(null);
  await runWithConcurrency(online.map((item, index) => ({ item, index })), 8, async ({ item, index }) => {
    const id = providerId(item.guid);
    if (!id || !item.guid) return;
    const local = await localMatchForGuid(item.guid, linked.serverToken);
    resolved[index] = local ? mapLocalWatchlistItem(local) : mapOnlineWatchlistItem(item);
  });
  return resolved.filter((item): item is PlexWatchlistItem => item != null);
}

async function localAccountMetadata(ratingKey: string, serverToken: string): Promise<AccountMediaMetadata> {
  const data = await plexJSON<{ MediaContainer: { Metadata?: AccountMediaMetadata[] } }>(
    `/library/metadata/${ratingKey}`,
    { includeGuids: "1" },
    serverToken,
  );
  const item = data.MediaContainer.Metadata?.[0];
  if (!item) throw new Error("That title is no longer available in the Plex library");
  return item;
}

async function watchlistGuid(
  linked: NonNullable<ReturnType<typeof accessToken>>,
  input: { ratingKey?: string; guid?: string },
): Promise<string> {
  if (input.guid && providerId(input.guid)) return input.guid;
  if (!input.ratingKey || !/^\d+$/.test(input.ratingKey)) throw new Error("Invalid Plex title");
  const item = await localAccountMetadata(input.ratingKey, linked.serverToken);
  if ((item.type !== "movie" && item.type !== "show") || !providerId(item.guid)) {
    throw new Error("Plex Watchlist is available only for movies and shows using a current Plex metadata agent");
  }
  return item.guid!;
}

export async function getPlexWatchlistState(userId: string, ratingKey: string): Promise<boolean> {
  const linked = requireAccessToken(userId);
  const guid = await watchlistGuid(linked, { ratingKey });
  const id = providerId(guid)!;
  const watchlist = await readWatchlist(linked.accountToken);
  return watchlist.some((item) => providerId(item.guid) === id);
}

export async function setPlexWatchlistState(
  userId: string,
  input: { ratingKey?: string; guid?: string },
  watchlisted: boolean,
): Promise<void> {
  const linked = requireAccessToken(userId);
  const guid = await watchlistGuid(linked, input);
  const id = providerId(guid)!;
  const action = watchlisted ? "addToWatchlist" : "removeFromWatchlist";
  const url = new URL(`${PLEX_DISCOVER}/actions/${action}`);
  url.searchParams.set("ratingKey", id);
  const response = await plexCloudFetch(url, {
    method: "PUT",
    headers: { ...plexTvHeaders(), "X-Plex-Token": linked.accountToken },
  });
  if (!response.ok) throw new Error(`Could not update your Plex Watchlist (${response.status})`);
}

async function watchedMembers(
  item: AccountMediaMetadata,
  ratingKey: string,
  serverToken: string,
): Promise<AccountMediaMetadata[]> {
  if (item.type !== "show" && item.type !== "season") return [item];
  const suffix = item.type === "show" ? "allLeaves" : "children";
  const data = await plexJSON<{ MediaContainer: { Metadata?: AccountMediaMetadata[] } }>(
    `/library/metadata/${ratingKey}/${suffix}`,
    undefined,
    serverToken,
  );
  return (data.MediaContainer.Metadata || []).filter(
    (entry) => entry.type === "episode" && !!entry.ratingKey && /^\d+$/.test(entry.ratingKey),
  );
}

export async function getPlexItemWatchedState(
  userId: string,
  ratingKey: string,
): Promise<{ watched: boolean; watchedCount: number; total: number }> {
  if (!/^\d+$/.test(ratingKey)) throw new Error("Invalid rating key");
  const linked = requireAccessToken(userId);
  const item = await localAccountMetadata(ratingKey, linked.serverToken);
  if (!["movie", "episode", "season", "show"].includes(item.type || "")) {
    throw new Error("This Plex item does not support watched state");
  }
  const members = await watchedMembers(item, ratingKey, linked.serverToken);
  const watchedCount = members.reduce(
    (count, member) => count + (getProgress(userId, member.ratingKey!)?.watched ? 1 : 0),
    0,
  );
  return {
    watched: members.length > 0 && watchedCount === members.length,
    watchedCount,
    total: members.length,
  };
}

/** Explicit user action: update local Activity and only that user's linked Plex account. */
export async function setPlexItemWatched(
  userId: string,
  ratingKey: string,
  watched: boolean,
): Promise<{ progress: HistoryEntry | null; affected: number }> {
  if (!/^\d+$/.test(ratingKey)) throw new Error("Invalid rating key");
  const linked = requireAccessToken(userId);
  const item = await localAccountMetadata(ratingKey, linked.serverToken);
  if (!["movie", "episode", "season", "show"].includes(item.type || "")) {
    throw new Error("This Plex item does not support watched state");
  }
  const members = await watchedMembers(item, ratingKey, linked.serverToken);
  if (members.length === 0) throw new Error("This title has no episodes to update");

  // Plex applies scrobble/unscrobble recursively to season and show containers.
  // One parent action avoids hundreds of account requests for a long-running
  // series; local Activity is expanded per episode below so its UI stays exact.
  const response = await plexFetch(
    watched ? "/:/scrobble" : "/:/unscrobble",
    { key: ratingKey, identifier: "com.plexapp.plugins.library" },
    undefined,
    "GET",
    linked.serverToken,
  );
  if (!response.ok) throw new Error(`Plex watched-state update failed (${response.status})`);
  if (!watched) {
    for (const member of members) deleteHistoryEntry(userId, member.ratingKey!);
    return { progress: null, affected: members.length };
  }
  const updatedAt = Date.now();
  await runWithConcurrency(members, 12, async (member) => {
    await mergeExternalProgress(userId, member.ratingKey!, {
      positionMs: member.duration || 0,
      durationMs: member.duration || 0,
      watched: true,
      updatedAt,
    }, member);
  });
  return {
    progress: members.length === 1 ? getProgress(userId, members[0].ratingKey!) : null,
    affected: members.length,
  };
}

interface RemoteMetadata {
  ratingKey?: string;
  historyKey?: string;
  viewOffset?: number;
  duration?: number;
  viewCount?: number;
  viewedAt?: number;
  lastViewedAt?: number;
  updatedAt?: number;
}

type LinkedAccount = NonNullable<ReturnType<typeof accessToken>>;

/** Find raw Plex playback events belonging to the requested Activity titles. */
async function plexHistoryPaths(
  linked: LinkedAccount,
  ratingKeys: ReadonlySet<string>,
): Promise<Set<string>> {
  const paths = new Set<string>();
  if (ratingKeys.size === 0) return paths;
  const onlyRatingKey = ratingKeys.size === 1 ? ratingKeys.values().next().value : undefined;
  let start = 0;
  while (true) {
    const params: Record<string, string> = {
      accountID: linked.row.plex_user_id,
      sort: "viewedAt:desc",
      "X-Plex-Container-Start": String(start),
      "X-Plex-Container-Size": String(HISTORY_PAGE_SIZE),
    };
    // One removal can be filtered by Plex. A bulk clear reads the account
    // history once and filters locally instead of repeating it for every row.
    if (onlyRatingKey) params.metadataItemID = onlyRatingKey;
    const data = await plexJSON<{
      MediaContainer: { Metadata?: RemoteMetadata[]; totalSize?: number };
    }>("/status/sessions/history/all", params, linked.serverToken);
    const items = data.MediaContainer.Metadata || [];
    for (const item of items) {
      if (
        item.ratingKey
        && ratingKeys.has(item.ratingKey)
        && /^\/status\/sessions\/history\/\d+$/.test(item.historyKey || "")
      ) {
        paths.add(item.historyKey!);
      }
    }
    start += items.length;
    const totalSize = data.MediaContainer.totalSize;
    if (
      items.length === 0
      || (typeof totalSize === "number" && start >= totalSize)
      || (totalSize == null && items.length < HISTORY_PAGE_SIZE)
    ) break;
  }
  return paths;
}

async function deletePlexHistoryPaths(linked: LinkedAccount, paths: ReadonlySet<string>): Promise<void> {
  await runWithConcurrency([...paths], 8, async (historyPath) => {
    let response = await plexFetch(historyPath, undefined, undefined, "DELETE", linked.serverToken);
    // Plex documents raw playback-history deletion as an admin operation.
    // Managed users can read their event but some PMS versions reject deleting
    // it, so retry through the configured server-owner token.
    if (response.status === 401 || response.status === 403) {
      response = await plexFetch(historyPath, undefined, undefined, "DELETE");
    }
    if (!response.ok && response.status !== 404) {
      throw new Error(`Plex history removal failed (${response.status})`);
    }
  });
}

/** Clear the independent Plex watched flag and resume position for one title. */
async function clearPlexItemState(
  linked: LinkedAccount,
  ratingKey: string,
  title?: string,
): Promise<void> {
  const item = title ? `“${title}”` : `item ${ratingKey}`;
  const unscrobble = await plexFetch(
    "/:/unscrobble",
    { key: ratingKey, identifier: "com.plexapp.plugins.library" },
    undefined,
    "GET",
    linked.serverToken,
  );
  // A stale Activity row can outlive the Plex library item it referred to.
  // Clearing is idempotent: if Plex says the state is already absent, that is
  // the result we wanted and must not hold the entire history clear hostage.
  if (!unscrobble.ok && unscrobble.status !== 404) {
    throw new Error(`Plex could not clear the watched state for ${item} (${unscrobble.status})`);
  }

  const progress = await plexFetch(
    "/:/progress",
    {
      key: ratingKey,
      identifier: "com.plexapp.plugins.library",
      time: "0",
      state: "stopped",
    },
    undefined,
    "GET",
    linked.serverToken,
  );
  if (progress.ok || progress.status === 404) return;

  // Some PMS releases accept /:/progress for ordinary updates but reject a
  // zero-position reset. Plex's supported fallback removes the item from the
  // Continue Watching hub, which prevents the next account sync from importing
  // the deleted resume row straight back into MonkeyPlex.
  if (progress.status === 400 || progress.status === 405 || progress.status === 501) {
    const dismissed = await plexFetch(
      "/actions/removeFromContinueWatching",
      { ratingKey },
      undefined,
      "PUT",
      linked.serverToken,
    );
    if (dismissed.ok || dismissed.status === 404) return;
    throw new Error(
      `Plex could not clear progress for ${item} `
      + `(progress ${progress.status}, Continue Watching ${dismissed.status})`,
    );
  }

  throw new Error(`Plex could not clear progress for ${item} (${progress.status})`);
}

/**
 * Remove one Activity item from the linked Plex account as well as SQLite.
 *
 * Plex keeps playback-history events separately from watched state and resume
 * position. Clearing all three prevents a later Sync now from restoring the
 * row that the user explicitly removed.
 */
export async function removePlexHistoryEntry(
  userId: string,
  ratingKey: string,
): Promise<{ syncedToPlex: boolean; deletedRemoteEvents: number }> {
  if (!/^\d+$/.test(ratingKey)) throw new Error("Invalid rating key");
  const linked = accessToken(userId);
  if (!linked) {
    deleteHistoryEntry(userId, ratingKey);
    return { syncedToPlex: false, deletedRemoteEvents: 0 };
  }

  const historyPaths = await plexHistoryPaths(linked, new Set([ratingKey]));
  await deletePlexHistoryPaths(linked, historyPaths);
  await clearPlexItemState(linked, ratingKey);

  lastLivePush.delete(`${userId}:${ratingKey}`);
  deleteHistoryEntry(userId, ratingKey);
  return { syncedToPlex: true, deletedRemoteEvents: historyPaths.size };
}

/** Clear every visible Activity history row from the linked Plex account too. */
export async function clearPlexHistory(
  userId: string,
): Promise<{ syncedToPlex: boolean; removed: number; deletedRemoteEvents: number }> {
  const entries = getAllHistory(userId);
  const linked = accessToken(userId);
  if (!linked) {
    clearHistory(userId);
    return { syncedToPlex: false, removed: entries.length, deletedRemoteEvents: 0 };
  }

  const ratingKeys = new Set(entries.map((entry) => entry.ratingKey));
  const historyPaths = await plexHistoryPaths(linked, ratingKeys);
  await deletePlexHistoryPaths(linked, historyPaths);
  await runWithConcurrency(entries, 4, async (entry) => {
    await clearPlexItemState(linked, entry.ratingKey, entry.title);
  });

  for (const ratingKey of ratingKeys) lastLivePush.delete(`${userId}:${ratingKey}`);
  // This also removes hidden Continue Watching dismissal markers, which are
  // local UI state and deliberately absent from getAllHistory().
  clearHistory(userId);
  return {
    syncedToPlex: true,
    removed: entries.length,
    deletedRemoteEvents: historyPaths.size,
  };
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

async function readRemoteState(
  token: string,
  accountId: string,
  sinceMs: number | null,
): Promise<Map<string, RemoteState>> {
  const remote = new Map<string, RemoteState>();
  let start = 0;
  while (true) {
    const data = await plexJSON<{
      MediaContainer: { Metadata?: RemoteMetadata[]; totalSize?: number };
    }>(
      "/status/sessions/history/all",
      {
        accountID: accountId,
        sort: "viewedAt:desc",
        "X-Plex-Container-Start": String(start),
        "X-Plex-Container-Size": String(HISTORY_PAGE_SIZE),
      },
      token,
    );
    const items = data.MediaContainer.Metadata || [];
    let reachedPreviousSync = false;
    for (const item of items) putRemote(remote, item, true);
    if (sinceMs != null) {
      reachedPreviousSync = items.some((item) => {
        const seconds = item.viewedAt || item.lastViewedAt || item.updatedAt || 0;
        return seconds > 0 && seconds * 1000 < sinceMs;
      });
    }
    start += items.length;
    const totalSize = data.MediaContainer.totalSize;
    if (
      items.length === 0
      || reachedPreviousSync
      || (typeof totalSize === "number" && start >= totalSize)
      || (totalSize == null && items.length < HISTORY_PAGE_SIZE)
    ) break;
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

export async function pushProgressToPlex(
  userId: string,
  entry: HistoryEntry,
  force = false,
  clearWatchedState = entry.becameUnwatched === true,
): Promise<boolean> {
  const linked = accessToken(userId);
  if (!linked) return false;
  const key = `${userId}:${entry.ratingKey}`;
  const now = Date.now();
  const last = lastLivePush.get(key) ?? 0;
  if (!force && now - last < LIVE_PUSH_INTERVAL_MS) return false;
  lastLivePush.set(key, now);

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

  // Plex stores the played flag independently of the resume position. When a
  // completed title is replayed from the middle, clear that flag before sending
  // the new partial position so Plex also changes it back to unwatched.
  if (clearWatchedState) {
    const unscrobble = await plexFetch(
      "/:/unscrobble",
      { key: entry.ratingKey, identifier: "com.plexapp.plugins.library" },
      undefined,
      "GET",
      linked.serverToken,
    );
    if (!unscrobble.ok) throw new Error(`Plex watched-state update failed (${unscrobble.status})`);
  }

  // /:/timeline represents an active Plex player. Sending it with a linked
  // user's token creates a synthetic Now Playing session in Plex/Tautulli even
  // though the shared server account is delivering the video. /:/progress is
  // the lighter resume-position endpoint: it updates Continue Watching without
  // claiming that the linked account is playing or consuming another stream.
  const response = await plexFetch(
    "/:/progress",
    {
      key: entry.ratingKey,
      identifier: "com.plexapp.plugins.library",
      time: String(entry.positionMs),
      state: "stopped",
    },
    undefined,
    "GET",
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
      const needsFullHistory = !linked.row.last_sync_at
        || linked.row.history_sync_version < HISTORY_SYNC_VERSION;
      const sinceMs = needsFullHistory
        ? null
        : Math.max(0, linked.row.last_sync_at! - INCREMENTAL_SYNC_OVERLAP_MS);
      const remote = await readRemoteState(linked.serverToken, linked.row.plex_user_id, sinceMs);
      let imported = 0;
      await runWithConcurrency([...remote.entries()], 8, async ([ratingKey, state]) => {
        const merged = await mergeExternalProgress(userId, ratingKey, state);
        if (merged.changed) imported++;
      });

      // Initial sync reconciles every local row against the complete Plex map.
      // Later syncs only reconsider rows changed in the overlap window, avoiding
      // an all-history export every fifteen minutes while still covering races.
      const local = getAllHistory(userId);
      const toExport = local.filter((entry) => {
        if (sinceMs != null && entry.updatedAt < sinceMs) return false;
        const there = remote.get(entry.ratingKey);
        return !there || entry.updatedAt > there.updatedAt;
      });
      let exported = 0;
      await runWithConcurrency(toExport, 4, async (entry) => {
        const there = remote.get(entry.ratingKey);
        const clearWatchedState = !entry.watched && there?.watched === true;
        if (await pushProgressToPlex(userId, entry, true, clearWatchedState)) exported++;
      });
      markSyncSuccess.run(Date.now(), HISTORY_SYNC_VERSION, userId);
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
