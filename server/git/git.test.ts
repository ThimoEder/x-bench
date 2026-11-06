import assert from "node:assert/strict";
import test from "node:test";
import { followCheckout, gitError, presentGit, presentPatch, presentPatches, presentRefs, refName, type GitBranch } from "./git.ts";
import { filterRefs } from "../../ui/refs.ts";

test("git status keeps the branch and the changed paths", () => {
  const view = presentGit(
    { branch: "main", commit: "abcdef1234567890" },
    { files: [{ path: "note.txt", type: "edit", additions: 1, deletions: 0 }] },
  );
  assert.equal(view.branch, "main");
  assert.equal(view.commit, "abcdef1");
  assert.equal(view.root, "");
  assert.deepEqual(view.files, [{ path: "note.txt", type: "edit", additions: 1, deletions: 0 }]);
});

test("a file diff returns only that patch", () => {
  const patch = presentPatch(
    {
      files: [
        { path: "other.txt", patch: "nope" },
        { path: "note.txt", patch: "@@ -1 +1,2 @@\n one\n+two\n", additions: 1, deletions: 0 },
      ],
    },
    "note.txt",
  );
  assert.ok(patch);
  assert.match(patch.patch, /\+two/);
  assert.equal(presentPatch({ files: [] }, "missing"), null);
});

test("a review loads every patch and keeps each one bounded", () => {
  const patches = presentPatches({
    files: [
      { path: "a.js", patch: `+${"x".repeat(20010)}`, additions: 1, deletions: 0 },
      { path: "", patch: "nope" },
      { path: "b.js", additions: 2, deletions: 3 },
    ],
  });
  assert.equal(patches.length, 2);
  assert.equal(patches[0]?.patch.length, 20000);
  assert.equal(patches[1]?.patch, "");
  assert.equal(patches[1]?.deletions, 3);
});

test("refs keep the current branch and this repo's worktrees", () => {
  const view = presentRefs(
    {
      currentBranch: "main",
      repoRoot: "/repo",
      branches: [
        { name: "origin/main", current: false, remote: true },
        { name: "topic", current: false, remote: false },
        { name: "main", current: true, remote: false },
      ],
    },
    [
      {
        id: "wt",
        path: "/work/topic/",
        source_repo: "/repo/",
        git_ref: "topic",
        status: "alive",
        metadata: { label: "topic" },
      },
      { id: "other", path: "/elsewhere", source_repo: "/other", git_ref: "main", status: "alive" },
      { id: "dead", path: "/work/old", source_repo: "/repo", status: "dead" },
    ],
    "/work/topic",
  );
  assert.deepEqual(
    view.branches.map((branch) => branch.name),
    ["main", "topic", "origin/main"],
  );
  assert.equal(view.branch, "main");
  assert.equal(view.worktree, true);
  assert.deepEqual(view.worktrees, [{ id: "wt", path: "/work/topic/", label: "topic", ref: "topic", current: true }]);
});

test("a copied worktree still counts when its git root is the copy", () => {
  const view = presentRefs(
    { currentBranch: "main", repoRoot: "/work/topic", branches: [{ name: "main", current: true }] },
    [
      {
        id: "wt",
        path: "/work/topic",
        source_repo: "/repo",
        git_ref: "main",
        status: "alive",
        metadata: { label: "2026-09-22-10913572" },
      },
    ],
    "/work/topic",
    { isWorktree: false },
  );
  assert.equal(view.worktree, true);
  assert.equal(view.worktrees[0]?.current, true);
});

test("the main checkout is not marked as a worktree", () => {
  const view = presentRefs({ currentBranch: "main", repoRoot: "/repo", branches: [{ name: "main", current: true }] }, [], "/repo");
  assert.equal(view.worktree, false);
  const linked = presentRefs(
    { currentBranch: "main", repoRoot: "/repo", branches: [{ name: "main", current: true }] },
    [],
    "/repo",
    { isWorktree: true },
  );
  assert.equal(linked.worktree, true);
});

test("a conversation on a worktree follows that checkout", () => {
  const topic = "/repo/.grok/worktrees/topic";
  assert.equal(followCheckout("/repo", { root: "/repo", isWorktree: false }), "/repo");
  assert.equal(followCheckout("/repo/ui", { root: "/repo", isWorktree: false }), "/repo/ui");
  assert.equal(followCheckout("/repo", { root: topic, isWorktree: true, branch: "topic" }), topic);
  assert.equal(followCheckout(`${topic}/`, { root: topic, isWorktree: true }), `${topic}/`);
  assert.equal(followCheckout(topic, { root: "/repo", isWorktree: false, branch: "main" }), "/repo");

  const view = presentRefs(
    {
      currentBranch: "main",
      repoRoot: "/repo",
      branches: [
        { name: "main", current: true },
        { name: "topic", current: false },
      ],
    },
    [
      { id: "main", path: "/repo", source_repo: "/repo", git_ref: "main", status: "alive", metadata: { label: "main" } },
      { id: "wt", path: topic, source_repo: "/repo", git_ref: "topic", status: "alive", metadata: { label: "topic" } },
    ],
    topic,
    { isWorktree: true, branch: "topic", root: topic },
  );
  assert.equal(view.branch, "topic");
  assert.equal(view.root, topic);
  assert.deepEqual(
    view.worktrees.filter((tree) => tree.current).map((tree) => tree.label),
    ["topic"],
  );
});

test("search matches a branch name or a worktree label", () => {
  const view = presentRefs(
    { currentBranch: "main", repoRoot: "/repo", branches: [{ name: "main", current: true }, { name: "feature", current: false }] },
    [{ id: "wt", path: "/work/feature", source_repo: "/repo", git_ref: "feature", status: "alive", metadata: { label: "feature" } }],
    "/repo",
  );
  assert.deepEqual(filterRefs(view, "feat").branches.map((branch: GitBranch) => branch.name), ["feature"]);
  assert.equal(filterRefs(view, "feat").worktrees[0]?.label, "feature");
  assert.equal(filterRefs(view, "").branches.length, 2);
});

test("refs name the default branch from origin/HEAD, otherwise main or master, and keep the current branch first", () => {
  const branches = [
    { name: "topic", current: true, remote: false },
    { name: "develop", current: false, remote: false },
    { name: "origin/develop", current: false, remote: true },
    { name: "main", current: false, remote: false },
  ];
  const named = presentRefs({ currentBranch: "topic", repoRoot: "/repo", remoteHead: "origin/develop", branches }, [], "/repo");
  assert.deepEqual(named.branches.map((branch) => branch.name), ["topic", "develop", "main", "origin/develop"]);
  assert.equal(named.defaultBranch, "develop");
  assert.equal(presentRefs({ currentBranch: "topic", repoRoot: "/repo", branches }, [], "/repo").defaultBranch, "main");
  assert.equal(presentRefs({ currentBranch: "topic", repoRoot: "/repo", branches: branches.slice(0, 1) }, [], "/repo").defaultBranch, "");
  const remoteOnly = [branches[0], { name: "origin/develop", current: false, remote: true }];
  assert.equal(presentRefs({ currentBranch: "topic", repoRoot: "/repo", remoteHead: "origin/develop", branches: remoteOnly }, [], "/repo").defaultBranch, "origin/develop");
});

test("ref names and git errors are cleaned up", () => {
  assert.equal(refName(" main "), "main");
  assert.equal(refName("-force"), "");
  assert.equal(refName("."), "");
  assert.equal(refName(" .. "), "");
  assert.equal(refName("has space"), "");
  assert.equal(gitError({ message: "Internal error: hub error: working tree has uncommitted changes" }), "working tree has uncommitted changes");
});
