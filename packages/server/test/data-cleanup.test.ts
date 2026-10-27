import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "data-cleanup-"));
process.env.THUMB_CACHE_DIR = data;
const { cleanDataFolder } = await import("../src/services/data-cleanup.js");

const DAY = 24 * 60 * 60_000;
const put = (rel: string, bytes = 10, ageDays = 0) => {
  const file = path.join(data, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes));
  const at = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(file, at, at);
  return file;
};
const age = (dir: string, days: number) => {
  const at = new Date(Date.now() - days * DAY);
  fs.utimesSync(dir, at, at);
};

// Kept on purpose.
put("thumb-cache.sqlite", 100);
put("previews/a.bif", 10, 100);
put("subtitle-fonts/f.ttf", 10, 100);
const playing = put("stream-cache/ffmpeg/live/run/seg1.ts");
const used = put("subtitles-pgs/new-1.sup", 10, 3);
// Not used any more.
put("hls/1db3de61/seg.ts", 2 * 1024 * 1024);
const oldPgs = put("subtitles-pgs/old-1.sup", 10, 90);
put("diagnose/2026-10-01-gpu.txt", 10, 30);
put("diagnose/2026-10-01-file/sample.mp4", 10, 30);
age(path.join(data, "diagnose/2026-10-01-file"), 30);
const recentReport = put("diagnose/2026-10-26-gpu.txt", 10, 1);
for (const dir of ["stream-cache/ffmpeg/gone-1", "stream-cache/ffmpeg/gone-2/run"]) {
  fs.mkdirSync(path.join(data, dir), { recursive: true });
}
age(path.join(data, "stream-cache/ffmpeg/gone-2/run"), 1);
age(path.join(data, "stream-cache/ffmpeg/gone-2"), 1);
age(path.join(data, "stream-cache/ffmpeg/gone-1"), 1);
// Made a moment ago: a run may be about to write to it.
fs.mkdirSync(path.join(data, "stream-cache/ffmpeg/starting"), { recursive: true });

const done = await cleanDataFolder(path.join(data, "stream-cache"));
assert.deepEqual(done, { oldHls: "1 (2 MB)", emptyFolders: "3", diagnose: "2", pictureSubtitles: "1" });
assert.equal(fs.existsSync(path.join(data, "hls")), false, "the old hls folder goes");
assert.equal(fs.existsSync(oldPgs), false, "a picture subtitle unplayed for 60 days goes");
assert.equal(fs.existsSync(used), true, "one played lately stays");
assert.equal(fs.existsSync(recentReport), true, "a recent diagnose report stays");
assert.deepEqual(fs.readdirSync(path.join(data, "diagnose")), ["2026-10-26-gpu.txt"]);
assert.equal(fs.existsSync(playing), true, "a stream being played keeps its segments");
assert.deepEqual(fs.readdirSync(path.join(data, "stream-cache/ffmpeg")).sort(), ["live", "starting"],
  "empty folders go, but not one just made");
for (const keep of ["thumb-cache.sqlite", "previews/a.bif", "subtitle-fonts/f.ttf"]) {
  assert.equal(fs.existsSync(path.join(data, keep)), true, `${keep} stays`);
}
assert.deepEqual(await cleanDataFolder(path.join(data, "stream-cache")), {}, "a second pass finds nothing");
fs.rmSync(data, { recursive: true, force: true });
console.log("data-cleanup: ok");
