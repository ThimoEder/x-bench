import type { GitBranch, GitWorktree } from "../server/git/git.ts";

// The refs view the branch menu searches. Rows are what presentRefs lists.
export interface RefView {
  branch?: unknown;
  branches?: readonly Pick<GitBranch, "name">[];
  worktrees?: readonly Pick<GitWorktree, "label" | "ref" | "path">[];
}

export function filterRefs<V extends RefView>(view: V, query: unknown): V {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return view;
  return {
    ...view,
    branches: (view?.branches ?? []).filter((branch) => branch.name.toLowerCase().includes(needle)),
    worktrees: (view?.worktrees ?? []).filter((tree) =>
      `${tree.label} ${tree.ref} ${tree.path}`.toLowerCase().includes(needle),
    ),
  };
}
