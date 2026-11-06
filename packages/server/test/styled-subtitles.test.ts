/**
 * Which ASS subtitles are drawn as their scripts have them (styled-subtitles.ts
 * styledAss): typeset ones — signs and songs placed, moved, faded, drawn and
 * set in their own fonts, as Your Lie in April's are — and not ones that are
 * plain dialogue with the odd italic or line raised to the top.
 */
import { fontNames, fontUses, styledAss } from "../src/services/ffmpeg/styled-subtitles.js";

let pass = 0;
let fail = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

const head = "[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n\n[Events]\n" +
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";
const at = (i: number) => `0:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.00`;
// Plain dialogue: commas in the text, an italic, every fiftieth line at the top.
const plain = head + Array.from({ length: 300 }, (_, i) =>
  `Dialogue: 0,${at(i)},${at(i + 1)},Default,,0,0,0,,${i % 50 === 0 ? "{\\an8}" : ""}{\\i1}Well, then, line ${i}{\\i0}`,
).join("\n");
const sign = "Dialogue: 0,0:00:01.00,0:00:02.00,Sign,,0,0,0,,{\\pos(10,10)\\c&H00FF00&}A";

check("plain dialogue, italics and \\an8 included, is drawn plainly", styledAss(plain), false);
check("a couple of signs in 300 lines isn't enough", styledAss(plain + `\n${sign}\n${sign}`), false);
check("eight signs in 300 lines is", styledAss(plain + `\n${sign}`.repeat(8)), true);
check("Your Lie in April's title drawings and karaoke are", styledAss(head + [
  "Dialogue: 9,0:00:54.71,0:00:55.37,Title,,0,0,0,,{\\an5\\blur2.25\\c&HF397FF&\\an7\\move(445.5,294,379.5,339)\\fad(0,300)\\p1\\1a&HB9&}m 2.625 -2.625 b 5.5 1.125",
  "Dialogue: 2,0:01:05.11,0:01:05.81,OP-Rom-Yuki,,0,0,0,fx,{\\an5\\blur1\\fscx0\\fscy0\\bord0\\frx360\\move(960,-10,735,50,0,200)\\t(0,500,\\bord2\\frx0)}i",
  "Dialogue: 0,0:00:55.54,0:00:55.67,Title,,0,0,0,,{\\bord1.5\\fnCorbert\\pos(939.105,241.65)\\clip(m 106.75 382.5 b 128.625 448 640.375 829)}Your Lie",
  "Dialogue: 0,0:01:30.00,0:01:32.00,Default,,0,0,0,,Kousei, wait.",
].join("\n")), true);
check("nothing but a script header isn't", styledAss(head), false);
check("SRT-like text isn't", styledAss("1\n00:00:01,000 --> 00:00:02,000\nHello\n"), false);

// ─── The names a font answers to, and when a script draws with it ───

/** A font's name table, at `base` in its file: [platform, encoding, name id, text]. */
function sfnt(names: Array<[number, number, number, string]>, base = 0): Buffer {
  const strings = names.map(([p, , , text]) => (p === 1 ? Buffer.from(text, "latin1") : Buffer.from(text, "utf16le").swap16()));
  const table = Buffer.alloc(6 + names.length * 12);
  table.writeUInt16BE(names.length, 2);
  table.writeUInt16BE(table.length, 4);
  let off = 0;
  names.forEach(([p, e, id], i) => {
    const r = 6 + i * 12;
    table.writeUInt16BE(p, r);
    table.writeUInt16BE(e, r + 2);
    table.writeUInt16BE(id, r + 6);
    table.writeUInt16BE(strings[i].length, r + 8);
    table.writeUInt16BE(off, r + 10);
    off += strings[i].length;
  });
  const head = Buffer.alloc(28);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt16BE(1, 4);
  head.write("name", 12, "latin1");
  head.writeUInt32BE(base + 28, 20);
  return Buffer.concat([head, table, ...strings]);
}

const arno = sfnt([[3, 1, 1, "Arno Pro"], [3, 1, 4, "Arno Pro Bold"], [3, 1, 6, "ArnoPro-Bold"], [3, 1, 2, "Bold"]]);
check("a font's family, full and PostScript names, lower-cased, not its style",
  fontNames(arno), ["arno pro", "arno pro bold", "arnopro-bold"]);
check("Mac Roman names too, not Shift JIS ones read as if they were UTF-16",
  fontNames(sfnt([[1, 0, 1, "Lead Coat"], [3, 2, 4, "試し"], [3, 1, 6, "LeadCoat"]])), ["lead coat", "leadcoat"]);
{
  const one = sfnt([[3, 1, 1, "Nunito"]], 20);
  const two = sfnt([[3, 1, 1, "Nunito Sans"]], 20 + one.length);
  const ttc = Buffer.alloc(20);
  ttc.write("ttcf", 0, "latin1");
  ttc.writeUInt32BE(0x00010000, 4);
  ttc.writeUInt32BE(2, 8);
  ttc.writeUInt32BE(20, 12);
  ttc.writeUInt32BE(20 + one.length, 16);
  check("every face of a collection", fontNames(Buffer.concat([ttc, one, two])), ["nunito", "nunito sans"]);
}
check("one that isn't a font answers to nothing", [fontNames(Buffer.from("not a font")), fontNames(Buffer.alloc(0))], [[], []]);

const styled = "[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\n" +
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold\n" +
  "Style: Default,Estrangelo Edessa,57,&H00FFFFFF,&H000000FF,&H00000000,&H96000000,0\n" +
  "Style: Title1,Arno Pro,60,&H00FFFFFF,&H000000FF,&H00000000,&H96000000,-1\n" +
  "Style: SignB,Arial Rounded MT Bold,45,&H00393743,&H000000FF,&H00787FC2,&H00000000,0\n" +
  "Style: OP Romaji,nu-century-gothic,45,&H00100F11,&H000000FF,&H32FFFFFF,&H00000000,0\n\n[Events]\n" +
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" + [
  "Dialogue: 0,0:00:04.50,0:00:06.00,Default,,0,0,0,,Okabe, wait, it's 12:00.",
  "Dialogue: 0,0:00:30.00,0:00:32.10,Default,,0,0,0,,Within 30 s of the one before: one stretch.",
  "Dialogue: 0,0:01:04.60,0:01:09.70,Title1,,0,0,0,,{\\fad(200,200)}Turning Point",
  "Dialogue: 0,0:03:43.80,0:03:44.90,SignB,,0,0,0,,{\\pos(10,10)}Radio Kaikan",
  "Comment: 0,0:05:00.00,0:05:10.00,OP Romaji,,0,0,0,,A comment draws nothing",
  "Dialogue: 0,0:10:47.40,0:10:50.00,Default,,0,0,0,,{\\fnLead Coat\\pos(5,5)}A sign in a font of its own",
  "Dialogue: 0,0:11:00.00,0:11:01.00,SignB,,0,0,0,,{\\rTitle1}Back to the title's, {\\fn@Arno Pro}upright",
  "Dialogue: 0,0:12:00.00,0:12:01.00,No Such Style,,0,0,0,,As Default",
].join("\n");
const filmFonts = [
  { id: "edessa", names: ["estrangelo edessa", "estrangeloedessa"] },
  { id: "arno", names: fontNames(arno) },
  { id: "arno-italic", names: ["arno pro", "arno pro italic", "arnopro-italic"] },
  { id: "rounded", names: ["arial rounded mt bold", "arialroundedmtbold"] },
  { id: "lead", names: ["lead coat", "leadcoat"] },
  { id: "gothic", names: ["nu-century-gothic"] },
  { id: "futo", names: ["a-otf futo min a101 pro"] },
  { id: "unread", names: [] },
];
const uses = fontUses(styled, filmFonts);
// The line in Lead Coat counts too: its style's font is the dialogue's, if
// none of it is drawn so. A font had a little early is no harm.
check("the dialogue's font: its lines, within 30 s of each other as one stretch",
  uses.get("edessa"), [[4.5, 32.1], [647.4, 650], [720, 721]]);
check("a style's, and every face of its family, by a \\r or a \\fn too",
  [uses.get("arno"), uses.get("arno-italic")], [[[64.6, 69.7], [660, 661]], [[64.6, 69.7], [660, 661]]]);
check("a sign's, by its full name", uses.get("rounded"), [[223.8, 224.9], [660, 661]]);
check("one only a \\fn names", uses.get("lead"), [[647.4, 650]]);
check("one only a comment's style, or nothing, has: none", [uses.get("gothic"), uses.get("futo")], [[], []]);
check("one whose names couldn't be read: left out, no telling", uses.has("unread"), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
