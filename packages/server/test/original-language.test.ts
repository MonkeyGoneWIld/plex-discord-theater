/**
 * Which audio tracks are in a title's original language: the language TMDB
 * gives, matched against tracks as Plex describes them.
 */
import { markOriginalAudio, shortCode, spokenLanguage } from "../src/services/original-language.js";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

console.log("— language codes —");
check("Plex's three letters and TMDB's two agree", [shortCode("jpn"), shortCode("eng"), shortCode("ita"), shortCode("ja")], ["ja", "en", "it", "ja"]);
check("bibliographic codes too", [shortCode("fre"), shortCode("ger"), shortCode("chi")], ["fr", "de", "zh"]);
check("no language is none", [shortCode("und"), shortCode(null)], [null, null]);

console.log("\n— what a track is spoken in —");
check("by its tag", spokenLanguage({ title: "Stereo (日本語 AAC)", languageCode: "jpn" }), "ja");
check("by a title that names it, over the tag",
  spokenLanguage({ title: "Japanese (English AC3 Stereo)", languageCode: "eng" }), "ja");
check("a title that names no language leaves the tag", spokenLanguage({ title: "Surround 5.1 (English AC3)", languageCode: "eng" }), "en");

console.log("\n— marking —");
const capote = [
  { title: "Italiano (AC3 5.1)", languageCode: "ita" },
  { title: "English (AC3 5.1)", languageCode: "eng" },
] as Array<{ title: string; languageCode: string; original?: boolean }>;
markOriginalAudio(capote, "en");
check("an Italian release of an English film: English is the original", capote.map((t) => !!t.original), [false, true]);
const frieren = [
  { title: "FLAC 2.0 (日本語)", languageCode: "jpn" },
  { title: "TrueHD 5.1 (English)", languageCode: "eng" },
  { title: "Commentary by Voice Actors", languageCode: "jpn" },
] as Array<{ title: string; languageCode: string; original?: boolean }>;
markOriginalAudio(frieren, "ja");
check("Japanese, and never the commentary in it", frieren.map((t) => !!t.original), [true, false, false]);
const none = [{ title: "English", languageCode: "eng" }] as Array<{ title: string; languageCode: string; original?: boolean }>;
markOriginalAudio(none, "ko");
check("nothing in that language marks nothing", none.map((t) => !!t.original), [false]);
markOriginalAudio(none, null);
check("nor does no language", none.map((t) => !!t.original), [false]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
