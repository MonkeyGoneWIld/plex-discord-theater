/**
 * Watch history API. Every route is scoped to the caller's own Discord identity —
 * the user id comes from their session, never from the request, so one user can
 * neither read nor delete another's history.
 *
 * Writes happen server-side from the sync heartbeat (see services/sync.ts); there
 * is deliberately no endpoint for a client to post arbitrary progress.
 */

import { Router, type Request, type Response } from "express";
import { getSessionUserId } from "../middleware/auth.js";
import {
  getContinueWatching,
  getHistory,
  getProgress,
  deleteHistoryEntry,
  dismissFromContinueWatching,
  clearHistory,
} from "../services/watch-history.js";

const router = Router();

const RATING_KEY_RE = /^\d+$/;

/**
 * The verified Discord user id behind this request, or null when the session
 * was created without one (possible when Discord's /users/@me lookup failed
 * during token exchange — see routes/discord.ts).
 */
function requestUserId(req: Request): string | null {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ")
    ? header.slice(7)
    : typeof req.query.token === "string"
      ? req.query.token
      : undefined;
  if (!token) return null;
  return getSessionUserId(token);
}

/** Resolve the caller's id, or send 403 and return null. */
function requireUserId(req: Request, res: Response): string | null {
  const userId = requestUserId(req);
  if (!userId) {
    res.status(403).json({ error: "Session has no verified identity" });
    return null;
  }
  return userId;
}

function parseLimit(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === "string" ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

/**
 * GET /api/history/continue?limit=20
 * In-progress items for the caller, most recently watched first.
 */
router.get("/continue", (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const limit = parseLimit(req.query.limit, 20, 50);
  res.json({ items: getContinueWatching(userId, limit) });
});

/**
 * DELETE /api/history/continue/:ratingKey
 * Drop one item from Continue Watching, keeping its history entry and position.
 * Contrast with DELETE /entry/:ratingKey, which forgets the item outright.
 */
router.delete("/continue/:ratingKey", (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const ratingKey = req.params.ratingKey as string;
  if (!RATING_KEY_RE.test(ratingKey)) {
    res.status(400).json({ error: "Invalid rating key" });
    return;
  }
  dismissFromContinueWatching(userId, ratingKey);
  res.json({ ok: true });
});

/**
 * GET /api/history/progress/:ratingKey
 * Saved progress for one item, or null if the caller has never played it.
 */
router.get("/progress/:ratingKey", (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const ratingKey = req.params.ratingKey as string;
  if (!RATING_KEY_RE.test(ratingKey)) {
    res.status(400).json({ error: "Invalid rating key" });
    return;
  }
  res.json({ progress: getProgress(userId, ratingKey) });
});

/**
 * DELETE /api/history/entry/:ratingKey
 * Forget one item. Nested under /entry so it can't collide with /continue.
 */
router.delete("/entry/:ratingKey", (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const ratingKey = req.params.ratingKey as string;
  if (!RATING_KEY_RE.test(ratingKey)) {
    res.status(400).json({ error: "Invalid rating key" });
    return;
  }
  deleteHistoryEntry(userId, ratingKey);
  res.json({ ok: true });
});

/**
 * GET /api/history?limit=100&offset=0
 * Full history for the caller, most recent first.
 */
router.get("/", (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const limit = parseLimit(req.query.limit, 100, 200);
  const rawOffset = typeof req.query.offset === "string" ? parseInt(req.query.offset, 10) : 0;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  res.json(getHistory(userId, limit, offset));
});

/**
 * DELETE /api/history
 * Clear the caller's history entirely.
 */
router.delete("/", (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  clearHistory(userId);
  res.json({ ok: true });
});

export default router;
