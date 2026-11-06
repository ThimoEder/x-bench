// How this app runs Claude: ~/.x-bench/claude.json names the Claude config folder
// (CLAUDE_CONFIG_DIR) and the claude binary. A person with two Claude accounts points configDir
// at the one this app should use. The settings page writes it.
//
// { "configDir": "~/.claude-personal", "executable": "~/.local/bin/claude" }
//
// Without the file, the environment decides, as it does for claude in a terminal. A file that
// does not read stops Claude from starting, so a broken file never lands the app on another account.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { fields, isRecord, maybe } from "../../bridge/lenient.ts";
import { collapseHome, expandHome } from "../../bridge/home.ts";
import { findClaude } from "../../bridge/claude/install.ts";
import { fileStamp, loadDurable, saveDurable, unreadable } from "../jsonFile.ts";

const Settings = fields({ configDir: maybe(z.string()), executable: maybe(z.string()) });

// claude.json as written, paths still with their ~.
export interface ClaudeFile {
  configDir?: string;
  executable?: string;
}

// What the provider runs with: absolute paths, and why Claude cannot start when it cannot.
export interface ClaudeSettings {
  configDir?: string;
  executable?: string;
  problem?: string;
}

function parseFile(value: unknown): ClaudeFile | null {
  if (!isRecord(value)) return null;
  const parsed = Settings.parse(value);
  return {
    ...(parsed.configDir?.trim() ? { configDir: parsed.configDir.trim() } : {}),
    ...(parsed.executable?.trim() ? { executable: parsed.executable.trim() } : {}),
  };
}

export interface ClaudeSettingsStore {
  readFile(): ClaudeFile;
  read(env?: NodeJS.ProcessEnv): ClaudeSettings;
  // Writes the fields given over the file as it is on disk, keeping any field this app does not know.
  // Returns false when the file on disk does not read, and leaves it alone.
  save(next: ClaudeFile): boolean;
  unreadable(): boolean;
}

export function createClaudeSettings(file: string): ClaudeSettingsStore {
  // Read whenever Claude starts or detects, so the file is parsed again only when it changed.
  let cached = { key: "", value: {} as ClaudeFile };
  function readFile(): ClaudeFile {
    const key = fileStamp(file);
    if (cached.key !== key) cached = { key, value: loadDurable<ClaudeFile>(file, parseFile, {}) };
    return { ...cached.value };
  }
  return {
    readFile,
    read(env = process.env) {
      const stored = readFile();
      if (unreadable(file)) {
        return { problem: `${collapseHome(file)} does not read. Fix it by hand. Claude does not start until then.` };
      }
      const configDir = stored.configDir ? expandHome(stored.configDir) : undefined;
      const executable = stored.executable ? expandHome(stored.executable) : findClaude(env);
      if (!executable) return { ...(configDir ? { configDir } : {}), problem: "Claude Code is not installed. Install claude to use Claude models." };
      return { ...(configDir ? { configDir } : {}), executable };
    },
    save(next) {
      let current: Record<string, unknown> = {};
      try {
        const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
        if (isRecord(raw)) current = raw;
      } catch {
        // No file yet. A file that is there but does not read is refused by saveDurable.
      }
      const merged: Record<string, unknown> = { ...current };
      for (const key of ["configDir", "executable"] as const) {
        if (next[key] === undefined || next[key] === "") delete merged[key];
        else merged[key] = next[key];
      }
      const saved = saveDurable(file, `${JSON.stringify(merged, null, 2)}\n`, parseFile);
      cached.key = "";
      return saved;
    },
    unreadable: () => unreadable(file),
  };
}
