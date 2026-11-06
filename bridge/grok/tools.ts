// Grok's tool calls in neutral facts. The name is the one Grok puts in _meta["x.ai/tool"]. The input's
// variant (ReadFile, WebSearch) comes only with the call's updates, so a name decides where there is one.

import { isRecord } from "../lenient.ts";
import { acpFacts, facts, textOf, type ToolCall, type ToolFacts, type ToolRole } from "../tools.ts";

const ROLES: Record<string, ToolRole> = {
  run_terminal_command: "shell",
  monitor: "shell",
  read_file: "read",
  search_replace: "edit",
  write: "edit",
  grep: "search",
  list_dir: "list",
  web_fetch: "web",
  spawn_subagent: "subagent",
};

// Grok's web searches have no name, and their input carries no query.
const WEB_SEARCHES: Record<string, string> = { WebSearch: "Web search", XSearch: "X search" };

export function grokFacts(tool: ToolCall): ToolFacts {
  const input = isRecord(tool.rawInput) ? tool.rawInput : {};
  // An MCP tool: use_tool names it in tool_name and passes its arguments in tool_input.
  if (tool.name === "use_tool") {
    const args = isRecord(input.tool_input) ? input.tool_input : {};
    return facts({ role: "other", label: prettyName(textOf(input.tool_name)), args });
  }
  const search = typeof input.variant === "string" ? WEB_SEARCHES[input.variant] : undefined;
  if (search) return { role: "web", label: search };
  const role = ROLES[tool.name] ?? acpFacts(tool).role;
  const runs = role === "shell" || role === "subagent";
  return facts({
    role,
    path: textOf(input.target_file) ?? textOf(input.file_path) ?? textOf(input.target_directory) ?? textOf(input.path),
    command: role === "shell" ? textOf(input.command) : undefined,
    query: role === "search" ? textOf(input.pattern) : undefined,
    label: runs ? textOf(input.description) : undefined,
    background: runs && (input.is_background === true || input.background === true || input.run_in_background === true),
    agent: role === "subagent" ? textOf(input.subagent_type) : undefined,
  });
}

// x_bench__suggest_task reads "X Bench Suggest Task".
function prettyName(name: string | undefined) {
  return name
    ?.replace(/__/g, " ")
    .replace(/_/g, " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}
