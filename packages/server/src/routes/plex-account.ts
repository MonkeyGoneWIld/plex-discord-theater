/** Account-link endpoints, always scoped to the authenticated Discord user. */
import { Router, type Request, type Response } from "express";
import { getSessionUserId } from "../middleware/auth.js";
import {
  getPlexAccountStatus,
  pollPlexAccountLink,
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

router.delete("/link", (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  unlinkPlexAccount(userId);
  res.json({ ok: true });
});

export default router;
