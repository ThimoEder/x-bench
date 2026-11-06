import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deleteSessionHistory, removeSessionDir } from "./sessionFiles.ts";

test("removeSessionDir deletes one chat and leaves the others", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "x-bench-delete-"));
  const id = "01a0c59e-1abb-70d1-bb11-0b33f705d3c2";
  const other = "01a0c59e-1abb-70d1-bb11-0b33f705d3c3";
  writeSummary(root, "/work/app", id, { generated_title: "Gone" });
  writeSummary(root, "/work/app", other, { generated_title: "Stay" });
  const calls: string[][] = [];
  await deleteSessionHistory(id, root, (command, args) => {
    calls.push([command, ...args]);
    return Promise.resolve({ stdout: "", stderr: "" });
  });
  assert.deepEqual(calls, [["grok", "sessions", "delete", id]]);
  assert.equal(existsSync(path.join(root, encodeURIComponent("/work/app"), id)), false);
  assert.equal(existsSync(path.join(root, encodeURIComponent("/work/app"), other, "summary.json")), true);
  assert.equal(removeSessionDir("../" + id, root), 0);
  rmSync(root, { recursive: true, force: true });
});

test("removeSessionDir does not follow a link outside the sessions root", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "x-bench-delete-root-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "x-bench-delete-out-"));
  writeFileSync(path.join(outside, "keep.txt"), "keep");
  const group = path.join(root, "group");
  mkdirSync(group);
  const id = "01a0c59e-1abb-70d1-bb11-0b33f705d3c2";
  symlinkSync(outside, path.join(group, id));
  assert.equal(removeSessionDir(id, root), 0);
  assert.equal(existsSync(path.join(outside, "keep.txt")), true);
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function writeSummary(root: string, cwd: string, id: string, fields: Record<string, unknown>) {
  const dir = path.join(root, encodeURIComponent(cwd), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "summary.json"),
    JSON.stringify({ info: { id, cwd }, ...fields }),
  );
}
