// The last skills and commands each harness reported, per folder (~/.x-bench/harness-commands.json),
// so a new chat's slash menu lists them before its session exists.

import { z } from "zod";
import { fileStamp, loadDurable, saveDurable } from "../jsonFile.ts";

const CommandSchema = z.object({ name: z.string(), description: z.string() });
// provider id → folder → commands. Each provider's folders run from the oldest report to the newest.
const FileSchema = z.record(z.string(), z.record(z.string(), z.array(CommandSchema)));

export type HarnessCommand = z.output<typeof CommandSchema>;
type CommandFile = z.output<typeof FileSchema>;

const MAX_FOLDERS = 20;

function parseFile(value: unknown): CommandFile | null {
  const parsed = FileSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface HarnessCommandsStore {
  // The folder's own list, or else the provider's newest one: most of a harness's skills are the user's and its plugins'.
  read(provider: string, cwd: string): HarnessCommand[];
  save(provider: string, cwd: string, commands: HarnessCommand[]): void;
}

export function createHarnessCommands(file: string): HarnessCommandsStore {
  let cached: { key: string; value: CommandFile } | null = null;
  function readFile(): CommandFile {
    const key = fileStamp(file);
    if (cached?.key === key) return cached.value;
    const value = loadDurable<CommandFile>(file, parseFile, {});
    cached = { key, value };
    return value;
  }
  return {
    read(provider, cwd) {
      const folders = readFile()[provider] ?? {};
      return folders[cwd] ?? Object.values(folders).at(-1) ?? [];
    },
    save(provider, cwd, commands) {
      const all = readFile();
      const folders = { ...all[provider] };
      const newest = Object.keys(folders).at(-1) === cwd;
      if (newest && JSON.stringify(folders[cwd]) === JSON.stringify(commands)) return;
      delete folders[cwd];
      folders[cwd] = commands;
      const kept = Object.fromEntries(Object.entries(folders).slice(-MAX_FOLDERS));
      saveDurable(file, `${JSON.stringify({ ...all, [provider]: kept })}\n`, parseFile);
    },
  };
}
