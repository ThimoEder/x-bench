// What a tool call does, in the same words for every harness. Each provider reads its harness's
// tool calls into these.

import { isRecord } from "./lenient.ts";
import type { ToolItem } from "./reducer.ts";

export type ToolRole = "edit" | "shell" | "read" | "search" | "web" | "list" | "subagent" | "other";

export interface ToolFacts {
  role: ToolRole;
  // The file a call reads or edits, or the folder it lists or searches in.
  path?: string;
  command?: string;
  // What a search or a web search looks for.
  query?: string;
  // Words that name the call better than its title, such as a command's description.
  label?: string;
  // A command or a subagent that runs on after its call returns.
  background?: boolean;
  // The type of subagent.
  agent?: string;
  // An MCP tool's own arguments.
  args?: Record<string, unknown>;
}

export type ToolCall = Pick<ToolItem, "name" | "kind" | "title" | "rawInput" | "locations">;
export type ToolClassifier = (tool: ToolCall) => ToolFacts;

// task is the kind bridge/adapter.ts gives a subagent in a session of its own; ACP has none.
const ACP_ROLES: Record<string, ToolRole> = { read: "read", edit: "edit", search: "search", execute: "shell", fetch: "web", task: "subagent" };

// The standard ACP kinds, and the file a read or an edit names first in its locations.
export function acpFacts(tool: Pick<ToolCall, "kind" | "locations" | "rawInput">): ToolFacts {
  const role = ACP_ROLES[tool.kind] ?? "other";
  const input = isRecord(tool.rawInput) ? tool.rawInput : {};
  return facts({ role, path: role === "read" || role === "edit" ? tool.locations?.[0]?.path : undefined, agent: role === "subagent" ? textOf(input.subagent_type) : undefined });
}

export function facts(found: ToolFacts): ToolFacts {
  return Object.fromEntries(Object.entries(found).filter(([, value]) => value !== undefined && value !== "" && value !== false)) as unknown as ToolFacts;
}

export function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

// The working line while a tool runs.
export function toolPhase({ role }: ToolFacts) {
  return PHASES[role];
}

const PHASES: Record<ToolRole, string> = {
  subagent: "Waiting on subagent",
  read: "Reading",
  search: "Searching",
  web: "Browsing the web",
  edit: "Editing",
  shell: "Running command",
  list: "Listing",
  other: "Running tool",
};
