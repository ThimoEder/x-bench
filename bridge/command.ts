import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { adapterEnvironment } from "./adapter.ts";

// The first line of `<command> --version`, or null when the command does not run.
export function commandVersion(command: string, args: string[] = ["--version"]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 8000 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(String(stdout).trim().split("\n")[0] || "");
    });
  });
}

// What `<command> <args>` prints, or null when it does not run.
export function commandOutput(command: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 10000, env: adapterEnvironment(extra) }, (error, stdout) => {
      resolve(error ? null : String(stdout));
    });
  });
}

// A program on PATH, or in the usual install folders, which a packaged app started from Finder lacks.
export function findProgram(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return programsNamed(name, env)[0];
}

// Every program with that name on PATH and in the usual install folders.
export function programsNamed(name: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const folders = [...String(env.PATH || "").split(path.delimiter), path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  return [...new Set(folders.filter(Boolean).map((folder) => path.join(folder, name)))].filter(isExecutable);
}

export function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
