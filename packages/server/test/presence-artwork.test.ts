import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

// Real auth and HTTP routes; only Plex is a local fixture. Public image requests
// must not become an unauthenticated route into the library or photo proxy.
const directory = mkdtempSync(path.join(tmpdir(), "presence-artwork-"));
process.env.THUMB_CACHE_DIR = directory;
process.env.REDIRECT_URI = "https://theater.example";
process.env.PLEX_TOKEN = "private-plex-token";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1sAAAAASUVORK5CYII=", "base64");
const upstream: URL[] = [];
const plex = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://plex");
  upstream.push(url);
  if (url.pathname.startsWith("/library/metadata/")) {
    const id = url.pathname.split("/")[3];
    const item = id === "2"
      ? { ratingKey: id, type: "episode", thumb: "/library/metadata/2/thumb/1", grandparentThumb: "/library/metadata/3/thumb/1", grandparentRatingKey: "3" }
      : { ratingKey: id, type: id === "3" ? "show" : "movie", thumb: `/library/metadata/${id}/thumb/1` };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ MediaContainer: { Metadata: [item] } }));
    return;
  }
  if (url.pathname === "/photo/:/transcode") {
    const image = url.searchParams.get("url") ?? "";
    if (image.includes("/4/thumb")) {
      res.setHeader("Content-Type", "image/svg+xml");
      res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    } else if (image.includes("/5/thumb")) {
      res.setHeader("Content-Type", "image/png");
      const oversized = Buffer.alloc(6 * 1024 * 1024);
      png.copy(oversized);
      res.end(oversized);
    } else {
      res.setHeader("Content-Type", "image/png");
      res.end(png);
    }
    return;
  }
  res.writeHead(404).end();
});
plex.listen(0, "127.0.0.1");
await once(plex, "listening");
process.env.PLEX_URL = `http://127.0.0.1:${(plex.address() as AddressInfo).port}`;
// These modules capture environment configuration and open SQLite on import;
// load only after the isolated directory and ephemeral Plex port are ready.
const { default: routes } = await import("../src/routes/presence.js");
const { createSession, closeSessionDb } = await import("../src/middleware/auth.js");
const thumbs = await import("../src/services/thumb-cache.js");
const app = express();
app.use(express.json());
app.use("/api/presence", routes);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const token = createSession("viewer");
const publish = (ratingKey: string, authenticated = true) => fetch(`${origin}/api/presence/artwork`, {
  method: "POST", headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ ratingKey }),
});
try {
  assert.equal((await publish("1", false)).status, 401);
  assert.equal(upstream.length, 0, "unauthenticated publication never reaches Plex");
  assert.equal((await publish("../../identity")).status, 400);
  assert.equal(upstream.length, 0, "rating keys cannot inject paths");
  for (const ratingKey of ["1", "2", "3"]) {
    const result = await publish(ratingKey);
    assert.equal(result.status, 200);
    const { url } = await result.json() as { url: string };
    assert.equal(new URL(url).origin, "https://theater.example");
    assert.ok(!url.includes(token) && !url.includes(process.env.PLEX_TOKEN!));
    assert.equal(new URL(url).search, "");
    const count = upstream.length;
    const image = await fetch(`${origin}${new URL(url).pathname}`);
    assert.equal(image.status, 200, "artwork is fetchable without authentication");
    assert.equal(image.headers.get("content-type")?.split(";")[0], "image/png");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    assert.equal(upstream.length, count, "public GET only reads cached bytes");
  }
  const images = upstream.filter((url) => url.pathname === "/photo/:/transcode").map((url) => url.searchParams.get("url")!);
  assert.ok(images.some((url) => url.includes("/3/thumb")), "episode publishes its show's poster");
  assert.ok(!images.some((url) => url.includes("/2/thumb")), "episode still is not the show poster");
  const count = upstream.length;
  assert.equal((await fetch(`${origin}/api/presence/artwork/${"0".repeat(48)}?url=http://private/identity`)).status, 404);
  assert.equal(upstream.length, count, "unknown public IDs cannot fetch remote URLs");
  for (const id of ["4", "5"]) {
    const response = await publish(id);
    const body = await response.json() as { url?: string | null };
    assert.ok(!body.url, "active or oversized content must not become public artwork");
  }
  console.log("Presence artwork: auth, movie/show posters, credential-free public reads, cache-only access, SVG and size rejection passed");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  plex.closeAllConnections();
  await new Promise<void>((resolve) => plex.close(() => resolve()));
  closeSessionDb();
  thumbs.close();
  rmSync(directory, { recursive: true, force: true });
}
