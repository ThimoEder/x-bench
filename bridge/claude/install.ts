// Where Claude Code is installed and which config folders it has, for the settings page to pick from.

import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findProgram, programsNamed } from "../command.ts";
import { collapseHome, expandHome } from "../home.ts";

// The config folder claude uses in a terminal without CLAUDE_CONFIG_DIR set by this app.
export function environmentConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() ? path.resolve(expandHome(env.CLAUDE_CONFIG_DIR.trim())) : path.join(os.homedir(), ".claude");
}

// Claude config folders in the home folder (~/.claude, ~/.claude-work, …), to pick from. Only names
// and folder kinds are read, never a file inside.
export function claudeConfigFolders(home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const found = new Set<string>();
  try {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (entry.isDirectory() && /^\.claude($|[-_.])/.test(entry.name)) found.add(path.join(home, entry.name));
    }
  } catch {
    // An unreadable home lists nothing.
  }
  if (env.CLAUDE_CONFIG_DIR?.trim()) found.add(environmentConfigDir(env));
  return [...found].sort().map((folder) => collapseHome(folder, home));
}

// The claude binaries on PATH and in the usual install folders, to pick from.
export function claudeBinaries(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set(programsNamed("claude", env).map((file) => collapseHome(file)))];
}

// The installed claude on PATH, or where its installer puts it.
export function findClaude(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return findProgram("claude", env);
}
