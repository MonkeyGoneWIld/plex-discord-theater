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
  const body = req.body as { clientId?: string; sentAt?: number; entries?: ClientLogEntry[] };
  const entries = Array.isArray(body?.entries) ? body.entries.slice(0, MAX_ENTRIES_PER_BATCH) : [];
  if (entries.length === 0) {
    res.json({ ok: true, written: 0 });
    return;
  }

  const clientId = String(body.clientId ?? "unknown").slice(0, 16);
  const ip = req.ip ?? "?";

  // Rebase browser timestamps onto our clock. A merged log is only worth having
  // if it sorts, and browser clocks don't agree with ours or with each other —
  // one client in a stress-test run was 25s behind, so its events appeared to
  // happen before the server lines they caused. Skew is measured from when the
  // batch was sent, so it absorbs the clock offset and leaves only the one-way
  // network delay. The browser's own reading is kept as clientT for reference.
  const skewMs = Number.isFinite(body.sentAt) ? Date.now() - (body.sentAt as number) : 0;

  for (const entry of entries) {
    const rawT = Number.isFinite(entry.t) ? (entry.t as number) : Date.now();
    // Number.isFinite rejects NaN and Infinity but not 1e20, which is finite,
    // makes an Invalid Date, and throws from toISOString — losing the whole
    // batch to a 500 rather than one bad line.
    let when = new Date(rawT + skewMs);
    if (Number.isNaN(when.getTime())) when = new Date();
    const level = String(entry.level ?? "log").toUpperCase().slice(0, 5);
    // Newlines stripped: these go into a line-oriented file, and without this a
    // client can write whatever it likes into it, forged timestamps included.
    const oneLine = (v: string) => v.replace(/[\r\n]+/g, " ");
    const tag = oneLine(String(entry.tag ?? "Client")).slice(0, 32);
    const msg = oneLine(String(entry.msg ?? "")).slice(0, MAX_MESSAGE_CHARS);
    const levelTag = level === "LOG" || level === "INFO" ? "" : ` [${level}]`;
    const rawDate = new Date(rawT);
    const clientT =
      Math.abs(skewMs) > 1000 && !Number.isNaN(rawDate.getTime())
        ? ` clientT=${rawDate.toISOString()}`
        : "";
    writeClientLine(
      `${when.toISOString()}${levelTag} [client:${clientId}] [${tag}] ${msg}${renderData(entry.data)}${clientT} ip=${ip}`,
    );
  }

  res.json({ ok: true, written: entries.length });
});

export default router;
