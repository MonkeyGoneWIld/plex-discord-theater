import { gzip } from "node:zlib";
import { promisify } from "node:util";
import type { Request, Response } from "express";

const gzipAsync = promisify(gzip);

/** Below this a playlist goes as it is: gzip saves less than it costs. */
const GZIP_FROM_BYTES = 1024;

/**
 * Send an HLS playlist, gzipped for a player that takes it.
 *
 * A growing playlist lists every segment since the start or the last seek, each
 * with a long proxied URL: two hours into a re-encode cut every 3 s it is about
 * 2,400 entries and half a megabyte, and hls.js reloads it every 3 to 6 s for
 * as long as it grows — about 1 Mbps a viewer of nothing but playlist, which a
 * viewer far away pays for in the picture. Nothing compressed it: the app has
 * no compression middleware. The same lines over and over gzip some twenty
 * times smaller.
 */
export async function sendPlaylist(req: Request, res: Response, playlist: string | Buffer): Promise<void> {
  res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
  res.vary("Accept-Encoding");
  const body = typeof playlist === "string" ? Buffer.from(playlist, "utf8") : playlist;
  if (body.length < GZIP_FROM_BYTES || !/\bgzip\b/i.test(String(req.headers["accept-encoding"] ?? ""))) {
    res.send(body);
    return;
  }
  const zipped = await gzipAsync(body, { level: 6 });
  if (res.headersSent || res.destroyed) return;
  res.setHeader("Content-Encoding", "gzip");
  res.send(zipped);
}
