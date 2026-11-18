import type { Server } from "node:http";
import type { Socket } from "node:net";
import { adminHooks } from "./admin-hooks.js";

/**
 * Everything the bot's port sends, counted at its sockets — segments,
 * playlists, the page, the API and the rooms' messages — and handed to the
 * dashboard's recorder every ten seconds: the upload qBittorrent shares the
 * line with, for the Statistics page. What players say they had from the
 * bot counts only video; this counts all of it, as it leaves.
 */
const EVERY_MS = 10_000;

export function meterUpload(server: Pick<Server, "on">, everyMs = EVERY_MS, now: () => number = Date.now): () => void {
  const written = new Map<Socket, number>();
  let closed = 0;
  const take = (s: Socket) => {
    const total = s.bytesWritten;
    const sent = total - (written.get(s) ?? 0);
    written.set(s, total);
    return Math.max(0, sent);
  };
  server.on("connection", (s: Socket) => {
    written.set(s, 0);
    s.once("close", () => {
      closed += take(s);
      written.delete(s);
    });
  });
  const flush = () => {
    let bytes = closed;
    closed = 0;
    for (const s of written.keys()) bytes += take(s);
    if (bytes > 0 && adminHooks.on) adminHooks.sent({ at: now(), bytes });
  };
  const timer = setInterval(flush, everyMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    flush();
  };
}
