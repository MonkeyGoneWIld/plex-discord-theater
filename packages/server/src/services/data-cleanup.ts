/**
 * What the data folder gathers that nothing uses any more, cleared a minute
 * after the server starts and once a day after: in run 23 bot 2's held 5 GB
 * of it. The caches kept on purpose keep to their own sizes — the artwork
 * (thumb-cache.sqlite, THUMB_CACHE_MAX_SIZE), previews (FFMPEG_PREVIEWS_MAX_GB),
 * picture subtitles (FFMPEG_PGS_MAX_GB) — and aren't touched here. This is
 * for the rest:
 *
 * - hls/: segments of streams from before August, when they were kept there.
 *   Nothing writes to it now; bot 2's held 2.5 GB.
 * - Empty folders under the stream cache (STREAM_CACHE_DIR): a run's own is
 *   removed when it stops, and now its session's with it, but a server up for
 *   days had gathered them.
 * - diagnose/: scripts/diagnose-ffmpeg.mjs's reports and sample encodes, after
 *   DIAGNOSE_KEEP_DAYS. Bot 2's held 2.5 GB of samples from 17 October.
 * - Picture subtitles nobody has played for PGS_KEEP_DAYS: a film replaced in
 *   Plex leaves its old one's behind under another name (Project Hail Mary's,
 *   three times), until the size limit gets to them.
 */
import fs from "node:fs";
import path from "node:path";
import { logEvent } from "./logger.js";

const DAY_MS = 24 * 60 * 60_000;
const DIAGNOSE_KEEP_DAYS = 14;
const PGS_KEEP_DAYS = 60;
/** An empty folder younger than this may be one a run is about to write to. */
const EMPTY_FOR_MS = 10 * 60_000;
/** After the server starts: what it does first comes first. */
const FIRST_AFTER_MS = 60_000;

interface Freed {
  items: number;
  bytes: number;
}

function dataDir(): string {
  return process.env.THUMB_CACHE_DIR
    ? path.resolve(process.env.THUMB_CACHE_DIR)
    : path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "../../data");
}

async function sizeOf(p: string): Promise<number> {
  try {
    const st = await fs.promises.stat(p);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const n of await fs.promises.readdir(p)) total += await sizeOf(path.join(p, n));
    return total;
  } catch {
    return 0;
  }
}

async function remove(p: string, freed: Freed): Promise<void> {
  const bytes = await sizeOf(p);
  try {
    await fs.promises.rm(p, { recursive: true, force: true });
    freed.items++;
    freed.bytes += bytes;
  } catch {
    // In use, or not ours to remove: the next pass tries again.
  }
}

/** What in `dir` hasn't changed for `days`, and passes `which`. */
async function olderThan(dir: string, days: number, which: (name: string) => boolean, freed: Freed): Promise<void> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return;
  }
  for (const n of names.filter(which)) {
    try {
      const st = await fs.promises.stat(path.join(dir, n));
      if (Date.now() - st.mtimeMs > days * DAY_MS) await remove(path.join(dir, n), freed);
    } catch {
      // Gone already.
    }
  }
}

/** Empty folders under `dir`, deepest first, and not `dir`. Whether it is empty now. */
async function emptyFolders(dir: string, freed: Freed, top = true): Promise<boolean> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  let left = 0;
  for (const e of entries) {
    if (e.isDirectory() && await emptyFolders(path.join(dir, e.name), freed, false)) continue;
    left++;
  }
  if (top || left) return false;
  try {
    // Emptied just now by this pass is old enough: removing what was in it
    // made it look new.
    if (!entries.length && Date.now() - (await fs.promises.stat(dir)).mtimeMs < EMPTY_FOR_MS) return false;
    await fs.promises.rmdir(dir);
    freed.items++;
    return true;
  } catch {
    return false;
  }
}

/** One pass; what it removed, by kind, for the log. */
export async function cleanDataFolder(streamCacheDir: string): Promise<Record<string, string>> {
  const data = dataDir();
  const done: Record<string, string> = {};
  const note = (kind: string, f: Freed) => {
    if (f.items) done[kind] = `${f.items}${f.bytes >= 1024 * 1024 ? ` (${Math.round(f.bytes / 1024 / 1024)} MB)` : ""}`;
  };
  const hls: Freed = { items: 0, bytes: 0 };
  if (fs.existsSync(path.join(data, "hls"))) await remove(path.join(data, "hls"), hls);
  note("oldHls", hls);
  const empty: Freed = { items: 0, bytes: 0 };
  await emptyFolders(streamCacheDir, empty);
  note("emptyFolders", empty);
  const diagnose: Freed = { items: 0, bytes: 0 };
  await olderThan(path.join(data, "diagnose"), DIAGNOSE_KEEP_DAYS, () => true, diagnose);
  note("diagnose", diagnose);
  const pgs: Freed = { items: 0, bytes: 0 };
  await olderThan(path.join(data, "subtitles-pgs"), PGS_KEEP_DAYS, (n) => n.endsWith(".sup"), pgs);
  note("pictureSubtitles", pgs);
  if (Object.keys(done).length) logEvent("Cleanup", "removed what the data folder no longer uses", done);
  return done;
}

/** A pass a minute after start, and one a day. */
export function startDataCleanup(streamCacheDir: string): void {
  const pass = () => void cleanDataFolder(streamCacheDir).catch((err) =>
    logEvent("Cleanup", "the data folder's cleanup stopped part way", { why: String(err) }));
  setTimeout(pass, FIRST_AFTER_MS).unref();
  setInterval(pass, DAY_MS).unref();
}
