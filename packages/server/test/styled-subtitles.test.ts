/**
 * Which ASS subtitles are drawn as their scripts have them (styled-subtitles.ts
 * styledAss): typeset ones — signs and songs placed, moved, faded, drawn and
 * set in their own fonts, as Your Lie in April's are — and not ones that are
 * plain dialogue with the odd italic or line raised to the top.
 */
import { styledAss } from "../src/services/ffmpeg/styled-subtitles.js";

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
