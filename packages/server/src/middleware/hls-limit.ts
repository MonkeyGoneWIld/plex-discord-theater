import rateLimit from "express-rate-limit";
import type { Request, RequestHandler } from "express";
import { MAX_SEGMENT_PARTS } from "../services/direct-stream.js";

/** The second part on (`part=1` up) of a segment asked for in parts — see
 *  the player's lib/segmentParts.ts and direct-stream.ts segmentPart. */
export function laterPart(req: Pick<Request, "query">): boolean {
  const part = Number(req.query.part);
  return req.query.parts !== undefined && Number.isInteger(part) && part > 0;
}

/**
 * The HLS budget, `max` a quarter of an hour: a segment counts once, by its
 * first part, and the rest of its parts against a ceiling of their own,
 * MAX_SEGMENT_PARTS times as high. Counted part by part, run 29 (29 October)
 * spent the 3,000 in eleven and a half minutes: 1.3 GB of HDR re-encodes at
 * 20 Mbps, each 3 s segment in 16 parts of 150 KB up. Every request after it
 * was refused (429), the playlist and the ping too, and nothing started until
 * the quarter was up.
 */
export function hlsLimiters(max: number): RequestHandler[] {
  const windowMs = 15 * 60 * 1000;
  return [
    rateLimit({ windowMs, max, skip: laterPart, standardHeaders: true, legacyHeaders: false }),
    rateLimit({
      windowMs,
      max: max * MAX_SEGMENT_PARTS,
      skip: (req) => !laterPart(req),
      standardHeaders: true,
      legacyHeaders: false,
    }),
  ];
}
