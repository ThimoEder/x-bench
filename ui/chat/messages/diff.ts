export interface DiffRow {
  type: "same" | "del" | "add";
  text: string;
  ln: number;
}

// A path inside the session folder relative to it, any other as its last two parts.
export function shortPath(cwd: string, full: unknown) {
  const path = String(full || "").replace(/`/g, "");
  const root = String(cwd || "").replace(/\/$/, "");
  if (root && (path === root || path.startsWith(`${root}/`))) return path.slice(root.length + 1);
  const parts = path.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || path;
}

const hunkCache = new Map<string, { rows: DiffRow[]; cut: boolean }>();

// The first limit rows of the change, and whether the change goes on past them.
export function hunkRows(oldText: string, newText: string, limit = 80) {
  const key = `${limit}\0${oldText}\0${newText}`;
  const cached = hunkCache.get(key);
  if (cached) return cached;
  const before = splitLines(oldText);
  const after = splitLines(newText);
  const all = !before.length && !after.length ? [] : diffLines(before.slice(0, limit), after.slice(0, limit));
  const hunk = { rows: all.slice(0, limit), cut: before.length > limit || after.length > limit || all.length > limit };
  if (hunkCache.size > 500) hunkCache.clear();
  hunkCache.set(key, hunk);
  return hunk;
}

function splitLines(text: string) {
  if (!text) return [];
  const lines = String(text).split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function diffLines(before: string[], after: string[]) {
  const n = before.length;
  const m = after.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i];
    const next = dp[i + 1];
    if (row === undefined || next === undefined) continue;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = before[i] === after[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  let oldNumber = 1;
  let newNumber = 1;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      rows.push({ type: "same", text: before[i] ?? "", ln: newNumber });
      i += 1;
      j += 1;
      oldNumber += 1;
      newNumber += 1;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      rows.push({ type: "del", text: before[i] ?? "", ln: oldNumber });
      i += 1;
      oldNumber += 1;
    } else {
      rows.push({ type: "add", text: after[j] ?? "", ln: newNumber });
      j += 1;
      newNumber += 1;
    }
  }
  while (i < n) {
    rows.push({ type: "del", text: before[i] ?? "", ln: oldNumber });
    i += 1;
    oldNumber += 1;
  }
  while (j < m) {
    rows.push({ type: "add", text: after[j] ?? "", ln: newNumber });
    j += 1;
    newNumber += 1;
  }
  return rows;
}
