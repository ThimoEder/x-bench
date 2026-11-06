import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearBtwHistory, loadBtwHistory, readBtwHistory } from "./btw.ts";

test("side-question history keeps the latest exchanges and skips a torn line", () => {
  const lines: string[] = [];
  for (let i = 0; i < 45; i += 1) {
    lines.push(JSON.stringify({ btwSessionId: `btw-${i}`, question: `q${i}`, answer: `a${i}`, askedAt: "2026-09-22T00:00:00Z" }));
  }
  lines.push("{torn");
  lines.push(JSON.stringify({ question: "", answer: "" }));
  const entries = readBtwHistory(lines.join("\n"));
  assert.equal(entries.length, 40);
  assert.equal(entries[0]?.id, "btw-5");
  assert.equal(entries.at(-1)?.answer, "a44");
});

test("the history file loads and clears, and a missing one is empty", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "btw-"));
  assert.deepEqual(loadBtwHistory(dir), []);
  writeFileSync(path.join(dir, "btw_history.jsonl"), `${JSON.stringify({ btwSessionId: "btw-9", question: "which file?", answer: "bridge.js" })}\n`);
  assert.deepEqual(loadBtwHistory(dir), [{ id: "btw-9", question: "which file?", answer: "bridge.js", askedAt: null }]);
  clearBtwHistory(dir);
  assert.equal(readFileSync(path.join(dir, "btw_history.jsonl"), "utf8"), "");
  assert.deepEqual(loadBtwHistory(dir), []);
  clearBtwHistory(dir);
});
