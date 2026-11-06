// Grok's session folders under ~/.grok/sessions: <folder>/<session id>/ with summary.json, updates.jsonl,
// events.jsonl and plan.md.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { canonicalCwd } from "../home.ts";
import { fields, isRecord } from "../lenient.ts";

const SESSION_ROOT = path.join(os.homedir(), ".grok", "sessions");

// The folder and the id stay unknown, since path.resolve throws on a folder that is not a string.
const Summary = fields({ info: fields({ id: z.unknown().optional(), cwd: z.unknown().optional() }) });

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CommandOutput {
  stdout: string;
  stderr: string;
}

export type RunCommand = (command: string, args: string[], timeout: number) => Promise<CommandOutput>;

export function findSessionDir(cwd: string, sessionId: string | null | undefined, root = SESSION_ROOT): string | null {
  const abs = canonicalCwd(cwd);
  if (!existsSync(root) || !sessionId) return null;
  for (const group of readdirSync(root, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const dir = path.join(root, group.name, sessionId);
    const summaryPath = path.join(dir, "summary.json");
    if (!existsSync(summaryPath)) continue;
    try {
      const raw: unknown = JSON.parse(readFileSync(summaryPath, "utf8"));
      if (raw === null) continue;
      const { info } = Summary.parse(raw);
      const folder = info.cwd || "";
      if (typeof folder !== "string") continue;
      if ((info.id || sessionId) === sessionId && canonicalCwd(folder) === abs) return dir;
    } catch {
      // A summary mid-write is not this session.
    }
  }
  return null;
}

export function findSessionDirs(sessionId: string, root = SESSION_ROOT): string[] {
  if (!sessionIdPattern.test(sessionId) || !existsSync(root)) return [];
  const base = canonicalCwd(root);
  const found: string[] = [];
  for (const group of readdirSync(root, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const dir = path.join(root, group.name, sessionId);
    if (!existsSync(dir)) continue;
    let resolved: string;
    try {
      resolved = realpathSync(dir);
    } catch {
      continue;
    }
    const inside = resolved === base || resolved.startsWith(`${base}${path.sep}`);
    if (!inside || path.basename(resolved) !== sessionId) continue;
    found.push(resolved);
  }
  return found;
}

export function removeSessionDir(sessionId: string, root = SESSION_ROOT): number {
  const dirs = findSessionDirs(sessionId, root);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  return dirs.length;
}

// Files a session under another folder, since grok's session/load looks for it under the folder it is given.
export function moveSessionDir(sessionId: string, cwd: string, root = SESSION_ROOT): void {
  const [from] = findSessionDirs(sessionId, root);
  if (!from) throw new Error("Grok's copy of this chat was not found");
  const summary: unknown = JSON.parse(readFileSync(path.join(from, "summary.json"), "utf8"));
  if (!isRecord(summary)) throw new Error("Grok's summary of this chat does not read");
  const folder = canonicalCwd(cwd);
  const to = path.join(canonicalCwd(root), encodeURIComponent(folder), sessionId);
  if (from !== to) {
    mkdirSync(path.dirname(to), { recursive: true });
    renameSync(from, to);
    try {
      rmdirSync(path.dirname(from));
    } catch {
      // The old folder still holds other sessions.
    }
  }
  // The worktree it was added from names the old folder, and the sidebar would still file the chat there.
  const { source_workspace_dir: _source, worktree_label: _label, ...kept } = summary;
  writeFileSync(path.join(to, "summary.json"), `${JSON.stringify({ ...kept, info: { ...(isRecord(summary.info) ? summary.info : {}), cwd: folder } }, null, 2)}\n`);
}

export async function deleteSessionHistory(sessionId: string, root = SESSION_ROOT, run: RunCommand = runGrok): Promise<void> {
  if (!sessionIdPattern.test(sessionId)) throw new Error("Unknown session");
  let cliError: unknown = null;
  try {
    await run("grok", ["sessions", "delete", sessionId], 20000);
  } catch (error) {
    cliError = error;
  }
  removeSessionDir(sessionId, root);
  if (findSessionDirs(sessionId, root).length > 0) {
    const failure = isRecord(cliError) ? cliError : undefined;
    const detail = String(failure?.stderr || failure?.message || "").trim();
    throw new Error(detail || "Couldn't delete that chat");
  }
}

function runGrok(command: string, args: string[], timeout: number): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
