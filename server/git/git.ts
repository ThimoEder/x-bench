import { z } from "zod";
import { fields, isRecord, listOf, maybe } from "../../bridge/lenient.ts";

// Git results from localGit.ts, in the shapes Grok's _x.ai/git/* had. Values the host forwards as they came stay unknown.
const GitStatusBody = fields({
  branch: z.unknown().optional(),
  commit: z.unknown().optional(),
  root: z.unknown().optional(),
  isWorktree: z.unknown().optional(),
});

const GitDiffFile = fields({
  path: z.unknown().optional(),
  type: z.unknown().optional(),
  patch: z.unknown().optional(),
  additions: z.unknown().optional(),
  deletions: z.unknown().optional(),
});

const GitDiffsBody = fields({ files: maybe(z.array(GitDiffFile)) });

const GitBranchInput = fields({
  name: z.unknown().optional(),
  current: z.unknown().optional(),
  remote: z.unknown().optional(),
});

const GitBranchesBody = fields({
  repoRoot: z.unknown().optional(),
  currentBranch: z.unknown().optional(),
  // origin/HEAD as git names it, such as "origin/main".
  remoteHead: z.unknown().optional(),
  branches: maybe(z.array(GitBranchInput)),
});

const WorktreeRow = z.looseObject({
  id: z.unknown().optional(),
  path: z.unknown().optional(),
  status: z.unknown().optional(),
  source_repo: z.unknown().optional(),
  repo_name: z.unknown().optional(),
  git_ref: z.unknown().optional(),
  metadata: maybe(fields({ label: z.unknown().optional() })),
});

type WorktreeRow = z.output<typeof WorktreeRow>;

export interface GitView {
  branch: unknown;
  commit: string;
  root: string;
  files: GitFile[];
}

// One changed file as localGit.ts listed it. The fields pass through unchecked.
export interface GitFile {
  path: unknown;
  type: unknown;
  additions: unknown;
  deletions: unknown;
}

export interface GitRefs {
  branch: unknown;
  root: unknown;
  branches: GitBranch[];
  worktrees: GitWorktree[];
  worktree: boolean;
  // The local branch origin/HEAD names, otherwise main or master, otherwise the same on origin, or "".
  defaultBranch: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
}

export interface GitWorktree {
  id: string;
  path: string;
  label: string;
  ref: string;
  current: boolean;
}

export interface GitPatch {
  path: unknown;
  patch: string;
  additions: unknown;
  deletions: unknown;
}

export function presentGit(status: unknown, diffs: unknown): GitView {
  const state = GitStatusBody.parse(status);
  const files = (GitDiffsBody.parse(diffs).files ?? []).map((file) => ({
    path: file.path,
    type: file.type || "edit",
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
  }));
  return {
    branch: state.branch || "",
    commit: state.commit ? String(state.commit).slice(0, 7) : "",
    root: String(state.root || "").trim().replace(/[/\\]+$/, ""),
    files,
  };
}

export function followCheckout(cwd: string | null | undefined, status: unknown): string {
  const state = GitStatusBody.parse(status);
  const root = String(state.root || "").trim();
  const current = String(cwd || "");
  if (!root || samePath(root, current)) return current;
  if (state.isWorktree) return root;
  if (isGrokWorktree(current)) return root;
  return current;
}

export function presentRefs(branches: unknown, worktrees: unknown, cwd: string | null | undefined, status?: unknown): GitRefs {
  const list = GitBranchesBody.parse(branches);
  const state = GitStatusBody.parse(status);
  const root = list.repoRoot || state.root || "";
  const names = (list.branches ?? [])
    .map((branch) => ({
      name: String(branch.name || ""),
      current: Boolean(branch.current),
      remote: Boolean(branch.remote),
    }))
    .filter((branch) => branch.name);
  names.sort(byBranch);
  const rows = worktreeRows(worktrees).filter((item) => item.status !== "dead" && item.path);
  const currentRow = rows.find((item) => samePath(item.path, cwd) || samePath(item.path, root));
  const source = currentRow?.source_repo || root;
  const onNamedTree = rows.some((item) => samePath(item.path, cwd));
  const trees = rows
    .filter((item) => !source || samePath(item.source_repo, source) || samePath(item.path, source))
    .map((item) => ({
      id: String(item.id || ""),
      path: String(item.path),
      label: String(item.metadata?.label || item.repo_name || item.git_ref || "worktree"),
      ref: String(item.git_ref || ""),
      current: onNamedTree ? samePath(item.path, cwd) : samePath(item.path, root),
    }));
  trees.sort((a, b) => Number(b.current) - Number(a.current) || a.label.localeCompare(b.label));
  const here = trees.find((item) => item.current);
  return {
    branch: state.branch || list.currentBranch || names.find((branch) => branch.current)?.name || "",
    root: here?.path || root,
    branches: names,
    worktrees: trees,
    worktree: Boolean(state.isWorktree) || Boolean(currentRow),
    defaultBranch: defaultBranch(list.remoteHead, names),
  };
}

// A ref from the page, or "" when git could read it as an option or as the whole folder.
export function refName(value: unknown): string {
  const ref = String(value || "").trim();
  if (!ref || ref.length > 250 || ref.startsWith("-") || ref === "." || ref === "..") return "";
  // eslint-disable-next-line no-control-regex -- reject a ref that contains an ASCII control character
  if (/[\u0000-\u001f\s]/.test(ref)) return "";
  return ref;
}

export function gitError(error: unknown): string {
  return String(messageOf(error) || "Git request failed")
    .replace(/^(?:Internal error:\s*)?(?:hub error:\s*)?/i, "")
    .replace(/^invalid params:\s*/i, "");
}

function messageOf(error: unknown): unknown {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return undefined;
  return "message" in error ? error.message : undefined;
}

// Rows that are not objects never had a path, so they drop out here.
function worktreeRows(payload: unknown): WorktreeRow[] {
  if (Array.isArray(payload)) return listOf(WorktreeRow).parse(payload);
  if (isRecord(payload) && Array.isArray(payload.worktrees)) return listOf(WorktreeRow).parse(payload.worktrees);
  return [];
}

// The local branch origin/HEAD names, otherwise a local main or master, otherwise the same names on origin.
function defaultBranch(remoteHead: unknown, branches: GitBranch[]): string {
  const local = new Set(branches.filter((branch) => !branch.remote).map((branch) => branch.name));
  const remote = new Set(branches.filter((branch) => branch.remote).map((branch) => branch.name));
  const head = String(remoteHead || "").trim();
  const names = [head.replace(/^[^/]+\//, ""), "main", "master"].filter(Boolean);
  return names.find((name) => local.has(name)) || [head, "origin/main", "origin/master"].find((name) => name && remote.has(name)) || "";
}

function byBranch(a: GitBranch, b: GitBranch): number {
  return Number(b.current) - Number(a.current) || Number(a.remote) - Number(b.remote) || a.name.localeCompare(b.name);
}

function samePath(left: unknown, right: unknown): boolean {
  if (!left || !right) return false;
  return String(left).replace(/[/\\]+$/, "") === String(right).replace(/[/\\]+$/, "");
}

function isGrokWorktree(folder: unknown): boolean {
  return /[/\\]\.grok[/\\]worktrees[/\\]/i.test(String(folder || ""));
}

export function presentPatches(diffs: unknown): GitPatch[] {
  return (GitDiffsBody.parse(diffs).files ?? [])
    .filter((file) => file.path)
    .map((file) => ({
      path: file.path,
      patch: String(file.patch || "").slice(0, 20000),
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
    }));
}

export function presentPatch(diffs: unknown, filePath: string, limit = 20000): GitPatch | null {
  const files = GitDiffsBody.parse(diffs).files ?? [];
  const file = files.find((item) => item.path === filePath) || null;
  if (!file) return null;
  return {
    path: file.path,
    patch: String(file.patch || "").slice(0, limit),
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
  };
}
