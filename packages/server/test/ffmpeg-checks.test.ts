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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
