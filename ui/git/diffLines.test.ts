import assert from "node:assert/strict";
import test from "node:test";
import { diffLines } from "./diffLines.ts";

test("a diff shows its hunks with the line numbers each side gives", () => {
  const patch = [
    "diff --git a/a.ts b/a.ts",
    "index 1111111..2222222 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -10,3 +10,3 @@ function a() {",
    " keep",
    "-old",
    "+new",
    "--- a dashed line",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  assert.deepEqual(diffLines(patch), [
    { kind: "hunk", text: "@@ -10,3 +10,3 @@ function a() {" },
    { kind: "same", text: "keep", number: 10 },
    { kind: "del", text: "old", number: 11 },
    { kind: "add", text: "new", number: 11 },
    { kind: "del", text: "-- a dashed line", number: 12 },
    { kind: "note", text: "\\ No newline at end of file" },
  ]);
});

test("a mode change or rename shows above the hunks, without the lines the title already says", () => {
  const patch = [
    "diff --git a/old.sh b/new.sh",
    "old mode 100644",
    "new mode 100755",
    "similarity index 90%",
    "rename from old.sh",
    "rename to new.sh",
    "index 1111111..2222222",
    "--- a/old.sh",
    "+++ b/new.sh",
    "@@ -1 +1 @@",
    "-echo old",
    "+echo new",
  ].join("\n");
  assert.deepEqual(diffLines(patch), [
    { kind: "note", text: "old mode 100644" },
    { kind: "note", text: "new mode 100755" },
    { kind: "note", text: "similarity index 90%" },
    { kind: "note", text: "rename from old.sh" },
    { kind: "note", text: "rename to new.sh" },
    { kind: "hunk", text: "@@ -1 +1 @@" },
    { kind: "del", text: "echo old", number: 1 },
    { kind: "add", text: "echo new", number: 1 },
  ]);
});

test("a binary diff keeps its one line, and an empty diff has nothing to lay out", () => {
  assert.deepEqual(diffLines("diff --git a/b.png b/b.png\nindex 1..2 100644\nBinary files a/b.png and b/b.png differ\n"), [
    { kind: "note", text: "Binary files a/b.png and b/b.png differ" },
  ]);
  assert.equal(diffLines(""), null);
});
