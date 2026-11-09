import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { gitExec, parseGitWorktreeList, type ExecFile } from "./folderGit.ts";
import { branchSlug, freeBranch, runIn } from "./branch.ts";
import { presentGit, type GitView } from "./git.ts";
import { localGitDiffs, localGitStatus } from "./localGit.ts";

export interface CreatedWorktree {
  path: string;
  ref: string;
  // The worktree's new branch.
  label: string;
}

export interface WorktreeOptions {
  // Text the worktree is named after, such as the first message.
  name?: string;
  // The new branch. Defaults to grok/<name>, claude/<name> or codex/<name>.
  branch?: string;
  root: string;
}

const branchPrefix: Record<string, string> = { grok: "grok", claude: "claude", chatgpt: "codex" };

export async function createHarnessWorktree(providerId: string, folder: string, gitRef: string, options: WorktreeOptions): Promise<CreatedWorktree> {
  const prefix = branchPrefix[providerId];
  if (!prefix) throw new Error(`${providerId} cannot create a worktree`);
  const branch = options.branch || `${prefix}/${branchSlug(options.name || "") || randomBytes(3).toString("hex")}`;
  return { ...(await addWorktree(folder, gitRef, branch, options.root)), ref: gitRef };
}

export async function gitWorktreeRows(cwd: string): Promise<unknown[]> {
  return parseGitWorktreeList(await gitExec(cwd, ["worktree", "list", "--porcelain"]));
}

export async function gitRoot(repo: string): Promise<string> {
  const toplevel = (await gitExec(repo, ["rev-parse", "--show-toplevel"])).trim();
  if (!toplevel) throw new Error("Folder is not a git repository");
  return toplevel;
}

// Checkout filters and post-checkout hooks run inside `git worktree add`, so it gets longer than other git calls.
const ADD_TIMEOUT = 300000;
const addRun: ExecFile = (file, args, options, callback) => execFile(file, args, { ...options, timeout: ADD_TIMEOUT }, callback);

// Creates in one repository run one at a time, so two sends cannot pick the same free name.
const creating = new Map<string, Promise<unknown>>();

// A new branch at gitRef, named stem or stem-2 … when taken, checked out in its own folder under root. Started from
// a subfolder of the repository, it returns the same subfolder of the new worktree.
export async function addWorktree(
  repo: string,
  gitRef: string,
  stem: string,
  root: string,
): Promise<{ path: string; label: string }> {
  const toplevel = await gitRoot(repo);
  const prefix = (await gitExec(repo, ["rev-parse", "--show-prefix"])).trim();
  const commonDir = path.resolve(repo, (await gitExec(repo, ["rev-parse", "--git-common-dir"])).trim());
  const mainRoot = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : toplevel;
  const previous = creating.get(commonDir) ?? Promise.resolve();
  const created = previous.catch(() => {}).then(() => addFree(toplevel, mainRoot, gitRef, stem, root));
  creating.set(commonDir, created);
  try {
    const { dest, branch } = await created;
    return { path: path.resolve(dest, prefix), label: branch };
  } finally {
    if (creating.get(commonDir) === created) creating.delete(commonDir);
  }
}

async function addFree(toplevel: string, mainRoot: string, gitRef: string, stem: string, root: string): Promise<{ dest: string; branch: string }> {
  const parent = path.join(root, worktreeFolderName(mainRoot));
  const folderFor = (branch: string) => path.join(parent, branch.replaceAll("/", "-"));
  await mkdir(parent, { recursive: true });
  for (let attempt = 1; ; attempt += 1) {
    const branch = await freeBranch(stem, runIn(toplevel), (name) => existsSync(folderFor(name)));
    const dest = folderFor(branch);
    try {
      await gitExec(toplevel, ["worktree", "add", "--no-track", "-b", branch, dest, gitRef], addRun);
      return { dest, branch };
    } catch (error) {
      // Another host can take the same name between the check and the add. Its branch and folder stay.
      const taken = /already exists/.test(error instanceof Error ? error.message : "");
      if (taken && attempt < 3) continue;
      if (!taken) await dropPartial(toplevel, dest, branch);
      throw error;
    }
  }
}

// What a failed or timed-out add left behind: the folder, git's record of it, and the new branch.
async function dropPartial(toplevel: string, dest: string, branch: string) {
  await gitExec(toplevel, ["worktree", "remove", "--force", dest]).catch(() => {});
  await rm(dest, { recursive: true, force: true }).catch(() => {});
  await gitExec(toplevel, ["worktree", "prune"]).catch(() => {});
  await gitExec(toplevel, ["branch", "-D", branch]).catch(() => {});
}

// The folder under the worktree root that holds a checkout's worktrees.
export function worktreeFolderName(mainRoot: string): string {
  return `${path.basename(mainRoot) || "repo"}-${createHash("sha256").update(mainRoot).digest("hex").slice(0, 6)}`;
}

// The worktree this app added that a canonical folder lies in, <root>/<checkout>-<hash>/<name>, or null. root is canonical too.
export function appWorktreeOf(cwd: string, root: string): string | null {
  const inRoot = path.relative(root, cwd);
  if (!inRoot || inRoot.startsWith("..") || path.isAbsolute(inRoot)) return null;
  const [group = "", name = ""] = inRoot.split(path.sep);
  return group && name ? path.join(root, group, name) : null;
}

// Removes a worktree with its ignored files and keeps its branch. Without force, git refuses one with modified or untracked files.
export async function removeWorktree(folder: string, force = false): Promise<void> {
  const commonDir = path.resolve(folder, (await gitExec(folder, ["rev-parse", "--git-common-dir"])).trim());
  try {
    await gitExec(commonDir, ["worktree", "remove", ...(force ? ["--force"] : []), folder]);
  } catch (error) {
    throw new Error((error instanceof Error ? error.message : String(error)).replace(/^fatal:\s*/, "").replace(/, use --force to delete it$/, ""), { cause: error });
  }
  // The checkout's folder under the root goes with its last worktree.
  await rmdir(path.dirname(folder)).catch(() => {});
}

type ChatRows = readonly { id: string; cwd?: string }[];

function usedByAnotherChat(worktree: string, sessionId: string, rows: ChatRows, root: string): boolean {
  return rows.some((row) => row.id !== sessionId && row.cwd && appWorktreeOf(row.cwd, root) === worktree);
}

// The files removing worktree would throw away, or null when nothing would be lost or another chat keeps it.
export async function worktreeChanges(worktree: string, sessionId: string, rows: ChatRows, root: string): Promise<GitView | null> {
  if (usedByAnotherChat(worktree, sessionId, rows, root) || !existsSync(worktree)) return null;
  try {
    const [status, diffs, staged] = await Promise.all([localGitStatus(worktree), localGitDiffs(worktree), gitExec(worktree, ["diff", "--cached", "--name-only", "--no-renames", "-z"])]);
    const changes = presentGit(status, diffs);
    const listed = new Set(changes.files.map((file) => file.path));
    // A staged change the working tree undid differs from HEAD only in the index.
    for (const file of staged.split("\0")) {
      if (file && !listed.has(file)) changes.files.push({ path: file, type: "edit", additions: 0, deletions: 0 });
    }
    changes.files.sort((a, b) => String(a.path).localeCompare(String(b.path)));
    return changes.files.length ? changes : null;
  } catch (error) {
    throw new Error(`The worktree's changes could not be read: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

// Removes worktree unless a chat other than sessionId runs in it. Answers why it stays, or "" once it is gone.
export async function removeChatWorktree(worktree: string, sessionId: string, rows: ChatRows, root: string, force = false): Promise<string> {
  if (usedByAnotherChat(worktree, sessionId, rows, root)) return "The worktree stays: another chat uses it.";
  try {
    await removeWorktree(worktree, force);
    return "";
  } catch (error) {
    return `The worktree stays: ${error instanceof Error ? error.message : String(error)}`;
  }
}
