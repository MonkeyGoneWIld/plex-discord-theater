import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express, { type Request, type Response } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { AdminSessions, cookieToken, passwordMatches, requireAdmin, sessionCookie, SESSION_MS } from "./auth.js";
import { logFiles, overview, readLog, settingsView } from "./data.js";
import { MAX_GRAPH_DAYS, Recorder } from "./recorder.js";
import { EXPORTS, exportFile, exportName, type ExportKind } from "./export.js";
import { okRatingKey, plexTitles, type TitleSource } from "./titles.js";
import { cachesView } from "./caches.js";
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
  /** Posters and running times; Plex's, unless the tests give their own. */
  titles?: TitleSource;
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
      logEvent("Admin", "dashboard sign-in failed: wrong password", { from: req.ip ?? "unknown" });
      res.status(401).json({ error: "Wrong password" });
      return;
    }
    const token = sessions.create();
    res.setHeader("Set-Cookie", sessionCookie(req, token));
    logEvent("Admin", "dashboard sign-in", { from: req.ip ?? "unknown" });
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

  // What the page shows of titles beside their names: ?keys=1,2,3, up to 60.
  const titles = opts.titles ?? plexTitles();
  app.get("/api/titles", admin, async (req: Request, res: Response) => {
    const keys = [...new Set(String(req.query.keys ?? "").split(",").filter(okRatingKey))].slice(0, 60);
    const found = await Promise.all(keys.map((k) => titles.info(k).catch(() => null)));
    res.json({ titles: Object.fromEntries(keys.map((k, i) => [k, found[i]])) });
  });
  // A title's poster, as Plex has it, kept by the browser for a day.
  app.get("/api/poster/:ratingKey", admin, async (req: Request, res: Response) => {
    const key = String(req.params.ratingKey);
    const poster = okRatingKey(key) ? await titles.poster(key).catch(() => null) : null;
    if (!poster) {
      res.status(404).json({ error: "No poster" });
      return;
    }
    res.setHeader("Content-Type", poster.type);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(poster.body);
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
    res.json({ requests: recorder!.requests({ limit: req.query.limit, before: req.query.before, q: req.query.q }) });
  });
  app.get("/api/people", admin, recorded, (req: Request, res: Response) => {
    res.json({ people: recorder!.people({ q: req.query.q, limit: req.query.limit, offset: req.query.offset }) });
  });
  app.get("/api/people/:id", admin, recorded, (req: Request, res: Response) => {
    const id = String(req.params.id);
    const person = /^\d{1,25}$/.test(id) ? recorder!.person(id) : null;
    if (!person) {
      res.status(404).json({ error: "Nobody by that ID" });
      return;
    }
    res.json(person);
  });
  app.get("/api/places", admin, recorded, (_req: Request, res: Response) => {
    res.json({ guilds: recorder!.places() });
  });
  // Graphs: the history by day, over the last ?days= days (0: all of it).
  app.get("/api/graphs", admin, recorded, (req: Request, res: Response) => {
    res.json(recorder!.graphs({ days: req.query.days }));
  });
  // The history file, and what removing what is older than ?days= days would remove.
  const trimDays = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= MAX_GRAPH_DAYS ? n : null;
  };
  app.get("/api/history-file", admin, recorded, (req: Request, res: Response) => {
    const days = trimDays(req.query.days);
    res.json({ summary: recorder!.summary(), trim: days ? recorder!.trimPreview(Date.now() - days * 86_400_000) : null });
  });
  // Removes it, and can't be undone: only when the page asks, with how many days to keep.
  app.post("/api/history-file/trim", admin, recorded, (req: Request, res: Response) => {
    const days = trimDays((req.body as { days?: unknown } | undefined)?.days);
    if (!days) {
      res.status(400).json({ error: `Say how many days to keep: 1 to ${MAX_GRAPH_DAYS}` });
      return;
    }
    const removed = recorder!.trim(Date.now() - days * 86_400_000);
    console.log(`[Admin] History older than ${days} days removed: ${removed.plays} plays, ${removed.events} lines, `
      + `${removed.usage} launches and joins, ${removed.requests} requests, ${removed.people} people; `
      + `${removed.bytesBefore} → ${removed.bytesAfter} bytes`);
    res.json(removed);
  });
  // The lists as files: history, people, usage or requests, .csv or .json,
  // honouring ?q=; and the whole history as admin.sqlite.
  app.get("/api/export/:file", admin, recorded, (req: Request, res: Response) => {
    const file = String(req.params.file);
    if (file === "admin.sqlite") {
      res.setHeader("Content-Type", "application/vnd.sqlite3");
      res.setHeader("Content-Disposition", `attachment; filename="${exportName("admin", "sqlite")}"`);
      res.send(recorder!.snapshot());
      return;
    }
    const m = /^([a-z]+)\.(csv|json)$/.exec(file);
    if (!m || !(EXPORTS as readonly string[]).includes(m[1])) {
      res.status(404).json({ error: "No such export" });
      return;
    }
    const format = m[2] as "csv" | "json";
    res.setHeader("Content-Type", format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${exportName(m[1], format)}"`);
    res.send(exportFile(recorder!, m[1] as ExportKind, format, req.query.q));
  });
  // What each cache holds. Without the history, titles are named only where
  // the details cache knows them, and Discord's cache isn't known.
  app.get("/api/caches", admin, async (_req: Request, res: Response) => {
    try {
      res.json(await cachesView(recorder));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
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
        "The dashboard has not been built. Run: npm run build -w packages/client\n",
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
    logEvent("Admin", "dashboard off: set ADMIN_PASSWORD to turn it on");
    return null;
  }
  const port = numberSetting("ADMIN_PORT", 3050, 1);
  const host = process.env.ADMIN_HOST?.trim() || "0.0.0.0";
  if (port === mainPort) {
    logEvent("Admin", "dashboard off: ADMIN_PORT is the Activity's own port; give it one of its own", { port });
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
    logEvent("Admin", "the dashboard's history couldn't be opened; it shows only what is live", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const stopRecording = () => {
    setAdminHooks(null);
    recorder?.close();
  };
  const server = http.createServer(createAdminApp({ password, recorder: recorder ?? undefined }));
  server.on("error", (err: NodeJS.ErrnoException) => {
    logEvent("Admin", "dashboard couldn't start; the server goes on without it", { port, host, error: err.code ?? err.message });
    if (!server.listening) stopRecording();
  });
  server.listen(port, host, () => {
    logEvent("Admin", "dashboard listening", { url: `http://${host === "0.0.0.0" ? "localhost" : host}:${port}` });
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
