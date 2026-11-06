import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// An absolute path for one a person typed with ~.
export function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

// ~/… for a path in the home folder, as a person would type it.
export function collapseHome(value: string, home = os.homedir()): string {
  if (value === home) return "~";
  return value.startsWith(`${home}${path.sep}`) ? `~${value.slice(home.length)}` : value;
}

export function canonicalCwd(folder: string): string {
  const resolved = path.resolve(folder);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}
