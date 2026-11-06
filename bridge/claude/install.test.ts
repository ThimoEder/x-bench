import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeConfigFolders } from "./install.ts";

test("config folders to pick from are the home folder's .claude folders, never a file", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-claude-install-"));
  try {
    fs.mkdirSync(path.join(folder, ".claude"));
    fs.mkdirSync(path.join(folder, ".claude-personal"));
    fs.mkdirSync(path.join(folder, ".claudette"));
    fs.writeFileSync(path.join(folder, ".claude.json"), "{}");
    assert.deepEqual(claudeConfigFolders(folder, {}), ["~/.claude", "~/.claude-personal"]);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
