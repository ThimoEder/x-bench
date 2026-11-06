import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { findSessionDir } from "./sessionFiles.ts";

const PLAN_LIMIT = 20000;

export interface PlanText {
  text: string;
  missing: boolean;
}

export function readPlan(cwd: string, sessionId: string | null | undefined, root?: string): PlanText {
  const dir = findSessionDir(cwd, sessionId, root);
  if (!dir) return { text: "", missing: true };
  const file = path.join(dir, "plan.md");
  if (!existsSync(file)) return { text: "", missing: true };
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return { text: "", missing: true };
  return { text: text.slice(0, PLAN_LIMIT), missing: false };
}

