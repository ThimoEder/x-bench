import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

export interface OpenFolderDeps {
  isDirectory?: (folder: string) => boolean;
  platform?: string;
  execFile?: RunFile;
}

type RunFile = (
  command: string,
  args: string[],
  options: { timeout: number },
  callback: (error: Error | null) => void,
) => void;

export function chooseFolder(): Promise<string | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    execFile(
      "osascript",
      ["-e", 'POSIX path of (choose folder with prompt "Open a project")'],
      { timeout: 120000 },
      (error, stdout, stderr) => {
        if (error) {
          const message = `${error.message}\n${stderr || ""}`;
          if (message.includes("User canceled") || message.includes("(-128)")) {
            resolve(null);
            return;
          }
          reject(error);
          return;
        }
        const folder = stdout.trim().replace(/\/$/, "");
        resolve(folder || null);
      },
    );
  });
}

// A folder or a file the person picks in the macOS chooser, hidden ones included (~/.claude-personal),
// starting in start. null when they cancel or on another OS.
export function choosePath(kind: "folder" | "file", prompt: string, start: string): Promise<string | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  const quoted = (text: string) => `"${text.replace(/[\\"]/g, "\\$&")}"`;
  const script = `POSIX path of (choose ${kind} with prompt ${quoted(prompt)} default location (POSIX file ${quoted(start)}) with invisibles)`;
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { timeout: 120000 }, (error, stdout, stderr) => {
      if (error) {
        const message = `${error.message}\n${stderr || ""}`;
        if (message.includes("User canceled") || message.includes("(-128)")) {
          resolve(null);
          return;
        }
        reject(error);
        return;
      }
      const picked = stdout.trim();
      resolve(picked ? (kind === "folder" ? picked.replace(/\/$/, "") : picked) : null);
    });
  });
}

export function openFolder(folder: unknown, deps: OpenFolderDeps = {}): Promise<string> {
  const target = path.resolve(String(folder || ""));
  const directory = deps.isDirectory || isDirectory;
  if (!directory(target)) return Promise.reject(new Error("Folder does not exist"));
  const platform = deps.platform || process.platform;
  if (platform !== "darwin") return Promise.reject(new Error("Open folder is only available on macOS"));
  const exec: RunFile = deps.execFile || execFile;
  return new Promise((resolve, reject) => {
    exec("open", [target], { timeout: 10000 }, (error) => {
      if (error) reject(error);
      else resolve(target);
    });
  });
}

// Selects a file in Finder, the way a chat without a review dock opens a file link. Finder only shows
// it: nothing is opened or run, whatever the file is.
export function revealFile(file: unknown, deps: OpenFolderDeps & { isFile?: (file: string) => boolean } = {}): Promise<string> {
  const target = String(file || "");
  if (!path.isAbsolute(target)) return Promise.reject(new Error("File does not exist"));
  const exists = deps.isFile || isFile;
  if (!exists(target)) return Promise.reject(new Error("File does not exist"));
  const platform = deps.platform || process.platform;
  if (platform !== "darwin") return Promise.reject(new Error("Show in Finder is only available on macOS"));
  const exec: RunFile = deps.execFile || execFile;
  return new Promise((resolve, reject) => {
    exec("open", ["-R", target], { timeout: 10000 }, (error) => {
      if (error) reject(error);
      else resolve(target);
    });
  });
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectory(folder: string): boolean {
  try {
    return statSync(folder).isDirectory();
  } catch {
    return false;
  }
}
