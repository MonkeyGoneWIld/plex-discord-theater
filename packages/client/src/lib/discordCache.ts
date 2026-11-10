/**
 * How much of what came over HTTP Discord's own cache sent (the Cloudflare in
 * front of the activity, which keeps the server's segments: EDGE_SEGMENT_ROUTE)
 * against the server, for Stats for nerds. From segmentParts' edgeTotals, its
 * answers since the page opened. Null when nothing came through it: a browser
 * outside Discord.
 */
export interface DiscordCacheShare {
  /** The share of the bytes Discord's cache sent, 0 to 100. */
  pct: number;
  fromCache: number;
  fromServer: number;
  hits: number;
  downloads: number;
}

export function discordCacheShare(edge: { hit: number; of: number; hitBytes: number; bytes: number }): DiscordCacheShare | null {
  if (edge.of <= 0) return null;
  const fromCache = Math.min(edge.hitBytes, edge.bytes);
  return {
    pct: edge.bytes > 0 ? Math.round((fromCache / edge.bytes) * 100) : 0,
    fromCache,
    fromServer: edge.bytes - fromCache,
    hits: edge.hit,
    downloads: edge.of,
  };
}
