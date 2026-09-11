import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";

process.env.PLEX_URL = "http://plex.test";
process.env.PLEX_TOKEN = "test-token";
process.env.SEERR_URL = "http://seerr.test";

const realFetch = globalThis.fetch;
let providerAvailable = false;
let providerCalls = 0;
let libraryCalls = 0;
let seerrStatus = 503;
let loginStatus = 200;
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", ...headers },
});

globalThis.fetch = (async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "127.0.0.1") return realFetch(input, init);
  if (url.hostname === "plex.test") {
    libraryCalls++;
    return json({ MediaContainer: { Metadata: [{
      ratingKey: "123", type: "show", title: "Love Island", year: 2019,
      guid: "plex://show/love-island-us", Guid: [{ id: "tvdb://test" }],
    }] } });
  }
  if (url.hostname === "seerr.test") {
    if (url.pathname.endsWith("/auth/plex")) {
      return json({}, loginStatus, { "set-cookie": "connect.sid=test; Path=/" });
    }
    return json({ seasons: Array.from({ length: 8 }, (_, i) => ({
      seasonNumber: i + 1, episodeCount: 22, airDate: "2019-07-09",
    })) }, seerrStatus);
  }
  if (url.hostname.endsWith(".plex.tv")) {
    providerCalls++;
    return providerAvailable
      ? json({ MediaContainer: { Metadata: [{ summary: "A show", Guid: [{ id: "tmdb://90521" }] }] } })
      : json({}, 503);
  }
  throw new Error(`Unexpected upstream: ${url.hostname}`);
}) as typeof fetch;

const { buildMeta } = await import("../src/routes/plex.js");
const { default: seerr } = await import("../src/routes/seerr.js");
const app = express();
app.use("/api/seerr", seerr);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

try {
  // A cache warmer or first viewer reaches an unavailable metadata provider.
  assert.equal((await buildMeta("123"))?.tmdbId, null);
  providerAvailable = true;
  assert.equal((await buildMeta("123"))?.tmdbId, 90521,
    "a later viewer must recover without waiting an hour or restarting the server");
  const calls = [libraryCalls, providerCalls];
  assert.equal((await buildMeta("123"))?.tmdbId, 90521);
  assert.deepEqual([libraryCalls, providerCalls], calls, "complete metadata remains cached");

  assert.equal((await fetch(`${base}/api/seerr/tv/90521`)).status, 502,
    "upstream failure must not masquerade as a successful empty season list");
  seerrStatus = 200;
  const recovered = await fetch(`${base}/api/seerr/tv/90521`);
  assert.equal(recovered.status, 200);
  const body = await recovered.json() as { seasons: Array<{ seasonNumber: number; requestable: boolean }> };
  assert.deepEqual(body.seasons.map((s) => s.seasonNumber), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(body.seasons.every((s) => s.requestable));

  seerrStatus = 401;
  loginStatus = 401;
  assert.equal((await fetch(`${base}/api/seerr/tv/90521`)).status, 502,
    "failed reauthentication must also be retryable");

  delete process.env.SEERR_URL;
  const disabled = await fetch(`${base}/api/seerr/tv/90521`);
  assert.equal(disabled.status, 200);
  assert.deepEqual(await disabled.json(), { configured: false, status: null, seasons: [] });
  console.log("missing seasons tests passed");
} finally {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}
