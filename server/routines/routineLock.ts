// routines.lock: the host that runs the routine schedule holds it open with an exclusive lock for as long as it runs,
// and writes { "port", "pid" } into it so the other hosts can say which one does. The lock goes with the process,
// so a crash frees it as well as a quit.

import { closeSync, constants, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";
import { isRecord } from "../../bridge/lenient.ts";
import { openLocked, pidAlive } from "../../bridge/fileLock.ts";

export interface LockHolder {
  port: number;
  pid: number;
}

export interface SchedulerLock {
  // Takes the lock unless another process holds it. True while this process holds it.
  take(): boolean;
  held(): boolean;
  // The live process that holds it, this one included.
  holder(): LockHolder | null;
  release(): void;
}

function readHolder(file: string): LockHolder | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(value) || typeof value.port !== "number" || typeof value.pid !== "number") return null;
    return pidAlive(value.pid) ? { port: value.port, pid: value.pid } : null;
  } catch {
    return null;
  }
}

export function fileLock(port: number, file: string): SchedulerLock {
  let fd: number | null = null;
  const own = { port, pid: process.pid };

  function stamp(descriptor: number) {
    ftruncateSync(descriptor, 0);
    writeSync(descriptor, JSON.stringify(own), 0);
  }

  return {
    take() {
      if (fd !== null) return true;
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        if (process.platform === "darwin") {
          fd = openLocked(file, 0);
        } else {
          // Without O_EXLOCK the file's live holder decides.
          const holder = readHolder(file);
          if (holder && holder.pid !== process.pid) return false;
          fd = openSync(file, constants.O_RDWR | constants.O_CREAT);
        }
        stamp(fd);
        return true;
      } catch {
        if (fd !== null) closeSync(fd);
        fd = null;
        return false;
      }
    },
    held: () => fd !== null,
    holder: () => (fd !== null ? own : readHolder(file)),
    release() {
      if (fd === null) return;
      try {
        ftruncateSync(fd, 0);
      } catch {
        // The next holder writes its own.
      }
      closeSync(fd);
      fd = null;
    },
  };
}
