/**
 * What a stream assignment means for the tracks a player was on
 * (lib/trackMove): when the host moved it onto others, said on its loading
 * screen, and when it was only the answer to what it asked for itself.
 */
import { readAssignment, type TracksHeld, type TracksAssigned } from "../src/lib/trackMove";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

/** Plays assignments through as the player does, saying what it showed. */
function player(held: TracksHeld) {
  return (next: TracksAssigned) => {
    const read = readAssignment(held, next);
    held = {
      variantKey: next.variantKey, ratingKey: next.ratingKey,
      audioStreamId: next.audioStreamId || null, subtitleStreamId: next.subtitleStreamId,
      asked: read.stillAsked,
    };
    return read.movedBy;
  };
}
const film = "47349";
const at = (variantKey: string, audioStreamId = 302993, subtitleStreamId = 302998): TracksAssigned =>
  ({ variantKey, ratingKey: film, audioStreamId, subtitleStreamId });

console.log("\n— a viewer that asks for its own quality as it joins —");
{
  // 4 November, 19:59:44: Firefox joined on the host's 8 Mbps and asked for
  // Auto. The server first said again the stream the player had just started,
  // then answered with Auto — read as the host switching subtitles.
  const assign = player({
    variantKey: "302993:0@8000/h264", ratingKey: film,
    audioStreamId: 302993, subtitleStreamId: 302998, asked: true,
  });
  check("the stream it is on, said again, is no move", assign(at("302993:0@8000/h264")), null);
  check("and the quality it asked for, arriving after, is no move either", assign(at("302993:0")), null);
}

console.log("\n— the host moving a viewer —");
{
  const assign = player({
    variantKey: "302993:0", ratingKey: film, audioStreamId: 302993, subtitleStreamId: 0, asked: false,
  });
  check("onto other audio is said as audio", assign(at("302994:0", 302994, 0)), "audio");
  check("onto a subtitle burned in is said as subtitles", assign(at("302994:302998", 302994, 302998)), "subtitle");
  check("onto the same tracks for another screen is no move", assign(at("302994:302998/sdr", 302994, 302998)), null);
}

console.log("\n— nothing but the quality changing, not asked for here —");
{
  const assign = player({
    variantKey: "302993:0@8000", ratingKey: film, audioStreamId: 302993, subtitleStreamId: 0, asked: false,
  });
  check("is not called a change of subtitles", assign(at("302993:0", 302993, 0)), null);
}

console.log("\n— a change asked for here —");
{
  const assign = player({
    variantKey: "302993:0", ratingKey: film, audioStreamId: 302993, subtitleStreamId: 0, asked: true,
  });
  check("its answer is no move", assign(at("302994:0", 302994, 0)), null);
  check("and once answered, the host's next one is", assign(at("302993:0", 302993, 0)), "audio");
}

console.log("\n— a new title —");
{
  const assign = player({
    variantKey: "302993:0", ratingKey: film, audioStreamId: 302993, subtitleStreamId: 0, asked: false,
  });
  check("comes with its own tracks, and is no move",
    assign({ variantKey: "411:0", ratingKey: "18180", audioStreamId: 411, subtitleStreamId: 0 }), null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
