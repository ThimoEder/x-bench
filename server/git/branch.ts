import { gitExec, type GitRun } from "./folderGit.ts";

export function runIn(folder: string): GitRun {
  return (args) => gitExec(folder, args);
}

async function succeeds(run: GitRun, args: string[]): Promise<boolean> {
  try {
    await run(args);
    return true;
  } catch {
    return false;
  }
}

// The main branch as it is on the remote now: origin's default branch, fetched first. Without a remote, the
// local main or master. A fetch that fails (offline) keeps the remote branch as it was last fetched.
export async function latestMain(folder: string, run: GitRun = runIn(folder)): Promise<string> {
  let remote = "";
  try {
    remote = (await run(["rev-parse", "--abbrev-ref", "origin/HEAD"])).trim();
  } catch {
    // origin/HEAD is not set on every clone.
  }
  if (!remote.startsWith("origin/")) {
    remote = "";
    for (const name of ["origin/main", "origin/master"]) {
      if (await succeeds(run, ["rev-parse", "--verify", "--quiet", `refs/remotes/${name}`])) {
        remote = name;
        break;
      }
    }
  }
  if (remote) {
    await succeeds(run, ["fetch", "--quiet", "origin", remote.slice("origin/".length)]);
    return remote;
  }
  for (const name of ["main", "master"]) {
    if (await succeeds(run, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])) return name;
  }
  throw new Error("This folder has no main branch to start from");
}

// The branch the folder has checked out, or "" when it is detached or not a repository.
export async function currentBranch(folder: string, run: GitRun = runIn(folder)): Promise<string> {
  try {
    return (await run(["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
  } catch {
    return "";
  }
}

// Text as a branch or folder name: lowercase words joined by dashes, at most max characters, or "".
export function branchSlug(text: string, max = 48): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

// stem, or stem-2, stem-3 … when a branch of that name exists or taken says the name is in use.
// Git cannot hold claude/x next to a branch named claude, so then the name is claude-x.
export async function freeBranch(stem: string, run: GitRun, taken: (branch: string) => boolean = () => false): Promise<string> {
  const isBranch = (name: string) => succeeds(run, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
  const parts = stem.split("/");
  let base = stem;
  for (let end = 1; end < parts.length; end += 1) {
    if (await isBranch(parts.slice(0, end).join("/"))) {
      base = parts.join("-");
      break;
    }
  }
  const inUse = async (name: string) =>
    taken(name) || (await isBranch(name)) || Boolean((await run(["for-each-ref", "--count=1", "--format=x", `refs/heads/${name}/`]).catch(() => "")).trim());
  let branch = base;
  for (let suffix = 2; await inUse(branch); suffix += 1) {
    branch = `${base}-${suffix}`;
  }
  return branch;
}

// Checks out a new branch named stem from the latest main, in the folder itself. Git keeps uncommitted changes
// that do not clash with main, and refuses the switch when they do.
export async function branchFromMain(folder: string, stem: string, run: GitRun = runIn(folder)): Promise<{ branch: string; base: string }> {
  const base = await latestMain(folder, run);
  return { branch: await taskBranch(stem, base, run), base };
}

// Checks out stem at base, with -2, -3 … when the name is taken.
export async function taskBranch(stem: string, base: string, run: GitRun): Promise<string> {
  const branch = await freeBranch(stem, run);
  await run(["checkout", "--no-track", "-b", branch, base]);
  return branch;
}
