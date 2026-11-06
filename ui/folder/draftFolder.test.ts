import assert from "node:assert/strict";
import test from "node:test";
import { draftFolder, folderName } from "./draftFolder.ts";

test("the project of the latest session wins", () => {
  const projects = [
    { cwd: "/code/older", sessions: [{ rankedAt: "2026-09-01T10:00:00.000Z" }] },
    { cwd: "/code/newer", sessions: [{ rankedAt: "2026-09-20T10:00:00.000Z" }, { rankedAt: "2026-08-01T10:00:00.000Z" }] },
    { cwd: "/code/middle", sessions: [{ rankedAt: "2026-09-10T10:00:00.000Z" }] },
  ];
  assert.equal(draftFolder(projects), "/code/newer");
});

test("archived sessions are skipped", () => {
  const archived = { cwd: "/code/archived", sessions: [{ rankedAt: "2026-09-20T10:00:00.000Z", archived: true as const }] };
  const kept = { cwd: "/code/kept", sessions: [{ rankedAt: "2026-09-01T10:00:00.000Z" }] };
  assert.equal(draftFolder([kept, archived]), "/code/kept");
  assert.equal(draftFolder([archived]), "");
});

test("a worktree session gives its project folder", () => {
  const projects = [
    {
      cwd: "/code/x_bench",
      sessions: [
        {
          cwd: "/code/x_bench/.claude/worktrees/calm-fox",
          source: "/code/x_bench",
          worktree: "/code/x_bench/.claude/worktrees/calm-fox",
          rankedAt: "2026-09-20T10:00:00.000Z",
        },
      ],
    },
    { cwd: "/code/other", sessions: [{ cwd: "/code/other", rankedAt: "2026-09-01T10:00:00.000Z" }] },
  ];
  assert.equal(draftFolder(projects), "/code/x_bench");
});

test("no sessions gives no folder", () => {
  assert.equal(draftFolder([]), "");
  assert.equal(draftFolder(null), "");
  assert.equal(draftFolder([{ cwd: "/code/empty", sessions: [] }]), "");
});

test("a session only loaded or retitled does not beat the one last prompted", () => {
  // Loading tvio's session moved Grok's updated_at, but x_bench had the later prompt.
  const projects = [
    { cwd: "/code/tvio", sessions: [{ updatedAt: "2026-09-28T18:20:08.935885Z", rankedAt: "2026-09-20T10:00:00.000Z" }] },
    { cwd: "/code/x_bench", sessions: [{ updatedAt: "2026-09-27T09:00:00.000Z", rankedAt: "2026-09-28T17:00:00.000Z" }] },
  ];
  assert.equal(draftFolder(projects), "/code/x_bench");
});

test("a new session with no updated_at yet wins by its prompt", () => {
  // Rows only in the bridge catalog carry updatedAt "" until Grok writes the summary.
  const projects = [
    { cwd: "/code/older", sessions: [{ updatedAt: "2026-09-27T09:00:00.000Z", rankedAt: "2026-09-27T09:00:00.000Z" }] },
    { cwd: "/code/fresh", sessions: [{ updatedAt: "", rankedAt: "2026-09-28T20:00:00.000Z" }] },
  ];
  assert.equal(draftFolder(projects), "/code/fresh");
  assert.equal(draftFolder([{ cwd: "/code/unranked", sessions: [{ rankedAt: "" }] }]), "");
});

test("the folder name is the last part of the path", () => {
  assert.equal(folderName("/Users/me/code/x_bench"), "x_bench");
  assert.equal(folderName("/Users/me/code/x_bench/"), "x_bench");
  assert.equal(folderName("C:\\code\\x_bench"), "x_bench");
  assert.equal(folderName("/"), "/");
});
