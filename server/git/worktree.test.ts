import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseGitWorktreeList } from "./folderGit.ts";
import { addWorktree, appWorktreeOf, createHarnessWorktree, gitWorktreeRows, removeChatWorktree, removeWorktree, worktreeChanges } from "./worktree.ts";

test("a worktree gets a new branch named after the message in its own folder, and the source branch stays", async () => {
  const repo = makeRepo();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-worktrees-"));
  try {
    execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: repo });
    const first = await createHarnessWorktree("claude", repo, "main", { name: "Fix the badge", root });
    const second = await createHarnessWorktree("claude", repo, "main", { name: "Fix the badge", root });
    const codex = await createHarnessWorktree("chatgpt", repo, "main", { name: "Fix the badge", root });
    const grok = await createHarnessWorktree("grok", repo, "main", { name: "Fix the badge", root });
    const unnamed = await createHarnessWorktree("claude", repo, "main", { root });
    const task = await createHarnessWorktree("claude", repo, "main", { name: "Fix the badge", branch: "task/fix-the-badge", root });
    assert.deepEqual([first.label, second.label, codex.label, grok.label, task.label], ["claude/fix-the-badge", "claude/fix-the-badge-2", "codex/fix-the-badge", "grok/fix-the-badge", "task/fix-the-badge"]);
    assert.match(unnamed.label, /^claude\/[0-9a-f]{6}$/);
    assert.equal(path.basename(second.path), "claude-fix-the-badge-2");
    assert.equal(first.ref, "main");
    assert.equal(branchAt(first.path), first.label);
    assert.equal(fs.existsSync(path.join(first.path, "note.txt")), true);
    assert.equal(branchAt(repo), "feature");
    await assert.rejects(addWorktree(repo, "no-such-ref", "claude/x", root));
    await assert.rejects(createHarnessWorktree("other", repo, "main", { root }), /cannot create a worktree/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a worktree branch steps around a branch git cannot hold next to it", async () => {
  const repo = makeRepo();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-worktrees-"));
  try {
    execFileSync("git", ["branch", "claude"], { cwd: repo });
    execFileSync("git", ["branch", "grok/fix-the-badge/old"], { cwd: repo });
    const claude = await createHarnessWorktree("claude", repo, "main", { name: "Fix the badge", root });
    const grok = await createHarnessWorktree("grok", repo, "main", { name: "Fix the badge", root });
    assert.deepEqual([claude.label, grok.label], ["claude-fix-the-badge", "grok/fix-the-badge-2"]);
    assert.equal(branchAt(claude.path), "claude-fix-the-badge");
    assert.equal(branchAt(grok.path), "grok/fix-the-badge-2");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("worktrees start in the draft's subfolder, two creates at once get two names, and a failed add leaves nothing behind", async () => {
  const repo = makeRepo();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-worktrees-"));
  try {
    fs.mkdirSync(path.join(repo, "packages", "app"), { recursive: true });
    fs.writeFileSync(path.join(repo, "packages", "app", "index.js"), "");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "app"], { cwd: repo });
    const nested = await createHarnessWorktree("claude", path.join(repo, "packages", "app"), "main", { name: "Nested", root });
    assert.equal(path.basename(nested.path), "app");
    assert.equal(nested.path.endsWith("/"), false);
    assert.equal(fs.existsSync(path.join(nested.path, "index.js")), true);

    const both = await Promise.all([1, 2].map(() => createHarnessWorktree("claude", repo, "main", { name: "Same", root })));
    assert.deepEqual(both.map((tree) => tree.label).sort(), ["claude/same", "claude/same-2"]);

    const hooks = path.join(repo, ".git", "hooks");
    fs.writeFileSync(path.join(hooks, "post-checkout"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await assert.rejects(createHarnessWorktree("claude", repo, "main", { name: "Broken", root }));
    const branches = execFileSync("git", ["branch", "--list", "claude/broken*"], { cwd: repo, encoding: "utf8" });
    assert.equal(branches.trim(), "");
    assert.equal(fs.readdirSync(path.dirname(path.dirname(nested.path))).some((name) => name.startsWith("claude-broken")), false);
    assert.doesNotMatch(execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" }), /claude-broken/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("git's worktree list leaves out the main checkout, also from inside a linked worktree", async () => {
  const repo = fs.realpathSync(makeRepo());
  const tree = `${repo}-tree`;
  try {
    execFileSync("git", ["worktree", "add", "-q", "-b", "topic", tree], { cwd: repo, stdio: "ignore" });
    for (const cwd of [repo, tree]) {
      assert.deepEqual(await gitWorktreeRows(cwd), [
        { id: tree, path: tree, status: "alive", source_repo: repo, git_ref: "topic", metadata: { label: path.basename(tree) } },
      ]);
    }
    assert.deepEqual(parseGitWorktreeList(""), []);
    const gone = `worktree ${repo}\nHEAD abc\nbranch refs/heads/main\n\nworktree /gone\nHEAD def\nbranch refs/heads/old\nprunable gitdir file points to non-existent location\n`;
    assert.deepEqual(parseGitWorktreeList(gone), []);
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("an app worktree's uncommitted changes are listed before it goes, and discarding them removes it while its branch stays", async () => {
  const repo = makeRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-worktrees-")));
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-plain-"));
  try {
    const created = await createHarnessWorktree("claude", repo, "main", { name: "Draft", root });
    const worktree = appWorktreeOf(created.path, root) ?? "";
    const alone = [{ id: "a", cwd: created.path }];
    assert.equal(await worktreeChanges(worktree, "a", alone, root), null);
    assert.equal(await worktreeChanges(path.join(root, "gone", "gone"), "a", [], root), null);
    await assert.rejects(worktreeChanges(plain, "a", [], root), /^Error: The worktree's changes could not be read/);

    fs.writeFileSync(path.join(created.path, "note.txt"), "one\ntwo\n");
    execFileSync("git", ["add", "note.txt"], { cwd: created.path });
    fs.writeFileSync(path.join(created.path, "note.txt"), "one\n");
    fs.writeFileSync(path.join(created.path, "draft.txt"), "draft\n");
    const changes = await worktreeChanges(worktree, "a", alone, root);
    assert.equal(changes?.branch, "claude/draft");
    assert.deepEqual(changes?.files.map((file) => [file.path, file.type]), [["draft.txt", "untracked"], ["note.txt", "edit"]]);
    assert.equal(await worktreeChanges(worktree, "a", [...alone, { id: "b", cwd: created.path }], root), null);

    assert.equal(await removeChatWorktree(worktree, "a", alone, root, true), "");
    assert.equal(fs.existsSync(worktree), false);
    assert.match(execFileSync("git", ["branch", "--list", created.label], { cwd: repo, encoding: "utf8" }), /claude\/draft/);
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("removing an app worktree refuses local changes, and a clean one goes while its branch stays", async () => {
  const repo = makeRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-worktrees-")));
  try {
    fs.mkdirSync(path.join(repo, "app"));
    fs.writeFileSync(path.join(repo, "app", "index.js"), "");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "app"], { cwd: repo });
    const created = await createHarnessWorktree("claude", path.join(repo, "app"), "main", { name: "Tidy", root });
    const worktree = appWorktreeOf(created.path, root);
    assert.equal(worktree, path.dirname(created.path));
    assert.equal(appWorktreeOf(path.dirname(worktree ?? ""), root), null);
    assert.equal(appWorktreeOf(repo, root), null);

    fs.writeFileSync(path.join(created.path, "draft.txt"), "");
    await assert.rejects(removeWorktree(worktree ?? ""), (error: Error) => /contains modified or untracked files$/.test(error.message) && !/^fatal/.test(error.message));
    assert.equal(fs.existsSync(created.path), true);

    fs.rmSync(path.join(created.path, "draft.txt"));
    const rows = [{ id: "a", cwd: created.path }, { id: "b", cwd: created.path }];
    assert.equal(await removeChatWorktree(worktree ?? "", "a", rows, root), "The worktree stays: another chat uses it.");
    assert.equal(fs.existsSync(created.path), true);
    assert.equal(await removeChatWorktree(worktree ?? "", "a", rows.slice(0, 1), root), "");
    assert.equal(fs.existsSync(worktree ?? ""), false);
    assert.equal(fs.existsSync(path.dirname(worktree ?? "")), false);
    assert.match(execFileSync("git", ["branch", "--list", created.label], { cwd: repo, encoding: "utf8" }), /claude\/tidy/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

function branchAt(cwd: string): string {
  return execFileSync("git", ["-C", cwd, "branch", "--show-current"], { encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-worktree-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "note.txt"), "one\n");
  git("add", "note.txt");
  git("commit", "-m", "init");
  return repo;
}
