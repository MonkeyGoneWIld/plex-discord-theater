/**
 * A copy's big segments cut into pieces (ffmpeg/split-segment.ts): a film
 * with a keyframe every 30 s, copied by real ffmpeg with the engine's own
 * arguments, in MPEG-TS and in fMP4; each long segment cut, and its pieces
 * read back by ffprobe as the very frames ffmpeg wrote, in the same order.
 * The film is small, so pieces are asked for at a size that makes them about
 * 4 s (`about4s`); left to the engine's sizes, it isn't cut at all. Segments
 * as big as Steins;Gate's, x264's filler making up their bytes, are cut at the
 * engine's own sizes.
 *
 * Skipped where there is no ffmpeg.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyArgs, planCopy } from "../src/services/ffmpeg/plan.js";
import { SPLIT_OVER_BYTES, splitSegment } from "../src/services/ffmpeg/split-segment.js";
import { initTracks, mp4Span } from "../src/services/mp4-timestamps.js";
import { videoSpan } from "../src/services/ts-timestamps.js";

if (spawnSync("ffmpeg", ["-hide_banner", "-version"]).status !== 0) {
  console.log("split-segment: skipped, no ffmpeg on PATH");
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "split-segment-"));
const run = (args: string[], cwd = tmp) => {
  const r = spawnSync(args[0], args.slice(1), { cwd, encoding: "latin1", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${args.slice(0, 3).join(" ")}: ${r.stderr}`);
  return r.stdout;
};

/** 60 s with B-frames, a keyframe at 0 and 30 s only, and the sound given. */
function film(name: string, audio: string[], gop = 720): string {
  run(["ffmpeg", "-hide_banner", "-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "60", "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-bf", "2",
    "-g", String(gop), "-keyint_min", String(gop), "-sc_threshold", "0", "-pix_fmt", "yuv420p", ...audio, name]);
  return path.join(tmp, name);
}

/**
 * `seconds` of a picture with a keyframe at its start only, at `mbps` all
 * through, x264's filler making up what the picture doesn't need, with Opus.
 */
function heavy(name: string, seconds: number, mbps: number): string {
  const rate = `${mbps * 1000}k`;
  run(["ffmpeg", "-hide_banner", "-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", String(seconds), "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
    "-g", "100000", "-keyint_min", "100000", "-sc_threshold", "0",
    "-b:v", rate, "-minrate", rate, "-maxrate", rate, "-bufsize", `${mbps * 500}k`, "-x264-params", "filler=1",
    "-pix_fmt", "yuv420p", "-c:a", "libopus", "-b:a", "64k", "-ac", "1", name]);
  return path.join(tmp, name);
}

/** The film copied as the engine copies it, from `fromS`, into its own folder: its segments' names. */
function copied(file: string, audio: string, fromS = 0): { dir: string; segments: string[] } {
  const plan = planCopy({
    container: "mkv", width: 320, height: 180, partKey: "/library/parts/1/1/file.mkv", file,
    streams: [{ id: 1, streamType: 1, index: 0, codec: "h264", bitDepth: 8 },
      { id: 2, streamType: 2, index: 1, codec: audio, channels: 1, default: true }],
  } as Parameters<typeof planCopy>[0], { audioStreamId: null, hevcOk: true, opusOk: true });
  if (!plan.ok) throw new Error(plan.why);
  const dir = fs.mkdtempSync(path.join(tmp, "run-"));
  run(["ffmpeg", ...copyArgs(plan, ["-i", file], fromS, 60)], dir);
  return { dir, segments: fs.readdirSync(dir).filter((f) => /^\d+\.(ts|m4s)$/.test(f)).sort() };
}

/** Every packet of a stream as ffprobe reads it: decode and presentation time, size, and whether a keyframe. */
function packets(file: string, stream: "v" | "a"): string[] {
  return run(["ffprobe", "-v", "error", "-select_streams", stream, "-show_entries", "packet=pts,dts,size,flags",
    "-of", "csv=p=0", file]).trim().split(/\r?\n/).map((l) => l.replace(/,_*$|_/g, ""));
}

const round1 = (n: number) => Math.round(n * 10) / 10;
/** Pieces of about 4 s of a 30 s segment, however small it is. */
const about4s = (segment: Buffer) => ({ pieceBytes: segment.length / 7.5, splitOverBytes: 0 });
/** Pieces of a size a 30 s segment has in half a second. */
const halfSecond = (segment: Buffer) => ({ pieceBytes: segment.length / 60, splitOverBytes: 0 });

console.log("\n— fMP4: Opus copied, as on 4 November —");
{
  const { dir, segments } = copied(film("opus.mkv", ["-c:a", "libopus", "-b:a", "64k", "-ac", "1"]), "opus");
  const init = fs.readFileSync(path.join(dir, "init.mp4"));
  const tracks = initTracks(init)!;
  const first = fs.readFileSync(path.join(dir, segments[0]));
  check("ffmpeg's first segment is the whole first 30 s, as the film has no keyframe sooner",
    round1(mp4Span(tracks, first)!.end - mp4Span(tracks, first)!.start), 30);
  check("left whole at the engine's sizes: 30 s, but under SPLIT_OVER_BYTES, it comes in about as fast as pieces",
    [first.length < SPLIT_OVER_BYTES, splitSegment(first, tracks)], [true, null]);
  const pieces = splitSegment(first, tracks, about4s(first))!;
  const spans = pieces.map((p) => mp4Span(tracks, p)!);
  check("cut into pieces of about 4 s", spans.map((s) => round1(s.end - s.start) >= 3 && round1(s.end - s.start) <= 4.5),
    spans.map(() => true));
  check("  seven or eight of them", pieces.length >= 7 && pieces.length <= 8, true);
  check("  each lined up after the one before, the first where the segment was",
    [spans.every((s, i) => i === 0 || (s.alignStart > spans[i - 1].alignStart && Math.abs(s.alignStart - spans[i - 1].end) < 0.2)),
      Math.abs(spans[0].alignStart - mp4Span(tracks, first)!.alignStart) < 0.001], [true, true]);
  check("  with sound from the start of each", spans.map((s) => s.audioStart !== null && Math.abs(s.audioStart - s.alignStart) < 0.1),
    spans.map(() => true));

  const whole = path.join(dir, "whole.mp4");
  const cut = path.join(dir, "cut.mp4");
  fs.writeFileSync(whole, Buffer.concat([init, first]));
  fs.writeFileSync(cut, Buffer.concat([init, ...pieces]));
  const before = packets(whole, "v");
  const after = packets(cut, "v");
  check("its pictures, read back by ffprobe, are the ones ffmpeg wrote, times, sizes and keyframes",
    [after.length, after.join("|") === before.join("|")], [before.length, true]);
  check("  only the first piece opens on a keyframe",
    before.filter((l) => l.endsWith(",K")).length, 1);
  const sound = packets(whole, "a");
  check("  and its sound", [packets(cut, "a").length, packets(cut, "a").join("|") === sound.join("|")], [sound.length, true]);
  const decoded = spawnSync("ffmpeg", ["-v", "error", "-i", cut, "-f", "null", "-"], { encoding: "latin1" });
  check("  decoded from the first piece on without an error", [decoded.status, decoded.stderr.trim()], [0, ""]);

  const second = fs.readFileSync(path.join(dir, segments[1]));
  check("the next segment, the last 30 s, is cut too", (splitSegment(second, tracks, about4s(second)) ?? []).length >= 7, true);
  check("but not with no cut allowed until near its end: nothing left to cut",
    splitSegment(first, tracks, { ...about4s(first), notBeforeS: mp4Span(tracks, first)!.end - 0.5 }), null);
  const late = splitSegment(first, tracks, { ...about4s(first), notBeforeS: 10 + 21 })!;
  const lateSpans = late.map((p) => mp4Span(tracks, p)!);
  check("a run's first segment, the player starting 21 s in: no cut before there, so its piece has the keyframe",
    [lateSpans[0].start < 10.1, lateSpans[0].end >= 31, late.length >= 2 && late.length <= 3], [true, true, true]);
  check("  and the pieces after it about 4 s again, not a second each",
    lateSpans.slice(1, -1).every((s) => s.end - s.start >= 3), true);
  const fromStart = splitSegment(first, tracks, { ...about4s(first), notBeforeS: 10 + 1 })!.map((p) => mp4Span(tracks, p)!);
  check("a run from the start: its first piece a share like the rest, not the second before where it starts",
    round1(fromStart[0].end - fromStart[0].start) >= 3, true);

  // A share of its bytes under a second of film, as in Steins;Gate's sixth
  // segment (72 Mbps): pieces a second long, not a few pictures each, as every
  // piece is a download that takes a second and more to get going.
  const fine = splitSegment(first, tracks, halfSecond(first))!;
  const fineSpans = fine.map((p) => mp4Span(tracks, p)!);
  check("a share of its bytes half a second of film: pieces of a second, not of a share",
    [fine.length >= 25 && fine.length <= 30, fineSpans.every((s) => s.end - s.start >= 0.9)], [true, true]);
  fs.writeFileSync(cut, Buffer.concat([init, ...fine]));
  check("  its pictures and sound the ones ffmpeg wrote, decoded without an error",
    [packets(cut, "v").join("|") === before.join("|"), packets(cut, "a").join("|") === sound.join("|"),
      spawnSync("ffmpeg", ["-v", "error", "-i", cut, "-f", "null", "-"], { encoding: "latin1" }).stderr.trim()],
    [true, true, ""]);
}

console.log("\n— MPEG-TS: AAC copied —");
{
  const { dir, segments } = copied(film("aac.mkv", ["-c:a", "aac", "-b:a", "64k", "-ac", "1"]), "aac");
  const first = fs.readFileSync(path.join(dir, segments[0]));
  check("ffmpeg's first segment is the whole first 30 s", round1(videoSpan(first)!.end - videoSpan(first)!.start), 30);
  check("left whole at the engine's sizes", splitSegment(first, null), null);
  const pieces = splitSegment(first, null, about4s(first))!;
  const spans = pieces.map((p) => videoSpan(p)!);
  check("cut into seven or eight pieces of about 4 s",
    [pieces.length >= 7 && pieces.length <= 8, spans.every((s) => s.end - s.start >= 3 && s.end - s.start <= 4.6)], [true, true]);
  const pids = (p: Buffer) => [0, 1, 2, 3].map((k) => ((p[k * 188 + 1] & 0x1f) << 8) | p[k * 188 + 2]);
  check("  each opening with the segment's tables, its PAT among them", pieces.map((p) => pids(p).includes(0)), pieces.map(() => true));
  const share = first.length / 7.5;
  check("  each about a share of its bytes", pieces.map((p) => p.length > share * 0.5 && p.length < share * 1.6), pieces.map(() => true));
  const whole = path.join(dir, "whole.ts");
  const cut = path.join(dir, "cut.ts");
  fs.writeFileSync(whole, first);
  fs.writeFileSync(cut, Buffer.concat(pieces));
  const before = packets(whole, "v");
  check("its pictures and sound, read back, are the ones ffmpeg wrote",
    [packets(cut, "v").join("|") === before.join("|"), packets(cut, "a").join("|") === packets(whole, "a").join("|"), before.length > 700],
    [true, true, true]);
  const alone = path.join(dir, "piece.ts");
  fs.writeFileSync(alone, pieces[3]);
  check("  a piece on its own reads as the frames in it, none a keyframe",
    [packets(alone, "v").length > 80, packets(alone, "v").some((l) => l.endsWith(",K"))], [true, false]);

  const fine = splitSegment(first, null, halfSecond(first))!;
  const fineSpans = fine.map((p) => videoSpan(p)!);
  check("a share of its bytes half a second of film: pieces of a second, not of a share",
    [fine.length >= 25 && fine.length <= 30, fineSpans.every((s) => s.end - s.start >= 0.9)], [true, true]);
  fs.writeFileSync(cut, Buffer.concat(fine));
  const decode = (file: string) => spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"], { encoding: "latin1" })
    .stderr.replace(/@ [0-9a-f]+\]/g, "]").trim();
  check("  its pictures and sound the ones ffmpeg wrote, decoded as the whole one is",
    [packets(cut, "v").join("|") === before.join("|"), packets(cut, "a").join("|") === packets(whole, "a").join("|"),
      decode(cut) === decode(whole)],
    [true, true, true]);
}

console.log("\n— Steins;Gate's opening, at the engine's own sizes —");
{
  // Its second segment, 16.7 MB in 4.4 s, and its sixth, 106 MB in 11.8 s,
  // as the bot copied them on 6 November. Every piece is a download through
  // Discord's proxy, a second and more before it gets going: cut into 4 and
  // 25 that night, it took 19 s to start and stopped for 69 at the sixth.
  const second = copied(heavy("second.mkv", 4.4, 30), "opus");
  const secondSeg = fs.readFileSync(path.join(second.dir, second.segments[0]));
  const secondTracks = initTracks(fs.readFileSync(path.join(second.dir, "init.mp4")))!;
  check("its second segment made as big as it was: 15 to 18 MB, one segment",
    [secondSeg.length > 15e6 && secondSeg.length < 18e6, second.segments.length], [true, 1]);
  check("  left whole", splitSegment(secondSeg, secondTracks), null);

  const sixth = copied(heavy("sixth.mkv", 11.8, 72), "opus");
  const big = fs.readFileSync(path.join(sixth.dir, sixth.segments[0]));
  const bigTracks = initTracks(fs.readFileSync(path.join(sixth.dir, "init.mp4")))!;
  check("its sixth made as big as it was: 102 to 114 MB, one segment",
    [big.length > 102e6 && big.length < 114e6, sixth.segments.length], [true, 1]);
  const pieces = splitSegment(big, bigTracks) ?? [];
  const spans = pieces.map((p) => mp4Span(bigTracks, p)!);
  check("  cut into nine pieces of about 12 MB, each over a second",
    [pieces.length, pieces.every((p) => p.length > 8e6 && p.length < 16e6), spans.every((s) => s.end - s.start >= 1)],
    [9, true, true]);
  const whole = path.join(sixth.dir, "whole.mp4");
  const cut = path.join(sixth.dir, "cut.mp4");
  const init = fs.readFileSync(path.join(sixth.dir, "init.mp4"));
  fs.writeFileSync(whole, Buffer.concat([init, big]));
  fs.writeFileSync(cut, Buffer.concat([init, ...pieces]));
  check("  its pictures and sound the ones ffmpeg wrote",
    [packets(cut, "v").join("|") === packets(whole, "v").join("|"), packets(cut, "a").join("|") === packets(whole, "a").join("|")],
    [true, true]);
}

console.log("\n— segments the film's keyframes keep short —");
{
  const { dir, segments } = copied(film("short.mkv", ["-c:a", "aac", "-b:a", "64k", "-ac", "1"], 48), "aac");
  const lists = segments.map((s) => splitSegment(fs.readFileSync(path.join(dir, s)), null));
  check("a keyframe every 2 s: every segment left whole", [segments.length >= 14, lists.every((l) => l === null)], [true, true]);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
