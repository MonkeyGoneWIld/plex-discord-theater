/**
 * Drawing subtitles here: which lines are up at a moment, the viewer's own look
 * for them, and clearing everything the player has remembered.
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
    normaliseSubtitleStyle({ size: "huge", color: "plaid", background: 3, raise: 11, bold: "yes", font: "comic" }),
    { size: 100, color: "white", background: "outline", raise: 12, bold: false, font: "sans" });
  setSubtitleStyle(DEFAULT_SUBTITLE_STYLE);
  check("going back to the default saves nothing", store.has(SUBTITLE_STYLE_KEY), false);
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
  check("every saved player setting is cleared, and counted", resetSavedSettings(), 5);
  check("none of them is left", SAVED_SETTINGS.filter(({ key }) => store.has(key)), []);
  check("the subtitle look in use goes back to the default too", subtitleStyle().color, "white");
  check("what the device can play, and what you share, are not settings to reset",
    [store.get("pdt:hevc-failed"), store.get("plex-presence-details")], ["1", "false"]);
  check("a second reset finds nothing", resetSavedSettings(), 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
