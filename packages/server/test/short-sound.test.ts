/**
 * A file whose sound stops before its picture (ffmpeg/plan.ts audioArgs).
 *
 * Verity's sound ends at 7002.8 s and its picture at 7256.8 s. A browser
 * plays only as far as both are in, so the player sat "buffering" at 7002.8 s;
 * on 15 November it took that for a broken stream's end and ended the film
 * four minutes early.
 *
 * 18 November: apad with -shortest, the first fill, was still stuck at
 * 7002.8 s. ffmpeg starts the silence when it finds the sound has run out,
 * and the film read once runs out only at the end of the file, so every
 * segment past 7002.8 s went out with no sound. The sound is now read through
 * an opening of the film of its own, which runs out where the sound does.
 * Checked here as the bot runs it: a seek, its segments, and much more picture
 * past the sound's end than ffmpeg holds back to interleave.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { audioArgs, copyArgs, encodeArgs, inputArgs } from "../src/services/ffmpeg/plan.js";
import { probe, soundPadTo, streamLength } from "../src/services/ffmpeg/probe.js";

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
const run = (args: string[], cwd = tmp) => {
  const r = spawnSync(FFMPEG, args, { encoding: "utf8", cwd });
  if (r.status !== 0) throw new Error(r.stderr);
};
/** Each packet's time, a stream of a file. */
const times = (file: string, stream: "a:0" | "v:0") =>
  spawnSync(FFPROBE, ["-v", "error", "-select_streams", stream, "-show_entries", "packet=pts_time", "-of", "csv=p=0", file], { encoding: "utf8" })
    .stdout.split(/\r?\n/).map((l) => parseFloat(l)).filter(Number.isFinite);

// A minute of picture, sound for the first ten seconds, in EAC3 as Verity's.
const film = path.join(tmp, "short-sound.mkv");
run(["-hide_banner", "-v", "error", "-y",
  "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=60", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=10",
  "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-g", "48", "-pix_fmt", "yuv420p",
  "-c:a", "eac3", "-ac", "6", "-b:a", "384k", film]);

const probed = await probe(inputArgs({ local: film }));
const sound = probed?.streams.find((s) => s.index === 1)?.durationS ?? null;
check("the file says its sound stops at 10 s and it runs to 60 s",
  [sound !== null && Math.round(sound), probed?.durationS != null && Math.round(probed.durationS)], [10, 60]);
const padTo = soundPadTo(probed, 1);
check("  so its sound is filled to the end of the file", padTo !== null && Math.round(padTo), 60);
check("  a sound that runs to the end is left alone, and a file that doesn't say is too",
  [soundPadTo(probed && { ...probed, durationS: 10.5 }, 1), soundPadTo(null, 1)], [null, null]);
check("a stream's length: Matroska's tag first, else its own",
  [streamLength({ tags: { DURATION: "01:56:42.848000000" } }), streamLength({ duration: "7256.834", tags: { "DURATION-eng": "01:49:43.5" } }),
    streamLength({ duration: "12.5" }), streamLength({})],
  [7002.848, 6583.5, 12.5, null]);

const plan = {
  ok: true, video: { index: 0 }, audio: { index: 1 }, audioCopy: false, audioOut: { codec: "aac", channels: 6, kbps: 448 },
  codec: "h264", fmp4: false, sdrPeakNits: null, padSoundToS: padTo,
} as unknown as Parameters<typeof copyArgs>[0];

/** A copy run as the bot makes one, from `fromS`, into segments; each segment's picture and sound. */
const segmentsOf = (name: string, fromS: number, toS: number | null = null) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  run(copyArgs(plan, inputArgs({ local: film }), fromS, 60, 4, toS).map((a) => (a === "pipe:1" ? "list.csv" : a)), dir);
  return fs.readdirSync(dir).filter((f) => f.endsWith(".ts")).sort().map((f) => {
    const v = times(path.join(dir, f), "v:0");
    const a = times(path.join(dir, f), "a:0");
    return { f, v: [Math.min(...v), Math.max(...v)], a: a.length ? [Math.min(...a), Math.max(...a)] : null };
  });
};
// Sound over the whole of each segment's picture: what a browser needs to play past it.
const unsounded = (segs: ReturnType<typeof segmentsOf>) =>
  segs.filter((s) => !s.a || s.a[0] > s.v[0] + 0.1 || s.a[1] < s.v[1] - 0.1).map((s) => s.f);

const seeked = segmentsOf("seeked", 6);
check("a run from a seek: every segment has sound for all its picture, past where the sound stopped", unsounded(seeked), []);
check("  and the sound stops with the picture, no further",
  Math.abs(seeked.at(-1)!.a![1] - seeked.at(-1)!.v[1]) < 0.1, true);
check("a run from the start too", unsounded(segmentsOf("start", 0)), []);
const early = segmentsOf("early", 0, 30);
check("a run that stops before the end (a run's backfill): sound to where it stops, no further",
  [unsounded(early), Math.abs(early.at(-1)!.a![1] - early.at(-1)!.v[1]) < 0.1], [[], true]);

console.log("\n— the arguments —");
const args = copyArgs(plan, ["-i", "film.mkv"], 300, 7256.8);
check("the film opened twice, the second on the same seek, its sound from there",
  [args.filter((a) => a === "-i").length, args.filter((a) => a === "-noaccurate_seek").length, args[args.indexOf("-map", args.indexOf("-map") + 1) + 1]],
  [2, 2, "1:1"]);
check("silent to the picture's end, or a backfill's, and not stopped at the shorter stream",
  [audioArgs(plan).at(-1), audioArgs(plan, 30).at(-1), audioArgs(plan).includes("-shortest")],
  [`aresample=async=1,apad,atrim=end=${(padTo ?? 0).toFixed(3)}`, "aresample=async=1,apad,atrim=end=30.000", false]);
const plain = { ...plan, padSoundToS: null };
const once = copyArgs(plain, ["-i", "film.mkv"], 300, 7256.8);
check("any other sound: the film opened once, as before",
  [once.filter((a) => a === "-i").length, audioArgs(plain).slice(-3)], [1, ["-af", "aresample=async=1,apad", "-shortest"]]);
check("sound copied as it is is left as it is", audioArgs({ ...plan, audioCopy: true }), ["-c:a", "copy"]);
const enc = (burn: unknown) => {
  const a = encodeArgs({ ...plan, width: 1920, height: 1080, hardware: "cpu", color: {}, kbps: 8000, peakKbps: 12000, burn } as never,
    ["-i", "film.mkv"], 300, 7256.8, "");
  return a[a.lastIndexOf("-map") + 1];
};
check("re-encoding: its sound from the second opening, after a picture subtitle's own file",
  [enc(null), enc({ kind: "picture-sidecar", file: "subs.sup" })], ["1:1", "2:1"]);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
