import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express, { type Request, type Response } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { AdminSessions, cookieToken, passwordMatches, requireAdmin, sessionCookie, SESSION_MS } from "./auth.js";
import { logFiles, overview, readLog, settingsView } from "./data.js";
import { Recorder } from "./recorder.js";
import { numberSetting } from "../services/env-settings.js";
import { logEvent } from "../services/logger.js";
import { setAdminHooks } from "../services/admin-hooks.js";

const here = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);

/** The admin page, built by `npm run build -w packages/client` (vite.admin.config.ts). */
export const ADMIN_DIST = path.resolve(here, "../../../client/dist-admin");

/** How often the live feed sends the rooms. */
export const LIVE_EVERY_MS = 2_000;

export interface AdminOptions {
  password: string;
  distDir?: string;
  now?: () => number;
  /** Login attempts allowed per address in 15 minutes. */
  loginsPer15Min?: number;
  liveEveryMs?: number;
  /** The history (admin.sqlite); without one, the page shows only what is live. */
  recorder?: Recorder;
}

/**
 * The admin page and its API: its own Express app, on its own port
 * (ADMIN_PORT), so nothing of it is ever reachable through the Activity's
 * port or Discord's proxy. Everything but signing in needs the session
 * cookie a right ADMIN_PASSWORD gets.
 */
export function createAdminApp(opts: AdminOptions): express.Express {
  const now = opts.now ?? Date.now;
  const sessions = new AdminSessions(now);
  const distDir = opts.distDir ?? ADMIN_DIST;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    // Over plain HTTP on the LAN: no HSTS, no upgrading requests.
    strictTransportSecurity: false,
  }));
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "4kb" }));

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: opts.loginsPer15Min ?? 10,
    message: { error: "Too many sign-in attempts; try again in 15 minutes" },
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.post("/api/login", loginLimiter, (req: Request, res: Response) => {
    const given = (req.body as { password?: unknown } | undefined)?.password;
    if (!passwordMatches(given, opts.password)) {
      logEvent("Admin", "a wrong password at the admin page's sign-in", { from: req.ip ?? "unknown" });
      res.status(401).json({ error: "Wrong password" });
      return;
    }
    const token = sessions.create();
    res.setHeader("Set-Cookie", sessionCookie(req, token));
    logEvent("Admin", "signed in to the admin page", { from: req.ip ?? "unknown" });
    res.json({ ok: true, expiresInS: Math.floor(SESSION_MS / 1000) });
  });

  app.post("/api/logout", (req: Request, res: Response) => {
    sessions.revoke(cookieToken(req));
    res.setHeader("Set-Cookie", sessionCookie(req, null));
    res.json({ ok: true });
  });

  app.get("/api/session", (req: Request, res: Response) => {
    res.json({ signedIn: sessions.valid(cookieToken(req)) });
  });

  const admin = requireAdmin(sessions);
  const recorder = opts.recorder ?? null;
  const live = () => {
    const ov = overview(now());
    return recorder ? recorder.annotate(ov) : ov;
  };

  app.get("/api/overview", admin, (_req, res) => {
    res.json(live());
  });

  // Server-sent events: the rooms every LIVE_EVERY_MS, for as long as the
  // page is open and its session lasts.
  app.get("/api/live", admin, (req: Request, res: Response) => {
    const token = cookieToken(req);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");
    const send = () => {
      if (!sessions.valid(token)) {
        res.write("event: signed-out\ndata: {}\n\n");
        res.end();
        return;
      }
      try {
        res.write(`data: ${JSON.stringify(live())}\n\n`);
      } catch (err) {
        res.write(`event: problem\ndata: ${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n\n`);
      }
    };
    send();
    const timer = setInterval(send, opts.liveEveryMs ?? LIVE_EVERY_MS);
    timer.unref();
    const stop = () => clearInterval(timer);
    req.on("close", stop);
    res.on("close", stop);
  });

  app.get("/api/logs/files", admin, (_req, res) => {
    res.json({ files: logFiles() });
  });

  app.get("/api/logs", admin, async (req: Request, res: Response) => {
    const q = req.query;
    const files = logFiles();
    const name = typeof q.file === "string" && q.file ? q.file : files[0]?.name;
    if (!name) {
      res.json({ file: null, lines: [], scanned: 0, matched: 0 });
      return;
    }
    const level = q.level === "warn" || q.level === "error" ? q.level : undefined;
    const limit = typeof q.limit === "string" ? Number(q.limit) || undefined : undefined;
    const result = await readLog(name, {
      q: typeof q.q === "string" ? q.q.slice(0, 200) : undefined,
      tag: typeof q.tag === "string" ? q.tag.slice(0, 60) : undefined,
      level,
      limit,
    });
    if (!result) {
      res.status(404).json({ error: "No such log file" });
      return;
    }
    res.json({ file: name, ...result });
  });

  app.get("/api/settings", admin, (_req, res) => {
    res.json(settingsView(now()));
  });

  // The history. Lists are newest first, a page at a time: ?limit=, and
  // ?before=<the last id shown> for the next.
  const recorded = (req: Request, res: Response, next: () => void) => {
    if (recorder) next();
    else res.status(503).json({ error: "Nothing is recorded" });
  };
  app.get("/api/history", admin, recorded, (req: Request, res: Response) => {
    res.json({ plays: recorder!.history({ limit: req.query.limit, before: req.query.before, q: req.query.q }) });
  });
  app.get("/api/history/:id", admin, recorded, (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const play = Number.isInteger(id) && id > 0 ? recorder!.play(id) : null;
    if (!play) {
      res.status(404).json({ error: "No such play" });
      return;
    }
    res.json(play);
  });
  app.get("/api/usage", admin, recorded, (req: Request, res: Response) => {
    res.json({ usage: recorder!.usage({ limit: req.query.limit, before: req.query.before }) });
  });
  app.get("/api/requests", admin, recorded, (req: Request, res: Response) => {
    res.json({ requests: recorder!.requests({ limit: req.query.limit, before: req.query.before }) });
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // The page itself. Its files need no sign-in — they hold nothing — and the
  // page asks /api/session before it shows anything.
  if (fs.existsSync(path.join(distDir, "index.html"))) {
    app.use(express.static(distDir, { index: false, maxAge: "1h" }));
    app.get("*", (_req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(path.join(distDir, "index.html"));
    });
  } else {
    app.get("*", (_req, res) => {
      res.status(503).type("text/plain").send(
        "The admin page isn't built. Run: npm run build -w packages/client\n",
      );
    });
  }
  return app;
}

export interface AdminHandle {
  server: http.Server;
  recorder: Recorder | null;
  /** Stop serving, and end every play still open in the history. */
  close(): void;
}

/** admin.sqlite, beside the bot's other databases. */
export function adminDbPath(): string {
  const dir = process.env.THUMB_CACHE_DIR
    ? path.resolve(process.env.THUMB_CACHE_DIR)
    : path.resolve(here, "../../data");
  return path.join(dir, "admin.sqlite");
}

/**
 * Start the admin page on ADMIN_PORT (3050), if ADMIN_PASSWORD is set, and
 * its recorder. Off otherwise, and nothing is recorded. A port that can't be
 * had is said in the log, and the bot goes on without it.
 */
export function startAdminServer(mainPort: number): AdminHandle | null {
  const password = process.env.ADMIN_PASSWORD ?? "";
  if (!password.trim()) {
    logEvent("Admin", "admin page off: set ADMIN_PASSWORD to turn it on");
    return null;
  }
  const port = numberSetting("ADMIN_PORT", 3050, 1);
  const host = process.env.ADMIN_HOST?.trim() || "0.0.0.0";
  if (port === mainPort) {
    logEvent("Admin", "admin page off: ADMIN_PORT is the Activity's own port; give it one of its own", { port });
    return null;
  }
  if (password.length < 12) {
    logEvent("Admin", "ADMIN_PASSWORD is short; one of 12 characters or more is far harder to guess", { length: password.length });
  }
  let recorder: Recorder | null = null;
  try {
    recorder = new Recorder({ dbPath: adminDbPath() });
    setAdminHooks(recorder);
    recorder.start();
  } catch (err) {
    // The live pages work without it.
    recorder = null;
    logEvent("Admin", "the admin page's history couldn't be opened; it shows only what is live", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const stopRecording = () => {
    setAdminHooks(null);
    recorder?.close();
  };
  const server = http.createServer(createAdminApp({ password, recorder: recorder ?? undefined }));
  server.on("error", (err: NodeJS.ErrnoException) => {
    logEvent("Admin", "admin page couldn't start; the bot goes on without it", { port, host, error: err.code ?? err.message });
    if (!server.listening) stopRecording();
  });
  server.listen(port, host, () => {
    logEvent("Admin", "admin page listening", { url: `http://${host === "0.0.0.0" ? "localhost" : host}:${port}` });
  });
  return {
    server,
    recorder,
    close() {
      server.close();
      server.closeAllConnections();
      stopRecording();
    },
  };
}
