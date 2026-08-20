/** Account-link endpoints, always scoped to the authenticated Discord user. */
import { Router, type Request, type Response } from "express";
import { getSessionUserId } from "../middleware/auth.js";
import {
  getPlexWatchlist,
  getPlexWatchlistState,
  getPlexAccountStatus,
  pollPlexAccountLink,
  setPlexItemWatched,
  setPlexWatchlistState,
  startPlexAccountLink,
  syncPlexAccount,
  unlinkPlexAccount,
} from "../services/plex-accounts.js";

const router = Router();

function requireUserId(req: Request, res: Response): string | null {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ")
    ? header.slice(7)
    : typeof req.query.token === "string"
      ? req.query.token
      : undefined;
  const userId = token ? getSessionUserId(token) : null;
  if (!userId) {
    res.status(403).json({ error: "Session has no verified Discord identity" });
    return null;
  }
  return userId;
}

router.get("/status", (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  res.json(getPlexAccountStatus(userId));
});

router.post("/link", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    res.json(await startPlexAccountLink(userId));
  } catch (err) {
    console.error("[Plex Account] Failed to start link:", err);
    res.status(502).json({ error: err instanceof Error ? err.message : "Could not start Plex sign-in" });
  }
});

router.get("/link", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const status = await pollPlexAccountLink(userId);
    res.json(status);
  } catch (err) {
    console.error("[Plex Account] Link poll failed for", userId.substring(0, 8), err);
    res.status(502).json({ error: err instanceof Error ? err.message : "Could not finish Plex sign-in" });
  }
});

router.post("/sync", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const result = await syncPlexAccount(userId);
    res.json({ ...result, status: getPlexAccountStatus(userId) });
  } catch (err) {
    console.error("[Plex Account] Sync failed for", userId.substring(0, 8), err);
    res.status(502).json({ error: err instanceof Error ? err.message : "Plex history sync failed" });
  }
});

router.get("/watchlist", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    res.json({ items: await getPlexWatchlist(userId) });
  } catch (err) {
    console.error("[Plex Account] Watchlist failed for", userId.substring(0, 8), err);
    res.status(502).json({ error: err instanceof Error ? err.message : "Could not load Plex Watchlist" });
  }
});

router.get("/watchlist/:ratingKey", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const ratingKey = req.params.ratingKey as string;
  if (!/^\d+$/.test(ratingKey)) {
    res.status(400).json({ error: "Invalid rating key" });
    return;
  }
  try {
    res.json({ watchlisted: await getPlexWatchlistState(userId, ratingKey) });
  } catch (err) {
    console.error("[Plex Account] Watchlist state failed for", userId.substring(0, 8), err);
    res.status(502).json({ error: err instanceof Error ? err.message : "Could not read Plex Watchlist state" });
  }
});

router.put("/watchlist", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const ratingKey = typeof req.body?.ratingKey === "string" ? req.body.ratingKey : undefined;
  const guid = typeof req.body?.guid === "string" ? req.body.guid : undefined;
  if (typeof req.body?.watchlisted !== "boolean" || (!ratingKey && !guid)) {
    res.status(400).json({ error: "A Plex title and watchlist state are required" });
    return;
  }
  try {
    await setPlexWatchlistState(userId, { ratingKey, guid }, req.body.watchlisted);
    res.json({ watchlisted: req.body.watchlisted });
  } catch (err) {
    console.error("[Plex Account] Watchlist update failed for", userId.substring(0, 8), err);
    res.status(502).json({ error: err instanceof Error ? err.message : "Could not update Plex Watchlist" });
  }
});

router.put("/watched/:ratingKey", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const ratingKey = req.params.ratingKey as string;
  if (!/^\d+$/.test(ratingKey) || typeof req.body?.watched !== "boolean") {
    res.status(400).json({ error: "A valid rating key and watched state are required" });
    return;
  }
  try {
    const progress = await setPlexItemWatched(userId, ratingKey, req.body.watched);
    res.json({ watched: req.body.watched, progress });
  } catch (err) {
    console.error("[Plex Account] Watched update failed for", userId.substring(0, 8), err);
    res.status(502).json({ error: err instanceof Error ? err.message : "Could not update watched state" });
  }
});

router.delete("/link", (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  unlinkPlexAccount(userId);
  res.json({ ok: true });
});

export default router;
