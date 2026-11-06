// Checks the adapter patch in patches/: session/delete removes the transcript, although this app is an AIR client.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionIndexConnection } from "@agentclientprotocol/claude-agent-acp/dist/session-index/connection.js";

test("claude: deleting a session removes its transcript", async () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), "x-bench-claude-config-"));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    const sessionId = randomUUID();
    const folder = path.join(configDir, "projects", "-tmp-project");
    mkdirSync(folder, { recursive: true });
    const transcript = path.join(folder, `${sessionId}.jsonl`);
    const line = { type: "user", sessionId, cwd: "/tmp/project", uuid: randomUUID(), message: { role: "user", content: "hello" } };
    writeFileSync(transcript, `${JSON.stringify(line)}\n`);
    const connection = new SessionIndexConnection({ agent: { sessions: {} }, isAirClient: () => true } as never);
    await connection.deleteSession({ sessionId });
    assert.equal(existsSync(transcript), false);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(configDir, { recursive: true, force: true });
  }
});
