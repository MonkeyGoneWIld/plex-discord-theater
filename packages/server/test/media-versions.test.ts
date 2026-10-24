/**
 * Which of a title's files are offered, and which one is the default.
 */
import { editionOf, playableVersionOrder } from "../src/services/media-versions.js";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

console.log("\n— a title's files, best first —");
const uhd = { videoResolution: "4k", width: 3840, height: 1608, bitrate: 60000 };
const fhd = { videoResolution: "1080", width: 1920, height: 804, bitrate: 12000 };
const hd = { videoResolution: "720", width: 1280, height: 536, bitrate: 4000 };
check("a 4K copy beside a 1080p one is offered, after it", playableVersionOrder([uhd, fhd]), [1, 0]);
check("after every lower one: the default stays 1080p", playableVersionOrder([uhd, hd, fhd]), [2, 1, 0]);
check("two 4K copies go best first, after the 1080p", playableVersionOrder([uhd, fhd, { ...uhd, bitrate: 80000 }]), [1, 2, 0]);
check("only 4K (Andor): it is the default", playableVersionOrder([uhd]), [0]);
check("nothing in 4K: best first, as before", playableVersionOrder([hd, fhd]), [1, 0]);
check("no files, nothing", playableVersionOrder([]), []);

console.log("\n— a file's edition, from its name —");
check("Plex's tag: Project Hail Mary's two 4K files",
  [editionOf("/data/media/movies-4K/Project Hail Mary (2026) {imdb-tt12042730}/Project Hail Mary (2026) {tmdb-687163} {edition-1.43 IMAX} [4K][Remux-2160p][DV HDR10][TrueHD Atmos 7.1][HEVC]-CiNEPHiLES.mkv"),
    editionOf("/data/media/movies-4K/Project Hail Mary (2026) {imdb-tt12042730}/Project Hail Mary (2026) {tmdb-687163}{edition-IMAX} [4K][Remux-2160p][DV HDR10Plus][TrueHD Atmos 7.1][HEVC]-CiNEPHiLES.mkv")],
  ["1.43 IMAX", "IMAX"]);
check("a tag of several words, kept as it is", editionOf("/m/Avatar (2009)/Avatar (2009) {edition-Extended Collector's Edition}.mkv"), "Extended Collector's Edition");
check("a release's own words, after the year", [
  editionOf("/m/The.Dark.Knight.2008.IMAX.1080p.BluRay.x264.mkv"),
  editionOf("/m/Aliens (1986) Special Edition [Bluray-1080p].mkv"),
  editionOf("C:\\m\\Apocalypse Now (1979) Redux.mkv"),
  editionOf("/m/Blade Runner (1982) The Final Cut [Remux-2160p].mkv"),
  editionOf("/m/Kingdom of Heaven (2005) Director's Cut.mkv"),
  editionOf("/tv/Show - S01E01 - Pilot Uncut [WEB-1080p].mkv"),
], ["IMAX", "Special Edition", "Redux", "Final Cut", "Director's Cut", "Uncut"]);
check("IMAX Enhanced is one edition, not two", editionOf("/m/Shang-Chi (2021) IMAX Enhanced [WEB-2160p].mkv"), "IMAX Enhanced");
check("a title's own words aren't one", editionOf("/m/Extended Family (2019) [WEB-1080p].mkv"), null);
check("no edition, none", [editionOf("/m/Hot Fuzz (2007) [Remux-1080p][VC1].mkv"), editionOf(undefined)], [null, null]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
