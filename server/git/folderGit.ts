import { execFile } from "node:child_process";
import path from "node:path";
import { isRecord } from "../../bridge/lenient.ts";
import { gitError, presentRefs, type GitBranch, type GitRefs } from "./git.ts";
import type { Providers } from "../providers/providers.ts";

// The part of child_process.execFile these helpers call.
export type ExecFile = (
  file: string,
  args: string[],
  options: { timeout: number; cwd?: string; maxBuffer?: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => unknown;

export type GitRun<T = string> = (args: string[]) => Promise<T>;

export interface FolderGitDeps {
  git?: GitRun;
  execFile?: ExecFile;
  worktrees?: (root: string) => Promise<unknown>;
}

export interface CheckoutDeps {
  git?: GitRun<unknown>;
  execFile?: ExecFile;
}

// What git reported for one folder. worktrees is Grok's list merged with git's own.
export interface FolderRefInput {
  cwd: string;
  root: string;
  head: string;
  refText: string;
  worktrees: unknown;
  gitDir: string;
  commonDir: string;
  remoteHead?: string;
}

// Sent when git fails. It has no worktree flag.
export interface FolderRefsFailure extends Omit<GitRefs, "worktree"> {
  error: string;
}

export type FolderRefs = GitRefs | FolderRefsFailure;

export function parseGitRefs(text: string): GitBranch[] {
  const branches: GitBranch[] = [];
  for (const line of String(text || "").split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const head = line.slice(0, tab);
    const ref = line.slice(tab + 1).trim();
    if (ref.startsWith("refs/heads/")) {
      const name = ref.slice("refs/heads/".length);
      if (!name) continue;
      branches.push({ name, current: head === "*", remote: false });
    } else if (ref.startsWith("refs/remotes/")) {
      const name = ref.slice("refs/remotes/".length);
      if (!name || name.endsWith("/HEAD")) continue;
      branches.push({ name, current: false, remote: true });
    }
  }
  return branches;
}

export function parseWorktrees(stdout: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(String(stdout || ""));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function folderRefView({ cwd, root, head, refText, worktrees, gitDir, commonDir, remoteHead }: FolderRefInput): GitRefs {
  const linked = Boolean(gitDir && commonDir && path.resolve(gitDir) !== path.resolve(commonDir));
  const branch = !head || head === "HEAD" ? "" : head;
  return presentRefs(
    { currentBranch: branch, repoRoot: root || cwd, remoteHead, branches: parseGitRefs(refText) },
    worktrees || [],
    cwd,
    { isWorktree: linked },
  );
}

function resolveGitPath(cwd: string, dir: string): string {
  if (!dir) return "";
  return path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
}

export function gitExec(cwd: string, args: string[], run: ExecFile = execFile): Promise<string> {
  return new Promise((resolve, reject) => {
    run("git", ["-C", cwd, ...args], { timeout: 20000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message || "Git failed").trim()));
        return;
      }
      resolve(String(stdout));
    });
  });
}

export async function readFolderRefs(cwd: string, deps: FolderGitDeps = {}): Promise<FolderRefs> {
  const run: GitRun = deps.git || ((args) => gitExec(cwd, args, deps.execFile));
  try {
    const [root, head, refText, gitDir, commonDir, treeText, remoteHead] = await Promise.all([
      run(["rev-parse", "--show-toplevel"]),
      run(["rev-parse", "--abbrev-ref", "HEAD"]),
      run(["for-each-ref", "--format=%(HEAD)%09%(refname)", "refs/heads", "refs/remotes"]),
      run(["rev-parse", "--git-dir"]),
      run(["rev-parse", "--git-common-dir"]),
      run(["worktree", "list", "--porcelain"]).catch(() => ""),
      run(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch(() => ""),
    ]);
    const list = deps.worktrees || ((folder: string) => listGrokWorktrees(folder, deps));
    const worktrees = mergeWorktreeLists(await list(root.trim()), parseGitWorktreeList(treeText));
    return folderRefView({
      cwd,
      root: root.trim(),
      head: head.trim(),
      refText,
      worktrees,
      gitDir: resolveGitPath(cwd, gitDir.trim()),
      commonDir: resolveGitPath(cwd, commonDir.trim()),
      remoteHead: remoteHead.trim(),
    });
  } catch (error) {
    return { branch: "", root: "", branches: [], worktrees: [], defaultBranch: "", error: gitError(error) };
  }
}

// The trailing -- makes git read the branch as a ref only, never as a path to check out.
export async function checkoutFolder(cwd: string, branch: string, deps: CheckoutDeps = {}): Promise<void> {
  const run: GitRun<unknown> = deps.git || ((args) => gitExec(cwd, args, deps.execFile));
  try {
    await run(["checkout", branch, "--"]);
  } catch (error) {
    if (!String(branch).includes("/")) throw error;
    await run(["checkout", "--track", branch, "--"]);
  }
}

// The folders of sessions in a turn, waiting on the person included.
export function turnFolders(providers: Pick<Providers, "activityMarks" | "getSession">): string[] {
  const { working, attention } = providers.activityMarks();
  return [...working, ...attention].map((id) => providers.getSession(id)?.cwd || "").filter(Boolean);
}

export async function sharesCheckout(cwd: string, folders: readonly string[]): Promise<boolean> {
  if (!folders.length) return false;
  const top = (folder: string) => gitExec(folder, ["rev-parse", "--show-toplevel"]).then((text) => text.trim(), () => "");
  const mine = await top(cwd);
  return Boolean(mine) && (await Promise.all(folders.map(top))).includes(mine);
}

// True when git would read ref as a path: it names no commit, yet matches files in the folder or its repository.
// /api/git/checkout checks out only refs where this is false.
export async function refIsOnlyPath(cwd: string, ref: string, deps: CheckoutDeps = {}): Promise<boolean> {
  const run: GitRun<unknown> = deps.git || ((args) => gitExec(cwd, args, deps.execFile));
  try {
    await run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return false;
  } catch {
    // Not a commit here. It may still be a remote branch that checkout creates, or a path.
  }
  try {
    return Boolean(String(await run(["ls-files", "--", ref, `:(top)${ref}`])).trim());
  } catch {
    return false;
  }
}

export function listGrokWorktrees(_root: string, deps: { execFile?: ExecFile } = {}): Promise<unknown[]> {
  const run: ExecFile = deps.execFile || execFile;
  return new Promise((resolve) => {
    run("grok", ["worktree", "list", "--json"], { timeout: 8000 }, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      resolve(parseWorktrees(stdout));
    });
  });
}

// Linked worktrees from `git worktree list --porcelain`, in the shape of Grok's worktree list.
// The first record is always the main worktree: it is left out and is every row's source_repo.
export function parseGitWorktreeList(text: string): unknown[] {
  const [main, ...linked] = String(text || "").trim().split(/\n\n+/).map(parseRecord);
  if (!main?.folder) return [];
  return linked
    .filter((record) => record.folder)
    .map(({ folder, ref }) => ({
      id: folder,
      path: folder,
      status: "alive",
      source_repo: main.folder,
      git_ref: ref,
      metadata: { label: path.basename(folder) },
    }));
}

// A prunable record is a worktree whose folder is gone.
function parseRecord(record: string): { folder: string; ref: string } {
  let folder = "";
  let ref = "";
  for (const line of record.split("\n")) {
    if (line.startsWith("worktree ")) folder = line.slice("worktree ".length).trim();
    else if (line.startsWith("branch ")) ref = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    else if (line === "prunable" || line.startsWith("prunable ")) return { folder: "", ref: "" };
  }
  return { folder, ref };
}

// A row from primary wins when both lists name the same path.
export function mergeWorktreeLists(primary: unknown, extra: readonly unknown[]): unknown[] {
  const rows = Array.isArray(primary) ? [...primary] : [];
  const seen = new Set(rows.map(worktreePath));
  for (const row of extra) {
    const folder = worktreePath(row);
    if (!folder || seen.has(folder)) continue;
    seen.add(folder);
    rows.push(row);
  }
  return rows;
}

function worktreePath(row: unknown): string {
  if (!isRecord(row) || typeof row.path !== "string") return "";
  return row.path.replace(/[/\\]+$/, "");
}
