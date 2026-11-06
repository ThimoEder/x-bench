import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isRecord } from "../lenient.ts";
import { forgetSessionUpdates, readSessionUpdates } from "./follow.ts";

// params.text of one logged message.
function textOf(message: unknown): unknown {
  return isRecord(message) && isRecord(message.params) ? message.params.text : undefined;
}

test("a session log is read once, then only the new lines", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "x-bench-follow-"));
  const id = "11111111-1111-1111-1111-111111111111";
  try {
    const dir = path.join(root, "group", id);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "updates.jsonl");
    writeFileSync(file, `${JSON.stringify({ method: "session/update", params: { sessionId: id, text: "one" } })}\n`);
    const first = readSessionUpdates(root, id);
    assert.equal(first.reset, true);
    assert.equal(first.messages.length, 1);
    assert.equal(textOf(first.messages[0]), "one");
    assert.deepEqual(readSessionUpdates(root, id).messages, []);
    appendFileSync(file, `${JSON.stringify({ method: "session/update", params: { sessionId: id, text: "two" } })}\n`);
    const next = readSessionUpdates(root, id);
    assert.equal(next.reset, false);
    assert.deepEqual(next.messages.map(textOf), ["two"]);
    forgetSessionUpdates(id);
    assert.equal(readSessionUpdates(root, id).reset, true);
  } finally {
    forgetSessionUpdates(id);
    rmSync(root, { recursive: true, force: true });
  }
});
