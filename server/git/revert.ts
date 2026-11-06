import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "../../bridge/lenient.ts";
import { gitExec } from "./folderGit.ts";

const UNMERGED = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

// One line of `git status --porcelain=v1 -z`. from is the original path of a rename or copy.
export interface PorcelainEntry {
  code: string;
  path: string;
  from: string;
}

export interface CheckoutActions {
  restore: string[];
  unstage: string[];
  unlink: string[];
  blocked: string[];
}

type CheckoutKind = keyof CheckoutActions;

export interface RevertSkip {
  path: string;
  message: string;
}

export interface RevertResult {
  reverted: string[];
  skipped: RevertSkip[];
  error: string;
}

// files are the changed files git listed, which pass through unchecked.
export interface RevertInput {
  cwd?: string;
  root?: string;
  files?: unknown;
}

// NUL status lists a rename as the current path, then the original path.
export function parsePorcelain(text: string): PorcelainEntry[] {
  const parts = String(text || "").split("\0");
  const entries: PorcelainEntry[] = [];
  let index = 0;
  while (index < parts.length) {
    const raw = parts[index];
    index += 1;
    if (!raw || raw.length < 4 || raw[2] !== " ") continue;
    const code = raw.slice(0, 2);
    const file = raw.slice(3);
    if (code[0] === "R" || code[0] === "C") {
      const from = parts[index] || "";
      index += 1;
      if (file && from) entries.push({ code, path: file, from });
      continue;
    }
    if (file) entries.push({ code, path: file, from: "" });
  }
  return entries;
}

export function isRepoPath(rel: unknown): boolean {
  const file = String(rel || "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!file || file.startsWith("/") || /^[A-Za-z]:\//.test(file)) return false;
  return !file.split("/").some((part) => !part || part === "." || part === "..");
}

export function checkoutActions(entries: readonly PorcelainEntry[] | null | undefined, paths: readonly unknown[] | null | undefined): CheckoutActions {
  const wanted = new Set((paths || []).filter(isRepoPath));
  const restore: string[] = [];
  const unstage: string[] = [];
  const unlink: string[] = [];
  const blocked: string[] = [];
  const seen: Record<CheckoutKind, Set<string>> = { restore: new Set(), unstage: new Set(), unlink: new Set(), blocked: new Set() };
  function push(kind: CheckoutKind, rel: string) {
    if (!isRepoPath(rel) || seen[kind].has(rel)) return;
    seen[kind].add(rel);
    if (kind === "restore") restore.push(rel);
    else if (kind === "unstage") unstage.push(rel);
    else if (kind === "unlink") unlink.push(rel);
    else blocked.push(rel);
  }
  for (const entry of entries || []) {
    if (!wanted.has(entry.path) && !(entry.from && wanted.has(entry.from))) continue;
    if (UNMERGED.has(entry.code)) {
      push("blocked", entry.path);
      continue;
    }
    if (entry.code === "??") {
      push("unlink", entry.path);
      continue;
    }
    if (entry.code[0] === "R" || entry.code[0] === "C") {
      push("restore", entry.from);
      push("unstage", entry.path);
      push("unlink", entry.path);
      continue;
    }
    if (entry.code[0] === "A") {
      push("unstage", entry.path);
      if (entry.code[1] !== "D") push("unlink", entry.path);
      continue;
    }
    push("restore", entry.path);
  }
  return {
    restore,
    unstage,
    unlink: unlink.filter((rel) => !seen.restore.has(rel)),
    blocked,
  };
}

// Puts every listed file back as HEAD has it. Untracked files are removed.
export async function revertAll(input: RevertInput): Promise<RevertResult> {
  const cwd = path.resolve(String(input.cwd || input.root || ""));
  let root = String(input.root || "").trim();
  if (!root) root = String(await gitExec(cwd, ["rev-parse", "--show-toplevel"])).trim();
  root = path.resolve(root);
  const files: unknown[] = Array.isArray(input.files) ? input.files : [];
  const paths = files.filter(isRecord).map((file) => file.path);
  if (!paths.length) return finish([], [], "Nothing to revert");
  const run = (args: string[]) => gitExec(root, args);
  const porcelain = parsePorcelain(await run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  const skipped = paths
    .filter((file) => !isRepoPath(file))
    .map((file) => ({ path: String(file || ""), message: `Can't revert ${file}.` }));
  const conflicts = porcelain.filter((entry) => UNMERGED.has(entry.code)).map((entry) => entry.path);
  if (conflicts.length) {
    return finish([], conflicts.map((file) => ({
      path: file,
      message: `Can't revert ${file}. Resolve the merge first.`,
    })));
  }
  const actions = checkoutActions(porcelain, paths);
  if (!actions.restore.length && !actions.unstage.length && !actions.unlink.length) {
    return finish([], skipped, skipped.length ? "" : "Nothing to revert");
  }
  if (actions.restore.length) await run(["restore", "--source=HEAD", "--staged", "--worktree", "--", ...actions.restore]);
  if (actions.unstage.length) await run(["restore", "--staged", "--", ...actions.unstage]);
  for (const file of actions.unlink) await removeRepoPath(root, file);
  return finish(unique([...actions.restore, ...actions.unstage, ...actions.unlink]), skipped);
}

function finish(reverted: string[], skipped: RevertSkip[], error = ""): RevertResult {
  const message = error || (reverted.length ? "" : skipped.map((item) => item.message).filter(Boolean).join(" "));
  return {
    reverted,
    skipped,
    error: reverted.length ? "" : message || "Nothing to revert",
  };
}

function unique(items: string[]): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    list.push(item);
  }
  return list;
}

function errorCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

function repoFile(root: string, rel: string): string {
  if (!isRepoPath(rel)) return "";
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(`${base}${path.sep}`)) return "";
  return abs;
}

async function anchorInside(root: string, abs: string): Promise<boolean> {
  const base = await fs.realpath(root);
  let current = path.dirname(abs);
  while (true) {
    try {
      const real = await fs.realpath(current);
      return real === base || real.startsWith(`${base}${path.sep}`);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
}

async function removeRepoPath(root: string, rel: string): Promise<void> {
  const abs = repoFile(root, rel);
  if (!abs || !(await anchorInside(root, abs))) throw new Error(`Can't revert ${rel}`);
  const stat = await fs.lstat(abs).catch((error: unknown) => (errorCode(error) === "ENOENT" ? null : Promise.reject(error)));
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    await fs.unlink(abs);
    await removeEmptyParents(root, path.dirname(abs));
    return;
  }
  if (stat.isDirectory()) {
    const real = await fs.realpath(abs);
    const base = await fs.realpath(root);
    if (real !== base && !real.startsWith(`${base}${path.sep}`)) throw new Error(`Can't revert ${rel}`);
    await fs.rm(abs, { recursive: true, force: true });
  } else {
    await fs.unlink(abs);
  }
  await removeEmptyParents(root, path.dirname(abs));
}

async function removeEmptyParents(root: string, start: string): Promise<void> {
  const base = path.resolve(root);
  let current = path.resolve(start);
  while (current !== base && current.startsWith(`${base}${path.sep}`)) {
    const names = await fs.readdir(current).catch(() => null);
    if (!names || names.length) return;
    await fs.rmdir(current);
    current = path.dirname(current);
  }
}
