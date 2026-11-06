// Claude Code's tool calls in neutral facts. The name is Claude Code's own (Bash, Read, Agent), which
// the adapter sends in _meta, and the input is the tool's input as Claude wrote it.

import { isRecord } from "../lenient.ts";
import { acpFacts, facts, textOf, type ToolCall, type ToolFacts, type ToolRole } from "../tools.ts";

const ROLES: Record<string, ToolRole> = {
  Bash: "shell",
  Monitor: "shell",
  Read: "read",
  Write: "edit",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Grep: "search",
  Glob: "search",
  WebSearch: "web",
  WebFetch: "web",
  // Agent is Claude Code 2's subagent tool, Task the older name for it.
  Agent: "subagent",
  Task: "subagent",
};

export function claudeFacts(tool: ToolCall): ToolFacts {
  const input = isRecord(tool.rawInput) ? tool.rawInput : {};
  // Claude Code names an MCP tool mcp__<server>__<tool>, and its input is the tool's own arguments.
  if (tool.name.startsWith("mcp__")) return { role: "other", args: input };
  const role = ROLES[tool.name] ?? acpFacts(tool).role;
  const runs = role === "shell" || role === "subagent";
  const files = role === "read" || role === "edit" || role === "search";
  return facts({
    role,
    path: files ? (textOf(input.file_path) ?? textOf(input.notebook_path) ?? textOf(input.path) ?? acpFacts(tool).path) : undefined,
    command: role === "shell" ? textOf(input.command) : undefined,
    query: role === "search" || role === "web" ? (textOf(input.pattern) ?? textOf(input.query)) : undefined,
    label: runs ? textOf(input.description) : undefined,
    background: runs && input.run_in_background === true,
    agent: role === "subagent" ? textOf(input.subagent_type) : undefined,
  });
}
