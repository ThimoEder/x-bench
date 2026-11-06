// Codex's tool calls in neutral facts. codex-acp sends standard ACP kinds, with a few calls of its own
// under them: an MCP call has kind execute, and a web search has kind search like a file search.

import { isRecord } from "../lenient.ts";
import { acpFacts, facts, textOf, type ToolCall, type ToolFacts } from "../tools.ts";

export function codexFacts(tool: ToolCall): ToolFacts {
  const input = isRecord(tool.rawInput) ? tool.rawInput : {};
  // An MCP call's input names its server and tool, and holds its arguments.
  if (textOf(input.server) && textOf(input.tool)) return { role: "other", args: isRecord(input.arguments) ? input.arguments : {} };
  const standard = acpFacts(tool);
  // A live web search's input names its type. A replayed one's has only the query and the action.
  if (standard.role === "search" && (input.type === "webSearch" || "action" in input)) return facts({ role: "web", query: textOf(input.query) });
  // A command is a line or an argv list.
  const command = Array.isArray(input.command) ? input.command.join(" ") : textOf(input.command);
  return facts({
    ...standard,
    command: standard.role === "shell" ? command : undefined,
    query: standard.role === "search" ? textOf(input.query) : undefined,
  });
}
