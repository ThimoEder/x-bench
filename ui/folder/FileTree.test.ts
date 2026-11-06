import { after, test } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "../testing/dom.ts";

const dom = installDom();
const { changedPaths } = await import("./FileTree.tsx");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

test("changed files resolve against the repo root", () => {
  assert.deepEqual([...changedPaths({ root: "/repo", files: [{ path: "ui/app.ts" }, { path: "README.md" }, {}] })], ["/repo/ui/app.ts", "/repo/README.md"]);
  assert.equal(changedPaths({ root: "", files: [{ path: "a" }] }).size, 0);
  assert.equal(changedPaths({ error: "not a repo", files: [] }).size, 0);
});
