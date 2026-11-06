// Where a suggested task's chat starts: a new worktree from the latest main, a new branch from it in the project
// folder, or the chat's own folder as it is.

import { realpathSync } from "node:fs";
import path from "node:path";
import { branchSlug } from "../git/branch.ts";

export const TASK_STARTS = ["worktree", "branch", "folder"] as const;
export type TaskStart = (typeof TASK_STARTS)[number];

export function isTaskStart(value: unknown): value is TaskStart {
  return typeof value === "string" && (TASK_STARTS as readonly string[]).includes(value);
}

export function taskBranchName(title: string): string {
  return `task/${branchSlug(title) || "follow-up"}`;
}

// Agents write absolute paths into a suggestion's prompt. Paths into the from folders are pointed at to, so a task
// that starts in a worktree or on a branch edits its own checkout.
export function retargetPrompt(prompt: string, from: string[], to: string): string {
  const target = new Set(pathForms(to));
  const forms = [...new Set(from.flatMap(pathForms))].filter((form) => !target.has(form) && form !== "/").sort((a, b) => b.length - a.length);
  if (!forms.length) return prompt;
  const pattern = new RegExp(`(?:${forms.map(escapeRegExp).join("|")})(?![\\w.-])`, "g");
  return prompt.replace(pattern, () => to);
}

// A folder as an agent may write it: as given, resolved, and with or without macOS's /private prefix.
function pathForms(folder: string): string[] {
  const resolved = path.resolve(folder).replace(/\/+$/, "") || "/";
  let real = resolved;
  try {
    real = realpathSync(resolved);
  } catch {
    // A folder that is gone is matched as written.
  }
  const forms = new Set([resolved, real]);
  if (real.startsWith("/private/")) forms.add(real.slice("/private".length));
  return [...forms];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
