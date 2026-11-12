// Checks the adapter patch in patches/, which keeps the worktree folders of a tool result, and the provider that follows them.
import assert from "node:assert/strict";
import test from "node:test";
import { toolResponseMarkers } from "@agentclientprotocol/claude-agent-acp/dist/tool-calls/content.js";
import { emptySession } from "../reducer.ts";
import { ClaudeProvider } from "./provider.ts";

const WORKTREE = "/repo/.claude/worktrees/topic";

function chat() {
  const provider = new ClaudeProvider({ command: "unused" });
  provider.sessionMap.set("s1", emptySession({ id: "s1", cwd: "/repo" }));
  const update = (fields: Record<string, unknown>) =>
    Reflect.apply(Reflect.get(provider, "onNotification"), provider, [{ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: fields } }]);
  // The adapter names the tool when the call starts, and sends the result's fields alone after it ran.
  const run = (toolCallId: string, toolName: string, toolResponse: unknown, parentToolUseId?: string) => {
    update({ sessionUpdate: "tool_call", toolCallId, title: toolName, _meta: { claudeCode: { toolName, ...(parentToolUseId ? { parentToolUseId } : {}) } } });
    update({ sessionUpdate: "tool_call_update", toolCallId, _meta: { claudeCode: { toolResponse: toolResponseMarkers(toolResponse) } } });
    return provider.sessionMap.get("s1")?.cwd;
  };
  return { provider, run };
}

test("claude: a chat follows EnterWorktree into the worktree and ExitWorktree back out", async () => {
  const { provider, run } = chat();
  try {
    assert.equal(run("t1", "EnterWorktree", { worktreePath: WORKTREE, worktreeBranch: "worktree-topic", message: "Created worktree" }), WORKTREE);
    assert.equal(run("t2", "ExitWorktree", { action: "keep", originalCwd: "/repo", worktreePath: WORKTREE, message: "Exited worktree" }), "/repo");
  } finally {
    await provider.stop();
  }
});

test("claude: a subagent's worktree leaves the chat in its folder", async () => {
  const { provider, run } = chat();
  try {
    assert.equal(run("t1", "Agent", { status: "completed", worktreePath: WORKTREE }), "/repo");
    assert.equal(run("t2", "EnterWorktree", { worktreePath: WORKTREE, message: "Created worktree" }, "t1"), "/repo");
  } finally {
    await provider.stop();
  }
});
