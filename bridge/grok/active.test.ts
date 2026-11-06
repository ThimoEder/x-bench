import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isRecord } from "../lenient.ts";
import {
  activeSessionFiles,
  liveActiveSessionIds,
  registerActiveSession,
  unregisterActivePid,
  unregisterActiveSession,
  type ActiveSessionFiles,
} from "./active.ts";

function rowAt(entries: unknown[], index: number): Record<string, unknown> {
  const row = entries.at(index);
  assert.ok(isRecord(row), `no registry row at ${index}`);
  return row;
}

function sessionIds(entries: unknown[]): unknown[] {
  return entries.map((entry) => (isRecord(entry) ? entry.session_id : undefined));
}

test("a new chat is added beside sessions another process still owns", () => {
  const files = tempFiles();
  const owner = spawn("sleep", ["30"]);
  try {
    writeFileSync(
      files.file,
      `${JSON.stringify([{ session_id: "theirs", pid: owner.pid, cwd: "/work/other", opened_at: "2026-09-22T00:00:00.000000Z" }], null, 2)}\n`,
    );
    const next = registerActiveSession({ sessionId: "ours", pid: process.pid, cwd: "/work/app" }, files);
    assert.deepEqual(sessionIds(next), ["theirs", "ours"]);
    assert.equal(rowAt(next, 1).pid, process.pid);
    assert.equal(rowAt(next, 1).cwd, "/work/app");
    assert.match(String(rowAt(next, 1).opened_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    const again = registerActiveSession({ sessionId: "ours", pid: process.pid, cwd: "/work/app" }, files);
    assert.equal(rowAt(again, 1).opened_at, rowAt(next, 1).opened_at);
  } finally {
    owner.kill();
    rmSync(path.dirname(files.file), { recursive: true, force: true });
  }
});

test("a live owner keeps the chat and a dead row is dropped", () => {
  const files = tempFiles();
  const owner = spawn("sleep", ["30"]);
  try {
    writeFileSync(
      files.file,
      `${JSON.stringify(
        [
          { session_id: "live", pid: owner.pid, cwd: "/work/live", opened_at: "2026-09-22T00:00:00.000000Z", extra: true },
          { session_id: "gone", pid: deadPid(), cwd: "/work/gone", opened_at: "2026-09-22T00:00:00.000000Z" },
        ],
        null,
        2,
      )}\n`,
    );
    const next = registerActiveSession({ sessionId: "live", pid: process.pid, cwd: "/work/stolen" }, files);
    assert.equal(next.length, 1);
    assert.equal(rowAt(next, 0).pid, owner.pid);
    assert.equal(rowAt(next, 0).cwd, "/work/live");
    assert.equal(rowAt(next, 0).extra, true);
  } finally {
    owner.kill();
    rmSync(path.dirname(files.file), { recursive: true, force: true });
  }
});

test("closing a chat removes only this process, and shutdown removes the rest", () => {
  const files = tempFiles();
  const owner = spawn("sleep", ["30"]);
  try {
    registerActiveSession({ sessionId: "a", pid: process.pid, cwd: "/work/app" }, files);
    registerActiveSession({ sessionId: "b", pid: process.pid, cwd: "/work/app" }, files);
    registerActiveSession({ sessionId: "theirs", pid: owner.pid, cwd: "/work/other" }, files);
    const closed = unregisterActiveSession("a", process.pid, files);
    assert.deepEqual(sessionIds(closed), ["b", "theirs"]);
    const stopped = unregisterActivePid(process.pid, files);
    assert.deepEqual(sessionIds(stopped), ["theirs"]);
  } finally {
    owner.kill();
    rmSync(path.dirname(files.file), { recursive: true, force: true });
  }
});

test("a live owner is listed and a dead row is not", () => {
  const files = tempFiles();
  try {
    registerActiveSession({ sessionId: "ours", pid: process.pid, cwd: "/work/app" }, files);
    registerActiveSession({ sessionId: "gone", pid: deadPid(), cwd: "/work/gone" }, files);
    assert.deepEqual(liveActiveSessionIds(files), ["ours"]);
  } finally {
    rmSync(path.dirname(files.file), { recursive: true, force: true });
  }
});

test("an unreadable registry is left untouched", () => {
  const files = tempFiles();
  writeFileSync(files.file, "{");
  assert.throws(() => registerActiveSession({ sessionId: "a", pid: process.pid, cwd: "/work/app" }, files), /unreadable/);
  assert.equal(readFileSync(files.file, "utf8"), "{");
  rmSync(path.dirname(files.file), { recursive: true, force: true });
});

function tempFiles(): ActiveSessionFiles {
  const dir = mkdtempSync(path.join(os.tmpdir(), "x-bench-active-"));
  return activeSessionFiles(dir);
}

function deadPid(): number {
  for (let pid = 1_000_000; pid < 1_010_000; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (isRecord(error) && error.code === "ESRCH") return pid;
    }
  }
  throw new Error("no unused pid");
}
