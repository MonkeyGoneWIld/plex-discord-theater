/**
 * The ffmpeg engine's checks on the library, without ffmpeg: a file's streams
 * against Plex's (ffmpeg/probe.ts), and whether the library is on the mount
 * at startup (ffmpeg/library-check.ts), and which file beside a film a
 * sidecar Plex lists is (ffmpeg/burn-files.ts findSidecar).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { trackMismatch, type Probed } from "../src/services/ffmpeg/probe.js";
import { checkLibraryPaths, libraryReadabilityText } from "../src/services/ffmpeg/library-check.js";
import { findSidecar } from "../src/services/ffmpeg/burn-files.js";
import { dropHot, hotSegment, hotSegmentStats, keepHot, setHotBudget } from "../src/services/ffmpeg/hot-segments.js";
import { bif, splitJpegs } from "../src/services/ffmpeg/previews.js";
import { copyArgs, copyNeeds, encodeArgs, planCopy, planEncode } from "../src/services/ffmpeg/plan.js";
import { measuredPlaylist } from "../src/services/measured-playlist.js";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

console.log("— a file's streams against Plex's —");
{
  const file: Probed = {
    startS: 0,
    streams: [
      { index: 0, codecType: "video", codecName: "hevc", language: null, filename: null, mimetype: null },
      { index: 1, codecType: "audio", codecName: "dts", language: "ger", filename: null, mimetype: null },
      { index: 2, codecType: "audio", codecName: "eac3", language: "eng", filename: null, mimetype: null },
      { index: 3, codecType: "subtitle", codecName: "hdmv_pgs_subtitle", language: "eng", filename: null, mimetype: null },
      { index: 4, codecType: "attachment", codecName: "ttf", language: null, filename: "Arial.ttf", mimetype: "font/ttf" },
    ],
  };
  const v = { id: 1, streamType: 1, index: 0, codec: "hevc" };
  check("the same streams at the same numbers agree, Plex's names for codecs and languages taken as ffprobe's",
    trackMismatch([v, { id: 2, streamType: 2, index: 1, codec: "dca", languageCode: "deu" },
      { id: 3, streamType: 3, index: 3, codec: "pgs", languageCode: "eng" }], file), null);
  check("a track the file hasn't",
    trackMismatch([{ id: 2, streamType: 2, index: 7, codec: "aac" }], file), "the file has no stream #7 (Plex's audio aac)");
  check("one of another kind",
    trackMismatch([{ id: 2, streamType: 2, index: 3, codec: "aac" }], file), "stream #3 is subtitle in the file, audio to Plex");
  check("another codec: the commentary where the film's sound was",
    trackMismatch([{ id: 2, streamType: 2, index: 2, codec: "ac3" }], file), "stream #2 is eac3 in the file, ac3 to Plex");
  check("another language",
    trackMismatch([{ id: 2, streamType: 2, index: 2, codec: "eac3", languageCode: "jpn" }], file),
    "stream #2 is eng in the file, jpn to Plex");
  check("nor one written otherwise than in three letters, nor a codec of the same family", trackMismatch([
    { id: 2, streamType: 2, index: 2, codec: "eac3", languageCode: "en" },
    { id: 3, streamType: 2, index: 2, codec: "eac", languageCode: "English" },
  ], file), null);
  check("a language only one side names isn't held against it",
    trackMismatch([{ id: 2, streamType: 2, index: 2, codec: "eac3", languageCode: "und" }, v], file), null);
  check("nor is a sidecar, which isn't in the file",
    trackMismatch([{ id: 9, streamType: 3, codec: "srt", key: "/library/streams/9" }], file), null);
}

console.log("\n— the library on the mount, at startup —");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "library-check-"));
  const movies = path.join(tmp, "movies");
  fs.mkdirSync(movies);
  for (const name of ["a.mkv", "b.mkv"]) fs.writeFileSync(path.join(movies, name), "x");
  process.env.MEDIA_PATH_MAP = `/data/movies=>${movies.replace(/\\/g, "/")}`;
  const plex = async <T>(p: string): Promise<T> => {
    if (p === "/library/sections") {
      return { MediaContainer: { Directory: [
        { key: "1", title: "Movies", type: "movie" }, { key: "2", title: "TV Shows", type: "show" },
        { key: "3", title: "Music", type: "artist" },
      ] } } as T;
    }
    const file = (f: string) => ({ Media: [{ Part: [{ file: f }] }] });
    if (p.startsWith("/library/sections/1/all?type=1&")) {
      return { MediaContainer: { Metadata: [file("/data/movies/a.mkv"), file("/data/movies/b.mkv")] } } as T;
    }
    if (p.startsWith("/library/sections/2/all?type=4&")) {
      return { MediaContainer: { Metadata: [file("/data/tv/Show/S01E01.mkv")] } } as T;
    }
    throw new Error(`asked ${p}`);
  };
  const libraries = await checkLibraryPaths(plex);
  check("each movie and TV library's files looked for where MEDIA_PATH_MAP puts them, not music's",
    libraries.map((l) => [l.title, l.readable, l.looked]), [["Movies", 2, 2], ["TV Shows", 0, 1]]);
  check("and what to do about one that isn't there", libraryReadabilityText(libraries),
    "Movies 2/2 readable, TV Shows 0/1 readable — check MEDIA_PATH_MAP and the library mount " +
    "(not found here: /data/tv/Show/S01E01.mkv); what isn't readable is read through Plex");
  check("all there, said plainly", libraryReadabilityText(libraries.slice(0, 1)), "Movies 2/2 readable");
  delete process.env.MEDIA_PATH_MAP;
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("\n— which file a sidecar is —");
{
  const film = "/data/movies/Heat (1995)/Heat (1995).mkv";
  const folder = (names: string[]) => () => names;
  const at = (name: string) => path.join(path.dirname(film), name);
  const en = { id: 1, streamType: 3, codec: "srt", key: "/library/streams/1", languageTag: "en", languageCode: "eng", language: "English" };
  const files = ["Heat (1995).mkv", "Heat (1995).en.srt", "Heat (1995).en.forced.srt", "Heat (1995).en.sdh.srt",
    "Heat (1995).fr.srt", "Heat (1995).English.sup", "Heat (1995) - Behind the Scenes.en.srt", "Other.en.srt"];
  check("the one named for its language, not its forced or SDH ones, nor another film's",
    findSidecar(film, en, folder(files)), at("Heat (1995).en.srt"));
  check("its forced one", findSidecar(film, { ...en, forced: true }, folder(files)), at("Heat (1995).en.forced.srt"));
  check("its SDH one", findSidecar(film, { ...en, hearingImpaired: true }, folder(files)), at("Heat (1995).en.sdh.srt"));
  check("French by its two letters", findSidecar(film, { ...en, languageTag: "fr", languageCode: "fra", language: "French" },
    folder(files)), at("Heat (1995).fr.srt"));
  check("a PGS one by its language's name and .sup", findSidecar(film, { ...en, codec: "pgs" }, folder(files)),
    at("Heat (1995).English.sup"));
  check("German, which none of them is: none", findSidecar(film, { ...en, languageTag: "de", languageCode: "deu", language: "German" },
    folder(files)), null);
  check("a file named for the film alone, when it is the only one",
    findSidecar(film, en, folder(["Heat (1995).mkv", "Heat (1995).srt"])), at("Heat (1995).srt"));
  check("but not when two say its language", findSidecar(film, en, folder(["Heat (1995).srt", "Heat (1995).eng.SRT",
    "Heat (1995).en.srt"])), null);
  check("German's other code in a name, and VobSub by its .idx", findSidecar(film, { ...en, codec: "vobsub", languageTag: "de",
    languageCode: "deu", language: "German" }, folder(["Heat (1995).ger.idx", "Heat (1995).ger.sub"])), at("Heat (1995).ger.idx"));
  check("a folder that can't be read: none", findSidecar(film, en, () => { throw new Error("EACCES"); }), null);
}

console.log("\n— segments kept in memory —");
{
  setHotBudget(30);
  const run1 = path.join("/cache", "s1", "k1");
  const run2 = path.join("/cache", "s1", "k10");
  keepHot(path.join(run1, "a.ts"), Buffer.alloc(10));
  keepHot(path.join(run1, "b.ts"), Buffer.alloc(10));
  keepHot(path.join(run2, "c.ts"), Buffer.alloc(10));
  hotSegment(path.join(run1, "a.ts"));
  keepHot(path.join(run2, "d.ts"), Buffer.alloc(10));
  check("past the budget, the least recently used goes",
    [!!hotSegment(path.join(run1, "a.ts")), !!hotSegment(path.join(run1, "b.ts")), hotSegmentStats()],
    [true, false, { segments: 3, bytes: 30 }]);
  keepHot(path.join(run2, "e.ts"), Buffer.alloc(40));
  check("one bigger than all of it isn't kept", hotSegment(path.join(run2, "e.ts")), null);
  dropHot(run1);
  check("a run's go when it ends, not another's whose name starts the same", hotSegmentStats(), { segments: 2, bytes: 20 });
  setHotBudget(0);
  check("a budget of nothing keeps nothing", hotSegmentStats(), { segments: 0, bytes: 0 });
  setHotBudget(null);
}

console.log("\n— a BIF of previews —");
{
  const jpeg = (n: number) => Buffer.from([0xff, 0xd8, n, 0xff, 0xd9]);
  const made = bif([jpeg(1), jpeg(2), jpeg(3)], 10_000);
  const offset = (i: number) => made.readUInt32LE(64 + i * 8 + 4);
  check("its header: the magic, version 0, three frames ten seconds apart",
    [made.subarray(0, 8).toString("hex"), made.readUInt32LE(8), made.readUInt32LE(12), made.readUInt32LE(16)],
    ["894249460d0a1a0a", 0, 3, 10_000]);
  check("its index: each frame's number and where it starts, then the end",
    [[0, 1, 2, 3].map((i) => made.readUInt32LE(64 + i * 8)), [0, 1, 2, 3].map(offset)],
    [[0, 1, 2, 0xffffffff], [96, 101, 106, 111]]);
  check("and the frames, in order", made.subarray(offset(1), offset(2)).toString("hex"), "ffd802ffd9");
  // ffmpeg's pipe, cut anywhere: between the FF and the D9 that end a frame too.
  const piped = Buffer.concat([jpeg(1), Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd0, 7, 0xff, 0xd9]), jpeg(3)]);
  const found: string[] = [];
  let rest = Buffer.alloc(0);
  for (const cut of [[0, 4], [4, 13], [13, 19]]) {
    const split = splitJpegs(Buffer.concat([rest, piped.subarray(cut[0], cut[1])]));
    found.push(...split.frames.map((f) => f.toString("hex")));
    rest = split.rest;
  }
  check("the frames in ffmpeg's pipe, each ended by its EOI, however it comes",
    [found, rest.length], [["ffd801ffd9", "ffd8ff00ffd007ffd9", "ffd803ffd9"], 0]);
}

console.log("\n— the segment cuts —");
{
  const plan = { ok: true, video: { index: 0 }, audio: null, audioCopy: false, audioOut: null } as unknown as Parameters<typeof copyArgs>[0];
  const cutsOf = (args: string[]) => args[args.indexOf("-segment_times") + 1];
  const film = cutsOf(copyArgs(plan, ["-i", "film.mkv"], 0, 7200, 3)).split(",");
  check("a two-hour film's cuts run past its end", [film[0], film.length, Number(film.at(-1))], ["3", 2440, 7320]);
  // Grimm S3E7: Plex says 97 hours.
  const days = cutsOf(copyArgs(plan, ["-i", "film.mkv"], 0, 350_083, 3));
  check("a length days long lists twelve hours of cuts, in one argument Linux takes",
    [Number(days.split(",").at(-1)), Buffer.byteLength(days) < 128 * 1024], [43_200, true]);
}

console.log("\n— AV1, Opus and FLAC copied, in fragmented MP4 —");
{
  const version = (video: Record<string, unknown>, audio: Record<string, unknown>, more: Record<string, unknown> = {}) => ({
    container: "mkv", width: 1920, height: 1080, partKey: "/library/parts/1/1/file.mkv", file: "/data/media/f.mkv",
    streams: [{ id: 11, streamType: 1, index: 0, codec: "av1", bitDepth: 10, ...video },
      { id: 12, streamType: 2, index: 1, codec: "opus", channels: 6, default: true, ...audio }],
    ...more,
  });
  const all = { audioStreamId: null, hevcOk: true, av1Ok: true, opusOk: true, flacOk: true, ac3Ok: true, eac3Ok: true };
  const av1 = planCopy(version({}, {}), all);
  check("10-bit AV1 with Opus 5.1, for a player that decodes both, is copied as it is, in fMP4",
    av1.ok && [av1.codec, av1.audioCopy, av1.fmp4, copyNeeds(av1)], ["av1", true, true, ["av1", "opus"]]);
  const why = (p: ReturnType<typeof planCopy>) => (p.ok ? "copy" : p.why);
  check("not for a player that can't decode AV1", why(planCopy(version({}, {}), { ...all, av1Ok: false })),
    "AV1, and this player can't decode it");
  check("nor 12-bit AV1", why(planCopy(version({ bitDepth: 12 }, {}), all)), "12-bit AV1");
  check("from WebM too, which MPEG-TS copies never were", why(planCopy(version({}, {}, { container: "webm" }), all)), "copy");
  const noOpus = planCopy(version({ codec: "h264", bitDepth: 8 }, {}), { ...all, opusOk: false });
  check("Opus for a player that can't decode it becomes AAC, and H.264 with it stays MPEG-TS",
    noOpus.ok && [noOpus.audioCopy, noOpus.fmp4, copyNeeds(noOpus)], [false, false, []]);
  const opus = planCopy(version({ codec: "h264", bitDepth: 8 }, {}), all);
  check("for one that can, H.264 with its Opus is fMP4", opus.ok && [opus.fmp4, copyNeeds(opus)], [true, ["opus"]]);
  const flac = (audio: Record<string, unknown>) => planCopy(version({ codec: "hevc" }, { codec: "flac", ...audio }), all);
  const flacCopied = (p: ReturnType<typeof planCopy>) => p.ok && [p.audioCopy, p.fmp4, copyNeeds(p)];
  check("FLAC stereo at 1 Mbps is copied", flacCopied(flac({ channels: 2, bitrate: 1000 })), [true, true, ["hevc", "flac"]]);
  check("FLAC 5.1 at 4 Mbps becomes AAC, sent to every viewer as it is",
    flacCopied(flac({ channels: 6, bitrate: 4000 })), [false, false, ["hevc"]]);
  check("and with no bitrate said, stereo is copied and surround isn't",
    [flacCopied(flac({ channels: 2 })), flacCopied(flac({ channels: 6 }))], [[true, true, ["hevc", "flac"]], [false, false, ["hevc"]]]);
  const sound = (audio: Record<string, unknown>, ask: Partial<typeof all> = {}) =>
    planCopy(version({ codec: "h264", bitDepth: 8 }, audio), { ...all, ...ask });
  const eac3 = sound({ codec: "eac3", channels: 8 });
  check("EAC3 7.1 for a player that decodes EAC3 is copied as it is, all 8 channels, in fMP4",
    eac3.ok && [eac3.audioCopy, eac3.fmp4, copyNeeds(eac3), eac3.audioWhy], [true, true, ["eac3"], null]);
  const ac3 = sound({ codec: "ac3", channels: 6 });
  check("and AC3 5.1 for one that decodes AC3", ac3.ok && [ac3.audioCopy, ac3.fmp4, copyNeeds(ac3)], [true, true, ["ac3"]]);
  const audioWhy = (p: ReturnType<typeof planCopy>) => (p.ok ? [p.audioCopy, p.audioWhy] : p.why);
  check("not for a player that can't, which is told why",
    audioWhy(sound({ codec: "eac3", channels: 6 }, { eac3Ok: false })), [false, "EAC3, and this player can't play it"]);
  check("DTS and TrueHD never, as no browser plays them",
    [audioWhy(sound({ codec: "dca", channels: 6 })), audioWhy(sound({ codec: "truehd", channels: 8 }))],
    [[false, "DTS, which browsers can't play"], [false, "TrueHD, which browsers can't play"]]);
  check("FLAC too heavy to send says so, with its bitrate",
    audioWhy(sound({ codec: "flac", channels: 6, bitrate: 4000 })), [false, "FLAC at 4,000 kbps, too heavy to send as it is"]);
  const hevcFlac = flac({ channels: 2, bitrate: 1000 });
  const args = hevcFlac.ok ? copyArgs(hevcFlac, ["-i", "f.mkv"], 0, 60, 4).join(" ") : "";
  check("an fMP4 copy is cut by the HLS muxer, on the copy's clock, HEVC tagged as Chrome takes it",
    [args.includes("-tag:v hvc1"), args.includes("-output_ts_offset 10 -f hls -hls_segment_type fmp4 -hls_time 3.9375"),
      args.includes("-hls_fmp4_init_filename init.mp4 -hls_segment_filename %05d.m4s"),
      args.includes("movflags=+frag_discont+negative_cts_offsets:use_editlist=0"), args.includes("-segment_times")],
    [true, true, true, true, false]);
}

console.log("\n— AV1 re-encodes —");
{
  const version = (video: Record<string, unknown>) => ({
    container: "mkv", width: 3840, height: 2160, partKey: "/library/parts/1/1/file.mkv", file: "/data/media/f.mkv",
    streams: [{ id: 11, streamType: 1, index: 0, codec: "hevc", bitDepth: 10, colorPrimaries: "bt709", colorTrc: "bt709",
      colorSpace: "bt709", colorRange: "tv", ...video },
      { id: 12, streamType: 2, index: 1, codec: "eac3", channels: 6, default: true }],
  });
  const ask = { audioStreamId: null, hevcOk: true, av1Ok: true, hardware: "qsv" as "qsv" | "vaapi" | "nvenc" | "software",
    kbps: 12000, peakKbps: 12000, maxWidth: 1920, maxHeight: 1080, keepHdr: false };
  const plan = (v: ReturnType<typeof version>, more: Partial<Parameters<typeof planEncode>[1]> = {}) =>
    planEncode(v, { ...ask, ...more });
  const sdr = plan(version({}));
  check("4K SDR for a player that decodes AV1 on its GPU is AV1, in about half H.264's bits",
    sdr.ok && [sdr.codec, sdr.width, sdr.height], ["av1", 1920, 1080]);
  const sdrArgs = sdr.ok ? encodeArgs(sdr, ["-i", "f.mkv"], 0, 60, "/dev/dri/renderD128").join(" ") : "";
  check("  on QSV, 8 bits, no profile named, an IDR at every cut, in fMP4",
    [sdrArgs.includes("-c:v av1_qsv -low_power 1 -preset medium"), sdrArgs.includes("format=nv12"),
      sdrArgs.includes("-profile:v"), sdrArgs.includes("-forced_idr 1"), sdrArgs.includes("-hls_segment_type fmp4"),
      sdrArgs.includes("-segment_times")], [true, true, false, true, true, false]);
  const hdr = plan(version({ colorPrimaries: "bt2020", colorTrc: "smpte2084", colorSpace: "bt2020nc" }));
  check("HDR tone-mapped is AV1 too", hdr.ok && [hdr.codec, hdr.hdrTrc, !!hdr.tonemap], ["av1", null, true]);
  const kept = plan(version({ colorPrimaries: "bt2020", colorTrc: "smpte2084", colorSpace: "bt2020nc" }), { keepHdr: true });
  check("HDR kept stays HEVC Main10", kept.ok && [kept.codec, kept.hdrTrc], ["hevc", "smpte2084"]);
  check("not with a subtitle burned in, which is H.264's",
    (() => { const p = plan({ ...version({}), streams: [...version({}).streams,
      { id: 21, streamType: 3, index: 2, codec: "pgs" }] } as ReturnType<typeof version>, { burn: 21 }); return p.ok && p.codec; })(),
    "h264");
  check("nor without the GPU's AV1", [plan(version({}), { av1Ok: false }), plan(version({}), { hardware: "software" })]
    .map((p) => p.ok && p.codec), ["hevc", "h264"]);
  const va = plan(version({}), { hardware: "vaapi", lowPower: false, av1LowPower: true });
  const vaArgs = va.ok ? encodeArgs(va, ["-i", "f.mkv"], 0, 60, "/dev/dri/renderD128").join(" ") : "";
  check("on VAAPI, its low-power AV1 encoder where that's all it has", vaArgs.includes("-c:v av1_vaapi -low_power 1 -rc_mode VBR"), true);
  const nv = plan(version({}), { hardware: "nvenc" });
  const nvArgs = nv.ok ? encodeArgs(nv, ["-i", "f.mkv"], 0, 60, "0").join(" ") : "";
  check("on NVENC, with no profile to name", [nvArgs.includes("-c:v av1_nvenc -preset p4 -tune hq -rc vbr"), nvArgs.includes("-profile:v")],
    [true, false]);
}

console.log("\n— a measured playlist of fragmented MP4 —");
{
  const init = { path: "/s/init.mp4", bytes: 900 };
  const before = { path: "/s/binit.mp4", bytes: 880 };
  const seg = (path: string, start: number, end: number, i: typeof init) =>
    ({ path, start, end, videoStart: start, audioStart: start, bytes: 1000, init: i });
  const { text } = measuredPlaylist({
    segments: [seg("/s/b00000.m4s", 70, 74, before), seg("/s/00000.m4s", 74, 78, init), seg("/s/00001.m4s", 78, 82, init)],
    published: 3, offsetS: 70, ended: false, targetDuration: 4, urlFor: (p, n) => `${p}?n=${n}`,
  });
  const lines = text.trim().split("\n");
  check("version 7, for EXT-X-MAP", lines[1], "#EXT-X-VERSION:7");
  const maps = lines.filter((l) => l.startsWith("#EXT-X-MAP"));
  check("the init named before the gaps, and again where it changes",
    maps, ['#EXT-X-MAP:URI="/s/binit.mp4?n=880"', '#EXT-X-MAP:URI="/s/init.mp4?n=900"']);
  check("first of all", lines.findIndex((l) => l.startsWith("#EXT-X-MAP")) < lines.findIndex((l) => l === "#EXT-X-GAP"), true);
  check("the gaps named as fMP4", lines.includes("gap.m4s") && !lines.includes("gap.ts"), true);
  check("the second init just before the segment that needs it",
    lines[lines.indexOf('#EXT-X-MAP:URI="/s/init.mp4?n=900"') + 2], "/s/00000.m4s?n=1000");
  const ts = measuredPlaylist({
    segments: [{ path: "/s/00000.ts", start: 0, end: 4, videoStart: 0, audioStart: 0, bytes: 1000 }],
    published: 1, offsetS: 0, ended: true, targetDuration: 4, urlFor: (p) => p,
  }).text;
  check("MPEG-TS as before: version 3, no map", [ts.includes("#EXT-X-VERSION:3"), ts.includes("#EXT-X-MAP")], [true, false]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
