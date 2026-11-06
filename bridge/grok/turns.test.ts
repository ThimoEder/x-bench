import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openTurnIds } from "./turns.ts";

test("an open turn is working and a finished turn is not", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "x-bench-turns-"));
  try {
    writeTurn(root, "live", '{"type":"turn_started"}\n{"type":"phase_changed"}\n');
    writeTurn(root, "done", '{"type":"turn_started"}\n{"type":"turn_ended","outcome":"completed"}\n');
    writeTurn(root, "quiet", '{"type":"phase_changed"}\n');
    assert.deepEqual(openTurnIds(root, ["live", "done", "quiet", "missing"]).sort(), ["live"]);
    appendFileSync(path.join(root, "group", "live", "events.jsonl"), '{"type":"tool_completed"}\n');
    assert.deepEqual(openTurnIds(root, ["live"]), ["live"]);
    appendFileSync(path.join(root, "group", "live", "events.jsonl"), '{"type":"turn_ended","outcome":"completed"}\n');
    assert.deepEqual(openTurnIds(root, ["live"]), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dead owner does not keep the loading mark", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "x-bench-turns-"));
  try {
    writeTurn(root, "live", '{"type":"turn_started"}\n');
    assert.deepEqual(openTurnIds(root, []), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeTurn(root: string, id: string, text: string) {
  const dir = path.join(root, "group", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "events.jsonl"), text);
}
