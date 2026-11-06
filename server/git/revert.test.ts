import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gitExec } from "./folderGit.ts";
import { checkoutActions, parsePorcelain, revertAll } from "./revert.ts";

test("nul status lists the renamed path before the original", () => {
  const entries = parsePorcelain("R  moved.txt\0note.txt\0?? extra.txt\0M  kept.txt\0");
  assert.deepEqual(entries, [
    { code: "R ", path: "moved.txt", from: "note.txt" },
    { code: "??", path: "extra.txt", from: "" },
    { code: "M ", path: "kept.txt", from: "" },
  ]);
});

test("checkout actions stay inside the review list", () => {
  const entries = parsePorcelain(" M keep.txt\0?? extra.txt\0A  added.txt\0R  moved.txt\0note.txt\0UU bad.txt\0 M other.txt\0");
  assert.deepEqual(checkoutActions(entries, ["keep.txt", "extra.txt", "added.txt", "moved.txt", "bad.txt"]), {
    restore: ["keep.txt", "note.txt"],
    unstage: ["added.txt", "moved.txt"],
    unlink: ["extra.txt", "added.txt", "moved.txt"],
    blocked: ["bad.txt"],
  });
  assert.deepEqual(checkoutActions(entries, ["extra.txt"]), {
    restore: [],
    unstage: [],
    unlink: ["extra.txt"],
    blocked: [],
  });
  assert.deepEqual(checkoutActions(entries, ["../outside.txt"]), {
    restore: [],
    unstage: [],
    unlink: [],
    blocked: [],
  });
});

test("all puts tracked, staged, and untracked review paths back and leaves the rest", async (t) => {
  const root = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (args: string[]) => gitExec(root, args);
  await writeFile(path.join(root, "note.txt"), "three\n");
  await git(["add", "note.txt"]);
  await writeFile(path.join(root, "note.txt"), "four\n");
  await writeFile(path.join(root, "extra.txt"), "x\n");
  await git(["add", "extra.txt"]);
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, "nested", "deep.txt"), "deep\n");
  await writeFile(path.join(root, "stay.txt"), "keep\n");
  const result = await revertAll({
    root,
    files: [
      { path: "note.txt", type: "edit" },
      { path: "extra.txt", type: "untracked" },
      { path: "nested/deep.txt", type: "untracked" },
    ],
  });
  assert.deepEqual(result.reverted, ["note.txt", "extra.txt", "nested/deep.txt"]);
  assert.equal(result.error, "");
  assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "one\n");
  assert.equal(await exists(path.join(root, "extra.txt")), false);
  assert.equal(await exists(path.join(root, "nested")), false);
  assert.equal(await readFile(path.join(root, "stay.txt"), "utf8"), "keep\n");
  assert.equal(await git(["status", "--porcelain=v1", "--untracked-files=all"]), "?? stay.txt\n");
});

test("all restores a rename to the committed path", async (t) => {
  const root = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (args: string[]) => gitExec(root, args);
  await git(["mv", "note.txt", "moved.txt"]);
  const result = await revertAll({
    root,
    files: [{ path: "moved.txt", type: "edit" }],
  });
  assert.deepEqual(result.reverted, ["note.txt", "moved.txt"]);
  assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "one\n");
  assert.equal(await exists(path.join(root, "moved.txt")), false);
  assert.equal(await git(["status", "--porcelain=v1"]), "");
});

test("all refuses a merge, also one in a file it was not asked for, and leaves every file alone", async (t) => {
  const root = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (args: string[]) => gitExec(root, args);
  await git(["checkout", "-b", "side"]);
  await writeFile(path.join(root, "note.txt"), "side\n");
  await git(["add", "note.txt"]);
  await git(["commit", "-m", "side"]);
  await git(["checkout", "main"]);
  await writeFile(path.join(root, "note.txt"), "main\n");
  await git(["add", "note.txt"]);
  await git(["commit", "-m", "main"]);
  await git(["merge", "--no-edit", "side"]).catch(() => {});
  await writeFile(path.join(root, "extra.txt"), "x\n");
  const before = await readFile(path.join(root, "note.txt"), "utf8");
  const result = await revertAll({
    root,
    files: [
      { path: "note.txt", type: "edit" },
      { path: "extra.txt", type: "untracked" },
    ],
  });
  assert.deepEqual(result.reverted, []);
  assert.match(result.error, /note\.txt/);
  assert.match(result.error, /merge/);
  assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), before);
  assert.equal(await readFile(path.join(root, "extra.txt"), "utf8"), "x\n");
  const unlisted = await revertAll({ root, files: [{ path: "extra.txt", type: "untracked" }] });
  assert.deepEqual(unlisted.reverted, []);
  assert.match(unlisted.error, /note\.txt/);
  assert.equal(await readFile(path.join(root, "extra.txt"), "utf8"), "x\n");
});

async function makeRepo() {
  const root = await mkdtemp(path.join(tmpdir(), "revert-"));
  const git = (args: string[]) => gitExec(root, args);
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(root, "note.txt"), "one\n");
  await git(["add", "note.txt"]);
  await git(["commit", "-m", "init"]);
  return root;
}

async function exists(file: string) {
  return access(file).then(() => true, () => false);
}
