/** Focused harness for per-Discord-user Plex links and two-way history sync. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plex-account-sync-"));
process.env.THUMB_CACHE_DIR = dataDir;
process.env.PLEX_URL = "http://plex.test";
process.env.PLEX_TOKEN = "shared-server-token";
process.env.DISCORD_CLIENT_SECRET = "test-discord-secret";

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
const plexCalls: Array<{ method: string; url: URL; token: string | null }> = [];

globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
  const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));

  if (url.hostname === "clients.plex.tv" && url.pathname === "/api/v2/pins" && method === "POST") {
    const id = nextPin++;
    pinTokens.set(id, `personal-token-${id}`);
    return Response.json({ id, code: `code-${id}`, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  }
  if (url.hostname === "clients.plex.tv" && url.pathname.startsWith("/api/v2/pins/")) {
    const id = Number(url.pathname.split("/").pop());
    return Response.json({ authToken: pinTokens.get(id) ?? null });
  }
  if (url.hostname === "plex.tv" && url.pathname === "/api/v2/user") {
    const token = headers.get("X-Plex-Token") || "";
    const suffix = token.split("-").pop();
    return Response.json({ id: suffix, username: `plex-user-${suffix}`, email: `user-${suffix}@example.test` });
  }

  if (url.hostname === "plex.test") {
    plexCalls.push({ method, url, token: url.searchParams.get("X-Plex-Token") });
    if (url.pathname === "/library/sections") {
      return Response.json({ MediaContainer: { Directory: [{ key: "1", title: "Movies", type: "movie" }] } });
    }
    if (url.pathname === "/status/sessions/history/all") {
      return Response.json({
        MediaContainer: {
          totalSize: 1,
          Metadata: [{ ratingKey: "101", duration: 100_000, viewedAt: 1_700_000_000 }],
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
    if (url.pathname.startsWith("/library/metadata/")) {
      const ratingKey = url.pathname.split("/").pop()!;
      return Response.json({
        MediaContainer: {
          Metadata: [{
            ratingKey, title: `Title ${ratingKey}`, type: "movie", duration: 100_000,
            thumb: `/library/metadata/${ratingKey}/thumb/1`,
          }],
        },
      });
    }
    if (url.pathname === "/:/timeline" || url.pathname === "/:/scrobble") {
      return new Response("", { status: 200 });
    }
  }
  return new Response("not mocked", { status: 404 });
};

const accounts = await import("../src/services/plex-accounts.js");
const history = await import("../src/services/watch-history.js");

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

const dbBytes = fs.readdirSync(dataDir)
  .filter((name) => name.startsWith("plex-accounts.sqlite"))
  .map((name) => fs.readFileSync(path.join(dataDir, name)))
  .reduce((all, part) => Buffer.concat([all, part]), Buffer.alloc(0));
check("personal tokens are not stored as plaintext", dbBytes.includes(Buffer.from("personal-token-10")), false);

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
  "the export uses b's personal token",
  plexCalls.some((call) => call.url.pathname === "/:/timeline" && call.token === "personal-token-11"),
  true,
);

accounts.unlinkPlexAccount("discord-a");
check("disconnect removes only a", accounts.getPlexAccountStatus("discord-a").linked, false);
check("b remains linked", accounts.getPlexAccountStatus("discord-b").linked, true);

accounts.closePlexAccountsDb();
history.closeHistoryDb();
fs.rmSync(dataDir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
