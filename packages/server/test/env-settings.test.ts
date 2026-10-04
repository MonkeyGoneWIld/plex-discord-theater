import assert from "node:assert/strict";
import { numberSetting, sizeSetting } from "../src/services/env-settings.js";

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

const GB = 1024 ** 3;
const MB = 1024 ** 2;
function size(raw: string | undefined, fallback = 10 * GB) {
  if (raw === undefined) delete process.env[NAME];
  else process.env[NAME] = raw;
  return sizeSetting(NAME, fallback);
}
assert.equal(size(undefined), 10 * GB, "unset size falls back");
assert.equal(size(""), 10 * GB, "empty size falls back");
assert.equal(size("10G"), 10 * GB);
assert.equal(size("10GB"), 10 * GB);
assert.equal(size("10 gb"), 10 * GB, "any case, and a space before the unit");
assert.equal(size("1.5T"), 1.5 * 1024 * GB);
assert.equal(size("500M"), 500 * MB);
assert.equal(size("2048K"), 2 * MB);
assert.equal(size("500"), 500 * MB, "a bare number is megabytes, as THUMB_CACHE_MAX_MB always read it");
assert.equal(size("0"), 10 * GB, "zero falls back");
assert.equal(size("-5G"), 10 * GB, "negative falls back");
assert.equal(size("10X"), 10 * GB, "an unknown unit falls back");
assert.equal(size("ten gigs"), 10 * GB, "not a size falls back");
delete process.env[NAME];

console.log("env settings tests passed");
