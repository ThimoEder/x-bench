import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isTaskStart, retargetPrompt, taskBranchName } from "./taskStart.ts";

function scratch() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-task-start-")));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a task branch is named after its title", () => {
  assert.equal(taskBranchName("Fix the stale README badge!"), "task/fix-the-stale-readme-badge");
  assert.equal(taskBranchName("Café: ünïcode"), "task/cafe-unicode");
  assert.equal(taskBranchName("???"), "task/follow-up");
  assert.ok(taskBranchName("word ".repeat(40)).length <= "task/".length + 48);
  assert.equal(isTaskStart("worktree"), true);
  assert.equal(isTaskStart("main"), false);
});

test("a prompt's paths into the source folder point at the folder the task starts in", () => {
  const dir = scratch();
  const source = path.join(dir, "demo");
  const tree = path.join(dir, "tree");
  fs.mkdirSync(source);
  fs.mkdirSync(tree);
  const prompt = `In ${source}, fix ${source}/math.js. Leave ${source}2/notes.md and ${source}.bak alone.`;
  assert.equal(retargetPrompt(prompt, [source], tree), `In ${tree}, fix ${tree}/math.js. Leave ${source}2/notes.md and ${source}.bak alone.`);
  assert.equal(retargetPrompt(prompt, [source], source), prompt, "a task in its own folder keeps the prompt");
  assert.equal(retargetPrompt("Fix math.js.", [source], tree), "Fix math.js.");
  assert.equal(retargetPrompt(`Fix ${source}/a.js`, [source], "/x/$&"), "Fix /x/$&/a.js", "the target is inserted as written");
});

test("a prompt names the source folder with or without macOS's /private prefix", { skip: process.platform !== "darwin" }, () => {
  const source = fs.realpathSync(fs.mkdtempSync("/tmp/x-bench-retarget-"));
  test.after(() => fs.rmSync(source, { recursive: true, force: true }));
  assert.ok(source.startsWith("/private/tmp/"));
  const short = source.slice("/private".length);
  assert.equal(retargetPrompt(`Edit ${short}/a.js and ${source}/b.js.`, [short], "/tree"), "Edit /tree/a.js and /tree/b.js.");
});
