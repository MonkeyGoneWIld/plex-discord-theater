import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "theater-detail-cache-"));
process.env.THUMB_CACHE_DIR = dataDir;

const cache = await import("../src/services/detail-cache.js");
const index = await import("../src/services/library-index.js");

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok   ${name}`);
};

check("persistent rows retain both detail-page halves", () => {
  cache.writeDetailCache("meta", "10", { title: "One" });
  cache.writeDetailCache("related", "10", { collections: [], recommendations: [] });
  assert.deepEqual(cache.readDetailCache("meta", "10")?.payload, { title: "One" });
  assert.equal(cache.detailCacheMatches("10", 123), false);
  cache.markDetailCacheVersion("10", 123);
  assert.equal(cache.detailCacheMatches("10", 123), true);
  assert.equal(cache.detailCacheMatches("10", 124), false);
});

check("invalidation removes both detail-page halves", () => {
  cache.invalidateDetailCache("10");
  assert.equal(cache.readDetailCache("meta", "10"), null);
  assert.equal(cache.readDetailCache("related", "10"), null);
});

check("library index distinguishes not-ready from not-owned", () => {
  index.clearLibraryIndex();
  assert.equal(index.findIndexedLibraryItem({ tmdbId: 1, title: "Missing", type: "movie" }), undefined);
  index.replaceLibraryIndex([]);
  assert.equal(index.findIndexedLibraryItem({ tmdbId: 1, title: "Missing", type: "movie" }), null);
});

check("library index resolves by TMDB id before title", () => {
  const item = {
    ratingKey: "20",
    title: "Localized title",
    type: "movie",
    year: 2020,
    Guid: [{ id: "tmdb://500" }],
  };
  index.replaceLibraryIndex([item]);
  assert.equal(index.findIndexedLibraryItem({ tmdbId: 500, title: "Different title", type: "movie" }), item);
});

check("library index retains title and same-year fallback matching", () => {
  const exact = { ratingKey: "30", title: "Spider-Man: Homecoming", type: "movie", year: 2017 };
  const loose = { ratingKey: "31", title: "Marvel's Daredevil", type: "show", year: 2015 };
  index.replaceLibraryIndex([exact, loose]);
  assert.equal(index.findIndexedLibraryItem({ tmdbId: 1, title: "spider man homecoming", type: "movie", year: 2018 }), exact);
  assert.equal(index.findIndexedLibraryItem({ tmdbId: 2, title: "Daredevil", type: "show", year: 2015 }), loose);
});

cache.writeDetailCache("meta", "restart-check", { title: "Still here" });
cache.closeDetailCache();
check("detail rows survive closing and reopening the database", () => {
  const reopened = new Database(path.join(dataDir, "detail-cache.sqlite"), { readonly: true });
  const row = reopened.prepare("SELECT payload_json FROM detail_cache WHERE kind = 'meta' AND rating_key = ?")
    .get("restart-check") as { payload_json: string } | undefined;
  reopened.close();
  assert.deepEqual(JSON.parse(row?.payload_json ?? "null"), { title: "Still here" });
});
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${passed} persistent detail-cache and library-index checks passed.`);
