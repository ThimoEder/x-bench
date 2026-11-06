import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeSettings } from "./claudeSettings.ts";

function scratch() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-claude-settings-"));
  return { folder, file: path.join(folder, "claude.json"), done: () => fs.rmSync(folder, { recursive: true, force: true }) };
}

test("claude.json names the folder and program with ~, and the provider gets them expanded", () => {
  const { file, done } = scratch();
  try {
    fs.writeFileSync(file, JSON.stringify({ configDir: "~/.claude-personal", executable: "~/.local/bin/claude" }));
    assert.deepEqual(createClaudeSettings(file).read({}), {
      configDir: path.join(os.homedir(), ".claude-personal"),
      executable: path.join(os.homedir(), ".local", "bin", "claude"),
    });
  } finally {
    done();
  }
});

test("without an installed claude, Claude reports that Claude Code is not installed", (t) => {
  const { folder, file, done } = scratch();
  const home = process.env.HOME;
  process.env.HOME = folder;
  t.after(() => {
    process.env.HOME = home;
    done();
  });
  if (["/opt/homebrew/bin/claude", "/usr/local/bin/claude"].some((program) => fs.existsSync(program))) {
    t.skip("claude is installed in a shared folder on this Mac");
    return;
  }
  assert.deepEqual(createClaudeSettings(file).read({ PATH: "" }), { problem: "Claude Code is not installed. Install claude to use Claude models." });
});

test("a claude.json that does not read stops Claude instead of falling back to the default folder", () => {
  const { file, done } = scratch();
  try {
    fs.writeFileSync(file, "{ not json");
    const settings = createClaudeSettings(file).read({});
    assert.equal(settings.configDir, undefined);
    assert.match(settings.problem ?? "", /does not read/);
    // Nothing is written over it.
    assert.equal(createClaudeSettings(file).save({ configDir: "~/.claude" }), false);
    assert.equal(fs.readFileSync(file, "utf8"), "{ not json");
  } finally {
    done();
  }
});

test("saving keeps the fields this app does not know, and drops an empty program", () => {
  const { file, done } = scratch();
  try {
    fs.writeFileSync(file, JSON.stringify({ configDir: "~/.claude-personal", executable: "~/.local/bin/claude", note: "mine" }));
    const settings = createClaudeSettings(file);
    assert.equal(settings.save({ configDir: "~/.claude-work", executable: "" }), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { configDir: "~/.claude-work", note: "mine" });
    assert.deepEqual(settings.readFile(), { configDir: "~/.claude-work" });
  } finally {
    done();
  }
});
