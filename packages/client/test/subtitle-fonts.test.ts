/**
 * Which of an ASS subtitle's fonts a player fetches beside the picture, and
 * in what order the rest come (lib/subtitleFonts), on Steins;Gate's first
 * episode as the server lists its fonts: 29, 16.3 MB, every one of which
 * came in beside its first two segments on 6 November.
 */
import { NEAR_S, nextFont, untilUseS, wantedNow, type FontUses } from "../src/lib/subtitleFonts";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

// Its 29 fonts, [bytes, uses], in the order the server lists them: the
// stretches of film each is drawn with (the server's fontUses), none for one
// no line of this subtitle uses.
const listed: Array<[number, Array<[number, number]>]> = [
  [49544, []], [49792, []], [15560, [[1341, 1416.5]]], [412252, [[647.4, 727]]], [116572, []],
  [129464, [[880.7, 887.2]]], [120480, [[880.7, 887.2]]], [144556, []], [5520448, []],
  [774476, [[1292.6, 1298.1]]], [751104, [[1292.6, 1298.1]]], [563800, [[1292.6, 1298.1]]], [557760, [[1292.6, 1298.1]]],
  [45260, [[223.8, 224.9], [396.8, 397.2], [548, 551.5], [1303.6, 1306.6]]],
  [403036, [[64.6, 69.7]]], [475412, [[64.6, 69.7]]], [404236, [[64.6, 69.7]]], [26064, [[786.9, 797.2]]],
  [226564, []], [228304, []], [4609224, [[786.9, 797.2]]], [110436, [[4.5, 534.3], [569.6, 618.5], [724.2, 1314.7]]],
  [15792, []], [108664, []], [75420, [[647.4, 721]]], [49284, []], [195544, []], [56384, []], [56196, []],
];
const fonts = listed.map(([bytes, uses], i) => ({ id: `f${i}`, bytes, uses }));
const mb = (fs: Array<{ bytes: number }>) => Math.round(fs.reduce((n, f) => n + f.bytes, 0) / 1e4) / 100;

console.log("\n— starting from the beginning —");
const first = fonts.filter((f) => wantedNow(f, 0));
check("beside the picture, only the font its first minute is drawn in: 0.11 MB of 16.3",
  [first.map((f) => f.id), mb(first), mb(fonts)], [["f21"], 0.11, 16.29]);
const rest = fonts.filter((f) => !wantedNow(f, 0));
check("nothing more while the picture has none to spare: the next is drawn with at 64.6 s",
  nextFont(rest, 0, false), null);
check("  but with picture to spare, the one drawn with soonest",
  ["f14", "f15", "f16"].includes(nextFont(rest, 0, true)?.id ?? ""), true);
check("  and once its lines come within a minute, whatever the picture has",
  ["f14", "f15", "f16"].includes(nextFont(rest, 64.6 - NEAR_S, false)?.id ?? ""), true);

// Fetched in turn, picture to spare all along: those drawn with ahead in the
// order they are, then those drawn with only before, or never.
const order: string[] = [];
const left = [...rest];
for (let f = nextFont(left, 0, true); f; f = nextFont(left, 0, true)) {
  order.push(f.id);
  left.splice(left.indexOf(f), 1);
}
const firstUse = (id: string) => fonts.find((f) => f.id === id)!.uses[0]?.[0] ?? Infinity;
check("in turn, by when they're first drawn with, those never used last",
  [order.length, order.every((id, i) => i === 0 || firstUse(order[i - 1]) <= firstUse(id)),
    order.slice(-13).every((id) => !fonts.find((f) => f.id === id)!.uses.length)], [28, true, true]);

console.log("\n— joining at 13:00, or skipping there —");
const at780 = fonts.filter((f) => wantedNow(f, 780));
check("the fonts of 13:00 to 14:00, and the dialogue's", at780.map((f) => f.id).sort(), ["f17", "f20", "f21"]);
check("one drawn with only before there isn't wanted", wantedNow(fonts[14], 780), false);

console.log("\n— no telling —");
const unknown: FontUses = { id: "x" };
check("a font whose names the server couldn't read is wanted at once", [untilUseS(unknown, 500), wantedNow(unknown, 500)], [0, true]);
check("one drawn with now", untilUseS({ id: "y", uses: [[10, 20]] }, 15), 0);
check("one drawn with again in 24 s", untilUseS({ id: "y", uses: [[10, 20], [45, 50]] }, 21), 24);
check("one never drawn with after here", untilUseS({ id: "y", uses: [[10, 20]] }, 21), Infinity);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
