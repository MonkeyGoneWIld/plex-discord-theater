/**
 * The sizes the client asks for each kind of artwork.
 *
 * The thumb proxy caches one entry per image *and* size, so the cache warmer
 * has to request exactly these sizes. Anything else fills entries nobody
 * reads. The client's copies are in packages/client/src/lib/api.ts, and
 * test/cache-warmer.test.ts fails if the two drift apart.
 */

export interface ArtworkSize {
  w: number;
  h: number;
}

/** Every poster: library cards, title pages, season grids (POSTER_THUMB_*). */
export const POSTER_SIZE: ArtworkSize = { w: 400, h: 600 };
/** The blurred backdrop behind title and show pages (BACKDROP_THUMB_*). */
export const BACKDROP_SIZE: ArtworkSize = { w: 240, h: 135 };
/** Cast and crew portraits (PERSON_THUMB_SIZE). */
export const PERSON_SIZE: ArtworkSize = { w: 320, h: 320 };
/** Episode stills in a season's episode list (EPISODE_THUMB_*). */
export const EPISODE_STILL_SIZE: ArtworkSize = { w: 400, h: 225 };

/**
 * Portraits warmed per title: directors first, then cast, as the page lays
 * them out. The same first screen or so the client's hover prefetch primes
 * (DETAIL_CAST_PREFETCH_LIMIT). The rest of the row loads when it is opened.
 */
export const WARM_PORTRAITS_PER_TITLE = 12;
