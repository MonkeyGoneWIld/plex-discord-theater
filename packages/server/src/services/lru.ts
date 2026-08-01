/**
 * A Map that forgets its least-recently-used entry once it is full.
 *
 * The server is long-lived and most of its caches are keyed by something
 * unbounded — every ratingKey ever opened, every search term ever typed, every
 * TMDB id ever resolved. A plain Map with a TTL checked on *read* never shrinks:
 * the stale entries are simply never returned, and the memory is held until the
 * process restarts. This is the missing half of that pattern.
 *
 * Insertion order is the recency order (`get` re-inserts on hit), which is what
 * a JS Map gives for free — no linked list, no timestamps, and eviction is
 * `keys().next()`.
 */
export class LruMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly max: number) {
    if (max < 1) throw new RangeError("LruMap needs a positive capacity");
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Re-insert to move it to the back — this is what makes it an LRU rather
    // than a plain FIFO, so a hot entry isn't evicted by a burst of cold ones.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  /** Membership without promoting the entry — for caches that store `null` as a
   *  meaningful value (a lookup that legitimately found nothing). */
  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): void {
    // Delete first so an overwrite also refreshes recency.
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }
}
