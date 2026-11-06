import assert from "node:assert/strict";
import test from "node:test";
import { markdownChunks, markdownImageSrc } from "./markdownDiff.ts";

const patch = [
  "diff --git a/notes.md b/notes.md",
  "--- a/notes.md",
  "+++ b/notes.md",
  "@@ -1,14 +1,17 @@",
  " # Release notes",
  " ",
  "-Long links wrap.",
  "+Long links now **wrap**.",
  " ",
  " - Width per chat",
  "-- Dropped item",
  " - Kept item",
  "-- Cards overlap",
  "+- Cards leave a gap",
  "+",
  "+  with a second paragraph",
  " ",
  " ```sh",
  " npm test",
  " ",
  " npm run lint",
  " ```",
  "\\ No newline at end of file",
  "",
].join("\n");

test("a whole patch splits into the new version's blocks, each marked by how it changed", () => {
  assert.deepEqual(markdownChunks(patch), [
    { text: "# Release notes", change: "same" },
    { text: "Long links now **wrap**.", change: "changed" },
    { text: "- Width per chat", change: "same" },
    { text: "- Dropped item", change: "removed" },
    { text: "- Kept item", change: "same" },
    { text: "- Cards leave a gap\n\n  with a second paragraph", change: "changed" },
    { text: "```sh\nnpm test\n\nnpm run lint\n```", change: "same" },
  ]);
});

const hunk = (...lines: string[]) => ["@@ -1 +1 @@", ...lines].join("\n");

test("removed blocks pair in order with the blocks added in their place, and one left over stays removed", () => {
  assert.deepEqual(markdownChunks(hunk("-- One", "-- Two", "-- Three", "+- Uno", "+- Dos", " ", " Next")), [
    { text: "- Uno", change: "changed" },
    { text: "- Dos", change: "changed" },
    { text: "- Three", change: "removed" },
    { text: "Next", change: "same" },
  ]);
});

test("an ordered list keeps counting across its items, and a new list starts again", () => {
  const texts = markdownChunks(hunk(" 1. One", " 1. Two", "+1. Three", " ", " Text", " ", " 4) Four", " 1) Five")).map((chunk) => chunk.text);
  assert.deepEqual(texts, ["1. One", "2. Two", "3. Three", "Text", "4) Four", "5) Five"]);
});

test("a code block closes only on a fence of its own kind that is at least as long", () => {
  const fence = "`".repeat(3);
  const outer = "`".repeat(4);
  const text = [`${outer}md`, fence, "", "# Inside", fence, outer].join("\n");
  assert.deepEqual(markdownChunks(hunk(...[...text.split("\n"), "", "After"].map((line) => ` ${line}`))), [
    { text, change: "same" },
    { text: "After", change: "same" },
  ]);
});

test("a patch without a hunk has nothing to show", () => {
  assert.deepEqual(markdownChunks("Binary files a/x.md and b/x.md differ"), []);
  assert.deepEqual(markdownChunks(undefined), []);
});

test("a picture a Markdown file shows is found from the file's own folder", () => {
  const path = (href: string) => new URL(markdownImageSrc("s1", "/repo/docs/guide.md", href), "http://x").searchParams.get("path");
  assert.equal(path("shots/one.png"), "/repo/docs/shots/one.png");
  assert.equal(path("./one.png"), "/repo/docs/one.png");
  assert.equal(path("/tmp/two.png"), "/tmp/two.png");
});
