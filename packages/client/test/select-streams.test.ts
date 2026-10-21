/**
 * Pressing Play on a title whose file was replaced in Plex since its details
 * were cached (lib/selectStreams): Plex refuses the old part, the details are
 * fetched fresh, and the same tracks are set on the new file — against a fake
 * bot.
 */
import { selectStreams } from "../src/lib/selectStreams";
import { versionOf, type PlexMeta, type StreamTrack } from "../src/lib/api";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

const track = (id: number, title: string, codec: string, more: Partial<StreamTrack> = {}): StreamTrack =>
  ({ id, title, codec, language: "English", languageCode: "eng", selected: false, ...more });

/** Tenzing as it was cached: TrueHD and a commentary, full and forced English. */
const old: PlexMeta = {
  ratingKey: "5", title: "Tenzing", partId: 100,
  audioTracks: [track(1, "English (TRUEHD 7.1)", "truehd", { channels: 8 }), track(2, "Commentary (AAC Stereo)", "aac", { channels: 2 })],
  subtitleTracks: [track(11, "English (SRT)", "srt"), track(12, "English Forced (SRT)", "srt")],
} as unknown as PlexMeta;
/** And its new file: other ids, in another order. */
const now: PlexMeta = {
  ratingKey: "5", title: "Tenzing", partId: 200,
  audioTracks: [track(32, "Commentary (AAC Stereo)", "aac", { channels: 2 }), track(31, "English (EAC3 5.1)", "eac3", { channels: 6 })],
  subtitleTracks: [track(21, "English Forced (SRT)", "srt"), track(22, "English (SRT)", "srt")],
} as unknown as PlexMeta;

interface Bot { asked: string[]; parts: Set<number>; fresh: PlexMeta | null }
function bot(b: Bot): void {
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const put = /^\/api\/plex\/streams\/(\d+)$/.exec(url);
    if (put && init?.method === "PUT") {
      b.asked.push(`PUT ${put[1]} ${init.body}`);
      return b.parts.has(Number(put[1])) ? json(200, { ok: true }) : json(404, { error: "Failed to set streams" });
    }
    if (url === "/api/plex/meta/5?fresh=1") {
      b.asked.push("fresh");
      return b.fresh ? json(200, b.fresh) : json(502, { error: "Failed to fetch metadata" });
    }
    b.asked.push(url);
    return json(404, {});
  }) as typeof fetch;
}

console.log("— the details held are right —");
{
  const b: Bot = { asked: [], parts: new Set([100]), fresh: now };
  bot(b);
  const set = await selectStreams("5", versionOf(old), { audioStreamID: 1, subtitleStreamID: 11 });
  check("set once, as asked, and nothing fetched", [b.asked, set.meta, set.audio(1), set.subtitle(11)],
    [['PUT 100 {"audioStreamID":1,"subtitleStreamID":11}'], null, 1, 11]);
}

console.log("\n— the file was replaced since —");
{
  const b: Bot = { asked: [], parts: new Set([200]), fresh: now };
  bot(b);
  const set = await selectStreams("5", versionOf(old), { audioStreamID: 1, subtitleStreamID: 11 });
  check("refused, fetched fresh, and set on the new part", b.asked,
    ['PUT 100 {"audioStreamID":1,"subtitleStreamID":11}', "fresh", 'PUT 200 {"audioStreamID":31,"subtitleStreamID":22}']);
  check("the same tracks by what they are: the film's sound, the full English", [set.audio(1), set.subtitle(11)], [31, 22]);
  check("a commentary stays one, a forced track stays forced, none stays none",
    [set.audio(2), set.subtitle(12), set.subtitle(0)], [32, 21, 0]);
  check("and the fresh details handed back", set.meta?.partId, 200);
}

console.log("\n— only one of them asked for —");
{
  const b: Bot = { asked: [], parts: new Set([200]), fresh: now };
  bot(b);
  await selectStreams("5", versionOf(old), { subtitleStreamID: 0 });
  check("the other left alone", b.asked.at(-1), 'PUT 200 {"subtitleStreamID":0}');
}

console.log("\n— Plex can't be reached —");
{
  const b: Bot = { asked: [], parts: new Set(), fresh: null };
  bot(b);
  const err = await selectStreams("5", versionOf(old), { audioStreamID: 1, subtitleStreamID: 0 }).then(() => null, (e: Error) => e.message);
  check("the refusal is what's thrown, after one try at fresh details", [err, b.asked.length], ["Failed to set streams", 2]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
