import { readdirSync, readFileSync, existsSync, statSync, type Dirent } from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { canonicalCwd } from "../../bridge/home.ts";
import { fields, maybe } from "../../bridge/lenient.ts";
import type { SessionListRow, SidebarSession } from "../snapshot.ts";

// One summary.json. The folders and the id stay unknown: they are compared or resolved
// below, and a folder that is not a string made path.resolve throw, which skipped the summary.
const Summary = fields({
  info: fields({ id: z.unknown().optional(), cwd: z.unknown().optional() }),
  session_kind: z.unknown().optional(),
  generated_title: maybe(z.string()),
  session_summary: maybe(z.string()),
  updated_at: maybe(z.string()),
  created_at: maybe(z.string()),
  current_model_id: maybe(z.string()),
  source_workspace_dir: z.unknown().optional(),
  worktree_label: z.unknown().optional(),
});

type Summary = z.output<typeof Summary>;

// A chat in the sidebar index, before sidebar.ts arranges it.
export type SessionIndexRow = Pick<SidebarSession, "id" | "cwd" | "title" | "updatedAt" | "source" | "worktreeLabel" | "provider" | "gone" | "earlierProviders">;

export interface SessionIndex {
  rows: SessionIndexRow[];
  subagentIds: string[];
}

const defaultRoot = path.join(os.homedir(), ".grok", "sessions");
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(id: unknown): id is string {
  return typeof id === "string" && sessionIdPattern.test(id);
}

export { canonicalCwd };

export function listSessions(cwd: string, root = defaultRoot): SessionListRow[] {
  const abs = path.resolve(cwd);
  if (!existsSync(root)) return [];
  const rows: SessionListRow[] = [];
  for (const group of readdirSync(root, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const groupDir = path.join(root, group.name);
    let entries: Dirent[];
    try {
      entries = readdirSync(groupDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const summaryPath = path.join(groupDir, entry.name, "summary.json");
      if (!existsSync(summaryPath)) continue;
      try {
        const summary = readSummary(summaryPath);
        if (isSubagentSession(summary)) continue;
        if (summary.info.cwd !== abs) continue;
        rows.push({
          id: rowId(summary, entry.name),
          title: summary.generated_title || summary.session_summary || "Untitled",
          updatedAt: summary.updated_at || summary.created_at || null,
          modelId: summary.current_model_id || null,
        });
      } catch {
        // Skip a summary that is mid-write.
      }
    }
  }
  rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return rows;
}

export function sessionIndex(root = defaultRoot): SessionIndex {
  const rows: SessionIndexRow[] = [];
  const subagentIds: string[] = [];
  if (!existsSync(root)) return { rows, subagentIds };
  const temp = canonicalCwd(os.tmpdir());
  for (const group of readdirSync(root, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const groupDir = path.join(root, group.name);
    let entries: Dirent[];
    try {
      entries = readdirSync(groupDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const summaryPath = path.join(groupDir, entry.name, "summary.json");
      if (!existsSync(summaryPath)) continue;
      try {
        const summary = readSummary(summaryPath);
        const id = rowId(summary, entry.name);
        if (isSubagentSession(summary)) {
          subagentIds.push(id);
          continue;
        }
        const folder = summary.info.cwd;
        if (!folder || typeof folder !== "string") continue;
        const key = canonicalCwd(folder);
        if (key === temp || key.startsWith(`${temp}${path.sep}`)) continue;
        const sourceDir = summary.source_workspace_dir;
        if (sourceDir && typeof sourceDir !== "string") continue;
        const source = typeof sourceDir === "string" && sourceDir ? canonicalCwd(sourceDir) : "";
        const worktreeLabel = summary.worktree_label ? String(summary.worktree_label) : "";
        rows.push({
          id,
          cwd: key,
          title: summary.generated_title || summary.session_summary || "Untitled",
          updatedAt: summary.updated_at || summary.created_at || "",
          ...(source && source !== key ? { source } : {}),
          ...(worktreeLabel ? { worktreeLabel } : {}),
        });
      } catch {
        // Skip a summary that is mid-write.
      }
    }
  }
  return { rows, subagentIds };
}

// Callers skip a null summary like a partial write.
function readSummary(file: string): Summary {
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (raw === null) throw new Error("summary.json is null");
  return Summary.parse(raw);
}

// An id that is not a string reads as missing.
function rowId(summary: Summary, fallback: string): string {
  const id = summary.info.id;
  return typeof id === "string" && id ? id : fallback;
}

function isSubagentSession(summary: Summary): boolean {
  return summary.session_kind === "subagent";
}

export function isDirectory(cwd: string): boolean {
  try {
    return statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}
