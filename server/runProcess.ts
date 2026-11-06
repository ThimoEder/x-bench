import { spawn } from "node:child_process";
import path from "node:path";

export interface RunOptions {
  timeoutMs?: number;
  // Written to the command's stdin, which is closed after it.
  input?: string;
  maxBytes?: number;
  // Added to the host's environment.
  env?: Record<string, string>;
}

export interface CommandResult {
  stdout: Buffer;
  stderr?: string;
}

export type RunCommand = (command: string, args: string[], options?: RunOptions) => Promise<CommandResult>;

// Runs a command to its end. A non-zero exit rejects with its stderr, and status 502 for the HTTP reply.
export function runProcess(command: string, args: string[], { timeoutMs = 20_000, input, maxBytes = 12_000_000, env }: RunOptions = {}): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], ...(env ? { env: { ...process.env, ...env } } : {}) });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    if (input !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const err = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        const reason = timedOut ? `${path.basename(command)} took longer than ${Math.round(timeoutMs / 1000)} seconds` : err || Buffer.concat(stdout).toString("utf8").trim().slice(-2000) || `${path.basename(command)} failed`;
        reject(Object.assign(new Error(reason), { status: 502 }));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout), stderr: err });
    });
  });
}
