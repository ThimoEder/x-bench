import assert from "node:assert/strict";
import test from "node:test";
import type { GitRefs } from "./git.ts";
import { isRecord } from "../../bridge/lenient.ts";
import {
  checkoutFolder,
  folderRefView,
  parseGitRefs,
  parseWorktrees,
  readFolderRefs,
  type FolderRefs,
  type FolderRefsFailure,
} from "./folderGit.ts";

function refsOf(view: FolderRefs): GitRefs {
  assert.ok(!("error" in view), "expected refs");
  return view;
}

function failureOf(view: FolderRefs): FolderRefsFailure {
  assert.ok("error" in view, "expected a failure");
  return view;
}

test("git refs keep local and remote branches and skip origin/HEAD", () => {
  assert.deepEqual(parseGitRefs("*\trefs/heads/main\n \trefs/heads/topic\n \trefs/remotes/origin/main\n \trefs/remotes/origin/HEAD\n"), [
    { name: "main", current: true, remote: false },
    { name: "topic", current: false, remote: false },
    { name: "origin/main", current: false, remote: true },
  ]);
});

test("a linked git dir is marked as a worktree", () => {
  const view = folderRefView({
    cwd: "/repo/.grok/worktrees/topic",
    root: "/repo",
    head: "topic",
    refText: "*\trefs/heads/topic\n",
    worktrees: [
      {
        id: "wt",
        path: "/repo/.grok/worktrees/topic",
        source_repo: "/repo",
        git_ref: "topic",
        status: "alive",
        metadata: { label: "topic" },
      },
    ],
    gitDir: "/repo/.git/worktrees/topic",
    commonDir: "/repo/.git",
  });
  assert.equal(view.branch, "topic");
  assert.equal(view.worktree, true);
  assert.equal(view.worktrees[0]?.current, true);
});

test("folder refs use the injected git reader", async () => {
  const calls: string[] = [];
  const view = refsOf(await readFolderRefs("/repo", {
    git: async (args) => {
      calls.push(args.join(" "));
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/repo\n";
      if (args[1] === "--abbrev-ref") return "main\n";
      if (args[0] === "for-each-ref") return "*\trefs/heads/main\n";
      if (args[1] === "--git-dir") return ".git\n";
      if (args[1] === "--git-common-dir") return ".git\n";
      if (args[0] === "worktree") return "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo-fix\nHEAD def\nbranch refs/heads/fix\n";
      return "";
    },
    worktrees: async () => [],
  }));
  assert.equal(view.branch, "main");
  assert.equal(view.worktree, false);
  assert.equal(view.worktrees[0]?.label, "repo-fix");
  assert.deepEqual(calls.map((line) => line.split(" ")[1]), ["--show-toplevel", "--abbrev-ref", "--format=%(HEAD)%09%(refname)", "--git-dir", "--git-common-dir", "list", "--quiet"]);
});

test("a missing repository becomes an empty ref list", async () => {
  const view = failureOf(await readFolderRefs("/missing", {
    git: async () => {
      throw new Error("not a git repository");
    },
    worktrees: async () => [],
  }));
  assert.equal(view.branch, "");
  assert.deepEqual(view.branches, []);
  assert.match(view.error, /not a git repository/);
});

test("checkout reads the branch only as a ref, never as a path", async () => {
  const commands: string[][] = [];
  await checkoutFolder("/repo", "topic", {
    git: async (args) => {
      commands.push(args);
    },
  });
  assert.deepEqual(commands, [["checkout", "topic", "--"]]);
});

test("a remote branch falls back to a tracking checkout", async () => {
  const commands: string[][] = [];
  await checkoutFolder("/repo", "origin/topic", {
    git: async (args) => {
      commands.push(args);
      if (args.length === 3) throw new Error("invalid reference");
    },
  });
  assert.deepEqual(commands, [
    ["checkout", "origin/topic", "--"],
    ["checkout", "--track", "origin/topic", "--"],
  ]);
});

test("worktree json ignores a bad payload", () => {
  assert.deepEqual(parseWorktrees("nope"), []);
  const first = parseWorktrees("[{\"path\":\"/wt\"}]")[0];
  assert.ok(isRecord(first));
  assert.equal(first.path, "/wt");
});
