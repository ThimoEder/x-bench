import assert from "node:assert/strict";
import { execFile as nodeExecFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExecFile } from "./folderGit.ts";
import { localGitDiffs } from "./localGit.ts";

test("to main lists a branch's committed and uncommitted changes, and HEAD only the uncommitted ones", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "local-git-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
    writeFileSync(path.join(root, "base.txt"), "one\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "topic");
    writeFileSync(path.join(root, "committed.txt"), "a\n");
    git("add", ".");
    git("commit", "-q", "-m", "topic");
    git("checkout", "-q", "main");
    writeFileSync(path.join(root, "later.txt"), "on main\n");
    git("add", ".");
    git("commit", "-q", "-m", "later on main");
    git("checkout", "-q", "topic");
    writeFileSync(path.join(root, "base.txt"), "one\ntwo\n");

    const paths = (result: { files: { path: string }[] }) => result.files.map((file) => file.path);
    assert.deepEqual(paths(await localGitDiffs(root)), ["base.txt"]);
    assert.deepEqual(paths(await localGitDiffs(root, null, {}, "main")), ["base.txt", "committed.txt"]);
    const [patch] = (await localGitDiffs(root, ["committed.txt"], {}, "main")).files;
    assert.match(patch?.patch ?? "", /\+a/);

    git("checkout", "-q", "main");
    assert.deepEqual(paths(await localGitDiffs(root, null, {}, "main")), ["base.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a whole patch carries every line of the file as context", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "local-git-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    writeFileSync(path.join(root, "notes.md"), `${lines.join("\n")}\n`);
    git("add", ".");
    git("commit", "-q", "-m", "base");
    writeFileSync(path.join(root, "notes.md"), `${lines.join("\n")}\nline 13\n`);

    const [short] = (await localGitDiffs(root, ["notes.md"])).files;
    const [whole] = (await localGitDiffs(root, ["notes.md"], {}, "head", true)).files;
    assert.doesNotMatch(short?.patch ?? "", /^ line 1$/m);
    assert.match(whole?.patch ?? "", /^ line 1$/m);
    assert.match(whole?.patch ?? "", /^\+line 13$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the patches of many files come from one git diff, each the same as the file's own", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "local-git-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
    mkdirSync(path.join(root, "dir"));
    const names = ["a.txt", "b c.txt", "dir/d.txt", 'say "hi".txt', "cr.txt", "link"];
    for (const name of names) writeFileSync(path.join(root, name), "one\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    for (const name of names.slice(0, 4)) writeFileSync(path.join(root, name), "one\ntwo\n");
    writeFileSync(path.join(root, "cr.txt"), "one\rdiff --git a/a.txt b/a.txt\n");
    rmSync(path.join(root, "link"));
    symlinkSync("a.txt", path.join(root, "link"));
    writeFileSync(path.join(root, "new.txt"), "fresh\n");
    const patchRuns: string[][] = [];
    const execFile: ExecFile = (file, args, options, callback) => {
      if (args.includes("diff") && !args.some((arg) => ["--numstat", "--name-status", "--no-index"].includes(arg))) patchRuns.push(args);
      return nodeExecFile(file, args, options, callback);
    };
    const own = (name: string) =>
      execFileSync("git", ["diff", "HEAD", "--no-renames", "--no-ext-diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--", name], { cwd: root }).toString();

    const { files } = await localGitDiffs(root, [...names, "new.txt"], { execFile });
    for (const name of names) assert.equal(files.find((file) => file.path === name)?.patch, own(name), name);
    assert.match(files.find((file) => file.path === "new.txt")?.patch ?? "", /^\+fresh$/m);
    // One run for every file, and one more for the name git quotes.
    assert.equal(patchRuns.length, 2);

    patchRuns.length = 0;
    const [one] = (await localGitDiffs(root, ["a.txt"], { execFile })).files;
    assert.equal(one?.patch, own("a.txt"));
    assert.deepEqual(patchRuns.map((args) => args.slice(args.indexOf("--"))), [["--", "a.txt"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
