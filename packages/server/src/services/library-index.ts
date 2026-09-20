/** Local ownership index used by collection/recommendation assembly. */

export interface IndexedLibraryItem {
  ratingKey: string;
  title: string;
  type: string;
  year?: number;
  librarySectionID?: number;
  Guid?: Array<{ id?: string }>;
}

export interface LibraryIndexQuery {
  tmdbId: number;
  title: string;
  type: string;
  year?: number;
}

let ready = false;
const byTmdb = new Map<string, IndexedLibraryItem>();
const byTitle = new Map<string, IndexedLibraryItem[]>();
const byYear = new Map<string, IndexedLibraryItem[]>();

const titleKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
const typeKey = (type: string, value: string | number) => `${type}:${value}`;

function tmdbIdOf(item: IndexedLibraryItem): number | null {
  const raw = item.Guid?.find((guid) => guid.id?.startsWith("tmdb://"))?.id?.slice(7);
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export function replaceLibraryIndex(items: IndexedLibraryItem[]): void {
  byTmdb.clear();
  byTitle.clear();
  byYear.clear();
  for (const item of items) {
    const tmdbId = tmdbIdOf(item);
    if (tmdbId != null) byTmdb.set(typeKey(item.type, tmdbId), item);

    const normalized = titleKey(item.title);
    const titleBucket = byTitle.get(typeKey(item.type, normalized)) ?? [];
    titleBucket.push(item);
    byTitle.set(typeKey(item.type, normalized), titleBucket);

    if (item.year != null) {
      const yearBucket = byYear.get(typeKey(item.type, item.year)) ?? [];
      yearBucket.push(item);
      byYear.set(typeKey(item.type, item.year), yearBucket);
    }
  }
  ready = true;
}

/**
 * Undefined means the index has not loaded yet and the caller may use its old
 * Plex-search fallback. Null means the complete local index is ready and the
 * title is genuinely not owned.
 */
export function findIndexedLibraryItem(query: LibraryIndexQuery): IndexedLibraryItem | null | undefined {
  if (!ready) return undefined;
  const exactId = byTmdb.get(typeKey(query.type, query.tmdbId));
  if (exactId) return exactId;
  if (!query.title) return null;

  const wanted = titleKey(query.title);
  const exactTitle = (byTitle.get(typeKey(query.type, wanted)) ?? []).find(
    (item) => query.year == null || item.year == null || Math.abs(item.year - query.year) <= 1,
  );
  if (exactTitle) return exactTitle;

  if (query.year != null) {
    const loose = (byYear.get(typeKey(query.type, query.year)) ?? []).find((item) => {
      const candidate = titleKey(item.title);
      return candidate.includes(wanted) || wanted.includes(candidate);
    });
    if (loose) return loose;
  }
  return null;
}

export function clearLibraryIndex(): void {
  ready = false;
  byTmdb.clear();
  byTitle.clear();
  byYear.clear();
}
