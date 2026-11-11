import fs from "node:fs";
import path from "node:path";
import { usage as thumbUsage, thumbCacheSummary } from "../services/thumb-cache.js";
import { detailCacheSummary, detailCacheTitles } from "../services/detail-cache.js";
import { embeddedSubtitleSummary } from "../services/embedded-subtitles.js";
import { directStreamCacheDir, directStreamSessions } from "../services/direct-stream.js";
import { hotSegmentStats } from "../services/ffmpeg/hot-segments.js";
import { previewsMaxBytes, segmentMemoryBytes } from "../services/ffmpeg/config.js";
import { previewPartOf } from "../services/ffmpeg/previews.js";
import { pictureSubtitlesMaxBytes } from "../services/ffmpeg/picture-subtitles.js";
import type { Recorder } from "./recorder.js";

/**
 * What the bot keeps, for the admin page's Caches: each cache, how much it
 * holds against its limit, what it holds (the newest first) and, where it
 * can be told, which title each item is of.
 */

const LIST = 200;

export interface CacheItem {
  name: string;
  title: string | null;
  ratingKey: string | null;
  bytes: number | null;
  at: number | null;
  /** More about it, in words. */
  detail?: string;
}

export interface CacheView {
  id: string;
  name: string;
  /** What it is for. */
  what: string;
  /** Where it is: a file, a folder, or memory. */
  where: string;
  bytes: number;
  limitBytes: number | null;
  items: number;
  /** How it lets things go. */
  kept: string;
  list: CacheItem[];
  /** Said when the list isn't the whole of it. */
  listNote: string | null;
}

function dataDir(): string {
  return process.env.THUMB_CACHE_DIR
    ? path.resolve(process.env.THUMB_CACHE_DIR)
    : path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "../../data");
}

/** Every file under `dir`: its size, and the newest change, by top-level entry. */
async function folder(dir: string, which: (name: string) => boolean = () => true):
  Promise<Array<{ name: string; bytes: number; files: number; at: number }>> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ name: string; bytes: number; files: number; at: number }> = [];
  for (const e of entries) {
    if (!which(e.name)) continue;
    const t = await tally(path.join(dir, e.name));
    out.push({ name: e.name, ...t });
  }
  return out.sort((a, b) => b.at - a.at);
}

async function tally(p: string): Promise<{ bytes: number; files: number; at: number }> {
  try {
    const st = await fs.promises.stat(p);
    if (!st.isDirectory()) return { bytes: st.size, files: 1, at: st.mtimeMs };
    let bytes = 0, files = 0, at = st.mtimeMs;
    for (const n of await fs.promises.readdir(p)) {
      const t = await tally(path.join(p, n));
      bytes += t.bytes;
      files += t.files;
      at = Math.max(at, t.at);
    }
    return { bytes, files, at };
  } catch {
    return { bytes: 0, files: 0, at: 0 };
  }
}

const sum = (xs: Array<{ bytes: number }>) => xs.reduce((s, x) => s + x.bytes, 0);
const note = (shown: number, total: number) => (total > shown ? `The newest ${shown} of ${total}` : null);

/** `/library/metadata/123/thumb/456`: item 123. */
function ratingKeyOfArt(p: string): string | null {
  return /\/library\/metadata\/(\d+)\//.exec(p)?.[1] ?? null;
}

export async function cachesView(recorder: Recorder | null): Promise<{
  at: number; caches: CacheView[]; discord: ReturnType<Recorder["discordCache"]> | null;
}> {
  const data = dataDir();
  const streamDir = directStreamCacheDir();

  // Titles: what the history played, then what the details cache knows.
  const keysWanted: string[] = [];
  const titleOf = (titles: Map<string, string>) => (key: string | null) => (key ? titles.get(key) ?? null : null);

  // ── Films being copied, and FFmpeg's runs: the stream cache ──
  const copies = directStreamSessions();
  const runsDir = path.join(streamDir, "ffmpeg");
  const [copyFolders, runFolders] = await Promise.all([
    folder(streamDir, (n) => n !== "ffmpeg"),
    folder(runsDir),
  ]);
  const hot = hotSegmentStats();
  const sessionIds = [...copies.map((c) => c.sessionId), ...runFolders.map((f) => f.name)];
  const sessionPlays = recorder?.sessions(sessionIds) ?? new Map<string, { playId: number; title: string | null; ratingKey: string }>();

  // ── Seek-bar previews, picture subtitles, fonts ──
  const [previews, pgs, fonts] = await Promise.all([
    folder(path.join(data, "previews"), (n) => n.endsWith(".bif")),
    folder(path.join(data, "subtitles-pgs"), (n) => n.endsWith(".sup")),
    folder(path.join(data, "subtitle-fonts")),
  ]);
  const previewKey = (name: string) => {
    const part = Number(/^(\d+)-/.exec(name)?.[1]);
    return Number.isFinite(part) ? previewPartOf(part)?.ratingKey ?? null : null;
  };

  const art = thumbCacheSummary(LIST);
  const artUse = thumbUsage();
  const details = detailCacheSummary(LIST);
  const subs = embeddedSubtitleSummary(LIST);

  for (const p of previews) keysWanted.push(previewKey(p.name) ?? "");
  for (const a of art.items) keysWanted.push(ratingKeyOfArt(a.path) ?? "");
  for (const s of subs.items) keysWanted.push(s.ratingKey);
  for (const c of copies) keysWanted.push(c.ratingKey);
  const wanted = keysWanted.filter(Boolean);
  const titles = recorder?.titles(wanted) ?? new Map<string, string>();
  for (const [k, v] of detailCacheTitles(wanted.filter((k) => !titles.has(k)))) titles.set(k, v);
  const title = titleOf(titles);

  const copyBy = new Map(copies.map((c) => [c.sessionId.replace(/[^\w-]/g, "_"), c] as const));
  const caches: CacheView[] = [
    {
      id: "stream",
      name: "Direct-play segments",
      what: "Segments of titles being sent unchanged (direct play), kept during playback so seeking backwards is instant.",
      where: streamDir,
      bytes: sum(copyFolders) + copies.reduce((s, c) => s + c.memoryBytes, 0),
      limitBytes: null,
      items: copies.length,
      kept: "Held in memory first, then on disk. Removed when the stream ends; the folder is cleared when the server starts.",
      list: copies.map((c): CacheItem => ({
        name: c.sessionId,
        ratingKey: c.ratingKey,
        title: sessionPlays.get(c.sessionId)?.title ?? title(c.ratingKey),
        bytes: c.memoryBytes + c.diskBytes,
        at: c.startedAt,
        detail: `${c.segments} segments: ${mb(c.memoryBytes)} in memory, ${mb(c.diskBytes)} on disk` +
          `${c.ended ? "; copied to the end" : ""}${c.failed ? "; stopped by an error" : ""}`,
      })).concat(copyFolders.filter((f) => !copyBy.has(f.name)).map((f) => ({
        name: f.name, ratingKey: null, title: null, bytes: f.bytes, at: f.at,
        detail: `${f.files} files left on disk by a stream that has ended`,
      }))),
      listNote: null,
    },
    {
      id: "ffmpeg",
      name: "FFmpeg stream segments",
      what: "Segments produced by FFmpeg for each active stream, on disk, with the most recently requested held in memory.",
      where: runsDir,
      bytes: sum(runFolders),
      limitBytes: null,
      items: runFolders.length,
      kept: `Removed when the stream ends. In memory: ${hot.segments} segments, ${mb(hot.bytes)} of ${mb(segmentMemoryBytes())} (FFMPEG_SEGMENT_MEMORY_MB).`,
      list: runFolders.slice(0, LIST).map((f) => {
        const play = sessionPlays.get(f.name);
        return {
          name: f.name, ratingKey: play?.ratingKey ?? null, title: play?.title ?? null, bytes: f.bytes, at: f.at,
          detail: `${f.files} files`,
        };
      }),
      listNote: note(LIST, runFolders.length),
    },
    {
      id: "art",
      name: "Artwork",
      what: "Posters, backdrops and cast photos from Plex and TMDB, so pages load without contacting Plex again.",
      where: path.join(data, "thumb-cache.sqlite"),
      bytes: artUse.bytes,
      limitBytes: artUse.maxBytes,
      items: art.count,
      kept: `${Math.round(art.ttlMs / 86_400_000)} days per image (THUMB_CACHE_TTL_MS). Above THUMB_CACHE_MAX_SIZE, the oldest are removed first.`,
      list: art.items.map((a) => {
        const key = ratingKeyOfArt(a.path);
        return { name: a.path, ratingKey: key, title: title(key), bytes: a.bytes, at: a.cachedAt };
      }),
      listNote: note(art.items.length, art.count),
    },
    {
      id: "details",
      name: "Title details",
      what: "Metadata for each title page, from Plex, Plex Discover, TMDB and TVDB: cast, ratings, related titles and seasons.",
      where: path.join(data, "detail-cache.sqlite"),
      bytes: details.bytes,
      limitBytes: null,
      items: details.meta + details.related + details.seasons,
      kept: `Details for ${details.meta} titles, related lists for ${details.related} titles, episode lists for ${details.seasons} seasons. Reused for one week and refreshed when Plex updates the title. Filled in advance by cache warming.`,
      list: details.items.map((d) => ({
        name: d.ratingKey, ratingKey: d.ratingKey, title: d.title, bytes: d.bytes, at: d.cachedAt,
        detail: [d.type, d.year].filter(Boolean).join(", ") || undefined,
      })),
      listNote: note(details.items.length, details.meta),
    },
    {
      id: "subtitles",
      name: "Text subtitles",
      what: "Text subtitles extracted from media files, so the next viewer receives them immediately.",
      where: path.join(data, "subtitles.sqlite"),
      bytes: subs.bytes,
      limitBytes: null,
      items: subs.count,
      kept: `${subs.count} subtitle tracks across ${subs.titles} titles. Kept indefinitely and extracted again if the file changes.`,
      list: subs.items.map((s) => ({
        name: `Stream ${s.streamId}`, ratingKey: s.ratingKey, title: title(s.ratingKey), bytes: s.bytes, at: s.cachedAt,
        detail: `${s.format.toUpperCase()}${s.whole === false ? ", read in part so far" : ""}`,
      })),
      listNote: note(subs.items.length, subs.count),
    },
    {
      id: "pgs",
      name: "Image subtitles",
      what: "DVD and Blu-ray (image-based) subtitles extracted from media files by FFmpeg and rendered by the player.",
      where: path.join(data, "subtitles-pgs"),
      bytes: sum(pgs),
      limitBytes: pictureSubtitlesMaxBytes(),
      items: pgs.length,
      kept: "Above FFMPEG_PGS_MAX_GB, the least recently used are removed first. Unused for 60 days: removed.",
      list: pgs.slice(0, LIST).map((f) => ({ name: f.name, ratingKey: null, title: null, bytes: f.bytes, at: f.at })),
      listNote: note(LIST, pgs.length),
    },
    {
      id: "previews",
      name: "Seek-bar previews",
      what: "Seek-bar preview thumbnails generated by FFmpeg for files that have none in Plex.",
      where: path.join(data, "previews"),
      bytes: sum(previews),
      limitBytes: previewsMaxBytes(),
      items: previews.length,
      kept: "Above FFMPEG_PREVIEWS_MAX_GB, the least recently used are removed first.",
      list: previews.slice(0, LIST).map((f) => {
        const key = previewKey(f.name);
        return { name: f.name, ratingKey: key, title: title(key), bytes: f.bytes, at: f.at };
      }),
      listNote: note(LIST, previews.length),
    },
    {
      id: "fonts",
      name: "Subtitle fonts",
      what: "Fonts embedded in media files, used to render styled subtitles.",
      where: path.join(data, "subtitle-fonts"),
      bytes: sum(fonts),
      limitBytes: null,
      items: fonts.length,
      kept: "Kept indefinitely.",
      list: fonts.slice(0, LIST).map((f) => ({ name: f.name, ratingKey: null, title: null, bytes: f.bytes, at: f.at })),
      listNote: note(LIST, fonts.length),
    },
  ];
  // Discord's own cache, in front of the bot: what the players say it handed them.
  return { at: Date.now(), caches, discord: recorder?.discordCache() ?? null };
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
}
