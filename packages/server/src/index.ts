import "dotenv/config";
// Installs the console tee as a side effect of being imported, so every later
// line also lands in <data>/logs. Must stay above the imports below: ESM
// evaluates modules in import order, and auth.ts / watch-history.ts both log
// while initialising. Calling initLogger() further down would run after them.
import { closeLogger } from "./services/logger.js";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";
import discordRoutes, { closeInstanceDb } from "./routes/discord.js";
import plexRoutes from "./routes/plex.js";
import seerrRoutes from "./routes/seerr.js";
import ratingsRoutes from "./routes/ratings.js";
import historyRoutes from "./routes/history.js";
import plexAccountRoutes from "./routes/plex-account.js";
import logRoutes from "./routes/logs.js";
import { requireAuth, closeSessionDb } from "./middleware/auth.js";
import * as thumbCache from "./services/thumb-cache.js";
import { startCacheWarmer, stopCacheWarmer } from "./services/cache-warmer.js";
import { closeHistoryDb } from "./services/watch-history.js";
import { closePlexAccountsDb } from "./services/plex-accounts.js";
import { attachWebSocketServer, closeWebSocketServer } from "./services/sync.js";

const required = ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "PLEX_URL", "PLEX_TOKEN", "REDIRECT_URI"] as const;
for (const name of required) {
  if (!process.env[name]) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (!allowedOrigins || allowedOrigins.length === 0) {
  console.error("Missing required environment variable: ALLOWED_ORIGINS");
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1);
const PORT = parseInt(process.env.PORT || "3000", 10);

// VPS relay origin for CSP — allow browser to fetch segments from VPS
const vpsRelayOrigin = process.env.VPS_RELAY_URL?.replace(/\/$/, "");

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        // blob: — hls.js attaches its MediaSource via URL.createObjectURL, so
        // without it the <video> src is refused.
        mediaSrc: ["'self'", "blob:", ...(vpsRelayOrigin ? [vpsRelayOrigin] : [])],
        // data: — Vite inlines any asset under 4 KB, which is five of the six
        // ratings icons. Under 'self' alone they were blocked and rendered as
        // broken images, while the one file over the limit loaded fine.
        imgSrc: ["'self'", "data:"],
        // hls.js builds its transmuxer worker from a blob. Refused, it falls
        // back to demuxing on the main thread — silently, no error, just jank.
        workerSrc: ["'self'", "blob:"],
        connectSrc: ["'self'", "https://discord.com", "https://*.discord.com", "https://*.discordsays.com", "wss://*.discord.gg", "wss://*.discordsays.com", "wss:", "ws:", ...(vpsRelayOrigin ? [vpsRelayOrigin] : [])],
        // Discord embeds Activities in an iframe from *.discordsays.com —
        // frame-ancestors must allow it or the browser blocks the embed
        frameAncestors: ["'self'", "https://discord.com", "https://*.discord.com", "https://*.discordsays.com"],
      },
    },
    frameguard: false, // Allow Discord iframe embedding (X-Frame-Options superseded by frame-ancestors)
  }),
);

app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "DELETE"],
  }),
);

// Log batches are the one payload that legitimately exceeds the general 10kb
// ceiling — a couple of hundred player events with their fields attached. Runs
// first so body-parser marks the body as read and the global limit below skips
// it; every other route keeps the tighter cap.
app.use("/api/logs", express.json({ limit: "512kb" }));
app.use(express.json({ limit: "10kb" }));

const isDev = process.env.NODE_ENV !== "production";

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 200 : 20,
  message: { error: "Too many authentication attempts" },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Requests originating on this machine — the cache warmer, which calls our own
 * routes over loopback. A full pass is 600 requests against a 600-request
 * budget, so without this it rate-limits itself out halfway through.
 *
 * Deliberately reads `req.socket.remoteAddress` and NOT `req.ip`. With
 * `trust proxy` set, `req.ip` is derived from the X-Forwarded-For *header*, so
 * an exposed deployment could be handed `X-Forwarded-For: 127.0.0.1` and skip
 * the rate limiter entirely. The socket's peer address is the kernel's answer
 * and cannot be set by a client.
 */
function isLoopback(req: { socket: { remoteAddress?: string | null } }): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 5000 : 600,
  skip: isLoopback,
  standardHeaders: true,
  legacyHeaders: false,
});

// Thumbnails get their own high ceiling — a single 200-item library page
// fires ~200 poster requests, so counting them against the general API
// limiter locked users out of every /api endpoint mid-browse.
const thumbLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 50000 : 5000,
  standardHeaders: true,
  legacyHeaders: false,
});

const hlsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 50000 : 3000,
  standardHeaders: true,
  legacyHeaders: false,
  // No keyGenerator: the library's default already does exactly this, and a
  // custom one trips its IPv6 validation warning (ERR_ERL_KEY_GEN_IPV6).
});

// Diagnostics ship on a timer from every connected client, so they'd eat most
// of the general budget on their own. Own ceiling, sized for a full room.
const logLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 20000 : 4000,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api/token", authLimiter);
app.use("/api/register", authLimiter);
app.use("/api/plex/hls/seg", hlsLimiter);
app.use("/api/plex/hls/ping", hlsLimiter);
app.use("/api/plex/thumb", thumbLimiter);
app.use("/api/logs", logLimiter);
// General API limiter — skip paths that have their own dedicated limiter
app.use("/api", (req, res, next) => {
  if (
    req.path.startsWith("/plex/hls/seg") ||
    req.path.startsWith("/plex/hls/ping") ||
    req.path.startsWith("/plex/thumb") ||
    req.path.startsWith("/logs") ||
    req.path === "/token" ||
    req.path === "/register"
  ) {
    return next();
  }
  return apiLimiter(req, res, next);
});

/**
 * GET /api/health
 *
 * Reports whether the thing this server exists to proxy is actually reachable.
 * The container HEALTHCHECK used to hit `/`, which express.static answers from
 * disk without involving Plex at all — so the container stayed green through a
 * total Plex outage and the status meant nothing.
 *
 * Unauthenticated on purpose (Docker's health probe has no session) but it
 * reveals nothing beyond up/down, and the result is cached so a probe every 30s
 * can't turn into a Plex request every 30s per prober.
 */
let healthAt = 0;
let healthOk = false;
const HEALTH_TTL_MS = 20_000;

app.get("/api/health", async (_req, res) => {
  const now = Date.now();
  if (now - healthAt > HEALTH_TTL_MS) {
    try {
      const { plexFetch } = await import("./services/plex.js");
      const probe = await plexFetch("/identity");
      probe.body?.cancel().catch(() => {});
      healthOk = probe.ok;
    } catch {
      healthOk = false;
    }
    healthAt = now;
  }
  res.status(healthOk ? 200 : 503).json({
    status: healthOk ? "ok" : "degraded",
    plex: healthOk ? "reachable" : "unreachable",
    uptimeS: Math.round(process.uptime()),
  });
});

app.use("/api", discordRoutes);
app.use("/api/plex", requireAuth, plexRoutes);
app.use("/api/seerr", requireAuth, seerrRoutes);
app.use("/api/ratings", requireAuth, ratingsRoutes);
app.use("/api/history", requireAuth, historyRoutes);
app.use("/api/plex-account", requireAuth, plexAccountRoutes);
app.use("/api/logs", requireAuth, logRoutes);

const clientDist = path.resolve(__dirname, "../../client/dist");
app.use(express.static(clientDist));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.sendFile(path.join(clientDist, "index.html"));
});

/**
 * Say which optional integrations are actually on.
 *
 * Every one of these fails *silently* when unconfigured — no ratings row, no
 * collection or recommendation rows, no request button, Discover detail 401s —
 * and each one has been mistaken for a bug at some point. One line at startup
 * turns "why is this row empty" into something you can answer by reading the
 * log you already have.
 */
function reportIntegrations(): void {
  const on = (name: string, enabled: boolean, note = "") =>
    `${enabled ? "✓" : "·"} ${name}${enabled || !note ? "" : ` (${note})`}`;
  console.log(
    "[Config]",
    [
      on("TMDB", !!process.env.TMDB_API_KEY, "no collections / recommendations / person pages"),
      on("TVDB", !!process.env.TVDB_API_KEY?.trim(), "missing-episode lists fall back to TMDB numbering"),
      on("Ratings", !!process.env.MDBLIST_API_KEY?.trim(), "ratings row hidden"),
      on("Requests", !!process.env.SEERR_URL, "Seerr request flow off"),
      on("Discover", !!process.env.PLEX_ACCOUNT_TOKEN, "online search detail may 401"),
      on("VPS relay", !!(process.env.VPS_RELAY_URL && process.env.VPS_RELAY_KEY), "P2P mode"),
      on("Guild allowlist", allowedGuildCount > 0, "open to any Discord server"),
    ].join("   "),
  );
}

const allowedGuildCount = (process.env.ALLOWED_GUILD_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean).length;

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  reportIntegrations();
  // Pre-fill the detail-page caches (metadata, cast, collections, related) in
  // the background so opening a title doesn't wait on Plex and TMDB. Started
  // from the listen callback because it calls back into our own HTTP port.
  startCacheWarmer(Number(PORT));
});

attachWebSocketServer(server);

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down gracefully`);
  stopCacheWarmer();
  const { stopAllActiveSessions } = await import("./routes/plex.js");
  await Promise.race([
    stopAllActiveSessions(),
    new Promise<void>((resolve) => setTimeout(resolve, 8000)),
  ]);
  // Close WebSocket connections first — server.close() won't complete while
  // WS connections are alive (they hold the underlying HTTP upgrade sockets open)
  closeWebSocketServer();
  server.close(() => {
    thumbCache.close();
    closeSessionDb();
    closeInstanceDb();
    closeHistoryDb();
    closePlexAccountsDb();
    closeLogger(); // last — everything above may still log on the way out
    process.exit(0);
  });
  // Fallback: force exit if server.close() hangs (e.g. lingering keep-alive connections)
  setTimeout(() => {
    console.warn("Shutdown timeout — forcing exit");
    closeLogger();
    process.exit(1);
  }, 15000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
