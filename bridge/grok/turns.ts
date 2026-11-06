import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, type Dirent, type Stats } from "node:fs";
import path from "node:path";

interface TurnScan {
  size: number;
  mtimeMs: number;
  open: boolean;
  offset: number;
}

interface TurnMark {
  open: boolean;
  offset: number;
}

const cache = new Map<string, TurnScan>();
const tailCap = 16_000_000;

// A turn stays open until events.jsonl records turn_ended. The builder does not
// copy that into another process, so a loaded copy looks idle while the owner is still working.
export function openTurnIds(root: string, aliveIds: Iterable<string> | null | undefined): string[] {
  const alive = new Set(aliveIds ?? []);
  const open: string[] = [];
  if (!root || !existsSync(root) || alive.size === 0) return open;
  let groups: Dirent[];
  try {
    groups = readdirSync(root, { withFileTypes: true });
  } catch {
    return open;
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    const groupDir = path.join(root, group.name);
    let names: string[];
    try {
      names = readdirSync(groupDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!alive.has(name)) continue;
      if (turnFileIsOpen(path.join(groupDir, name, "events.jsonl"))) open.push(name);
    }
  }
  return open;
}

function turnFileIsOpen(file: string): boolean {
  let st: Stats;
  try {
    st = statSync(file);
  } catch {
    return false;
  }
  const cached = cache.get(file);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.open;
  const from = cached && st.size >= cached.size ? cached.offset : Math.max(0, st.size - tailCap);
  const found = scanTurn(file, from, st.size);
  if (!found) {
    const open = cached ? cached.open : false;
    const offset = cached ? cached.offset : from;
    cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, open, offset });
    return open;
  }
  cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, open: found.open, offset: found.offset });
  return found.open;
}

function scanTurn(file: string, from: number, size: number): TurnMark | null {
  const length = size - from;
  if (length <= 0) return null;
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const read = readSync(fd, buf, 0, length, from);
    const text = buf.subarray(0, read).toString("utf8");
    const marker = /"type"\s*:\s*"turn_(started|ended)"/g;
    let found: TurnMark | null = null;
    for (const match of text.matchAll(marker)) {
      found = { open: match[1] === "started", offset: from + match.index };
    }
    return found;
  } finally {
    closeSync(fd);
  }
}
