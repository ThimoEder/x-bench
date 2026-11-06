// Files and @ file search for a session's folder, run by this app instead of the agent.
// Opening the file tree or typing @ starts no harness.

import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { FuzzyMatch } from "../../bridge/protocol.ts";
import { gitExec } from "../git/folderGit.ts";

const MAX_FILE_BYTES = 2_000_000;
const SEARCH_LIMIT = 12;
const SEARCH_FILES = 40_000;
const SEARCH_CACHE_MS = 10_000;

export interface ListedNode {
  name: string;
  path: string;
  type: "directory" | "file";
}

// One folder level, without what git ignores. The .git folder stays, as it did in Grok's list.
export async function listFolder(directory: string): Promise<ListedNode[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nodes = entries.map((entry): ListedNode => ({
    name: entry.name,
    path: path.join(directory, entry.name),
    type: entry.isDirectory() || (entry.isSymbolicLink() && isDirectorySync(path.join(directory, entry.name))) ? "directory" : "file",
  }));
  const ignored = await ignoredNames(directory, nodes.filter((node) => node.name !== ".git").map((node) => node.name));
  return nodes.filter((node) => !ignored.has(node.name));
}

function isDirectorySync(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

// Names in directory that git ignores. Outside a repository nothing is.
function ignoredNames(directory: string, names: string[]): Promise<Set<string>> {
  if (!names.length) return Promise.resolve(new Set());
  return new Promise((resolve) => {
    const child = execFile("git", ["-C", directory, "check-ignore", "-z", "--stdin"], { timeout: 10000 }, (_error, stdout) => {
      // check-ignore exits 1 when nothing is ignored and 128 outside a repository.
      resolve(new Set(String(stdout || "").split("\0").filter(Boolean)));
    });
    // Outside a repository git exits without reading, and a long name list then fails with EPIPE.
    child.stdin?.on("error", () => {});
    child.stdin?.end(names.join("\0") + "\0");
  });
}

export async function readFolderFile(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, MAX_FILE_BYTES));
    await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

// ---- @ file search ----

const fileLists = new Map<string, { at: number; files: string[] }>();

// Files under the folder: what git tracks plus untracked files it does not ignore, else a short walk.
async function folderFiles(folder: string): Promise<string[]> {
  const cached = fileLists.get(folder);
  if (cached && Date.now() - cached.at < SEARCH_CACHE_MS) return cached.files;
  let files: string[];
  try {
    const text = await gitExec(folder, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
    files = text.split("\0").filter(Boolean).slice(0, SEARCH_FILES);
  } catch {
    files = await walk(folder);
  }
  fileLists.set(folder, { at: Date.now(), files });
  return files;
}

async function walk(root: string): Promise<string[]> {
  const found: string[] = [];
  const queue = [""];
  while (queue.length && found.length < SEARCH_FILES) {
    const relative = queue.shift() ?? "";
    let entries;
    try {
      entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) queue.push(next);
      else found.push(next);
    }
  }
  return found;
}

// Files and folders whose path matches the query letters in order, best first. hidden also finds dot paths.
export async function searchFolder(folder: string, query: string, hidden = false): Promise<FuzzyMatch[]> {
  const files = await folderFiles(folder);
  const candidates = new Map<string, "file" | "directory">();
  for (const file of files) {
    candidates.set(file, "file");
    let dir = path.posix.dirname(file);
    while (dir && dir !== "." && !candidates.has(dir)) {
      candidates.set(dir, "directory");
      dir = path.posix.dirname(dir);
    }
  }
  const needle = query.trim().toLowerCase();
  const scored: { path: string; type: "file" | "directory"; score: number }[] = [];
  for (const [relative, type] of candidates) {
    if (!hidden && relative.split("/").some((part) => part.startsWith("."))) continue;
    const score = needle ? matchScore(relative.toLowerCase(), needle) : 1 / (1 + relative.length);
    if (score > 0) scored.push({ path: relative, type, score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return scored.slice(0, SEARCH_LIMIT).map((item) => ({
    name: path.posix.basename(item.path),
    path: path.join(folder, item.path),
    type: item.type,
  }));
}

// 0 when the letters are not all there in order. Matches in the file name, at word starts and in runs score higher.
export function matchScore(candidate: string, needle: string): number {
  const nameStart = candidate.lastIndexOf("/") + 1;
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const letter of needle) {
    const index = candidate.indexOf(letter, from);
    if (index < 0) return 0;
    score += 1;
    if (index === previous + 1) score += 2;
    if (index >= nameStart) score += 1;
    const before = candidate[index - 1];
    if (index === 0 || before === "/" || before === "-" || before === "_" || before === ".") score += 2;
    previous = index;
    from = index + 1;
  }
  if (candidate.slice(nameStart).startsWith(needle)) score += 10;
  return score / (1 + candidate.length / 40);
}
