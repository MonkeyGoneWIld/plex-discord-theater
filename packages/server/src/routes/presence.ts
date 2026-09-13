import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../middleware/auth.js";
import {
  getPresenceArtwork,
  isPresenceRatingKey,
  publishPresenceArtwork,
} from "../services/presence-artwork.js";

const router = Router();

// No loopback/dev bypass: unauthenticated image traffic has its own ceiling,
// including misses. Discord's image proxies can share an IP across many users.
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
const publishLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

router.use("/artwork", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

/** POST /api/presence/artwork — only an authenticated numeric library item can
 * publish a poster. There is deliberately no caller-controlled URL or path. */
router.post("/artwork", publishLimiter, requireAuth, async (req, res) => {
  const ratingKey: unknown = req.body?.ratingKey;
  if (!isPresenceRatingKey(ratingKey)) {
    res.status(400).json({ error: "Invalid rating key" });
    return;
  }
  try {
    res.json({ url: await publishPresenceArtwork(ratingKey) });
  } catch {
    res.status(502).json({ url: null });
  }
});

/** GET /api/presence/artwork/:opaqueId — public capability lookup, never a Plex
 * proxy. Match missing/malformed ids too, so they cannot fall through to SPA. */
router.get(["/artwork", "/artwork/*"], publicLimiter, (req, res) => {
  const id = req.params[0] as string | undefined;
  try {
    const image = id ? getPresenceArtwork(id) : null;
    if (!image) {
      res.status(404).end();
      return;
    }
    const maxAge = Math.max(0, Math.min(3600, Math.floor((image.expiresAt - Date.now()) / 1000)));
    res.setHeader("Content-Type", image.contentType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Cache-Control", `public, max-age=${maxAge}`);
    res.send(image.data);
  } catch {
    res.status(404).end();
  }
});

export default router;
