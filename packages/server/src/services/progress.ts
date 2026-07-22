import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Persist to the mounted data volume (same one the thumb cache uses) when set —
// the previous ../../../data path resolved to /app/packages/data in the
// container, which the non-root runtime user can't create (EACCES) and which
// isn't the mounted volume anyway, so progress was never saved. Fall back to the
// repo-local path for local dev.
const DATA_DIR = process.env.THUMB_CACHE_DIR
  ? path.resolve(process.env.THUMB_CACHE_DIR)
  : path.resolve(__dirname, "../../../data");
const PROGRESS_FILE = path.join(DATA_DIR, "watch-progress.json");
const MAX_ITEMS_PER_USER = 6;

export interface WatchProgress {
  ratingKey: string;
  title: string;
  thumb: string | null;
  type: string;
  parentTitle?: string;
  parentIndex?: number;
  index?: number;
  position: number;
  duration: number;
  updatedAt: number;
}

type ProgressStore = Record<string, WatchProgress[]>;

function readStore(): ProgressStore {
  try {
    if (!fs.existsSync(PROGRESS_FILE)) return {};
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function writeStore(store: ProgressStore): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(store, null, 2));
}

export function getProgress(userId: string): WatchProgress[] {
  const store = readStore();
  const items = store[userId] || [];
  return items
    .filter((p) => p.duration > 0 && p.position / p.duration <= 0.95)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_ITEMS_PER_USER);
}

export function upsertProgress(userId: string, entry: Omit<WatchProgress, "updatedAt">): void {
  const store = readStore();
  const items = store[userId] || [];
  const idx = items.findIndex((p) => p.ratingKey === entry.ratingKey);
  const record: WatchProgress = { ...entry, updatedAt: Date.now() };
  if (idx >= 0) {
    items[idx] = record;
  } else {
    items.push(record);
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  store[userId] = items.slice(0, MAX_ITEMS_PER_USER * 2);
  writeStore(store);
}

export function deleteProgress(userId: string, ratingKey: string): void {
  const store = readStore();
  const items = store[userId] || [];
  store[userId] = items.filter((p) => p.ratingKey !== ratingKey);
  writeStore(store);
}
