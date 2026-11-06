import assert from "node:assert/strict";
import test from "node:test";
import { createDraftWorktree, keptWorktree } from "./draftWorktree.ts";

// A host whose /repo is a checkout, /repo-tree a worktree of it, and /notes outside git.
function fakeHost() {
  const calls: [string, Record<string, unknown>][] = [];
  const call = async (path: string, body: Record<string, unknown>) => {
    calls.push([path, body]);
    if (path === "/api/folder/refs") {
      if (body.cwd === "/notes") return { root: "", branch: "", branches: [], worktrees: [], error: "not a git repository" };
      return { root: String(body.cwd), branch: "feature", defaultBranch: "main", branches: [], worktrees: [], worktree: body.cwd === "/repo-tree" };
    }
    return { path: "/worktrees/repo/claude-fix-the-badge", ref: body.gitRef ?? "origin/main", label: "claude/fix-the-badge" };
  };
  return { calls, call };
}

test("a draft moves into the worktree it created, so a retried send creates no second one", async () => {
  const { calls, call } = fakeHost();
  const draft = { cwd: "/repo", picks: undefined, worktree: { on: true, gitRef: "main" } };
  const moved = await createDraftWorktree(draft, "claude", "Fix the badge", call);
  assert.deepEqual(calls, [
    ["/api/folder/refs", { cwd: "/repo" }],
    ["/api/folder/worktree", { cwd: "/repo", gitRef: "main", name: "Fix the badge", provider: "claude" }],
  ]);
  assert.deepEqual(moved, { cwd: "/worktrees/repo/claude-fix-the-badge", picks: undefined, worktree: { on: false, gitRef: "main", made: true } });
  assert.equal(await createDraftWorktree(moved, "claude", "Fix the badge", call), moved);
  assert.equal(calls.length, 2);
});

test("a box without a picked ref leaves the starting point to the host", async () => {
  const { calls, call } = fakeHost();
  const moved = await createDraftWorktree({ cwd: "/repo", worktree: { on: true, gitRef: "" } }, "grok", "Hello", call);
  assert.deepEqual(calls.at(-1), ["/api/folder/worktree", { cwd: "/repo", name: "Hello", provider: "grok" }]);
  assert.deepEqual(moved.worktree, { on: false, gitRef: "", made: true });
});

test("a draft without the box, a chat, a folder outside git or a worktree creates nothing", async () => {
  const { calls, call } = fakeHost();
  const off = { cwd: "/repo", worktree: { on: false, gitRef: "main" } };
  assert.equal(await createDraftWorktree(off, "grok", "", call), off);
  const chat = { cwd: "chat", chat: true, worktree: { on: true, gitRef: "main" } };
  assert.equal(await createDraftWorktree(chat, "grok", "", call), chat);
  const plain = { cwd: "/notes", worktree: { on: true, gitRef: "main" } };
  assert.equal(await createDraftWorktree(plain, "grok", "", call), plain);
  const tree = { cwd: "/repo-tree", worktree: { on: true, gitRef: "" } };
  assert.equal(await createDraftWorktree(tree, "grok", "", call), tree);
  assert.equal(calls.some(([path]) => path === "/api/folder/worktree"), false);

  const broken = async (path: string) => (path === "/api/folder/refs" ? { root: "/repo", branches: [], worktrees: [] } : {});
  await assert.rejects(createDraftWorktree({ cwd: "/repo", worktree: { on: true, gitRef: "main" } }, "grok", "", broken), /Couldn't create the worktree/);
});

test("a draft moved to another folder keeps the box as the user left it, from that folder's default branch", () => {
  assert.deepEqual(keptWorktree({ on: false, gitRef: "topic" }), { on: false, gitRef: "" });
  assert.deepEqual(keptWorktree({ on: true, gitRef: "topic" }), { on: true, gitRef: "" });
  assert.deepEqual(keptWorktree({ on: false, gitRef: "main", made: true }), { on: true, gitRef: "" });
  assert.equal(keptWorktree(undefined), undefined);
});
