import assert from "node:assert/strict";
import { numberSetting } from "../src/services/env-settings.js";

const NAME = "THEATER_TEST_NUMBER_SETTING";
function read(raw: string | undefined, fallback: number, min?: number) {
  if (raw === undefined) delete process.env[NAME];
  else process.env[NAME] = raw;
  return numberSetting(NAME, fallback, min);
}

assert.equal(read(undefined, 240), 240, "unset falls back");
assert.equal(read("", 240), 240, "empty, as docker-compose passes a setting left out of .env, falls back");
assert.equal(read("   ", 240), 240, "blank falls back");
assert.equal(read("90", 240), 90);
assert.equal(read(" 90 ", 240), 90, "surrounding spaces are ignored");
assert.equal(read("1.5", 240, 1), 1.5);
assert.equal(read("0", 600), 0, "zero is allowed when the minimum is zero");
assert.equal(read("0", 240, 1), 240, "below the minimum falls back");
assert.equal(read("-5", 250), 250, "negative falls back");
assert.equal(read("abc", 250), 250, "not a number falls back");
assert.equal(read("Infinity", 250), 250, "infinite falls back");
delete process.env[NAME];

console.log("env settings tests passed");
