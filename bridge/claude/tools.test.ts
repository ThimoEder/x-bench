import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCall } from "../tools.ts";
import { claudeFacts } from "./tools.ts";

const call = (name: string, kind: string, rawInput: unknown, locations: ToolCall["locations"] = null): ToolCall => ({ name, kind, title: name, rawInput, locations });

test("claude: each Claude Code tool reads as a neutral role with its path, command or query", () => {
  assert.deepEqual(claudeFacts(call("Bash", "execute", { command: "npm run dev", description: "Start the dev server", run_in_background: true })), {
    role: "shell",
    command: "npm run dev",
    label: "Start the dev server",
    background: true,
  });
  assert.deepEqual(claudeFacts(call("Monitor", "other", { command: "tail -f dev.log", description: "Watch the dev server", persistent: true })), {
    role: "shell",
    command: "tail -f dev.log",
    label: "Watch the dev server",
  });
  assert.deepEqual(claudeFacts(call("Read", "read", { file_path: "/repo/a.ts" }, [{ path: "/repo/a.ts", line: 1 }])), { role: "read", path: "/repo/a.ts" });
  assert.deepEqual(claudeFacts(call("Write", "edit", { file_path: "/repo/b.ts", content: "b" })), { role: "edit", path: "/repo/b.ts" });
  assert.deepEqual(claudeFacts(call("Edit", "edit", { file_path: "/repo/b.ts", old_string: "a", new_string: "b" })), { role: "edit", path: "/repo/b.ts" });
  assert.deepEqual(claudeFacts(call("Grep", "search", { pattern: "todo", path: "/repo" })), { role: "search", path: "/repo", query: "todo" });
  assert.deepEqual(claudeFacts(call("Glob", "search", { pattern: "**/*.ts" })), { role: "search", query: "**/*.ts" });
  assert.deepEqual(claudeFacts(call("WebSearch", "fetch", { query: "acp spec" })), { role: "web", query: "acp spec" });
  assert.deepEqual(claudeFacts(call("WebFetch", "fetch", { url: "https://example.com", prompt: "Sum it up" })), { role: "web" });
  assert.deepEqual(claudeFacts(call("TodoWrite", "think", { todos: [] })), { role: "other" });
  assert.deepEqual(claudeFacts(call("ToolSearch", "other", { query: "select:Read", path: "/repo" })), { role: "other" });
});

test("claude: a subagent is the Agent tool, or Task in older Claude Code", () => {
  assert.deepEqual(claudeFacts(call("Agent", "think", { description: "Port the AI", subagent_type: "general-purpose", prompt: "Port it", run_in_background: true })), {
    role: "subagent",
    label: "Port the AI",
    background: true,
    agent: "general-purpose",
  });
  assert.deepEqual(claudeFacts(call("Task", "think", { description: "Look around" })), { role: "subagent", label: "Look around" });
});

test("claude: an MCP tool's input is its own arguments", () => {
  assert.deepEqual(claudeFacts(call("mcp__x_bench__suggest_task", "other", { title: "Fix it", description: "A bug" })), {
    role: "other",
    args: { title: "Fix it", description: "A bug" },
  });
});

test("claude: a call with no tool name falls back to its standard kind", () => {
  assert.deepEqual(claudeFacts(call("", "execute", { command: "ls" })), { role: "shell", command: "ls" });
  assert.deepEqual(claudeFacts(call("", "read", {}, [{ path: "/repo/c.ts" }])), { role: "read", path: "/repo/c.ts" });
});
