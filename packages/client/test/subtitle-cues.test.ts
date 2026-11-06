/**
 * lib/subtitleCues: which lines are up, and what a player knows of a subtitle
 * still being read.
 */
import {
  activeCues, coveredAhead, KEPT_SUBTITLES, keepLines, keptLines, longestCue, placeToAsk, plainLinesDraw, withStretch,
  type CoveredSpan, type TimedCue,
} from "../src/lib/subtitleCues";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

const line = (start: number, end: number, text = `${start}`): TimedCue => ({ start, end, text });

console.log("— where every line has come —");
{
  const spans: CoveredSpan[] = [[0, 120], [3570, 4200], [6000, null]];
  check("inside the read from the start: how far it goes on", coveredAhead(spans, 100), 20);
  check("at its very end, not inside it", coveredAhead(spans, 120), null);
  check("in a quiet stretch between: nothing known", coveredAhead(spans, 1000), null);
  check("inside a stretch read around somewhere", coveredAhead(spans, 3600), 600);
  check("in one that runs to the end", coveredAhead(spans, 7000), Infinity);
  check("nothing yet", coveredAhead([], 0), null);
}

console.log("\n— an answer for one stretch —");
{
  const known = [line(10, 12), line(100, 102, "old"), line(200, 205), line(590, 610, "spans the edge")];
  const merged = withStretch(known, 50, 600, [line(100, 102, "new"), line(300, 301)]);
  check("replaces what was known inside it — a line running out of it too — keeps what is outside, in order",
    merged.map((c) => c.text), ["10", "new", "300"]);
  check("a line running into it from before is the answer's to say", withStretch([line(40, 55, "into")], 50, 600, []).length, 0);
  check("one ending where it starts is kept", withStretch([line(40, 50, "before")], 50, 600, []).length, 1);
  check("and the answer's lines are drawn", activeCues(merged, 300.5, longestCue(merged)).map((c) => c.text), ["300"]);
}

console.log("\n— where to ask, after a skip —");
{
  // Pirates on 6 November: lines read around 2:06:45, then a skip to 2:17:37.
  const spans: CoveredSpan[] = [[7576, 7726]];
  check("a skip's target not known: asked for before the picture gets there", placeToAsk(spans, 7616, 8257), 8257);
  check("its target known: where the picture is, if that isn't", placeToAsk([[7576, 7726], [8228, 8378]], 7800, 8257), 7800);
  check("both known: nowhere", placeToAsk([[7576, 7726], [8228, 8378]], 7616, 8257), null);
  check("no skip, the picture somewhere not known: there", placeToAsk(spans, 8000, null), 8000);
  check("before the first answer: nowhere, that one is asked anyway", placeToAsk(null, 0, 8257), null);
}

console.log("\n— lines kept —");
{
  keepLines("a", [line(1, 2)]);
  check("kept once all have come", keptLines("a"), [line(1, 2)]);
  check("none for one never kept", keptLines("b"), null);
  for (let i = 0; i < KEPT_SUBTITLES; i++) keepLines(`n${i}`, [line(i, i + 1)]);
  check(`only the last ${KEPT_SUBTITLES}`, [keptLines("a"), keptLines("n0") !== null, keptLines(`n${KEPT_SUBTITLES - 1}`) !== null], [null, true, true]);
}

console.log("\n— the plain lines of an ASS subtitle —");
check("drawn styled, its drawing up: not drawn", plainLinesDraw({ styled: true, styledUp: true, inPip: false }), false);
check("drawn styled, its drawing not up yet (a PiP just closed): drawn till it is",
  plainLinesDraw({ styled: true, styledUp: false, inPip: false }), true);
check("in a PiP: drawn", plainLinesDraw({ styled: true, styledUp: true, inPip: true }), true);
check("not drawn styled: drawn", plainLinesDraw({ styled: false, styledUp: false, inPip: false }), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
