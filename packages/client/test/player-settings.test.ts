/**
 * This viewer's own settings: which subtitle lines are up at a moment and how
 * they look, what a player starts at (quality, volume, languages), and
 * clearing everything the player has remembered.
 */

// Storage as the browser has it, before anything below reads it.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
} as Storage;

const { activeCues, longestCue, sameCues } = await import("../src/lib/subtitleCues");
const { DEFAULT_SUBTITLE_STYLE, normaliseSubtitleStyle, setSubtitleStyle, subtitleStyle, SUBTITLE_STYLE_KEY } =
  await import("../src/lib/subtitleStyle");
const { resetSavedSettings, SAVED_SETTINGS } = await import("../src/lib/savedSettings");
const quality = await import("../src/lib/quality");
const volume = await import("../src/lib/volume");
const prefs = await import("../src/lib/trackPrefs");

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

console.log("— which lines are up —");
{
  const cues = [
    { start: 1, end: 3, text: "A" },
    { start: 2, end: 2.5, text: "B, over A" },
    { start: 2.2, end: 30, text: "SIGN", top: true },
    { start: 4, end: 5, text: "C" },
  ];
  const longest = longestCue(cues);
  const at = (t: number) => activeCues(cues, t, longest).map((c) => c.text);
  check("nothing before the first", at(0.5), []);
  check("one", at(1.5), ["A"]);
  check("two people talking at once, in the order they started", at(2.1), ["A", "B, over A"]);
  check("a sign up top alongside the dialogue", at(2.3), ["A", "B, over A", "SIGN"]);
  check("a long sign is still up after the lines around it", at(4.5), ["SIGN", "C"]);
  check("and after they have all gone", at(20), ["SIGN"]);
  check("nothing after the last", at(31), []);
  const once = activeCues(cues, 2.1, longest);
  check("the same lines twice are the same answer, so nothing redraws",
    sameCues(once, activeCues(cues, 2.15, longest)), true);
  check("a line coming up is a different answer", sameCues(once, activeCues(cues, 2.3, longest)), false);
}

console.log("\n— the viewer's own look —");
{
  check("nothing saved is the default", subtitleStyle(), DEFAULT_SUBTITLE_STYLE);
  setSubtitleStyle({ size: 140, color: "yellow", background: "box" });
  check("a choice is kept", [subtitleStyle().size, subtitleStyle().color, subtitleStyle().background], [140, "yellow", "box"]);
  check("and saved", JSON.parse(store.get(SUBTITLE_STYLE_KEY) ?? "{}").color, "yellow");
  setSubtitleStyle({ size: 999 });
  check("a size past the end stops at it", subtitleStyle().size, 200);
  check("anything stored that isn't a choice is the default",
    normaliseSubtitleStyle({ size: "huge", color: "plaid", background: 3, raise: 11, bold: "yes", italic: 1, font: "comic" }),
    { size: 100, color: "white", background: "outline", raise: 12, bold: false, italic: false, font: "sans" });
  setSubtitleStyle({ color: "gray", font: "mono", italic: true });
  check("grey, red, a monospaced font and italics are choices too",
    [subtitleStyle().color, subtitleStyle().font, subtitleStyle().italic], ["gray", "mono", true]);
  setSubtitleStyle(DEFAULT_SUBTITLE_STYLE);
  check("going back to the default saves nothing", store.has(SUBTITLE_STYLE_KEY), false);
}

console.log("\n— what a player starts at —");
{
  check("Original, until a default is chosen", [quality.defaultQuality(), quality.preferredQuality()], [0, 0]);
  quality.setDefaultQuality(8000);
  check("a default chosen with no player open is what the next one starts at", quality.preferredQuality(), 8000);
  quality.beginQualitySession();
  quality.setPreferredQuality(20000, { ratingKey: "s1e1", show: "s1" });
  check("changing it while watching isn't saved as the default", quality.defaultQuality(), 8000);
  check("but carries into the next episode", quality.carryQualityTo("s1e2", "s1"), 20000);
  check("and something else starts at the default", quality.carryQualityTo("film", null), 8000);
  quality.setPreferredQuality(0, { ratingKey: "s2e1", show: "s2" });
  check("Original chosen over a lower default carries into the next episode too", quality.carryQualityTo("s2e2", "s2"), 0);
  quality.setDefaultQuality(4000);
  check("a default changed while a player is open doesn't restart it", quality.preferredQuality(), 0);
  quality.resetPreferredQuality();
  check("closing the player goes back to the default", quality.preferredQuality(), 4000);

  check("volume starts at half until one is chosen", volume.loadVolume(), 0.5);
  volume.saveVolume(0.3);
  check("the last volume used is remembered", volume.loadVolume(), 0.3);
  volume.saveVolume(0);
  check("muting isn't kept as a level", volume.loadVolume(), 0.3);
  volume.saveVolume(1.5);
  check("a boost above 100% is remembered too", volume.loadVolume(), 1.5);

  prefs.chooseSubtitleLanguage({ code: "ja", name: "Japanese" });
  const tracks = [
    { id: 1, title: "English (SRT)", language: "English", languageCode: "eng", codec: "srt", selected: true },
    { id: 2, title: "Japanese (ASS)", language: "Japanese", languageCode: "jpn", codec: "ass", selected: false },
  ];
  check("a subtitle language chosen ahead of time picks that language in a file",
    prefs.matchSubtitleTrack(tracks as never, prefs.loadSubtitlePref())?.id, 2);
  prefs.chooseSubtitleLanguage("off");
  check("off is off", prefs.matchSubtitleTrack(tracks as never, prefs.loadSubtitlePref()), null);
  prefs.chooseSubtitleLanguage(null);
  check("and no choice leaves each title to its own", prefs.loadSubtitlePref(), null);
  prefs.chooseAudioLanguage({ code: "en", name: "English" });
  check("an audio language too", prefs.matchAudioTrack(tracks as never, prefs.loadAudioPref())?.id, 1);
}

console.log("\n— resetting saved settings —");
{
  store.set("pdt:subtitlePref", JSON.stringify({ off: false, languageCode: "eng" }));
  store.set("pdt:audioPref", JSON.stringify({ languageCode: "jpn" }));
  store.set("pdt:videoZoom:v1", JSON.stringify({ "show:1": { mode: "fill", zoom: 100 } }));
  store.set("pdt:volume", "0.8");
  store.set("pdt:hevc-failed", "1");
  store.set("plex-presence-details", "false");
  setSubtitleStyle({ color: "cyan" });
  store.set("pdt:defaultQuality", "8000");
  check("every saved player setting is cleared, and counted", resetSavedSettings(), 6);
  check("none of them is left", SAVED_SETTINGS.filter(({ key }) => store.has(key)), []);
  check("the subtitle look in use goes back to the default too", subtitleStyle().color, "white");
  check("and so does the quality the next player starts at", quality.preferredQuality(), 0);
  check("what the device can play, and what you share, are not settings to reset",
    [store.get("pdt:hevc-failed"), store.get("plex-presence-details")], ["1", "false"]);
  check("a second reset finds nothing", resetSavedSettings(), 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
