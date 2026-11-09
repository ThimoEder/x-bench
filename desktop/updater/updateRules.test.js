import assert from "node:assert/strict";
import test from "node:test";
import { appBundle, copyName, isNewer, noteSections, notesList } from "./updateRules.js";

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

test("release notes group under heading lines, and notes before any heading form a section without one", () => {
  const text = "Wrap long links.\nNew:\nA board.\n\nFixed:\nA crash.\nA leak.\nEmpty:";
  assert.deepEqual(noteSections(text), [
    { heading: "", notes: ["Wrap long links."] },
    { heading: "New", notes: ["A board."] },
    { heading: "Fixed", notes: ["A crash.", "A leak."] },
  ]);
  assert.equal(notesList(text, (name) => `### ${name}`), "- Wrap long links.\n\n### New\n- A board.\n\n### Fixed\n- A crash.\n- A leak.");
  assert.deepEqual(noteSections(undefined), []);
});
