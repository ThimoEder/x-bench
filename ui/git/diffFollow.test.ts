import assert from "node:assert/strict";
import test from "node:test";
import { patchRecord, pathAtScroll, revealScroll, reviewPatches, samePatches } from "./diffFollow.ts";

test("the file at the top of the review scroll is the current one", () => {
  const sections = [
    { path: "a.js", top: 0 },
    { path: "b.js", top: 400 },
    { path: "c.js", top: 900 },
  ];
  assert.equal(pathAtScroll(0, sections), "a.js");
  assert.equal(pathAtScroll(399, sections), "a.js");
  assert.equal(pathAtScroll(400, sections), "b.js");
  assert.equal(pathAtScroll(1200, sections), "c.js");
  assert.equal(pathAtScroll(0, []), "");
});

test("the file list scrolls just enough to show the current file", () => {
  assert.equal(revealScroll(0, 0, 100, 10, 40), 0);
  assert.equal(revealScroll(0, 0, 100, 150, 180), 80);
  assert.equal(revealScroll(50, 50, 150, 10, 40), 10);
});

test("unchanged patches keep the same record", () => {
  const current = patchRecord([{ path: "a.js", patch: "+a" }]);
  assert.equal(samePatches(current, [{ path: "a.js", patch: "+a" }]), true);
  assert.equal(samePatches(current, [{ path: "a.js", patch: "+b" }]), false);
  assert.equal(samePatches(current, [{ path: "a.js", patch: "+a" }, { path: "b.js", patch: "" }]), false);
});

test("review patches use one bulk diff and fall back to each file", async () => {
  const bulk = await reviewPatches({
    bulk: async (paths) => paths.map((path) => ({ path, patch: `+${path}` })),
    one: async () => {
      throw new Error("single file");
    },
  }, ["a.js", "a.js", "b.js"]);
  assert.deepEqual(bulk, [
    { path: "a.js", patch: "+a.js" },
    { path: "b.js", patch: "+b.js" },
  ]);
  const single = await reviewPatches({
    bulk: async () => null,
    one: async (path) => `+${path}`,
  }, ["a.js"]);
  assert.deepEqual(single, [{ path: "a.js", patch: "+a.js" }]);
});
