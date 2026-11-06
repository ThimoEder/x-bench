// Git for a session's folder, run by this app instead of the agent, so reviewing a
// session starts no harness. The results have the shapes Grok's _x.ai/git/* returned,
// which the presenters in git.ts read: status (branch, commit, root, mainRoot,
// isWorktree), diffs against HEAD or where the branch left main, with the type edit,
// create, delete or untracked, and a patch for each path asked for.

import { execFile as nodeExecFile } from "node:child_process";
import path from "node:path";
import { gitExec, parseGitRefs, type ExecFile } from "./folderGit.ts";

// Git's empty tree, the base for a repository with no commit yet.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_UNTRACKED_BYTES = 2_000_000;

export interface LocalGitStatus {
  root: string;
  mainRoot: string;
  isWorktree: boolean;
  branch: string;
  commit: string;
}

export interface LocalDiffFile {
  path: string;
  type: "edit" | "create" | "delete" | "untracked";
  additions: number;
  deletions: number;
  patch?: string;
}

export interface LocalGitDeps {
  execFile?: ExecFile;
  // Reads an untracked file to count its lines.
  readFile?: (file: string) => Promise<Buffer>;
}

type Run = (args: string[]) => Promise<string>;

// What the review compares the working tree with: the last commit, or where the branch left main.
export type DiffBase = "head" | "main";

export function diffBaseOf(value: unknown): DiffBase {
  return value === "main" ? "main" : "head";
}

function runner(cwd: string, deps: LocalGitDeps): Run {
  return (args) => gitExec(cwd, args, deps.execFile);
}

export async function localGitStatus(cwd: string, deps: LocalGitDeps = {}): Promise<LocalGitStatus> {
  const run = runner(cwd, deps);
  const [rootText, gitDirText, commonDirText] = await Promise.all([
    run(["rev-parse", "--show-toplevel"]),
    run(["rev-parse", "--absolute-git-dir"]),
    run(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  ]);
  const root = rootText.trim();
  const gitDir = gitDirText.trim();
  const commonDir = commonDirText.trim();
  const [branch, commit] = await Promise.all([
    run(["symbolic-ref", "--quiet", "--short", "HEAD"]).then((text) => text.trim(), () => ""),
    run(["rev-parse", "--verify", "--quiet", "HEAD"]).then((text) => text.trim(), () => ""),
  ]);
  const linked = Boolean(gitDir && commonDir && path.resolve(gitDir) !== path.resolve(commonDir));
  const mainRoot = linked && path.basename(commonDir) === ".git" ? path.dirname(commonDir) : root;
  return { root, mainRoot, isWorktree: linked, branch, commit };
}

// Every change against the base, committed since it or not, and untracked files. With paths, only those, each with its patch.
export async function localGitDiffs(cwd: string, paths: string[] | null = null, deps: LocalGitDeps = {}, against: DiffBase = "head", whole = false): Promise<{ files: LocalDiffFile[] }> {
  const run = runner(cwd, deps);
  const root = (await run(["rev-parse", "--show-toplevel"])).trim();
  const inRoot = runner(root, deps);
  const base = against === "main" ? await mainBase(inRoot) : await inRoot(["rev-parse", "--verify", "--quiet", "HEAD"]).then(() => "HEAD", () => EMPTY_TREE);
  const [numstat, names, untrackedText] = await Promise.all([
    inRoot(["diff", base, "--numstat", "-z", "--no-renames", "--no-ext-diff"]),
    inRoot(["diff", base, "--name-status", "-z", "--no-renames", "--no-ext-diff"]),
    inRoot(["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const types = parseNameStatus(names);
  const files: LocalDiffFile[] = parseNumstat(numstat).map((row) => ({
    path: row.path,
    type: types.get(row.path) ?? "edit",
    additions: row.additions,
    deletions: row.deletions,
  }));
  for (const file of untrackedText.split("\0").filter(Boolean)) {
    files.push({ path: file, type: "untracked", additions: await lineCount(path.join(root, file), deps), deletions: 0 });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  if (!paths) return { files };
  const wanted = paths.map((item) => relativeTo(root, cwd, item));
  const found = wanted.map((want) => files.find((item) => item.path === want)).filter((file) => file !== undefined);
  const context = whole ? ["--unified=1000000"] : [];
  const tracked = new Set(found.filter((file) => file.type !== "untracked").map((file) => file.path));
  // Naming many files could pass the system's argument length limit, so several files are read from the whole diff.
  const pathspec = tracked.size === 1 ? ["--", ...tracked] : [];
  const patches = tracked.size ? patchesByPath(await inRoot([...patchDiff(base), ...context, ...pathspec])) : new Map<string, string>();
  const picked: LocalDiffFile[] = [];
  for (const file of found) {
    const patch = file.type === "untracked"
      ? await untrackedPatch(root, file.path, deps.execFile)
      : patches.get(file.path) ?? await inRoot([...patchDiff(base), ...context, "--", file.path]);
    picked.push({ ...file, patch: untrackedPatchPath(patch, file.path) });
  }
  return { files: picked };
}

// Pinned so the user's git settings can't change the headers patchesByPath splits by, or print lines outside them.
function patchDiff(base: string): string[] {
  return ["-c", "core.quotePath=false", "diff", base, "--no-renames", "--no-ext-diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--submodule=short"];
}

// Each file's part of one git diff, by the path its header names. A path git still quotes is left out.
function patchesByPath(text: string): Map<string, string> {
  const patches = new Map<string, string>();
  // After a newline only: a bare carriage return inside a changed line starts no part.
  for (const part of text.split(/(?<=\n)(?=diff --git )/)) {
    const header = part.slice(0, part.indexOf("\n"));
    const named = header.slice("diff --git a/".length);
    const file = named.slice(0, (named.length - " b/".length) / 2);
    // A file that became a symlink, or stopped being one, has two parts.
    if (header === `diff --git a/${file} b/${file}`) patches.set(file, (patches.get(file) ?? "") + part);
  }
  return patches;
}

// The commit where HEAD left the default branch: origin's HEAD, otherwise main or master, on origin first.
export async function mainBase(run: Run): Promise<string> {
  const remoteHead = await run(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).then((text) => text.trim(), () => "");
  for (const ref of [remoteHead, "origin/main", "origin/master", "main", "master"]) {
    if (!ref) continue;
    const base = await run(["merge-base", "HEAD", ref]).then((text) => text.trim(), () => "");
    if (base) return base;
  }
  throw new Error("No main branch to compare with");
}

export async function localGitBranches(cwd: string, deps: LocalGitDeps = {}) {
  const run = runner(cwd, deps);
  const [root, branch, refText, remoteHead] = await Promise.all([
    run(["rev-parse", "--show-toplevel"]),
    run(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => ""),
    run(["for-each-ref", "--format=%(HEAD)%09%(refname)", "refs/heads", "refs/remotes"]),
    run(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch(() => ""),
  ]);
  return { repoRoot: root.trim(), currentBranch: branch.trim(), remoteHead: remoteHead.trim(), branches: parseGitRefs(refText) };
}

function parseNumstat(text: string): { path: string; additions: number; deletions: number }[] {
  const rows: { path: string; additions: number; deletions: number }[] = [];
  for (const record of text.split("\0")) {
    if (!record) continue;
    const [added, deleted, ...rest] = record.split("\t");
    const file = rest.join("\t");
    if (!file) continue;
    // Binary files show "-" for both counts.
    rows.push({ path: file, additions: Number(added) || 0, deletions: Number(deleted) || 0 });
  }
  return rows;
}

function parseNameStatus(text: string): Map<string, LocalDiffFile["type"]> {
  const types = new Map<string, LocalDiffFile["type"]>();
  const parts = text.split("\0");
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const code = parts[index] ?? "";
    const file = parts[index + 1] ?? "";
    if (!file) continue;
    types.set(file, code.startsWith("A") ? "create" : code.startsWith("D") ? "delete" : "edit");
  }
  return types;
}

async function lineCount(file: string, deps: LocalGitDeps): Promise<number> {
  try {
    const fs = await import("node:fs/promises");
    // Big files are not read at all: their lines are not counted.
    if (!deps.readFile && (await fs.stat(file)).size > MAX_UNTRACKED_BYTES) return 0;
    const read = deps.readFile ?? ((name: string) => fs.readFile(name));
    const bytes = await read(file);
    if (bytes.length > MAX_UNTRACKED_BYTES || bytes.includes(0)) return 0;
    const text = bytes.toString("utf8");
    if (!text) return 0;
    return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  } catch {
    return 0;
  }
}

// git diff --no-index exits 1 when the files differ, which is always here. The patch is on stdout.
function untrackedPatch(root: string, file: string, run: ExecFile = nodeExecFile): Promise<string> {
  return new Promise((resolve) => {
    run("git", ["-C", root, "diff", "--no-index", "--no-ext-diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--", "/dev/null", file], { timeout: 20000 }, (_error, stdout) => {
      resolve(String(stdout || ""));
    });
  });
}

// --no-index names the untracked side b/<path> but the empty side a//dev/null. Grok named both by the path.
function untrackedPatchPath(patch: string, file: string): string {
  return patch.replace(/^diff --git a\/dev\/null b\//, `diff --git a/${file} b/`).replace(`diff --git a//dev/null b/${file}`, `diff --git a/${file} b/${file}`);
}

// The page names files as the diff listed them, relative to the repository root.
function relativeTo(root: string, cwd: string, file: string): string {
  if (!path.isAbsolute(file)) return file;
  const relative = path.relative(root, file);
  return relative.startsWith("..") ? path.relative(cwd, file) : relative;
}
