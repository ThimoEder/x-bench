import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCall } from "../tools.ts";
import { codexFacts } from "./tools.ts";

const call = (kind: string, title: string, rawInput: unknown, locations: ToolCall["locations"] = null): ToolCall => ({ name: "", kind, title, rawInput, locations });

test("chatgpt: Codex's commands, reads, searches and edits read as neutral roles", () => {
  assert.deepEqual(codexFacts(call("execute", "npm test", { command: "npm test", cwd: "/repo" })), { role: "shell", command: "npm test" });
  assert.deepEqual(codexFacts(call("execute", "ls", { command: ["bash", "-lc", "ls"] })), { role: "shell", command: "bash -lc ls" });
  assert.deepEqual(codexFacts(call("read", "Read file 'a.ts'", null, [{ path: "/repo/a.ts" }])), { role: "read", path: "/repo/a.ts" });
  assert.deepEqual(codexFacts(call("search", "Search for 'todo' in src", null)), { role: "search" });
  assert.deepEqual(codexFacts(call("search", "Search for 'app'", { query: "app" })), { role: "search", query: "app" });
  assert.deepEqual(codexFacts(call("edit", "Edit files", null, [{ path: "/repo/b.ts" }])), { role: "edit", path: "/repo/b.ts" });
  assert.deepEqual(codexFacts(call("other", "spawnAgent", { prompt: "Look around" })), { role: "other" });
});

test("chatgpt: a web search is a search whose input names it, live or replayed", () => {
  assert.deepEqual(codexFacts(call("search", "Web search: acp", { type: "webSearch", id: "ws-1", query: "acp", action: null })), { role: "web", query: "acp" });
  assert.deepEqual(codexFacts(call("search", "Web search: acp", { query: "acp", action: { type: "search" } })), { role: "web", query: "acp" });
});

test("chatgpt: an MCP call has kind execute, and carries the tool's own arguments", () => {
  assert.deepEqual(codexFacts(call("execute", "mcp.x_bench.browser_read_page", { server: "x_bench", tool: "browser_read_page", arguments: { mode: "text" } })), {
    role: "other",
    args: { mode: "text" },
  });
});
