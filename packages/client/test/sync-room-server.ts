// Server for the sync-room fixture:
//   npx tsx packages/client/test/sync-room-server.ts
// then `npm run dev -w packages/client` and open /test/sync-room.html.
//
// The real room — the sync server and P2P tracker from packages/server, on
// port 3000 where the dev server's /ws, /tracker and /api proxies point — and
// a stand-in for Plex serving the media-errors fixture's two-minute stream
// (generate it once with media-errors-server.mjs). Nothing else of the app's
// server runs: every other /api call answers an empty 200.
//
// A player's segments can be held back on demand, to make one player's stream
// stall while the others' doesn't:
//   POST /api/test/stall?user=u-host&ms=6000
// and every download of a player's can be held to a speed, as each one through
// Discord's proxy is, however many run beside it:
//   POST /api/test/flow?user=u-host&kbps=6000
//
// and all of them together held to one connection's speed, as the bot's own
// upload holds every player's downloads at once:
//   POST /api/test/upload?kbps=40000
//
// /api/test/reset?stream=copy plays a stream shaped like a copied film instead
// — one segment per ten-second keyframe interval, ~10 MB each, made once with
// ffmpeg — whose playlist gives each segment's size, as the bot's does, so the
// players fetch them in parts (lib/segmentParts). &parts=0 leaves the sizes out.
// &event=1 lists it as the bot lists a copy: from where the stream was asked
// to start, the next 40s, still growing, so a skip past that rebuilds the
// stream there, and &manifestMs= has a new one's playlist take that long to
// come, as Plex starting a copy does. stream=copy4 is the same with a
// four-second keyframe interval, ~4 MB a segment, and stream=copy4long the
// same five minutes long. stream=hdr is HEVC Main 10 marked PQ (HDR10), in
// four-second segments, as the ffmpeg engine sends a re-encode that keeps HDR;
// with &notes=1 its notes say HDR10, as the server says of an HDR stream.
//
// &cache=1 answers segments as the bot does, for the browser to keep five
// minutes (Cache-Control) — and so for the page after a pop-out to find them.
// &cache=none for it to keep none of them (no-store), as a browser that has
// let them go has none. &fresh=1 gives the segments addresses no earlier run
// had, so none of theirs is found in the browser's cache.
//
// &hevc=1 has the room take every stream for HEVC, as a copy of an HEVC film
// is — the media is the same H.264, which nobody but the sync server looks
// at — and a stream asked for by a player told it can't play HEVC
//   POST /api/test/nohevc?user=u-host
// for one re-encoded to H.264 for want of it, as the bot's are.
//
// &previews=1 gives the title preview frames, as Plex has them for most
// films: /api/plex/preview/<part>/index sends them a pass at a time as the
// bot does, each after &previewDelayMs= (Plex reading the file out), and
// /api/test/previews lists who was sent which pass.
//
// stream=sg is shaped like Steins;Gate's first episode as the bot copied it on
// 6 November (see makeSgStream), listed as the bot lists a copy, its big
// segments cut into pieces by the bot's own split-segment.ts: &split=4,6,1 for
// pieces of about 4 MB of segments of 6 MB or more, none under a second;
// &split=none for none cut; unset, split-segment.ts's own sizes. And
//   POST /api/test/flow?user=u-host&kbps=2000&latencyMs=300&slowMs=1030
// holds each of a user's downloads as one through Discord's proxy is: its
// first byte after latencyMs, the rest from slowMs after that, at kbps.
// /api/test/streams says when each user first asked for the stream.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

process.env.THUMB_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sync-room-"));
const { attachWebSocketServer } = await import("../../server/src/services/sync.js");
const { createSession, getSessionUserId } = await import("../../server/src/middleware/auth.js");
const { instanceHosts } = await import("../../server/src/routes/discord.js");
const { progressivePreview } = await import("../../server/src/services/preview-stream.js");
const { recordSessionVideoCodec, recordHevcWithheld, recordSessionHdr } = await import("../../server/src/routes/plex.js");
const { measuredPlaylist } = await import("../../server/src/services/measured-playlist.js");
const { initTracks, mp4Span } = await import("../../server/src/services/mp4-timestamps.js");
const { splitSegment } = await import("../../server/src/services/ffmpeg/split-segment.js");

const PORT = 3000;
const SMALL_STREAM = path.join(os.tmpdir(), "plex-theater-media-errors");
const COPY_STREAM = path.join(os.tmpdir(), "plex-theater-copy-stream");
const COPY4_STREAM = path.join(os.tmpdir(), "plex-theater-copy4-stream");
const COPY4_LONG_STREAM = path.join(os.tmpdir(), "plex-theater-copy4long-stream");
const HDR_STREAM = path.join(os.tmpdir(), "plex-theater-hdr-stream");
const SG_STREAM = path.join(os.tmpdir(), "plex-theater-sg-stream");
/** Each copied stream's keyframe interval, which is its segments' length. */
const SEGMENT_S = new Map([[COPY_STREAM, 10], [COPY4_STREAM, 4], [COPY4_LONG_STREAM, 4], [HDR_STREAM, 4]]);
/** How long each stream is, seconds: two minutes, but for the long one. */
const LENGTH_S = new Map([[COPY4_LONG_STREAM, 300], [SG_STREAM, 121]]);
const lengthOf = (dir: string) => LENGTH_S.get(dir) ?? 120;
/**
 * The room every player of a check joins. A new one for each check: the
 * server keeps a room everybody has left for half a minute (holdEmptyRoom),
 * and the next check would otherwise walk into the last one's.
 */
let instance = "sync-room";
let resets = 0;
if (!fs.existsSync(path.join(SMALL_STREAM, "index.m3u8"))) {
  console.error(`No test stream in ${SMALL_STREAM} — run media-errors-server.mjs once to generate it.`);
  process.exit(1);
}
for (const [dir, segmentS] of SEGMENT_S) {
  if (fs.existsSync(path.join(dir, "index.m3u8"))) continue;
  fs.mkdirSync(dir, { recursive: true });
  console.log("generating a copied-film stream in", dir);
  const gop = String(segmentS * 24);
  const video = dir === HDR_STREAM
    ? ["-c:v", "libx265", "-preset", "ultrafast", "-b:v", "4M", "-pix_fmt", "yuv420p10le", "-x265-params",
      `log-level=error:keyint=${gop}:min-keyint=${gop}:scenecut=0:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:hdr10=1:max-cll=1000,400`]
    : ["-c:v", "libx264", "-preset", "veryfast", "-b:v", "8M", "-maxrate", "8M", "-bufsize", "16M",
      "-g", gop, "-keyint_min", gop, "-sc_threshold", "0", "-pix_fmt", "yuv420p"];
  const made = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", String(lengthOf(dir)), ...video, "-c:a", "aac", "-b:a", "128k",
    "-f", "hls", "-hls_time", String(segmentS), "-hls_list_size", "0", "-hls_playlist_type", "vod",
    "-hls_segment_filename", path.join(dir, "seg%03d.ts"), path.join(dir, "index.m3u8"),
  ], { stdio: "inherit" });
  if (made.status !== 0) { console.error("ffmpeg failed — is it on the PATH?"); process.exit(1); }
}

/** The copy's clock: the film's own plus this, as the bot's copies are (plan.ts COPY_CLOCK_OFFSET_S). */
const SG_CLOCK_S = 10;
/**
 * Steins;Gate's first episode as the bot copied it on 6 November: its first
 * six segments as long and as big as they were — 11.3, 16.7, 10.3, 7.6 and
 * 5.6 MB, then 106 MB in 11.8 s, the film going 12 s without a keyframe at 72
 * Mbps — and four-second ones at 2.5 Mbps after, two minutes in all. Each
 * stretch is [pictures at 23.976 a second, MB with its sound]. The first two
 * segments have the most in their last second, as the film's had: cut with
 * pieces of 4 MB, none under a second, they came as 3.8 and 7.5 MB, and as
 * 4.3, 4.2 and 8.2.
 *
 * H.264 at a constant rate padded out with filler, so a test pattern comes to
 * the size the film did, each stretch opening on a keyframe; cut, as fMP4, as
 * the bot cuts a copy (plan.ts fmp4SegmentArgs), on the copy's clock.
 */
const SG_SECTIONS: Array<[number, number]> = [[76, 5.94], [24, 5.37], [81, 11.83], [24, 4.85], [99, 10.25], [115, 7.59],
  [91, 5.6], [283, 105.87], ...Array.from({ length: 22 }, (): [number, number] => [96, 1.25])];
function makeSgStream(dir: string) {
  console.log("generating a Steins;Gate-shaped stream in", dir);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const ffmpeg = (args: string[]) => {
    const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "latin1", cwd: dir });
    if (r.status !== 0) { console.error("ffmpeg failed — is it on the PATH?", r.stderr); process.exit(1); }
  };
  const fps = 24000 / 1001;
  const soundBytesPerS = 128_000 / 8 + 1_500;
  const list: string[] = [];
  let frames = 0;
  for (const [i, [count, mb]] of SG_SECTIONS.entries()) {
    const s = count / fps;
    const want = mb * 1e6 - soundBytesPerS * s;
    let kbps = (want * 8) / s / 1000;
    const name = `s${String(i).padStart(2, "0")}.mkv`;
    // The encoder comes in a little under the rate it is given: asked again until it's within 2%.
    for (let pass = 0; pass < 3; pass++) {
      const rate = `${Math.round(kbps)}k`;
      ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24000/1001", "-frames:v", String(count),
        "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-level", "4.1",
        "-g", "100000", "-keyint_min", "100000", "-sc_threshold", "0",
        "-b:v", rate, "-minrate", rate, "-maxrate", rate, "-bufsize", `${Math.round(kbps / 2)}k`,
        "-x264-params", "filler=1", "-pix_fmt", "yuv420p", "-an", name]);
      const got = fs.statSync(path.join(dir, name)).size;
      if (Math.abs(got - want) / want < 0.02) break;
      kbps *= want / got;
    }
    list.push(`file '${name}'`);
    frames += count;
  }
  fs.writeFileSync(path.join(dir, "list.txt"), list.join("\n") + "\n");
  ffmpeg(["-f", "concat", "-safe", "0", "-i", "list.txt",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", (frames / fps).toFixed(3),
    "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
    "-output_ts_offset", String(SG_CLOCK_S), "-f", "hls", "-hls_segment_type", "fmp4", "-hls_time", "3.9375",
    "-hls_list_size", "0", "-hls_fmp4_init_filename", "init.mp4", "-hls_segment_filename", "%05d.m4s",
    "-hls_segment_options", "movflags=+frag_discont+negative_cts_offsets:use_editlist=0", "index.m3u8"]);
  for (const f of fs.readdirSync(dir)) if (/^s\d+\.mkv$|^list\.txt$/.test(f)) fs.rmSync(path.join(dir, f));
  fs.writeFileSync(path.join(dir, "made"), "");
}

/** A piece's name after its segment's, as the bot's: 00005aa.m4s, 00005ab.m4s… (engine.ts pieceName). */
const pieceName = (i: number) => String.fromCharCode(97 + Math.floor(i / 26) % 26, 97 + (i % 26));
/** stream=sg as this check lists it: where its pieces are, its playlist, and what was cut how. */
let sgRun: { id: number; dir: string; playlist: string; layout: string[] } | null = null;
/** The segments read, kept: a part of one is a read of all of it otherwise. */
const sgRead = new Map<string, Buffer>();
/**
 * stream=sg laid out as the bot lays out a copy from its start (engine.ts):
 * each segment cut into pieces as split-segment.ts cuts it — with `split`'s
 * sizes, "MB,MB,s" (piece, over, shortest), or none with "none" — none in the
 * first one's first second, and each listed at its measured times on the
 * film's clock, every one's size on its URL (measured-playlist.ts).
 */
function layOutSg(split: string | null) {
  const runs = path.join(SG_STREAM, "runs");
  fs.rmSync(runs, { recursive: true, force: true });
  sgRead.clear();
  const id = resets;
  const dir = path.join(runs, String(id));
  fs.mkdirSync(dir, { recursive: true });
  const init = fs.readFileSync(path.join(SG_STREAM, "init.mp4"));
  const tracks = initTracks(init);
  if (!tracks) throw new Error("no tracks in the init segment");
  const sizes = split && split !== "none" ? split.split(",").map(Number) : null;
  const options = sizes
    ? { pieceBytes: sizes[0] * 1e6, splitOverBytes: sizes[1] * 1e6, ...(sizes[2] ? { minPieceS: sizes[2] } : {}) }
    : {};
  const base = `/api/test/stream/sg/${id}`;
  const segments = [];
  const layout: string[] = [];
  const names = fs.readdirSync(SG_STREAM).filter((f) => /^\d{5}\.m4s$/.test(f)).sort();
  for (const [i, name] of names.entries()) {
    const data = fs.readFileSync(path.join(SG_STREAM, name));
    const pieces = split === "none" ? null : splitSegment(data, tracks, { ...options, notBeforeS: i === 0 ? SG_CLOCK_S + 1 : undefined });
    const list = pieces ? pieces.map((d, j) => ({ name: `${name.slice(0, 5)}${pieceName(j)}.m4s`, data: d })) : [{ name, data }];
    const said: string[] = [];
    for (const piece of list) {
      if (pieces) fs.writeFileSync(path.join(dir, piece.name), piece.data);
      const span = mp4Span(tracks, piece.data);
      if (!span) throw new Error(`no times in ${piece.name}`);
      said.push(`${(piece.data.length / 1e6).toFixed(1)}MB/${(span.end - span.start).toFixed(2)}s`);
      segments.push({
        path: `${base}/${piece.name}`, start: span.alignStart - SG_CLOCK_S, end: span.end - SG_CLOCK_S,
        videoStart: span.start - SG_CLOCK_S, audioStart: span.audioStart === null ? null : span.audioStart - SG_CLOCK_S,
        bytes: piece.data.length, init: { path: `${base}/init.mp4`, bytes: init.length },
      });
    }
    if (i < 7) layout.push(`${name}: ${said.join(" ")}`);
  }
  const playlist = measuredPlaylist({
    segments, published: segments.length, offsetS: 0, ended: true, targetDuration: 0, urlFor: (p, bytes) => `${p}?n=${bytes}`,
  }).text;
  sgRun = { id, dir, playlist, layout };
  console.log(`[sg] split ${split ?? "as split-segment.ts has it"}: ${segments.length} listed\n  ${layout.join("\n  ")}`);
}
/** A file of stream=sg's: one of this run's pieces, or a segment or the init segment as they are. */
function sgFile(id: number, name: string): Buffer | null {
  const piece = path.join(SG_STREAM, "runs", String(id), name);
  const file = fs.existsSync(piece) ? piece : path.join(SG_STREAM, name);
  if (!fs.existsSync(file)) return null;
  const kept = sgRead.get(file) ?? fs.readFileSync(file);
  sgRead.set(file, kept);
  return kept;
}
if (!fs.existsSync(path.join(SG_STREAM, "made"))) makeSgStream(SG_STREAM);

let streamDir = SMALL_STREAM;
/** Whether the playlist gives segment sizes, for the players to fetch in parts. */
let partsOn = true;
/** Whether segments are answered for the browser to keep, as the bot's are — see &cache=1. */
let cacheOn = false;
let cacheNone = false;
/** On every segment's address, so none of an earlier run's is found in the browser's cache — see &fresh=1. */
let urlTag = "";

/** Until when each user's segments are held back. */
const stallUntil = new Map<string, number>();
/**
 * How often each user may have a segment, ms — a connection only a little
 * faster than the stream, so their buffer stays short and a stall reaches
 * the picture. Unset is as fast as the disk.
 */
const paceMs = new Map<string, number>();
const nextSlot = new Map<string, number>();
/** Each user's speed per download, kbps — unset is as fast as the disk. */
const flowKbps = new Map<string, number>();
/** How long each of a user's downloads takes to its first byte, ms, and then
 *  to get going past its first SLOW_AFTER_BYTES — Discord's proxy's, about
 *  0.3 and another second (split-segment.ts has the measurements). */
const latencyMs = new Map<string, number>();
const slowMs = new Map<string, number>();
const SLOW_AFTER_BYTES = 16_384;
/** When each user first asked for the stream, since the last reset. */
const streamsAsked: Array<{ user: string; at: number }> = [];
const lateAnswer = async (who: string | null) => {
  const ms = latencyMs.get(who ?? "") ?? 0;
  if (ms) await new Promise((r) => setTimeout(r, ms));
};
/** Every download's together, kbps, and when the shared connection is next free. */
let uploadKbps = 0;
let uploadFreeAt = 0;
/** Whether a copy is listed the way the bot lists one — see &event=1. */
let eventList = false;
/** How much of a copy the playlist lists from where it starts: 40s, or
 *  &eventS= — a longer list keeps a skip inside it in place. */
let eventS = 40;
/** &manifestMs=: how long a new copy's playlist takes to come, as the bot's
 *  takes while Plex starts the copy — a second or so. */
let manifestMs = 0;
/** &endlist=1: a copy made to its end, whose list says so once it lists the
 *  last segment — the bot's, once ffmpeg reaches the end of the file. */
let endlist = false;
/** &plexS=: the length Plex gives the title, seconds, when it isn't the
 *  file's — Grimm S3E7's was 97 hours on 21 October. */
let plexS = 0;
/** Where each session was asked to start: its owner says, everyone else joins it. */
const sessionStart = new Map<string, number>();
/** Whether streams are HEVC, and who can't play it — see &hevc=1. */
let hevcOn = false;
const noHevc = new Set<string>();
/** With &hevc=1, whether they are HDR too, and whose screen has left it —
 *  POST /api/test/nohdr?user=u-host. */
let hdrOn = false;
const noHdr = new Set<string>();
/** The sessions whose codec has been said, by whoever asked for each first. */
const codecSaid = new Set<string>();
/**
 * &notes=1: the stream's master playlist carries the notes the bot writes
 * into one (routes/plex.ts streamNotes) — the original video, its EAC3 5.1
 * audio converted to AAC — for Stats for nerds to show.
 */
let notesOn = false;
/** Whether titles have preview frames, and how long Plex takes to start sending them. */
let previewsOn = false;
let previewDelayMs = 0;
/** Preview passes sent, per user: which, when asked, when the last byte went. */
const previewsSent: Array<{ user: string; pass: number | null; askedAt: number; at: number; bytes: number }> = [];
/**
 * A two-minute title's preview index, one frame every two seconds: a BIF
 * whose images are JPEG-headed runs of 30 KB — the size of Plex's — which
 * is all the seek bar's reader looks at.
 */
const previewBif = (() => {
  const count = 60;
  const imageBytes = 30_000;
  const start = 64 + (count + 1) * 8;
  const bytes = Buffer.alloc(start + count * imageBytes);
  bytes.set([0x89, 0x42, 0x49, 0x46, 13, 10, 26, 10]);
  bytes.writeUInt32LE(count, 12);
  bytes.writeUInt32LE(2000, 16);
  for (let i = 0; i <= count; i++) {
    bytes.writeUInt32LE(i === count ? 0xffffffff : i, 64 + i * 8);
    bytes.writeUInt32LE(start + i * imageBytes, 68 + i * 8);
    if (i < count) { bytes.set([0xff, 0xd8], start + i * imageBytes); bytes.writeUInt32LE(i, start + i * imageBytes + 2); }
  }
  return bytes;
})();
/** Segments served, per user, for the checks to read. */
const served: Array<{ user: string; seg: string; at: number; heldMs: number; part?: string; bytes?: number; ms?: number; sent?: number; cut?: boolean; askedAt?: number }> = [];

/**
 * Each title's tracks, as Plex has them: two audio, a subtitle the player
 * draws and a picture one that has to be burned in. Stream ids belong to a
 * file, so every title has its own — a new title's assignment always differs
 * from the last one's, as it does in the app. Every set plays the same video.
 */
const tracksOf = (ratingKey: string) => {
  const base = (Number(ratingKey) % 100) * 10;
  return {
    audioTracks: [
      { id: base + 1, title: "English (AAC Stereo)", language: "English", languageCode: "eng", selected: true, default: true },
      { id: base + 2, title: "Français (AAC Stereo)", language: "Français", languageCode: "fra", selected: false },
    ],
    subtitleTracks: [
      { id: base + 3, title: "English (SRT)", language: "English", languageCode: "eng", selected: false, external: true },
      { id: base + 4, title: "English (PGS)", language: "English", languageCode: "eng", selected: false, external: false },
      // Text inside the file, which the bot reads out as the film plays.
      { id: base + 5, title: "English (in the file)", language: "English", languageCode: "eng", selected: false, external: true, sidecar: false },
    ],
  };
};
/**
 * A subtitle inside the file, answered the way the bot answers one it is still
 * reading (services/embedded-subtitles.ts): read from the start at
 * subtitleReadPace film seconds a second, and around anywhere a player says it
 * is SUBTITLE_AROUND_MS after it first asks — the bot reading those lines out
 * of the file's index. An ask is held until there are lines for where it is,
 * up to two seconds, and answered with those around it and where every line
 * has come. Never finished: the whole film is never needed here.
 */
const subtitleReads = new Map<number, { began: number; around: Array<{ from: number; to: number; at: number }> }>();
let subtitleReadPace = 3;
const SUBTITLE_AROUND_MS = 400;
const LINES = Array.from({ length: 200 }, (_, i) => ({ start: i * 3, end: i * 3 + 2, text: `Line ${i + 1}` }));
async function subtitleRead(res: http.ServerResponse, id: number, url: URL) {
  const read = subtitleReads.get(id) ?? { began: Date.now(), around: [] };
  subtitleReads.set(id, read);
  const spans = () => {
    const list: Array<[number, number]> = [[0, ((Date.now() - read.began) / 1000) * subtitleReadPace]];
    for (const w of read.around) if (Date.now() >= w.at) list.push([w.from, w.to]);
    list.sort((a, b) => a[0] - b[0]);
    const joined: Array<[number, number]> = [];
    for (const [a, b] of list) {
      const last = joined.at(-1);
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else joined.push([a, b]);
    }
    return joined;
  };
  const covers = (at: number) => spans().some(([a, b]) => a <= at && at < b);
  const lines = () => LINES.filter((l) => spans().some(([a, b]) => l.start >= a && l.start < b));
  if (!url.searchParams.has("at")) return json(res, { cues: lines(), complete: false });
  const at = Number(url.searchParams.get("at"));
  if (!covers(at) && !read.around.some((w) => w.from <= at && at < w.to)) {
    read.around.push({ from: Math.max(0, at - 30), to: at + 120, at: Date.now() + SUBTITLE_AROUND_MS });
  }
  for (const end = Date.now() + 2000; !covers(at) && Date.now() < end;) await new Promise((r) => setTimeout(r, 50));
  const from = Math.max(0, at - 60);
  const to = at + 600;
  const cues = lines().filter((c) => c.end > from && c.start < to);
  const covered = spans().map(([a, b]) => [Math.round(a * 100) / 100, Math.round(b * 100) / 100]);
  const here = covered.filter(([a, b]) => b > from && a < to).map(([a, b]) => [Math.max(a, from), Math.min(b, to)]);
  const sig = `${cues.length}:${cues.at(-1)?.start ?? -1}:${here.join(";")}`;
  if (url.searchParams.get("since") === sig) return json(res, { unchanged: true, complete: false, covered, from, to, sig });
  return json(res, { cues, complete: false, covered, from, to, sig });
}

const meta = (ratingKey: string) => ({
  ratingKey, title: `Sync Test ${ratingKey}`, type: "movie", thumb: null, duration: (plexS || lengthOf(streamDir)) * 1000,
  partId: Number(ratingKey), markers: [], genres: [], versions: [], ...tracksOf(ratingKey),
  previewThumbs: previewsOn,
});

function userOf(req: http.IncomingMessage, url: URL): string | null {
  const auth = req.headers.authorization?.replace(/^Bearer /, "") ?? url.searchParams.get("token");
  return auth ? getSessionUserId(auth) : null;
}

const json = (res: http.ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const user = userOf(req, url);
  const p = url.pathname;

  if (p === "/api/test/session") {
    const id = url.searchParams.get("user") ?? "u-viewer";
    instanceHosts.set(instance, { hostUserId: "u-host", guildId: null, channelId: null, createdAt: Date.now() });
    return json(res, { token: createSession(id, null), instanceId: instance });
  }
  if (p === "/api/test/stall") {
    const who = url.searchParams.get("user") ?? "u-host";
    const ms = Number(url.searchParams.get("ms") ?? 5000);
    stallUntil.set(who, Date.now() + ms);
    // The paced connection picks up from the end of the stall, not before.
    if (paceMs.has(who)) nextSlot.set(who, Math.max(nextSlot.get(who) ?? 0, Date.now() + ms));
    console.log(`[stall] ${who} for ${ms}ms`);
    return json(res, { ok: true });
  }
  if (p === "/api/test/flow") {
    const who = url.searchParams.get("user") ?? "u-host";
    const kbps = Number(url.searchParams.get("kbps") ?? 0);
    if (kbps > 0) flowKbps.set(who, kbps);
    else flowKbps.delete(who);
    for (const [key, map] of [["latencyMs", latencyMs], ["slowMs", slowMs]] as const) {
      const ms = Number(url.searchParams.get(key) ?? 0);
      if (ms > 0) map.set(who, ms);
      else map.delete(who);
    }
    return json(res, { ok: true });
  }
  if (p === "/api/test/streams") return json(res, streamsAsked);
  if (p === "/api/test/upload") {
    uploadKbps = Number(url.searchParams.get("kbps") ?? 0);
    uploadFreeAt = 0;
    return json(res, { ok: true });
  }
  if (p === "/api/test/pace") {
    const who = url.searchParams.get("user") ?? "u-host";
    const ms = Number(url.searchParams.get("ms") ?? 0);
    if (ms > 0) paceMs.set(who, ms);
    else { paceMs.delete(who); nextSlot.delete(who); }
    return json(res, { ok: true });
  }
  if (p === "/api/test/reset") {
    instance = `sync-room-${++resets}`;
    stallUntil.clear(); paceMs.clear(); nextSlot.clear(); flowKbps.clear(); served.length = 0;
    latencyMs.clear(); slowMs.clear(); streamsAsked.length = 0;
    uploadKbps = 0;
    uploadFreeAt = 0;
    previewsOn = url.searchParams.get("previews") === "1";
    notesOn = url.searchParams.get("notes") === "1";
    previewDelayMs = Number(url.searchParams.get("previewDelayMs") ?? 0) || 0;
    previewsSent.length = 0;
    eventList = url.searchParams.get("event") === "1";
    eventS = Number(url.searchParams.get("eventS") ?? 40) || 40;
    manifestMs = Number(url.searchParams.get("manifestMs") ?? 0) || 0;
    endlist = url.searchParams.get("endlist") === "1";
    plexS = Number(url.searchParams.get("plexS") ?? 0) || 0;
    sessionStart.clear();
    hevcOn = url.searchParams.get("hevc") === "1";
    noHevc.clear();
    hdrOn = url.searchParams.get("hdr") === "1";
    noHdr.clear();
    codecSaid.clear();
    p2pOn = url.searchParams.get("p2p") !== "0";
    const stream = url.searchParams.get("stream");
    streamDir = stream === "copy" ? COPY_STREAM : stream === "copy4" ? COPY4_STREAM : stream === "copy4long" ? COPY4_LONG_STREAM
      : stream === "hdr" ? HDR_STREAM : stream === "sg" ? SG_STREAM : SMALL_STREAM;
    sgRun = null;
    if (streamDir === SG_STREAM) layOutSg(url.searchParams.get("split"));
    partsOn = url.searchParams.get("parts") !== "0";
    cacheOn = url.searchParams.get("cache") === "1";
    cacheNone = url.searchParams.get("cache") === "none";
    urlTag = url.searchParams.get("fresh") === "1" ? `&r=${Date.now()}` : "";
    subtitleReads.clear();
    subtitleReadPace = Number(url.searchParams.get("subPace") ?? 3) || 3;
    return json(res, { ok: true, p2p: p2pOn, stream: path.basename(streamDir), parts: partsOn, layout: sgRun?.layout });
  }
  if (p === "/api/test/nohevc") {
    noHevc.add(url.searchParams.get("user") ?? "u-host");
    return json(res, { ok: true });
  }
  if (p === "/api/test/nohdr") {
    noHdr.add(url.searchParams.get("user") ?? "u-host");
    return json(res, { ok: true });
  }
  if (p === "/api/test/served") return json(res, served);
  if (p === "/api/test/previews") return json(res, previewsSent);

  if (/^\/api\/plex\/preview\/\d+\/index$/.test(p)) {
    if (!previewsOn) { res.writeHead(404).end(); return; }
    const askedAt = Date.now();
    const pass = url.searchParams.has("pass") ? Number(url.searchParams.get("pass")) : null;
    await new Promise((r) => setTimeout(r, previewDelayMs));
    if (res.destroyed) return;
    res.writeHead(200, { "Content-Type": "application/x-plex-preview-v2", "Access-Control-Allow-Origin": "*" });
    const whole = previewBif;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < whole.length; at += 64 * 1024) controller.enqueue(whole.subarray(at, at + 64 * 1024));
        controller.close();
      },
    });
    let bytes = 0;
    for await (const piece of progressivePreview(body, undefined, undefined, 2, pass ?? undefined)) {
      if (res.destroyed) return;
      bytes += piece.length;
      if (!res.write(piece)) await new Promise((r) => res.once("drain", r));
    }
    res.end();
    previewsSent.push({ user: user ?? "?", pass, askedAt, at: Date.now(), bytes });
    return;
  }

  if (p === "/api/plex/played-threshold") return json(res, { threshold: 0.9 });
  if (p.startsWith("/api/plex/meta/")) return json(res, meta(p.split("/").pop()!));
  if (p.startsWith("/api/plex/siblings/")) return json(res, { episode: false, prev: null, next: null });
  // The drawn subtitle: a line every few seconds.
  if (p.startsWith("/api/plex/subtitles/")) {
    const id = Number(p.split("/").pop());
    if (id % 10 !== 5) {
      const cues = Array.from({ length: 40 }, (_, i) => ({ start: i * 3, end: i * 3 + 2, text: `Line ${i + 1}` }));
      return json(res, { cues, complete: true });
    }
    return subtitleRead(res, id, url);
  }

  if (/^\/api\/plex\/hls\/[^/]+\/[^/]+\/master\.m3u8$/.test(p) && hevcOn) {
    const sid = p.split("/")[5];
    if (!codecSaid.has(sid)) {
      codecSaid.add(sid);
      const withheld = noHevc.has(user ?? "");
      recordSessionVideoCodec(sid, withheld ? "h264" : "hevc");
      recordHevcWithheld(sid, withheld);
      // HDR kept for a screen that shows it, as the bot's copy of an HDR
      // film is: for one asked for by a player whose screen doesn't, HDR
      // labelled for the browser to map, as SDR to the room (&hdr=1).
      if (hdrOn) recordSessionHdr(sid, url.searchParams.get("hdrOk") !== "0" && !noHdr.has(user ?? ""));
    }
  }
  if (/^\/api\/plex\/hls\/[^/]+\/[^/]+\/master\.m3u8$/.test(p) && notesOn && !url.searchParams.has("media")) {
    const notes: Record<string, string> = {
      video: "copy", kbps: "8000", audio: "transcode", audioFrom: "EAC3 5.1", audioTo: "AAC 5.1", audioKbps: "384",
      audioReason: "Unsupported codec (EAC3)",
      ...(streamDir === HDR_STREAM ? { video: "transcode", kbps: "4000", range: "HDR10 (kept)",
        videoFrom: "HEVC Main 10 · 10-bit · HDR10 · 1280×720 · 24 fps" } : {}),
    };
    const media = new URL(url);
    media.searchParams.set("media", "1");
    res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
    return res.end([
      "#EXTM3U",
      ...Object.entries(notes).map(([k, v]) => `#EXT-X-SESSION-DATA:DATA-ID="com.pdt.${k}",VALUE="${v}"`),
      "#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1280x720",
      `${media.pathname}${media.search}`,
      "",
    ].join("\n"));
  }

  // stream=sg: listed as the bot lists a copy it has made to the end.
  if (/^\/api\/plex\/hls\/[^/]+\/[^/]+\/master\.m3u8$/.test(p) && sgRun) {
    if (!streamsAsked.some((s) => s.user === (user ?? "?"))) streamsAsked.push({ user: user ?? "?", at: Date.now() });
    await lateAnswer(user);
    if (res.destroyed) return;
    res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
    return res.end(sgRun.playlist);
  }
  // The stream: a media playlist straight away, as a copy of Plex's would be.
  const segmentS = SEGMENT_S.get(streamDir);
  if (/^\/api\/plex\/hls\/[^/]+\/[^/]+\/master\.m3u8$/.test(p) && eventList && segmentS) {
    // As the bot lists a copy (services/direct-stream.ts): gaps up to where the
    // stream starts, then what it has measured from there — 40s — at each
    // segment's length, an EVENT playlist that says where to begin.
    const sid = p.split("/")[5];
    if (!sessionStart.has(sid)) {
      sessionStart.set(sid, Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0));
      if (manifestMs) await new Promise((r) => setTimeout(r, manifestMs));
      if (res.destroyed) return;
    }
    const offset = sessionStart.get(sid)!;
    const names = fs.readdirSync(streamDir).filter((f) => /^seg\d+\.ts$/.test(f)).sort();
    const first = Math.min(Math.floor(offset / segmentS), names.length - 1);
    const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-PLAYLIST-TYPE:EVENT", "#EXT-X-TARGETDURATION:12",
      "#EXT-X-MEDIA-SEQUENCE:0", `#EXT-X-START:TIME-OFFSET=${offset.toFixed(3)},PRECISE=YES`];
    for (let filled = 0; filled < first * segmentS; filled += 60) {
      lines.push(`#EXTINF:${Math.min(60, first * segmentS - filled).toFixed(3)},`, "#EXT-X-GAP", "gap.ts");
    }
    const listed = names.slice(first, first + Math.ceil(eventS / segmentS));
    for (const name of listed) {
      lines.push(`#EXTINF:${segmentS.toFixed(3)},`, `/api/test/stream/${name}?n=${fs.statSync(path.join(streamDir, name)).size}${urlTag}`);
    }
    if (endlist && listed.at(-1) === names.at(-1)) lines.push("#EXT-X-ENDLIST");
    res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
    return res.end(lines.join("\n") + "\n");
  }
  if (/^\/api\/plex\/hls\/[^/]+\/[^/]+\/master\.m3u8$/.test(p)) {
    const playlist = fs.readFileSync(path.join(streamDir, "index.m3u8"), "utf8")
      .replace(/^(seg\d+\.ts)$/gm, (name) => partsOn
        ? `/api/test/stream/${name}?n=${fs.statSync(path.join(streamDir, name)).size}${urlTag}`
        : `/api/test/stream/${name}`);
    res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
    return res.end(playlist);
  }
  const seg = p.match(/^\/api\/test\/stream\/(?:sg\/(\d+)\/)?(seg\d+\.ts|\d{5}(?:[a-z]{2})?\.m4s|init\.mp4)$/);
  if (seg) {
    const who = user ?? "unknown";
    const asked = Date.now();
    // Its turn on the paced connection, then — checked again and again, so a
    // stall called while it waits holds it too — past any stall.
    const pace = paceMs.get(who);
    let slot = asked;
    if (pace) {
      slot = Math.max(asked, stallUntil.get(who) ?? 0, nextSlot.get(who) ?? 0);
      nextSlot.set(who, slot + pace);
    }
    for (;;) {
      // A pace lifted lets go of what waits for its turn, as a stall ended does.
      const until = Math.max(paceMs.has(who) ? slot : asked, stallUntil.get(who) ?? 0);
      if (Date.now() >= until) break;
      await new Promise((r) => setTimeout(r, Math.min(200, until - Date.now())));
    }
    const held = Date.now() - asked;
    const name = seg[2];
    const file = path.join(streamDir, name);
    const kept = seg[1] ? sgFile(Number(seg[1]), name) : fs.existsSync(file) ? fs.readFileSync(file) : null;
    if (!kept) return json(res, { error: "no such segment" }, 404);
    await lateAnswer(who);
    if (res.destroyed) return;
    // The bot's answers: a part, the rest of one from a byte on, or the lot.
    const whole = kept;
    let body = whole;
    let status = 200;
    const headers: Record<string, string | number> = { "Content-Type": name.endsWith(".ts") ? "video/mp2t" : "video/mp4" };
    // As the bot's (routes/plex.ts setSegmentCacheHeaders).
    if (cacheOn) headers["Cache-Control"] = "public, max-age=300, immutable";
    if (cacheNone) headers["Cache-Control"] = "no-store";
    const parts = url.searchParams.get("parts");
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (parts) {
      const n = Number(parts);
      const i = Number(url.searchParams.get("part"));
      body = whole.subarray(Math.floor((whole.length * i) / n), Math.floor((whole.length * (i + 1)) / n));
    } else if (range) {
      const from = Number(range[1]);
      const to = range[2] ? Number(range[2]) : whole.length - 1;
      body = whole.subarray(from, to + 1);
      status = 206;
      headers["Content-Range"] = `bytes ${from}-${to}/${whole.length}`;
    }
    headers["Content-Length"] = body.length;
    res.writeHead(status, headers);
    // At this user's speed per download, if they have one.
    const kbps = flowKbps.get(who);
    const sentFrom = Date.now();
    // Bigger with a shared connection: each turn on it costs a timer, and
    // small turns waste what one download alone could have used.
    const chunk = uploadKbps ? 65_536 : 16_384;
    // Past its first few packets, one through the proxy takes a while to get going.
    const slow = slowMs.get(who) ?? 0;
    let pacedFrom = sentFrom;
    let going = !slow;
    let sent = 0;
    for (let at = 0; at < body.length && !res.destroyed;) {
      if (!going && at >= SLOW_AFTER_BYTES) {
        going = true;
        await new Promise((r) => setTimeout(r, slow));
        pacedFrom = Date.now() - (kbps ? (at * 8) / kbps : 0);
      }
      const piece = body.subarray(at, going ? at + chunk : Math.min(at + chunk, SLOW_AFTER_BYTES));
      at += piece.length;
      if (kbps) {
        const due = pacedFrom + (at * 8) / kbps;
        if (due > Date.now()) await new Promise((r) => setTimeout(r, due - Date.now()));
      }
      // Its turn on the one connection everybody's downloads share: sent at
      // the start of its slot, the next slot starting where this one ends, so
      // one download alone has the whole of it.
      if (uploadKbps) {
        const start = Math.max(Date.now(), uploadFreeAt);
        uploadFreeAt = start + (piece.length * 8) / uploadKbps;
        if (start > Date.now()) await new Promise((r) => setTimeout(r, start - Date.now()));
      }
      if (res.destroyed) break;
      sent += piece.length;
      if (!res.write(piece)) await new Promise((r) => res.once("drain", r));
    }
    const cut = res.destroyed;
    res.end();
    served.push({
      user: who, seg: name, at: Date.now(), heldMs: held, sent, cut, askedAt: asked,
      part: parts ? `${url.searchParams.get("part")}/${parts}` : range ? `from ${range[1]}` : undefined,
      bytes: body.length, ms: Date.now() - sentFrom,
    });
    return;
  }

  // Everything else the player calls — pings, stops, logs, previews — is
  // nothing to this fixture.
  json(res, {});
});

// Players in one browser find each other through the tracker and share
// segments, which is what a struggling host's stream is meant to be rescued by
// — and what a check on how the room behaves while the host struggles has to
// switch off: /api/test/reset?p2p=0.
let p2pOn = true;
server.prependListener("upgrade", (req, socket) => {
  if (!p2pOn && (req.url ?? "").startsWith("/tracker")) socket.destroy();
});
attachWebSocketServer(server);
server.listen(PORT, () => console.log(`sync-room server on http://localhost:${PORT} (streams in ${SMALL_STREAM}, ${COPY_STREAM}, ${COPY4_STREAM} and ${COPY4_LONG_STREAM})`));
