import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { fields, maybe } from "../../bridge/lenient.ts";

// One line of btw_history.jsonl.
const HistoryLine = fields({
  btwSessionId: maybe(z.string()),
  question: maybe(z.string()),
  answer: maybe(z.string()),
  askedAt: maybe(z.string()),
});

export interface BtwEntry {
  id: string;
  question: string;
  answer: string;
  askedAt: string | null;
}

export interface BtwAnswer {
  id: string | null;
  answer: string;
}

const HISTORY_LIMIT = 40;

export function readBtwHistory(text: unknown): BtwEntry[] {
  const entries: BtwEntry[] = [];
  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const row = HistoryLine.parse(parsed);
    const question = row.question ?? "";
    const answer = row.answer ?? "";
    if (!question && !answer) continue;
    entries.push({
      id: row.btwSessionId || `btw-${entries.length + 1}`,
      question,
      answer,
      askedAt: row.askedAt ?? null,
    });
  }
  return entries.slice(-HISTORY_LIMIT);
}

export function btwHistoryPath(dir: string | null | undefined): string {
  return dir ? path.join(dir, "btw_history.jsonl") : "";
}

export function loadBtwHistory(dir: string | null | undefined): BtwEntry[] {
  const file = btwHistoryPath(dir);
  if (!file || !existsSync(file)) return [];
  try {
    return readBtwHistory(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

export function clearBtwHistory(dir: string | null | undefined): void {
  const file = btwHistoryPath(dir);
  if (!file || !existsSync(file)) return;
  writeFileSync(file, "");
}

// Where this app keeps the side questions of a session whose harness keeps none.
export function ownBtwDir(sessionId: string, root: string): string {
  return path.join(root, path.basename(sessionId));
}

export function appendBtwHistory(dir: string, entry: BtwEntry): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(btwHistoryPath(dir), `${JSON.stringify({ btwSessionId: entry.id, question: entry.question, answer: entry.answer, askedAt: entry.askedAt })}\n`);
}
