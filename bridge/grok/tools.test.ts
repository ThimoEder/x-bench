import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCall } from "../tools.ts";
import { grokFacts } from "./tools.ts";

const call = (name: string, kind: string, rawInput: unknown): ToolCall => ({ name, kind, title: name, rawInput, locations: null });

test("grok: each of its tools reads as a neutral role with its path, command or query", () => {
  assert.deepEqual(grokFacts(call("run_terminal_command", "execute", { command: "npm run dev", description: "Start the dev server", is_background: true, variant: "Bash" })), {
    role: "shell",
    command: "npm run dev",
    label: "Start the dev server",
    background: true,
  });
  assert.deepEqual(grokFacts(call("run_terminal_command", "execute", { command: "ls", description: "List", background: false })), { role: "shell", command: "ls", label: "List" });
  assert.deepEqual(grokFacts(call("read_file", "read", { target_file: "/repo/a.ts", limit: 20 })), { role: "read", path: "/repo/a.ts" });
  assert.deepEqual(grokFacts(call("search_replace", "edit", { file_path: "/repo/a.ts", old_string: "a", new_string: "b" })), { role: "edit", path: "/repo/a.ts" });
  assert.deepEqual(grokFacts(call("write", "write", { file_path: "/repo/b.ts", content: "b", variant: "Write" })), { role: "edit", path: "/repo/b.ts" });
  assert.deepEqual(grokFacts(call("grep", "search", { pattern: "todo", path: "/repo", glob: "*.ts" })), { role: "search", path: "/repo", query: "todo" });
  assert.deepEqual(grokFacts(call("list_dir", "list", { target_directory: "/repo/src" })), { role: "list", path: "/repo/src" });
  assert.deepEqual(grokFacts(call("web_fetch", "web_fetch", { url: "https://example.com" })), { role: "web" });
  assert.deepEqual(grokFacts(call("todo_write", "plan", { todos: [] })), { role: "other" });
});

test("grok: a web search has no name, and its variant names it", () => {
  assert.deepEqual(grokFacts(call("", "search", { variant: "WebSearch", backend: true })), { role: "web", label: "Web search" });
  assert.deepEqual(grokFacts(call("", "search", { variant: "XSearch", backend: true })), { role: "web", label: "X search" });
});

test("grok: a subagent carries its description, its type and whether it runs in the background", () => {
  assert.deepEqual(grokFacts(call("spawn_subagent", "task", { description: "pr #13", prompt: "Review", background: true, subagent_type: "reviewer" })), {
    role: "subagent",
    label: "pr #13",
    background: true,
    agent: "reviewer",
  });
  assert.deepEqual(grokFacts(call("spawn_subagent", "task", { description: "pr #13", run_in_background: false, variant: "Task" })), { role: "subagent", label: "pr #13" });
});

test("grok: an MCP call through use_tool carries the tool's own arguments", () => {
  assert.deepEqual(grokFacts(call("use_tool", "use_tool", { tool_name: "x_bench__browser_navigate", tool_input: { url: "example.com" } })), {
    role: "other",
    label: "X Bench Browser Navigate",
    args: { url: "example.com" },
  });
});
