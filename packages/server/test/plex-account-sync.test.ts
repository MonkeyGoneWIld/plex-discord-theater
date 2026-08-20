/** Focused harness for per-Discord-user Plex links and two-way history sync. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plex-account-sync-"));
process.env.THUMB_CACHE_DIR = dataDir;
process.env.PLEX_URL = "http://plex.test";
process.env.PLEX_TOKEN = "shared-server-token";
process.env.DISCORD_CLIENT_SECRET = "test-discord-secret";

// Reproduce an installation upgraded from the original incompatible PIN flow.
const legacyDb = new Database(path.join(dataDir, "plex-accounts.sqlite"));
legacyDb.exec(`
  CREATE TABLE plex_link_pins (
    user_id TEXT PRIMARY KEY,
    pin_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    auth_url TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )
`);
legacyDb.prepare(`
  INSERT INTO plex_link_pins (user_id, pin_id, code, auth_url, expires_at)
  VALUES (?, ?, ?, ?, ?)
`).run("discord-legacy", 1, "old-code", "https://app.plex.tv/auth#?old", Date.now() + 600_000);
legacyDb.close();

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

let nextPin = 10;
const pinTokens = new Map<number, string>();
const pinAccountIds = new Map<number, string>();
const invalidPinIds = new Set<number>();
const plexCalls: Array<{ method: string; url: URL; token: string | null }> = [];
const defaultRemoteHistory = [
  { ratingKey: "101", duration: 100_000, viewedAt: 1_700_000_000 },
];
const remoteHistoryByAccount = new Map<string, typeof defaultRemoteHistory>();
const historyPageStarts: Array<{ accountId: string; start: number }> = [];

globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
  const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));

  if (url.hostname === "plex.tv" && url.pathname === "/api/v2/pins" && method === "POST") {
    const id = nextPin++;
    pinTokens.set(id, `personal-token-${id}`);
    return Response.json({ id, code: `code-${id}`, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  }
  if (url.hostname === "plex.tv" && url.pathname.startsWith("/api/v2/pins/")) {
    const id = Number(url.pathname.split("/").pop());
    if (invalidPinIds.has(id)) return new Response("gone", { status: 404 });
    return Response.json({ authToken: pinTokens.get(id) ?? null });
  }
  if (url.hostname === "plex.tv" && url.pathname === "/api/v2/user") {
    const token = headers.get("X-Plex-Token") || "";
    const suffix = token.split("-").pop();
    const accountId = pinAccountIds.get(Number(suffix)) ?? suffix;
    return Response.json({ id: accountId, username: `plex-user-${accountId}`, email: `user-${accountId}@example.test` });
  }
  if (url.hostname === "clients.plex.tv" && url.pathname === "/api/v2/resources") {
    const accountToken = headers.get("X-Plex-Token") || "";
    const suffix = accountToken.split("-").pop();
    return Response.json([{
      name: "Test server",
      provides: "server",
      clientIdentifier: "test-machine",
      accessToken: `server-token-${suffix}`,
    }]);
  }
  if (url.hostname === "discover.provider.plex.tv") {
    const token = headers.get("X-Plex-Token");
    plexCalls.push({ method, url, token });
    if (url.pathname === "/library/sections/watchlist/all") {
      return Response.json({
        MediaContainer: {
          totalSize: 1,
          Metadata: [{
            ratingKey: "provider-303",
            guid: "plex://movie/provider-303",
            title: "Title 303",
            type: "movie",
            thumb: "https://metadata-static.plex.tv/poster.jpg",
            Guid: [{ id: "tmdb://303" }],
          }],
        },
      });
    }
    if (url.pathname.startsWith("/actions/")) return new Response("", { status: 200 });
  }

  if (url.hostname === "plex.test") {
    plexCalls.push({ method, url, token: url.searchParams.get("X-Plex-Token") });
    if (url.pathname === "/identity") {
      return Response.json({ MediaContainer: { machineIdentifier: "test-machine" } });
    }
    if (url.pathname === "/library/sections") {
      return Response.json({ MediaContainer: { Directory: [{ key: "1", title: "Movies", type: "movie" }] } });
    }
    if (url.pathname === "/status/sessions/history/all") {
      const accountId = url.searchParams.get("accountID") || "default";
      const start = Number(url.searchParams.get("X-Plex-Container-Start") || 0);
      const size = Number(url.searchParams.get("X-Plex-Container-Size") || 100);
      const remoteHistory = remoteHistoryByAccount.get(accountId) ?? defaultRemoteHistory;
      historyPageStarts.push({ accountId, start });
      return Response.json({
        MediaContainer: {
          totalSize: remoteHistory.length,
          Metadata: remoteHistory.slice(start, start + size),
        },
      });
    }
    if (url.pathname === "/hubs") {
      return Response.json({
        MediaContainer: {
          Hub: [{
            hubIdentifier: "home.continueWatching",
            title: "Continue Watching",
            Metadata: [{
              ratingKey: "202", viewOffset: 50_000, duration: 100_000,
              lastViewedAt: 1_700_000_100,
            }],
          }],
        },
      });
    }
    if (url.pathname === "/library/all") {
      const guid = url.searchParams.get("guid");
      if (guid === "plex://movie/provider-303") {
        return Response.json({
          MediaContainer: {
            size: 1,
            Metadata: [{
              ratingKey: "303", title: "Title 303", type: "movie", duration: 100_000,
              thumb: "/library/metadata/303/thumb/1", guid,
            }],
          },
        });
      }
      return Response.json({ MediaContainer: { size: 0, Metadata: [] } });
    }
    if (url.pathname.startsWith("/library/metadata/")) {
      const ratingKey = url.pathname.split("/").pop()!;
      return Response.json({
        MediaContainer: {
          Metadata: [{
            ratingKey, title: `Title ${ratingKey}`, type: "movie", duration: 100_000,
            thumb: `/library/metadata/${ratingKey}/thumb/1`,
            guid: `plex://movie/provider-${ratingKey}`,
          }],
        },
      });
    }
    if (url.pathname === "/:/progress" || url.pathname === "/:/scrobble" || url.pathname === "/:/unscrobble") {
      return new Response("", { status: 200 });
    }
  }
  return new Response("not mocked", { status: 404 });
};

const accounts = await import("../src/services/plex-accounts.js");
const history = await import("../src/services/watch-history.js");

check("upgrade clears pending PINs from the incompatible flow", accounts.getPlexAccountStatus("discord-legacy").pending, undefined);
console.log("\n— Plex links are isolated by Discord identity —");
const startedA = await accounts.startPlexAccountLink("discord-a");
check("a receives only a temporary authorization URL", !!startedA.pending?.authUrl, true);
const linkedA = await accounts.pollPlexAccountLink("discord-a");
check("a is linked", linkedA.linked, true);
check("a sees their Plex identity", linkedA.account?.username, "plex-user-10");

await accounts.startPlexAccountLink("discord-b");
const linkedB = await accounts.pollPlexAccountLink("discord-b");
check("b has a different Plex identity", linkedB.account?.username, "plex-user-11");
check("a is still linked independently", accounts.getPlexAccountStatus("discord-a").account?.username, "plex-user-10");

console.log("\n— invalid PINs recover without trapping the user —");
const stale = await accounts.startPlexAccountLink("discord-stale");
check("stale user initially has a pending link", !!stale.pending, true);
invalidPinIds.add(12);
let staleMessage = "";
try {
  await accounts.pollPlexAccountLink("discord-stale");
} catch (err) {
  staleMessage = err instanceof Error ? err.message : String(err);
}
check("invalid PIN gets an actionable error", staleMessage, "That Plex sign-in is no longer valid. Start again.");
check("invalid PIN is removed", accounts.getPlexAccountStatus("discord-stale").pending, undefined);

const dbBytes = fs.readdirSync(dataDir)
  .filter((name) => name.startsWith("plex-accounts.sqlite"))
  .map((name) => fs.readFileSync(path.join(dataDir, name)))
  .reduce((all, part) => Buffer.concat([all, part]), Buffer.alloc(0));
check("personal tokens are not stored as plaintext", dbBytes.includes(Buffer.from("personal-token-10")), false);
check("server tokens are not stored as plaintext", dbBytes.includes(Buffer.from("server-token-10")), false);

console.log("\n— history moves in both directions —");
const imported = await accounts.syncPlexAccount("discord-a");
check("completed and partial Plex state are imported", imported.imported, 2);
check("completed state lands in a's history", history.getProgress("discord-a", "101")?.watched, true);
check("resume position lands in a's history", history.getProgress("discord-a", "202")?.positionMs, 50_000);
check("b does not inherit a's imported history before syncing", history.getProgress("discord-b", "101"), null);

await history.recordProgress("discord-b", "303", 70, { force: true });
const exported = await accounts.syncPlexAccount("discord-b");
check("new local progress is exported", exported.exported, 1);
check(
  "the export uses b's server-specific token",
  plexCalls.some((call) => call.url.pathname === "/:/progress" && call.token === "server-token-11"),
  true,
);
check(
  "linked-account progress never creates a Plex playback timeline",
  plexCalls.some((call) => call.url.pathname === "/:/timeline"),
  false,
);

console.log("\n— Watchlist and explicit watched actions stay personal —");
const watchlist = await accounts.getPlexWatchlist("discord-b");
check("Plex Watchlist titles resolve to the playable local copy", watchlist[0]?.ratingKey, "303");
check("Watchlist reads use the linked account token", plexCalls.some((call) =>
  call.url.hostname === "discover.provider.plex.tv" && call.token === "personal-token-11"
), true);
check("a title reports its current Plex Watchlist state", await accounts.getPlexWatchlistState("discord-b", "303"), true);
await accounts.setPlexWatchlistState("discord-b", { ratingKey: "303" }, false);
check("Watchlist updates use the linked account token", plexCalls.some((call) =>
  call.url.pathname === "/actions/removeFromWatchlist" && call.token === "personal-token-11"
), true);

await accounts.setPlexItemWatched("discord-b", "303", true);
check("mark watched updates local Activity", history.getProgress("discord-b", "303")?.watched, true);
check("mark watched uses b's server-specific token", plexCalls.some((call) =>
  call.url.pathname === "/:/scrobble" && call.token === "server-token-11"
), true);
await accounts.setPlexItemWatched("discord-b", "303", false);
check("mark unwatched clears the local Activity row", history.getProgress("discord-b", "303"), null);
check("mark unwatched uses b's server-specific token", plexCalls.some((call) =>
  call.url.pathname === "/:/unscrobble" && call.token === "server-token-11"
), true);
check("personal actions still never create a playback timeline", plexCalls.some((call) =>
  call.url.pathname === "/:/timeline"
), false);

console.log("\n— changing Plex accounts starts with clean history —");
await history.recordProgress("discord-a", "303", 70, { force: true });
accounts.unlinkPlexAccount("discord-a");
await accounts.startPlexAccountLink("discord-a");
const replacementPin = nextPin - 1;
pinAccountIds.set(replacementPin, "99");
const replacement = await accounts.pollPlexAccountLink("discord-a");
check("the different Plex identity is linked", replacement.account?.username, "plex-user-99");
check("old Activity history is cleared before syncing", history.getHistory("discord-a").total, 0);
const callsBeforeReplacementSync = plexCalls.length;
await accounts.syncPlexAccount("discord-a");
check("new account history becomes the new local history", history.getHistory("discord-a").total, 2);
check(
  "old local history is never exported to the replacement account",
  plexCalls.slice(callsBeforeReplacementSync).some((call) =>
    call.token === `server-token-${replacementPin}`
    && call.url.searchParams.get("ratingKey") === "303"
  ),
  false,
);

await history.recordProgress("discord-a", "404", 70, { force: true });
accounts.unlinkPlexAccount("discord-a");
await accounts.startPlexAccountLink("discord-a");
const sameAccountPin = nextPin - 1;
pinAccountIds.set(sameAccountPin, "99");
await accounts.pollPlexAccountLink("discord-a");
check("re-linking the same account preserves local history", !!history.getProgress("discord-a", "404"), true);

console.log("\n— full history is backfilled once, then synced incrementally —");
const fullHistory = Array.from({ length: 650 }, (_, index) => ({
  ratingKey: String(1_000 + index),
  duration: 100_000,
  viewedAt: 1_700_000_000 - index,
}));
remoteHistoryByAccount.set("5000", fullHistory);
await accounts.startPlexAccountLink("discord-full");
const fullPin = nextPin - 1;
pinAccountIds.set(fullPin, "5000");
await accounts.pollPlexAccountLink("discord-full");
const firstFullPage = historyPageStarts.length;
const fullResult = await accounts.syncPlexAccount("discord-full");
check("initial sync imports every unique Plex title", fullResult.imported, 651);
check("Activity storage keeps more than 500 rows", history.getHistory("discord-full", 1, 0).total, 651);
check(
  "initial sync paginates until Plex history is exhausted",
  historyPageStarts.slice(firstFullPage).filter((page) => page.accountId === "5000").map((page) => page.start),
  [0, 100, 200, 300, 400, 500, 600],
);

remoteHistoryByAccount.set("5000", [{
  ratingKey: "9999",
  duration: 100_000,
  viewedAt: Math.ceil(Date.now() / 1000),
}, ...fullHistory]);
const incrementalPage = historyPageStarts.length;
const callsBeforeIncremental = plexCalls.length;
const incremental = await accounts.syncPlexAccount("discord-full");
check("later sync imports newly watched Plex titles", incremental.imported, 1);
check(
  "later sync stops after crossing the previous-sync window",
  historyPageStarts.slice(incrementalPage).filter((page) => page.accountId === "5000").map((page) => page.start),
  [0],
);
check(
  "incremental sync does not re-export old local history",
  plexCalls.slice(callsBeforeIncremental).some((call) =>
    call.token === `server-token-${fullPin}`
    && (call.url.pathname === "/:/progress" || call.url.pathname === "/:/scrobble")
  ),
  false,
);

accounts.unlinkPlexAccount("discord-a");
check("disconnect removes only a", accounts.getPlexAccountStatus("discord-a").linked, false);
check("b remains linked", accounts.getPlexAccountStatus("discord-b").linked, true);

accounts.closePlexAccountsDb();
history.closeHistoryDb();
fs.rmSync(dataDir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
