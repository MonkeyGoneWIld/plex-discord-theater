import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";
import discordRoutes, { closeInstanceDb } from "./routes/discord.js";
import plexRoutes from "./routes/plex.js";
import progressRoutes from "./routes/progress.js";
import seerrRoutes from "./routes/seerr.js";
import { requireAuth, closeSessionDb } from "./middleware/auth.js";
import * as thumbCache from "./services/thumb-cache.js";
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
        mediaSrc: ["'self'", ...(vpsRelayOrigin ? [vpsRelayOrigin] : [])],
        imgSrc: ["'self'"],
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

app.use(express.json({ limit: "10kb" }));

const isDev = process.env.NODE_ENV !== "production";

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 200 : 20,
  message: { error: "Too many authentication attempts" },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 5000 : 600,
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
  keyGenerator: (req) => req.ip || req.socket.remoteAddress || "unknown",
});

app.use("/api/token", authLimiter);
app.use("/api/register", authLimiter);
app.use("/api/plex/hls/seg", hlsLimiter);
app.use("/api/plex/hls/ping", hlsLimiter);
app.use("/api/plex/thumb", thumbLimiter);
// General API limiter — skip paths that have their own dedicated limiter
app.use("/api", (req, res, next) => {
  if (
    req.path.startsWith("/plex/hls/seg") ||
    req.path.startsWith("/plex/hls/ping") ||
    req.path.startsWith("/plex/thumb") ||
    req.path === "/token" ||
    req.path === "/register"
  ) {
    return next();
  }
  return apiLimiter(req, res, next);
});

app.use("/api", discordRoutes);
app.use("/api/plex", requireAuth, plexRoutes);
app.use("/api/progress", requireAuth, progressRoutes);
app.use("/api/seerr", requireAuth, seerrRoutes);

const clientDist = path.resolve(__dirname, "../../client/dist");
app.use(express.static(clientDist));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.sendFile(path.join(clientDist, "index.html"));
});

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

attachWebSocketServer(server);

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down gracefully`);
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
    process.exit(0);
  });
  // Fallback: force exit if server.close() hangs (e.g. lingering keep-alive connections)
  setTimeout(() => {
    console.warn("Shutdown timeout — forcing exit");
    process.exit(1);
  }, 15000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
