import { Router, type Request, type Response } from "express";
import { writeClientLine } from "../services/logger.js";

const router = Router();

const MAX_ENTRIES_PER_BATCH = 200;
const MAX_MESSAGE_CHARS = 2000;

interface ClientLogEntry {
  t?: number;
  level?: string;
  tag?: string;
  msg?: string;
  data?: unknown;
}

function renderData(data: unknown): string {
  if (data === undefined || data === null) return "";
  if (typeof data !== "object") return ` ${String(data)}`;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    const rendered =
      typeof value === "number" && !Number.isInteger(value)
        ? value.toFixed(2)
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
    parts.push(`${key}=${rendered}`);
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

/**
 * POST /api/logs/client
 *
 * Browsers ship their player events here so they land in the same file as the
 * server's. Without this the log only ever shows the *effect* — a DELETE, a new
 * manifest at a surprising offset — and never the decision that caused it.
 *
 * Deliberately permissive about entry shape: this is diagnostics, and a
 * malformed batch that gets partially written is more useful than a 400.
 */
router.post("/client", (req: Request, res: Response) => {
  const body = req.body as { clientId?: string; entries?: ClientLogEntry[] };
  const entries = Array.isArray(body?.entries) ? body.entries.slice(0, MAX_ENTRIES_PER_BATCH) : [];
  if (entries.length === 0) {
    res.json({ ok: true, written: 0 });
    return;
  }

  const clientId = String(body.clientId ?? "unknown").slice(0, 16);
  const ip = req.ip ?? "?";

  for (const entry of entries) {
    const when = Number.isFinite(entry.t) ? new Date(entry.t as number) : new Date();
    const level = String(entry.level ?? "log").toUpperCase().slice(0, 5);
    const tag = String(entry.tag ?? "Client").slice(0, 32);
    const msg = String(entry.msg ?? "").slice(0, MAX_MESSAGE_CHARS);
    const levelTag = level === "LOG" || level === "INFO" ? "" : ` [${level}]`;
    writeClientLine(
      `${when.toISOString()}${levelTag} [client:${clientId}] [${tag}] ${msg}${renderData(entry.data)} ip=${ip}`,
    );
  }

  res.json({ ok: true, written: entries.length });
});

export default router;
