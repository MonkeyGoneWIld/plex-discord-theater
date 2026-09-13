import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { LruMap } from "./lru.js";
import { plexUrl } from "./plex.js";
import * as thumbCache from "./thumb-cache.js";

const PUBLIC_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_PUBLICATIONS = 512;
const MAX_IN_FLIGHT = 16;
const RATING_KEY_RE = /^\d{1,20}$/;
const OPAQUE_ID_RE = /^[0-9a-f]{48}$/;
// Only Plex's local metadata poster paths, never arbitrary URLs, queries or
// another Plex endpoint (even if malformed metadata happens to contain one).
const POSTER_PATH_RE = /^\/library\/metadata\/\d{1,20}\/thumb(?:\/\d{1,20})?$/;
const IMAGE_TYPES: Record<string, true> = {
  "image/jpeg": true,
  "image/png": true,
  "image/webp": true,
};

interface Artwork {
  contentType: string;
  data: Buffer;
}

interface Publication {
  cacheKey: string;
  expiresAt: number;
}

interface Metadata {
  type?: string;
  thumb?: string;
  grandparentThumb?: string;
  grandparentRatingKey?: string;
}

// Bytes stay in the existing size/TTL-bounded SQLite thumbnail cache. These
// bounded, process-local capabilities are the only way to read them publicly;
// a restart revokes old URLs, and GET never creates or refreshes a capability.
const publications = new LruMap<string, Publication>(MAX_PUBLICATIONS);
const resolved = new LruMap<string, { id: string | null; expiresAt: number }>(MAX_PUBLICATIONS);
const inFlight = new Map<string, Promise<string | null>>();
const imagesInFlight = new Map<string, Promise<Artwork | null>>();

const publicOrigin = (() => {
  try {
    const redirect = new URL(process.env.REDIRECT_URI ?? "");
    return redirect.protocol === "https:" && !redirect.username && !redirect.password
      ? redirect.origin
      : null;
  } catch {
    return null;
  }
})();

export function isPresenceRatingKey(value: unknown): value is string {
  return typeof value === "string" && RATING_KEY_RE.test(value);
}

function posterPath(value: unknown): string | null {
  return typeof value === "string" && POSTER_PATH_RE.test(value) ? value : null;
}

/** Require the declared raster format to agree with its file signature. */
function isRaster(artwork: Artwork): boolean {
  const { contentType, data } = artwork;
  if (data.length === 0 || data.length > MAX_IMAGE_BYTES) return false;
  switch (contentType) {
    case "image/jpeg":
      return data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case "image/png":
      return data.length >= 24 && data.readUInt32BE(0) === 0x89504e47 &&
        data.readUInt32BE(4) === 0x0d0a1a0a && data.toString("ascii", 12, 16) === "IHDR";
    case "image/webp":
      return data.length >= 16 && data.toString("ascii", 0, 4) === "RIFF" &&
        data.toString("ascii", 8, 12) === "WEBP" &&
        ["VP8 ", "VP8L", "VP8X"].includes(data.toString("ascii", 12, 16));
    default:
      return false;
  }
}

/** Unlike the streaming Plex helper, the deadline covers headers AND body,
 * and redirects are forbidden so a server token cannot leave the Plex origin. */
async function fetchBounded(
  path: string,
  params: Record<string, string> | undefined,
  signal: AbortSignal,
  image: boolean,
): Promise<Artwork | null> {
  const response = await fetch(plexUrl(path, params), {
    headers: {
      Accept: image ? "image/jpeg, image/png, image/webp" : "application/json",
      "X-Plex-Client-Identifier": "plex-discord-theater",
      "X-Plex-Product": "Plex Discord Theater",
      "X-Plex-Version": "1.0.0",
    },
    redirect: "error",
    signal,
  });
  const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
  const maxBytes = image ? MAX_IMAGE_BYTES : MAX_METADATA_BYTES;
  if (response.status === 404) {
    void response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.ok || !response.body ||
      (image ? IMAGE_TYPES[contentType] !== true : contentType !== "application/json") ||
      Number(response.headers.get("content-length")) > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new Error("Plex artwork response rejected");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error("Plex artwork response too large");
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return { contentType, data: Buffer.concat(chunks, length) };
}

async function metadata(ratingKey: string, signal: AbortSignal): Promise<Metadata | null> {
  const response = await fetchBounded(`/library/metadata/${ratingKey}`, undefined, signal, false);
  if (!response) return null;
  const data = JSON.parse(response.data.toString("utf8")) as {
    MediaContainer?: { Metadata?: Metadata[] };
  };
  return data?.MediaContainer?.Metadata?.[0] ?? null;
}

async function resolvePoster(ratingKey: string, signal: AbortSignal): Promise<string | null> {
  const item = await metadata(ratingKey, signal);
  if (item?.type === "movie" || item?.type === "show") return posterPath(item.thumb);
  if (item?.type !== "episode") return null;
  const grandparentThumb = posterPath(item.grandparentThumb);
  if (grandparentThumb) return grandparentThumb;
  if (!isPresenceRatingKey(item.grandparentRatingKey)) return null;
  const show = await metadata(item.grandparentRatingKey, signal);
  return show?.type === "show" ? posterPath(show.thumb) : null;
}

async function artwork(cacheKey: string, path: string, signal: AbortSignal): Promise<Artwork | null> {
  const cached = thumbCache.get(cacheKey);
  if (cached && isRaster(cached)) return cached;
  const pending = imagesInFlight.get(cacheKey);
  if (pending) return pending;

  const work = (async () => {
    const image = await fetchBounded("/photo/:/transcode", {
      width: "512",
      height: "512",
      minSize: "0",
      upscale: "0",
      format: "jpeg",
      url: path,
    }, signal, true);
    if (!image || !isRaster(image)) return null;
    // Plex returns a rectangle that Discord cover-crops. Keep the full poster
    // sharp over a dimmed, blurred copy that fills Discord's square image slot.
    signal.throwIfAborted();
    const poster = sharp(image.data, { limitInputPixels: 1024 * 1024 })
      .autoOrient()
      .timeout({ seconds: 2 });
    const foreground = await poster.clone()
      .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    signal.throwIfAborted();
    const square = await poster
      .resize(512, 512, { fit: "cover" })
      .blur(24)
      .modulate({ brightness: 0.68, saturation: 0.8 })
      .composite([{ input: foreground }])
      .png()
      .toBuffer();
    signal.throwIfAborted();
    if (square.length > MAX_IMAGE_BYTES) return null;
    // Separate namespace: the broader authenticated thumb proxy cannot seed a
    // public entry with an unchecked response. Honor cache eviction immediately.
    thumbCache.set(cacheKey, "image/png", square);
    return thumbCache.get(cacheKey);
  })();
  imagesInFlight.set(cacheKey, work);
  try {
    return await work;
  } finally {
    imagesInFlight.delete(cacheKey);
  }
}

/** Read-only lookup: no metadata resolution, network fetch, or expiry renewal. */
export function getPresenceArtwork(id: string): (Artwork & { expiresAt: number }) | null {
  if (!OPAQUE_ID_RE.test(id)) return null;
  const publication = publications.get(id);
  if (!publication) return null;
  if (publication.expiresAt <= Date.now()) {
    publications.delete(id);
    return null;
  }
  const image = thumbCache.get(publication.cacheKey);
  if (!image || !isRaster(image)) {
    publications.delete(id);
    return null;
  }
  return { ...image, expiresAt: publication.expiresAt };
}

async function publish(ratingKey: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  timer.unref();
  try {
    const path = await resolvePoster(ratingKey, controller.signal);
    if (path) {
      const cacheKey = `presence:v3:blurred512:${path}`;
      const image = await artwork(cacheKey, path, controller.signal);
      if (image) {
        const id = randomBytes(24).toString("hex");
        const expiresAt = Date.now() + PUBLIC_TTL_MS;
        publications.set(id, { cacheKey, expiresAt });
        resolved.set(ratingKey, { id, expiresAt });
        return `${publicOrigin}/api/presence/artwork/${id}`;
      }
    }
  } catch {
    // Artwork is optional. Never expose Plex errors, paths or token-bearing URLs
    // in a public response/log, and briefly back off failures as well as misses.
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  resolved.set(ratingKey, { id: null, expiresAt: Date.now() + MISS_TTL_MS });
  return null;
}

export async function publishPresenceArtwork(ratingKey: string): Promise<string | null> {
  // A local HTTP dev redirect must not leak an unusable or insecure image URL.
  if (!publicOrigin || !isPresenceRatingKey(ratingKey)) return null;
  const cached = resolved.get(ratingKey);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.id === null) return null;
    if (getPresenceArtwork(cached.id)) {
      return `${publicOrigin}/api/presence/artwork/${cached.id}`;
    }
  }
  const pending = inFlight.get(ratingKey);
  if (pending) return pending;
  if (inFlight.size >= MAX_IN_FLIGHT) return null;
  const work = publish(ratingKey);
  inFlight.set(ratingKey, work);
  try {
    return await work;
  } finally {
    inFlight.delete(ratingKey);
  }
}
