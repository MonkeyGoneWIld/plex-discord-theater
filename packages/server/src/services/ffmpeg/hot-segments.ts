/**
 * The segments of ffmpeg's runs that rooms are fetching now, kept in memory as
 * well as on disk (FFMPEG_SEGMENT_MEMORY_MB, 512 MB unless set): every viewer
 * of a room asks for the same segment within seconds of the others, and the
 * one just made is the next asked for. The least recently used goes first;
 * its file stays where it was, and is read from there if it is asked again.
 */
import path from "node:path";
import { segmentMemoryBytes } from "./config.js";

const hot = new Map<string, Buffer>();
let held = 0;
let budgetOverride: number | null = null;

function budget(): number {
  return budgetOverride ?? segmentMemoryBytes();
}

/** Keep a segment's bytes, by its file. */
export function keepHot(file: string, data: Buffer): void {
  const limit = budget();
  if (data.length > limit) return;
  const had = hot.get(file);
  if (had) {
    hot.delete(file);
    held -= had.length;
  }
  hot.set(file, data);
  held += data.length;
  trim(limit);
}

/** The least recently used let go, down to `limit` bytes. */
function trim(limit: number): void {
  for (const [oldest, bytes] of hot) {
    if (held <= limit) break;
    hot.delete(oldest);
    held -= bytes.length;
  }
}

/** A segment's bytes, when they are kept: now the most recently used. */
export function hotSegment(file: string): Buffer | null {
  const data = hot.get(file);
  if (!data) return null;
  hot.delete(file);
  hot.set(file, data);
  return data;
}

/** Forget every segment under `dir`: its run has ended. */
export function dropHot(dir: string): void {
  const inside = /[\\/]$/.test(dir) ? dir : dir + path.sep;
  for (const [file, bytes] of hot) {
    if (!file.startsWith(inside)) continue;
    hot.delete(file);
    held -= bytes.length;
  }
}

/** How many are kept, and their bytes. */
export function hotSegmentStats(): { segments: number; bytes: number } {
  return { segments: hot.size, bytes: held };
}

/** For tests: a budget of their own (null: FFMPEG_SEGMENT_MEMORY_MB's). */
export function setHotBudget(bytes: number | null): void {
  budgetOverride = bytes;
  trim(budget());
}
