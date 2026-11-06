import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectLocator, projectHome, readGitWorktree, readGrokWorktreeLinks, worktreeLinks } from "./projectHome.ts";
import { canonicalCwd } from "../chat/sessions.ts";

test("a normal folder stays its own project", () => {
  assert.deepEqual(projectHome("/work/app", new Map(), () => null), { home: "/work/app", worktree: null });
});

test("a grok worktree follows source_repo back to the checkout that started it", () => {
  const links = worktreeLinks([
    { path: "/wt/nested", source_repo: "/wt/mid" },
    { path: "/wt/mid", source_repo: "/repo" },
    { path: "/repo", source_repo: "/repo" },
  ]);
  assert.deepEqual(projectHome("/wt/nested", links), { home: "/repo", worktree: "nested" });
  assert.deepEqual(projectHome("/wt/nested/src", links), { home: "/repo", worktree: "nested" });
  assert.deepEqual(projectHome("/wt/mid", links), { home: "/repo", worktree: "mid" });
  assert.deepEqual(projectHome("/repo", links), { home: "/repo", worktree: null });
  assert.deepEqual(projectHome("/repo/pkg", links), { home: "/repo/pkg", worktree: null });
});

test("a cycle in worktree links stops", () => {
  const links = worktreeLinks([
    { path: "/wt/a", source_repo: "/wt/b" },
    { path: "/wt/b", source_repo: "/wt/a" },
  ]);
  const found = projectHome("/wt/a", links);
  assert.equal(found.worktree, "a");
  assert.ok(found.home === "/wt/a" || found.home === "/wt/b");
});

test("a linked git worktree belongs to the main checkout", () => {
  const root = mkdtempSync(path.join(tmpdir(), "git-wt-"));
  const topic = path.join(root, "checkout");
  mkdirSync(path.join(topic, "src"), { recursive: true });
  writeFileSync(path.join(topic, ".git"), `gitdir: ${path.join(root, "repo", ".git", "worktrees", "topic")}\n`);
  const main = path.join(root, "main");
  mkdirSync(path.join(main, ".git"), { recursive: true });
  mkdirSync(path.join(main, "src"), { recursive: true });
  writeFileSync(path.join(main, "src", ".git"), `gitdir: ${path.join(main, ".git", "modules", "src")}\n`);

  assert.equal(readGitWorktree(path.join(topic, "src"))?.home, path.join(root, "repo"));
  assert.equal(readGitWorktree(path.join(topic, "src"))?.worktree, "topic");
  assert.equal(readGitWorktree(path.join(topic, "src"))?.root, canonicalCwd(topic));
  assert.equal(readGitWorktree(path.join(main, "src")), null);
  const placed = projectHome(topic, new Map(), readGitWorktree);
  assert.equal(placed.home, path.join(root, "repo"));
  assert.equal(placed.worktree, "topic");
});

test("a worktree added where a removed one was belongs to its checkout", () => {
  const root = canonicalCwd(mkdtempSync(path.join(tmpdir(), "git-wt-again-")));
  const folder = path.join(root, "topic");
  const locate = createProjectLocator(path.join(root, "missing.db"));
  assert.deepEqual(locate(folder), { home: folder, worktree: null });
  mkdirSync(folder);
  writeFileSync(path.join(folder, ".git"), `gitdir: ${path.join(root, "repo", ".git", "worktrees", "topic")}\n`);
  assert.deepEqual(locate(folder), { home: path.join(root, "repo"), worktree: "topic" });
});

test("worktree rows are read from the grok database", () => {
  const root = mkdtempSync(path.join(tmpdir(), "wt-db-"));
  const dbPath = path.join(root, "worktrees.db");
  execFileSync("sqlite3", [dbPath, "CREATE TABLE worktrees (path TEXT, source_repo TEXT); INSERT INTO worktrees VALUES ('/wt/child', '/wt/parent'); INSERT INTO worktrees VALUES ('/wt/parent', '/repo');"]);
  const links = readGrokWorktreeLinks(dbPath);
  assert.deepEqual(projectHome("/wt/child", links), { home: "/repo", worktree: "child" });
  assert.equal(readGrokWorktreeLinks(path.join(root, "missing.db")).size, 0);
});
