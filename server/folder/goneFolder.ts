// A chat whose folder is gone, usually a removed worktree: the checkout it came from, so the chat
// still opens and can continue in a new worktree or in that checkout.

import path from "node:path";
import { gitExec } from "../git/folderGit.ts";
import { canonicalCwd, isDirectory } from "../chat/sessions.ts";
import { worktreeFolderName } from "../git/worktree.ts";

export interface GoneFolder {
  // The folder the chat ran in.
  path: string;
  // The checkout the worktree was added from, at the same subfolder when that exists. Null for a plain folder.
  home: string | null;
  // The branch home has checked out, or null when HEAD is detached.
  branch: string | null;
}

export interface GoneWorktree {
  // The project folder the sidebar files the worktree under.
  project: string;
  // The same subfolder in that checkout, else the project folder.
  folder: string;
  // The worktree's name.
  worktree: string;
}

// Where a removed worktree came from, read from its path: Claude Code adds worktrees under the
// checkout's .claude/worktrees, this app under <root>/<checkout name>-<hash of its path>.
export function goneWorktree(
  cwd: string,
  projects: readonly string[],
  root: string,
  exists: (folder: string) => boolean = isDirectory,
): GoneWorktree | null {
  const start = canonicalCwd(cwd);
  if (!start) return null;
  const marker = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
  const at = start.indexOf(marker);
  if (at > 0) {
    const [name = "", ...rest] = start.slice(at + marker.length).split(path.sep);
    return name ? placed(start.slice(0, at), name, rest, exists) : null;
  }
  const inRoot = path.relative(canonicalCwd(root), start);
  if (!inRoot || inRoot.startsWith("..") || path.isAbsolute(inRoot)) return null;
  const [group = "", name = "", ...rest] = inRoot.split(path.sep);
  const project = projects.map(canonicalCwd).find((folder) => folder && worktreeFolderName(folder) === group);
  return project && name ? placed(project, name, rest, exists) : null;
}

function placed(project: string, worktree: string, rest: readonly string[], exists: (folder: string) => boolean): GoneWorktree | null {
  if (!exists(project)) return null;
  const sub = path.join(project, ...rest);
  return { project, folder: rest.length && exists(sub) ? sub : project, worktree };
}

export async function goneFolder(cwd: string, home: string | null): Promise<GoneFolder> {
  return { path: canonicalCwd(cwd), home, branch: home ? await checkedOut(home) : null };
}

async function checkedOut(folder: string): Promise<string | null> {
  try {
    const branch = (await gitExec(folder, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}
