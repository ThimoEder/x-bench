import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { fields } from "../../bridge/lenient.ts";
import { canonicalCwd } from "../chat/sessions.ts";

const defaultDb = path.join(os.homedir(), ".grok", "worktrees.db");

// One row of Grok's worktrees table. Both values are coerced with String().
const WorktreeLinkRow = fields({
  path: z.unknown().optional(),
  source_repo: z.unknown().optional(),
});

// Where a folder belongs in the sidebar: its project folder, and the worktree
// name when the folder is a worktree of that project.
export interface ProjectPlace {
  home: string;
  worktree: string | null;
}

export type ProjectLocator = (cwd: string | null | undefined) => ProjectPlace;

// A git worktree found through its .git file, and root, the worktree's top folder.
export interface GitWorktreePlace {
  home: string;
  worktree: string;
  root?: string;
}

export type GitWorktreeLookup = (cwd: string) => GitWorktreePlace | null;

// Worktree folder to the checkout that created it, both canonical.
export type WorktreeLinks = Map<string, string>;

// Grok worktrees have their own git directory. source_repo is the checkout
// that created them, and that checkout can itself be a worktree.
export function worktreeLinks(rows: readonly unknown[] | null | undefined): WorktreeLinks {
  const links: WorktreeLinks = new Map();
  for (const item of rows || []) {
    const row = WorktreeLinkRow.parse(item);
    const from = canonicalCwd(String(row.path || ""));
    const to = canonicalCwd(String(row.source_repo || ""));
    if (!from || !to || from === to) continue;
    links.set(from, to);
  }
  return links;
}

export function projectHome(
  cwd: string | null | undefined,
  links: WorktreeLinks = new Map(),
  gitLookup: GitWorktreeLookup | null = null,
): ProjectPlace {
  const start = canonicalCwd(String(cwd || ""));
  if (!start) return { home: "", worktree: null };
  const linked = followLinks(start, links);
  if (linked.worktree) return linked;
  if (gitLookup) {
    const git = gitLookup(start);
    if (git?.home) {
      const home = canonicalCwd(String(git.home));
      if (home && home !== start) return { home, worktree: git.worktree || path.basename(start) };
    }
  }
  return { home: start, worktree: null };
}

export function readGitWorktree(cwd: string | null | undefined): GitWorktreePlace | null {
  let dir = canonicalCwd(String(cwd || ""));
  if (!dir) return null;
  const seen = new Set<string>();
  while (!seen.has(dir)) {
    seen.add(dir);
    const gitdir = readGitDir(dir);
    if (gitdir === false) return null;
    if (gitdir) {
      const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
      const at = gitdir.indexOf(marker);
      if (at < 0) return null;
      const name = gitdir.slice(at + marker.length).split(path.sep)[0];
      return { home: gitdir.slice(0, at), worktree: name || path.basename(dir), root: dir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function readGrokWorktreeLinks(dbPath: string = defaultDb): WorktreeLinks {
  if (!dbPath || !existsSync(dbPath)) return new Map();
  try {
    const text = execFileSync("sqlite3", ["-json", dbPath, "SELECT path, source_repo FROM worktrees"], {
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const rows: unknown = JSON.parse(String(text || "").trim() || "[]");
    return worktreeLinks(Array.isArray(rows) ? rows : []);
  } catch {
    return new Map();
  }
}

export function createProjectLocator(dbPath: string = defaultDb): ProjectLocator {
  let stamp: number | undefined = undefined;
  let links: WorktreeLinks = new Map();
  const cache = new Map<string, ProjectPlace>();
  let checkedAt = 0;
  return (cwd) => {
    const key = canonicalCwd(String(cwd || ""));
    const next = dbStamp(dbPath);
    const unknown = key && isGrokWorktreePath(key) && !coversWorktree(links, key) && Date.now() - checkedAt > 1000;
    if (next !== stamp || unknown) {
      links = readGrokWorktreeLinks(dbPath);
      stamp = dbStamp(dbPath);
      checkedAt = Date.now();
      cache.clear();
    }
    if (!key) return { home: "", worktree: null };
    const cached = cache.get(key);
    if (cached) return cached;
    const found = projectHome(key, links, readGitWorktree);
    // A removed worktree's folder can come back as a worktree at the same path.
    if (existsSync(key)) cache.set(key, found);
    return found;
  };
}

function isGrokWorktreePath(cwd: string): boolean {
  return cwd.includes(`${path.sep}.grok${path.sep}worktrees${path.sep}`);
}

function coversWorktree(links: WorktreeLinks, cwd: string): boolean {
  if (links.has(cwd)) return true;
  for (const from of links.keys()) {
    if (cwd.startsWith(`${from}${path.sep}`)) return true;
  }
  return false;
}

function followLinks(start: string, links: WorktreeLinks): ProjectPlace {
  let cursor = start;
  let worktreePath = "";
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    if (links.has(cursor)) {
      if (!worktreePath) worktreePath = cursor;
      const next = links.get(cursor);
      if (!next || next === cursor) break;
      cursor = next;
      continue;
    }
    if (worktreePath) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (!worktreePath) return { home: start, worktree: null };
  return { home: cursor, worktree: path.basename(worktreePath) };
}

function readGitDir(dir: string): string | false {
  const git = path.join(dir, ".git");
  let info;
  try {
    info = statSync(git);
  } catch {
    return "";
  }
  if (info.isDirectory()) return false;
  if (!info.isFile()) return "";
  try {
    const line = readFileSync(git, "utf8").split(/\r?\n/).find((item) => item.startsWith("gitdir:"));
    const raw = line ? line.slice("gitdir:".length).trim() : "";
    if (!raw) return "";
    return path.isAbsolute(raw) ? raw : path.resolve(dir, raw);
  } catch {
    return "";
  }
}

function dbStamp(dbPath: string): number {
  try {
    return statSync(dbPath).mtimeMs;
  } catch {
    return 0;
  }
}
