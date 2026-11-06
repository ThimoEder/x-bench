import assert from "node:assert/strict";
import test from "node:test";
import { appBundle, copyName, isNewer } from "./updateRules.js";

test("a version is newer only by its numbers, part by part", () => {
  assert.equal(isNewer("0.0.2", "0.0.1"), true);
  assert.equal(isNewer("0.10.0", "0.9.9"), true);
  assert.equal(isNewer("0.0.1", "0.0.1"), false);
  assert.equal(isNewer("0.0.1", "0.1.0"), false);
  assert.equal(isNewer("1.0", "0.0.1"), false);
  assert.equal(isNewer("1.0.0-beta", "0.0.1"), false);
});

test("the app replaces itself only from an app bundle macOS has not moved", () => {
  assert.equal(appBundle("/Applications/X Bench.app/Contents/MacOS/X Bench"), "/Applications/X Bench.app");
  assert.equal(appBundle("/usr/local/bin/electron"), null);
  assert.equal(appBundle("/private/var/folders/x/AppTranslocation/ABC/d/X Bench.app/Contents/MacOS/X Bench"), null);
});

test("only a packaged copy has a name in X_BENCH_APP_NAME", () => {
  assert.equal(copyName({}), null);
  assert.equal(copyName({ X_BENCH_APP_NAME: "  " }), null);
  assert.equal(copyName({ X_BENCH_APP_NAME: " Work Bench " }), "Work Bench");
});
