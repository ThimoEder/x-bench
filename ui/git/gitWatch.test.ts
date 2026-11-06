import assert from "node:assert/strict";
import test from "node:test";
import { gitSnapshot, reviewUpdate, reviewWatchMs, watchGit } from "./gitWatch.ts";

const files = [
  { path: "ui/Dock.jsx", type: "edit", additions: 2, deletions: 1 },
  { path: "ui/GitChanges.jsx", type: "edit", additions: 4, deletions: 0 },
];

test("the open review pane checks more often while a turn is running", () => {
  assert.equal(reviewWatchMs(true), 2000);
  assert.equal(reviewWatchMs(false), 5000);
});

test("the local git check pauses while the window is hidden and runs once when it shows", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const page = Object.assign(new EventTarget(), { visibilityState: "hidden" });
  Object.defineProperty(globalThis, "document", { value: page, configurable: true });
  t.after(() => Reflect.deleteProperty(globalThis, "document"));
  let loads = 0;
  const stop = watchGit(() => { loads += 1; }, 1000, null, false);
  t.mock.timers.tick(3000);
  assert.equal(loads, 0);
  page.visibilityState = "visible";
  page.dispatchEvent(new Event("visibilitychange"));
  t.mock.timers.tick(1000);
  assert.equal(loads, 2);
  stop();
});

test("an unchanged file list does not replace the review state", () => {
  const data = { branch: "main", commit: "abc1234", files };
  const update = reviewUpdate(gitSnapshot(data), data, "");
  assert.equal(update.info, null);
  assert.equal(update.refresh, null);
  assert.equal(update.clear, false);
});

test("a new or edited file replaces the review list", () => {
  const before = { branch: "main", commit: "abc1234", files };
  const after = {
    branch: "main",
    commit: "abc1234",
    files: [...files, { path: "ui/gitWatch.js", type: "add", additions: 10, deletions: 0 }],
  };
  const update = reviewUpdate(gitSnapshot(before), after, "ui/Dock.jsx");
  assert.equal(update.info, after);
  assert.equal(update.refresh?.path, "ui/Dock.jsx");
  assert.equal(update.clear, false);
});

test("the open diff refreshes even when the line counts stay the same", () => {
  const data = { branch: "main", commit: "abc1234", files };
  const update = reviewUpdate(gitSnapshot(data), data, "ui/GitChanges.jsx");
  assert.equal(update.info, null);
  assert.equal(update.refresh?.path, "ui/GitChanges.jsx");
  assert.equal(update.clear, false);
});

test("a selected file that disappeared closes its diff", () => {
  const data = { branch: "main", commit: "abc1234", files: [] };
  const update = reviewUpdate("previous", data, "ui/Dock.jsx");
  assert.equal(update.refresh, null);
  assert.equal(update.clear, true);
});
