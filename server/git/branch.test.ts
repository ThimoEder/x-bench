import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { branchFromMain, latestMain, runIn, taskBranch } from "./branch.ts";

function scratch() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-branch-")));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

// A clone of a remote whose main has moved on since the clone last fetched, checked out on a topic branch.
function cloneBehindRemote() {
  const dir = scratch();
  const remote = path.join(dir, "remote.git");
  const other = path.join(dir, "other");
  const clone = path.join(dir, "clone");
  git(dir, "init", "-q", "--bare", "-b", "main", remote);
  git(dir, "clone", "-q", remote, other);
  git(other, "config", "user.email", "t@example.com");
  git(other, "config", "user.name", "T");
  git(other, "config", "commit.gpgsign", "false");
  git(other, "checkout", "-q", "-b", "main");
  fs.writeFileSync(path.join(other, "a.txt"), "one\n");
  git(other, "add", "a.txt");
  git(other, "commit", "-q", "-m", "one");
  git(other, "push", "-q", "origin", "main");
  git(dir, "clone", "-q", remote, clone);
  git(clone, "config", "user.email", "t@example.com");
  git(clone, "config", "user.name", "T");
  git(clone, "config", "commit.gpgsign", "false");
  git(clone, "checkout", "-q", "-b", "topic");
  fs.writeFileSync(path.join(other, "a.txt"), "two\n");
  git(other, "commit", "-q", "-am", "two");
  git(other, "push", "-q", "origin", "main");
  return { clone, latest: git(other, "rev-parse", "HEAD") };
}

test("latest main is origin's default branch, fetched first", async () => {
  const { clone, latest } = cloneBehindRemote();
  assert.equal(await latestMain(clone), "origin/main");
  assert.equal(git(clone, "rev-parse", "origin/main"), latest, "the fetch brought main up to date");
});

test("a folder without a remote starts from its local main, and one without main is refused", async () => {
  const dir = scratch();
  git(dir, "init", "-q", "-b", "trunk");
  git(dir, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "--no-gpg-sign", "-m", "one");
  await assert.rejects(latestMain(dir), /no main branch/);
  git(dir, "branch", "-m", "trunk", "master");
  assert.equal(await latestMain(dir), "master");
});

test("branch from latest main checks out a new task branch in the folder, with a suffix when the name is taken", async () => {
  const { clone, latest } = cloneBehindRemote();
  const first = await branchFromMain(clone, "task/fix-the-badge");
  assert.deepEqual(first, { branch: "task/fix-the-badge", base: "origin/main" });
  assert.equal(git(clone, "rev-parse", "--abbrev-ref", "HEAD"), "task/fix-the-badge");
  assert.equal(git(clone, "rev-parse", "HEAD"), latest);
  assert.throws(() => git(clone, "config", "--get", "branch.task/fix-the-badge.remote"), "the branch does not track main");
  git(clone, "checkout", "-q", "topic");
  assert.equal((await branchFromMain(clone, "task/fix-the-badge")).branch, "task/fix-the-badge-2");
});

test("a detached worktree gets its task branch where it stands", async () => {
  const { clone, latest } = cloneBehindRemote();
  await latestMain(clone);
  git(clone, "checkout", "-q", "--detach", "origin/main");
  assert.equal(await taskBranch("task/add-a-test", "HEAD", runIn(clone)), "task/add-a-test");
  assert.equal(git(clone, "rev-parse", "HEAD"), latest);
});
