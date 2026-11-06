import { closeSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { isRecord } from "../lenient.ts";
import { openLocked, pidAlive } from "../fileLock.ts";

// active_sessions.json. Rows stay as Grok wrote them, fields and order included,
// because the whole list is written back. Rows that are not objects are kept too.
const Registry = z.array(z.unknown());

export interface ActiveSessionFiles {
  file: string;
  lock: string;
}

export interface ActiveSession {
  sessionId: string;
  pid: number | undefined;
  cwd: string;
  openedAt?: string;
}

export function activeSessionFiles(dir = path.join(os.homedir(), ".grok")): ActiveSessionFiles {
  return {
    file: path.join(dir, "active_sessions.json"),
    lock: path.join(dir, "active_sessions.lock"),
  };
}

export function registerActiveSession({ sessionId, pid, cwd, openedAt }: ActiveSession, files = activeSessionFiles()): unknown[] {
  if (!sessionId || !pid || !cwd) throw new Error("missing active session");
  return withRegistry(files, (entries) => {
    const kept = entries.filter(keepRow);
    const index = kept.findIndex((entry) => isRecord(entry) && entry.session_id === sessionId);
    const found = index >= 0 ? kept[index] : null;
    const current = isRecord(found) ? found : null;
    if (current && current.pid !== pid && pidAlive(current.pid)) return kept;
    const row = {
      ...(current?.pid === pid ? current : {}),
      session_id: sessionId,
      pid,
      cwd,
      opened_at: current?.pid === pid && current.opened_at ? current.opened_at : openedAt || stamp(),
    };
    if (index >= 0) {
      const next = kept.slice();
      next[index] = row;
      return next;
    }
    return [...kept, row];
  });
}

export function unregisterActiveSession(sessionId: string, pid: number, files = activeSessionFiles()): unknown[] {
  if (!sessionId || !pid) return [];
  return withRegistry(files, (entries) =>
    entries.filter((entry) => keepRow(entry) && !(field(entry, "session_id") === sessionId && field(entry, "pid") === pid)),
  );
}

export function unregisterActivePid(pid: number, files = activeSessionFiles()): unknown[] {
  if (!pid) return [];
  return withRegistry(files, (entries) => entries.filter((entry) => keepRow(entry) && field(entry, "pid") !== pid));
}

export function liveActiveSessionIds(files = activeSessionFiles()): string[] {
  try {
    return readEntries(files.file).flatMap((entry) =>
      isRecord(entry) && typeof entry.session_id === "string" && pidAlive(entry.pid) ? [entry.session_id] : [],
    );
  } catch {
    return [];
  }
}

function withRegistry(files: ActiveSessionFiles, mutate: (entries: unknown[]) => unknown[]): unknown[] {
  mkdirSync(path.dirname(files.file), { recursive: true });
  const fd = openLocked(files.lock, 1000);
  try {
    const current = readEntries(files.file);
    const next = mutate(current);
    if (JSON.stringify(current) !== JSON.stringify(next)) writeEntries(files.file, next);
    return next;
  } finally {
    closeSync(fd);
  }
}

function readEntries(file: string): unknown[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("active session registry is unreadable");
  }
  const entries = Registry.safeParse(parsed);
  if (!entries.success) throw new Error("active session registry is not a list");
  return entries.data;
}

function writeEntries(file: string, entries: unknown[]) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`);
  renameSync(tmp, file);
}

// A field of a row, read the way entry?.field did.
function field(entry: unknown, key: string): unknown {
  return isRecord(entry) ? entry[key] : undefined;
}

function keepRow(entry: unknown): boolean {
  if (!isRecord(entry) || typeof entry.pid !== "number") return true;
  return pidAlive(entry.pid);
}

function stamp(date = new Date()): string {
  return date.toISOString().replace(/(\.\d{3})Z$/, (_, fraction: string) => `${fraction}000Z`);
}
