import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { goneWorktree } from "./goneFolder.ts";
import { worktreeFolderName } from "../git/worktree.ts";

const root = "/home/me/.x-bench/worktrees";
const exists = (folders: string[]) => (folder: string) => folders.includes(folder);

test("a removed Claude Code worktree belongs to the checkout that holds .claude/worktrees", () => {
  const found = goneWorktree("/repo/.claude/worktrees/feature/app", [], root, exists(["/repo", "/repo/app"]));
  assert.deepEqual(found, { project: "/repo", folder: "/repo/app", worktree: "feature" });
  assert.deepEqual(goneWorktree("/repo/.claude/worktrees/feature/gone", [], root, exists(["/repo"])), { project: "/repo", folder: "/repo", worktree: "feature" });
  assert.equal(goneWorktree("/repo/.claude/worktrees/feature", [], root, exists([])), null);
});

test("a removed worktree of this app belongs to the project whose name and hash name its folder", () => {
  const group = worktreeFolderName("/code/shop");
  const found = goneWorktree(path.join(root, group, "claude-fix-badge"), ["/code/other", "/code/shop"], root, exists(["/code/shop"]));
  assert.deepEqual(found, { project: "/code/shop", folder: "/code/shop", worktree: "claude-fix-badge" });
  assert.equal(goneWorktree(path.join(root, group, "claude-fix-badge"), ["/elsewhere/shop"], root, exists(["/elsewhere/shop"])), null);
  assert.equal(goneWorktree(path.join(root, group), ["/code/shop"], root, exists(["/code/shop"])), null);
});

test("a plain folder that is gone has no checkout", () => {
  assert.equal(goneWorktree("/old/prototype", ["/old"], root, exists(["/old"])), null);
});
