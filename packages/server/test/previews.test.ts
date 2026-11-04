/**
 * Seek-bar previews made by ffmpeg: what is left on disk when they can't be
 * kept. Skipped where there is no ffmpeg.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
if (spawnSync(ffmpeg, ["-hide_banner", "-version"]).status !== 0) {
  console.log("previews: skipped, no ffmpeg on PATH");
  process.exit(0);
}

const data = fs.mkdtempSync(path.join(os.tmpdir(), "previews-"));
process.env.THUMB_CACHE_DIR = data;

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       expected ${e}\n       got      ${a}`); }
}

const film = path.join(data, "film.mkv");
const made = spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-f", "lavfi",
  "-i", "testsrc2=size=320x180:rate=10", "-t", "20", "-c:v", "mpeg4", "-g", "20", film]);
if (made.status !== 0) throw new Error(`couldn't make the film: ${made.stderr}`);

const { makePreview, forgetPreviewFailures } = await import("../src/services/ffmpeg/previews.js");
const previews = path.join(data, "previews");
const left = () => (fs.existsSync(previews) ? fs.readdirSync(previews).sort() : []);
const source = { partId: 7, fileSize: 1, film, durationS: 20, hdr: false };

console.log("\n— previews that can't be written —");
{
  // The disk fills partway through the write.
  const write = fs.writeFileSync;
  fs.writeFileSync = ((file: fs.PathOrFileDescriptor, bytes: Buffer, ...rest: []) => {
    if (!String(file).endsWith(".tmp")) return write(file, bytes, ...rest);
    write(file, bytes.subarray(0, 100));
    throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  }) as typeof fs.writeFileSync;
  try {
    check("none are kept", await makePreview(source), null);
  } finally {
    fs.writeFileSync = write;
  }
  check("and nothing half-written is left behind", left(), []);
}

console.log("\n— previews made again —");
{
  forgetPreviewFailures();
  const file = await makePreview(source);
  check("are kept, alone", [file && path.basename(file), left()], [path.basename(file ?? ""), [path.basename(file ?? "")]]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
