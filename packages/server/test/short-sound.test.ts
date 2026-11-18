/**
 * A file whose sound stops before its picture (ffmpeg/plan.ts audioArgs).
 *
 * 18 November: Verity's sound ends at 7002.8 s and its picture at 7256.8 s.
 * A browser plays only as far as both are in, so the player sat "buffering"
 * at 7002.8 s; on 15 November it took that for a broken stream's end and
 * ended the film four minutes early. Converted sound now goes on as silence
 * to the end of the picture.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { audioArgs } from "../src/services/ffmpeg/plan.js";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
if (spawnSync(FFMPEG, ["-hide_banner", "-version"]).status !== 0) {
  console.log("short-sound: skipped, no ffmpeg on PATH");
  process.exit(0);
}

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "short-sound-"));
const run = (args: string[]) => {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-v", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
};
/** Where a file's last sound packet ends, in seconds. */
const soundEnd = (file: string) => {
  const out = spawnSync(FFPROBE, ["-v", "error", "-select_streams", "a:0", "-show_entries", "packet=pts_time,duration_time",
    "-of", "csv=p=0", file], { encoding: "utf8" }).stdout.trim().split(/\r?\n/).map((l) => l.split(",").map(Number));
  return Math.max(...out.map(([pts, d]) => pts + (d || 0)).filter(Number.isFinite));
};
const pictureEnd = (file: string) => {
  const out = spawnSync(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time",
    "-of", "csv=p=0", file], { encoding: "utf8" }).stdout.trim().split(/\r?\n/).map(Number).filter(Number.isFinite);
  return { start: Math.min(...out), end: Math.max(...out) };
};

// Twelve seconds of picture, sound for the first five, in EAC3 as Verity's.
const film = path.join(tmp, "short-sound.mkv");
run(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=12", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=5",
  "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-g", "48", "-pix_fmt", "yuv420p",
  "-c:a", "eac3", "-ac", "6", "-b:a", "384k", film]);
check("the film: sound ends at 5 s, picture at 12 s", [Math.round(soundEnd(film)), Math.round(pictureEnd(film).end)], [5, 12]);

const converted = { audio: { index: 1 } as never, audioCopy: false, audioOut: { codec: "aac", channels: 6, kbps: 448 } as never };
for (const [name, out] of [["AAC", converted], ["FLAC", { ...converted, audioOut: { codec: "flac", channels: 2, kbps: 0 } as never }]] as const) {
  // FLAC as the engine puts it in MP4 needs -strict here; in Matroska it is the same sound.
  const made = path.join(tmp, name === "FLAC" ? "out.mkv" : "out.ts");
  run(["-i", film, "-map", "0:v", "-map", "0:a", "-c:v", "copy", ...audioArgs(out), made]);
  const sound = soundEnd(made);
  const picture = pictureEnd(made);
  check(`converted to ${name}: the sound goes on, silent, to the end of the picture, and no further`,
    [Math.abs(sound - picture.end) < 0.6, sound > 11], [true, true]);
}
check("sound copied as it is is left as it is", audioArgs({ ...converted, audioCopy: true }), ["-c:a", "copy"]);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
