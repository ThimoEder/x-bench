import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { signInCommand } from "./provider.ts";

test("the sign-in command quotes the config folder for a shell and keeps ~/ expanding", () => {
  assert.equal(signInCommand(""), "claude");
  assert.equal(signInCommand(os.homedir()), "CLAUDE_CONFIG_DIR=~ claude");
  assert.equal(signInCommand(path.join(os.homedir(), ".claude-work")), "CLAUDE_CONFIG_DIR=~/.claude-work claude");
  assert.equal(signInCommand(path.join(os.homedir(), "Claude Account")), "CLAUDE_CONFIG_DIR=~/'Claude Account' claude");
  assert.equal(signInCommand("/tmp/it's here"), "CLAUDE_CONFIG_DIR='/tmp/it'\\''s here' claude");
});
