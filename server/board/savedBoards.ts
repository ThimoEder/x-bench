// The last full load of each bound folder's board, one file per folder, so the board draws at once after a restart
// while its source loads.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isRecord } from "../../bridge/lenient.ts";
import type { BoardBinding } from "./sources.ts";

function fileFor(dir: string, folder: string): string {
  return path.join(dir, `${createHash("sha256").update(folder).digest("hex").slice(0, 32)}.json`);
}

// A binding's title and columns change with its board, so its provider and id alone name the saved board.
function boardOf(binding: BoardBinding): string {
  return `${binding.provider}:${binding.provider === "sak" ? binding.projectId : binding.boardId}`;
}

// A board saved under another binding reads as none.
export function readSavedBoard(dir: string, folder: string, binding: BoardBinding): Record<string, unknown> | null {
  try {
    const saved: unknown = JSON.parse(readFileSync(fileFor(dir, folder), "utf8"));
    return isRecord(saved) && saved.board === boardOf(binding) && isRecord(saved.view) ? saved.view : null;
  } catch {
    return null;
  }
}

export function saveBoard(dir: string, folder: string, binding: BoardBinding, view: unknown): void {
  const file = fileFor(dir, folder);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(temp, JSON.stringify({ board: boardOf(binding), view }), { mode: 0o600 });
    renameSync(temp, file);
  } catch {
    // A failed save only costs the next launch its saved copy.
    rmSync(temp, { force: true });
  }
}

export function forgetSavedBoard(dir: string, folder: string): void {
  rmSync(fileFor(dir, folder), { force: true });
}
