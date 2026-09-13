import { Router } from "express";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import rateLimit from "express-rate-limit";
import { plexJSON } from "../services/plex.js";
import { getQbtManagerStreams } from "../services/sync.js";

const router = Router();
const instanceId = randomUUID();
let sequence = 0;
let identity: string | null = null;
let identityRequest: Promise<string> | null = null;

export function validIntegrationKey(header: string | undefined, key: string | undefined): boolean {
  if (!key || !header?.startsWith("Bearer ")) return false;
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(header.slice(7)), hash(key));
}

async function serverIdentity(): Promise<string> {
  if (identity) return identity;
  if (!identityRequest) {
    identityRequest = plexJSON<{ MediaContainer?: { machineIdentifier?: string } }>("/")
      .then((value) => {
        const id = value.MediaContainer?.machineIdentifier;
        if (!id) throw new Error("Plex server identity unavailable");
        identity = id;
        return id;
      }).finally(() => { identityRequest = null; });
  }
  return identityRequest;
}

router.use(rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));
router.get("/state", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const key = process.env.QBT_MANAGER_API_KEY;
  if (!key) { res.status(503).json({ error: "Integration disabled" }); return; }
  if (!validIntegrationKey(req.headers.authorization, key)) {
    res.status(401).json({ error: "Unauthorized" }); return;
  }
  try {
    const plexServerId = await serverIdentity();
    const streams = getQbtManagerStreams();
    res.json({ schema_version: 1, instance_id: instanceId, sequence: ++sequence,
      plex_server_id: plexServerId,
      delivery_mode: process.env.VPS_RELAY_URL ? "vps_relay" : "direct_p2p", streams });
  } catch {
    console.warn("[QbtIntegration] Plex identity unavailable; snapshot withheld");
    res.status(503).json({ error: "Plex identity unavailable" });
  }
});

export default router;
