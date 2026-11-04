/**
 * Registering an Activity instance (POST /api/register, routes/discord.ts)
 * takes a channel's earlier registration away only from somebody Discord says
 * is in that channel's server. The ids in the request are the client's own
 * word; a session whose server list couldn't be read (null) proves nothing,
 * and one can be had on purpose, by authorizing the app without the guilds
 * scope.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

process.env.THUMB_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "instance-register-"));
delete process.env.ALLOWED_GUILD_IDS;
process.env.LOG_TO_FILE = "0";

const { default: express } = await import("express");
const { default: discordRoutes, instanceHosts, closeInstanceDb } = await import("../src/routes/discord.js");
const { createSession } = await import("../src/middleware/auth.js");

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

const app = express();
app.use(express.json());
app.use("/api", discordRoutes);
const server = http.createServer(app);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function register(token: string, body: Record<string, string>): Promise<number> {
  const res = await fetch(`${origin}/api/register`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  await res.text();
  return res.status;
}

const host = createSession("u-host", ["g-party"]);
const unread = createSession("u-other", null);
const elsewhere = createSession("u-elsewhere", ["g-other"]);

check("a party registers its instance",
  await register(host, { instanceId: "inst-party", userId: "u-host", guildId: "g-party", channelId: "c-party" }), 200);

check("somebody whose servers couldn't be read is let in (no allowlist)",
  await register(unread, { instanceId: "inst-unread", userId: "u-other", guildId: "g-party", channelId: "c-party" }), 200);
check("but doesn't take the party's registration away", instanceHosts.has("inst-party"), true);

await register(elsewhere, { instanceId: "inst-elsewhere", userId: "u-elsewhere", guildId: "g-party", channelId: "c-party" });
check("nor does somebody Discord says is in another server", instanceHosts.has("inst-party"), true);

await register(host, { instanceId: "inst-party-2", userId: "u-host", guildId: "g-party", channelId: "c-party" });
check("somebody in the party's server opening it again replaces the channel's last one",
  [instanceHosts.has("inst-elsewhere"), instanceHosts.has("inst-party-2")], [false, true]);

server.close();
closeInstanceDb();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
