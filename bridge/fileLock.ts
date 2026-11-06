// Exclusive locks on a lock file (macOS O_EXLOCK), and whether a process is alive. A lock goes with its process, so
// a crash frees it as well as a close.

import { closeSync, constants, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { isRecord } from "./lenient.ts";

// macOS open(2) O_EXLOCK. Node does not export it. Held until the descriptor closes.
const exclusiveLock = 0x20;

export function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function errorCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

// Opens lockPath holding its exclusive lock, trying again for up to waitMs while another process holds it.
// Throws when it stays held, and on any platform but macOS.
export function openLocked(lockPath: string, waitMs: number): number {
  if (process.platform !== "darwin") throw new Error("file locks need macOS");
  const flags = constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | exclusiveLock;
  const started = Date.now();
  for (;;) {
    try {
      return openSync(lockPath, flags);
    } catch (error) {
      const code = errorCode(error);
      if ((code !== "EAGAIN" && code !== "EWOULDBLOCK") || Date.now() - started >= waitMs) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

// Runs change while holding lockPath, so hosts on the same home take turns. Elsewhere than macOS it runs unlocked.
export function withFileLock<T>(lockPath: string, change: () => T): T {
  if (process.platform !== "darwin") return change();
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const fd = openLocked(lockPath, 1000);
  try {
    return change();
  } finally {
    closeSync(fd);
  }
}
