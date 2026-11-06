import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, type Dirent } from "node:fs";
import path from "node:path";

interface Cursor {
  file: string;
  offset: number;
}

// Lines of updates.jsonl as parsed JSON. The bridge checks them when it replays the log.
export interface SessionUpdates {
  reset: boolean;
  messages: unknown[];
}

const cursors = new Map<string, Cursor>();
const files = new Map<string, string>();

export function forgetSessionUpdates(sessionId: string): void {
  cursors.delete(sessionId);
}

export function readSessionUpdates(root: string, sessionId: string): SessionUpdates {
  const file = updatesFile(root, sessionId);
  if (!file) return { reset: false, messages: [] };
  let size;
  try {
    size = statSync(file).size;
  } catch {
    return { reset: false, messages: [] };
  }
  const cursor = cursors.get(sessionId);
  const reset = !cursor || cursor.file !== file || size < cursor.offset;
  const from = reset ? 0 : cursor.offset;
  if (size === from) return { reset: false, messages: [] };
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - from);
    const read = readSync(fd, buf, 0, buf.length, from);
    const data = buf.subarray(0, read);
    const end = data.lastIndexOf(0x0a);
    if (end < 0) return { reset: false, messages: [] };
    const messages: unknown[] = [];
    for (const line of data.subarray(0, end).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line));
      } catch {
        // A torn write is skipped. The next read continues after this newline.
      }
    }
    cursors.set(sessionId, { file, offset: from + end + 1 });
    return { reset, messages };
  } finally {
    closeSync(fd);
  }
}

function updatesFile(root: string, sessionId: string): string | null {
  const cached = files.get(sessionId);
  if (cached && existsSync(cached)) return cached;
  if (!root || !sessionId || !existsSync(root)) return null;
  let groups: Dirent[];
  try {
    groups = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    const file = path.join(root, group.name, sessionId, "updates.jsonl");
    if (!existsSync(file)) continue;
    files.set(sessionId, file);
    return file;
  }
  return null;
}
