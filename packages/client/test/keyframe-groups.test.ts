/**
 * A copy's long segments in pieces (lib/keyframeGroups): which pieces open on
 * a keyframe, the pieces as keyframe groups, what has to come in before the
 * picture can come from inside one, what hls.js is made to load after a skip,
 * and the player's choices that go by keyframes, made on groups. The pieces as
 * the bot lists them: film 20578, whose first keyframes are 29 s apart.
 *
 * What hls.js does with them is checked in the browser: a skip into the middle
 * of a group, in fMP4 and MPEG-TS, with hls.js 1.6.16.
 */
import { guardPieceLoads, keyframeGroups, leadInBytes, loadInstead, opensOnKeyframe } from "../src/lib/keyframeGroups";
import { safeBackCutS } from "../src/lib/bufferTrim";
import { nextNeededSegment } from "../src/lib/nextNeeded";
import { LAND_INTO_SEGMENT_S, landingBySize } from "../src/lib/roomWait";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

const MB = 1e6;
/** A segment's URL as a copy's playlist gives it: its path encoded in the query. */
const url = (name: string, bytes: number) => `https://bot.test/api/plex/hls/seg?p=%2Fvideo%2F%3A%2Ftranscode%2Funiversal%2Fsession%2Fab12cd%2Fbase%2F${name}&n=${bytes}`;

// 20578's first 29 s, cut into seven pieces; a 4 s segment; then a 30 s
// keyframe interval in eight. Starts and lengths as the playlist lists them.
const listed = [
  ...["aa", "ab", "ac", "ad", "ae", "af", "ag"].map((p, i) => ({ name: `00000${p}.m4s`, start: i * 4.13, duration: 4.13, bytes: 14 * MB })),
  { name: "00001.m4s", start: 28.91, duration: 4.0, bytes: 13 * MB },
  ...["aa", "ab", "ac", "ad", "ae", "af", "ag", "ah"].map((p, i) => ({ name: `00002${p}.m4s`, start: 32.91 + i * 3.75, duration: 3.75, bytes: 12 * MB })),
  { name: "00003.m4s", start: 62.91, duration: 4.0, bytes: 13 * MB },
].map((s, sn) => ({ sn, level: 0, start: s.start, duration: s.duration, url: url(s.name, s.bytes), bytes: s.bytes }));
const round2 = (n: number) => Math.round(n * 100) / 100;

console.log("\n— which open on a keyframe —");
check("a group's first piece, a whole segment, and every later piece",
  [url("00000aa.m4s", 1), url("00001.m4s", 1), url("00000ab.m4s", 1), url("00002ah.m4s", 1)].map(opensOnKeyframe), [true, true, false, false]);
check("  MPEG-TS pieces, a measured-before run's (b…), and a plain path, alike",
  ["https://bot.test/x/00012ab.ts", url("b00012ac.ts", 1), url("b00012aa.ts", 1), "/base/00012ac.m4s?n=5"].map(opensOnKeyframe), [false, false, true, false]);
check("  Plex's own segments, and a session named in letters, open on one",
  ["/video/:/transcode/universal/session/abcxy/base/media-00179.ts", url("00179.ts", 1), "https://bot.test/hls/sessionab/00012.ts"].map(opensOnKeyframe),
  [true, true, true]);

console.log("\n— keyframe groups —");
{
  const groups = keyframeGroups(listed)!;
  check("each group's pieces folded into its first: four groups",
    groups.map((g) => [round2(g.start), round2(g.duration), g.url === listed.find((s) => s.start === g.start)?.url]),
    [[0, 28.91, true], [28.91, 4, true], [32.91, 30, true], [62.91, 4, true]]);
  const plain = listed.filter((s) => opensOnKeyframe(s.url));
  check("  a list with no pieces is left as it is", keyframeGroups(plain) === plain, true);
  check("  and none is none", keyframeGroups(null), null);
}

console.log("\n— what has to come in first —");
{
  const lead = leadInBytes(listed);
  check("the pieces before each in its group; nothing for one that opens on a keyframe",
    lead.map((b) => (b === null ? null : b / MB)), [0, 14, 28, 42, 56, 70, 84, 0, 0, 12, 24, 36, 48, 60, 72, 84, 0]);
  const someCached = leadInBytes(listed.map((s, i) => ({ ...s, cached: i === 9 || i === 10 })));
  check("  what is in the browser's cache costs nothing", someCached.slice(8, 13).map((b) => b! / MB), [0, 12, 12, 12, 24]);
  const unknown = leadInBytes(listed.map((s, i) => ({ ...s, bytes: i === 9 ? null : s.bytes })));
  check("  and a size not known leaves the rest of the group unknown", unknown.slice(8, 17), [0, 12 * MB, null, null, null, null, null, null, 0]);
}

console.log("\n— what hls.js loads after a skip —");
{
  const at = (sn: number) => listed[sn];
  check("a skip to 45 s, in the third group's fourth piece: its first piece", loadInstead(at(11), null, listed).sn, 8);
  check("  then each after it", [loadInstead(at(11), at(8), listed).sn, loadInstead(at(11), at(9), listed).sn], [9, 10]);
  check("  then the piece asked for, following on", loadInstead(at(11), at(10), listed).sn, 11);
  check("a piece following on from the one before is loaded as asked", loadInstead(at(5), at(4), listed).sn, 5);
  check("a group's first piece, or a whole segment, as asked whatever came before",
    [loadInstead(at(8), at(2), listed).sn, loadInstead(at(16), null, listed).sn], [8, 16]);
  check("after a piece of another group, or of another quality, from the first piece",
    [loadInstead(at(11), at(3), listed).sn, loadInstead(at(11), { ...at(10), level: 1 }, listed).sn], [8, 8]);
  check("after a later piece of the same group (a skip back): from the first piece", loadInstead(at(11), at(13), listed).sn, 8);

  // hls.js asks for the piece at the playhead until it has it; each load is
  // buffered and becomes its previous.
  const loads: number[] = [];
  const removed: number[] = [];
  type F = (typeof listed)[number];
  const controller = {
    fragPrevious: at(15) as F | null,
    fragmentTracker: { removeFragment: (f: F) => removed.push(f.sn) },
    loadFragment(this: { fragPrevious: F | null }, frag: F) { loads.push(frag.sn); this.fragPrevious = frag; },
  };
  const hls = { streamController: controller };
  const heard: Array<[number, number]> = [];
  check("hls.js's stream controller is wrapped", guardPieceLoads<F>(hls, (a, b) => heard.push([a.sn, b.sn])), true);
  const level = { details: { fragments: listed } };
  for (let n = 0; n < 10 && loads[loads.length - 1] !== 12; n++) controller.loadFragment(at(12), level, 47.2);
  check("a skip back to 47.2 s with the end of the group in last: loaded from its first piece, one after another",
    loads, [8, 9, 10, 11, 12]);
  check("  each loaded again though hls.js may have it, as the browser needs the keyframe first", removed, [8, 9, 10, 11]);
  check("  and each heard of", heard, [[12, 8], [12, 9], [12, 10], [12, 11]]);
  {
    // 7 November: hls.js forgot the piece it had last loaded, with no skip.
    const loaded: number[] = [];
    const handlers = new Map<string, (e: string, data: { frag?: F }) => void>();
    const seekers: Array<() => void> = [];
    const media = {
      buffered: { length: 1, start: () => 32.91, end: () => at(11).start },
      addEventListener: (event: string, fn: () => void) => { if (event === "seeking") seekers.push(fn); },
    };
    const c2 = {
      fragPrevious: null as F | null,
      fragmentTracker: { removeFragment: () => {} },
      loadFragment(frag: F) { loaded.push(frag.sn); },
    };
    const h2 = { streamController: c2, media, on: (event: string, fn: (e: string, data: { frag?: F }) => void) => handlers.set(event, fn) };
    guardPieceLoads<F>(h2);
    handlers.get("hlsFragBuffered")?.("hlsFragBuffered", { frag: at(10) });
    c2.loadFragment(at(11), level, 44);
    check("the piece after the one last given the browser, still held: as asked, though hls.js forgot it", loaded, [11]);
    seekers.forEach((f) => f());
    c2.loadFragment(at(11), level, 44);
    check("  but after a skip, from the group's first piece", loaded, [11, 8]);
    media.buffered.end = () => at(11).start - 1;
    handlers.get("hlsFragBuffered")?.("hlsFragBuffered", { frag: at(10) });
    c2.loadFragment(at(11), level, 44);
    check("  and when the browser no longer holds its end, from the first piece", loaded, [11, 8, 8]);
  }
  check("nothing wrapped where hls.js isn't as expected", [guardPieceLoads({}), guardPieceLoads(null), guardPieceLoads({ streamController: { loadFragment() {} } })],
    [false, false, false]);
}

console.log("\n— cuts and landings by keyframe —");
{
  // The playhead at 45 s, in the third group's fourth piece; what is asked for, ten seconds behind.
  const pieceCut = safeBackCutS(listed, 45, 35);
  const groupCut = safeBackCutS(keyframeGroups(listed), 45, 35);
  check("by the pieces, a cut behind the playhead went to 35 s, inside its group: the browser carries a cut on to the next keyframe, at 62.91",
    round2(pieceCut!), 35);
  check("  by the groups, no further than the start of the group before, 28.91 s", round2(groupCut!), 28.91);

  const none = new Set<string>();
  const notBuffered = () => false;
  check("after a skip to 45 s, nothing held: the piece the picture needs next is the group's first, loaded first",
    nextNeededSegment(listed, 45, none, notBuffered), listed[8].url);
  check("  the pieces before it in the browser's buffer: the one at the playhead",
    nextNeededSegment(listed, 45, none, (s) => s.start < 44), listed[11].url);
  check("  or in the engine's memory", nextNeededSegment(listed, 45, new Set([listed[9].url, listed[10].url]), notBuffered), listed[11].url);
  check("  a whole segment as before", nextNeededSegment(listed, 30, none, notBuffered), listed[7].url);

  // The room at 36 s, a follower going to 40 s, fetching at 64 Mbps (counted
  // at four fifths of it, 6.4 MB/s): each 12 MB piece takes 1.875 s.
  const sized = listed.map((s) => ({ start: s.start, duration: s.duration, url: s.url, bytes: s.bytes }));
  const lead = leadInBytes(sized);
  const withLead = sized.map((s, i) => ({ ...s, leadInBytes: lead[i] }));
  const without = landingBySize(40, 36, sized, 8 * MB, 80);
  const landS = landingBySize(40, 36, withLead, 8 * MB, 80);
  check("by its own size alone, a landing went into the group's third piece, the two before it not counted: in at 41.6 s, after the room",
    round2(without), round2(40.41 + LAND_INTO_SEGMENT_S));
  check("  with them counted, into the fourth, once all four are in (48 MB, 7.5 s) and a second to spare", round2(landS), 44.5);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
