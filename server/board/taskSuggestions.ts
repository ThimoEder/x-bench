// suggestions.json: { "sessions": { "<session id>": [{ "id", "title", "summary", "prompt", "createdAt" }] } }

import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { isRecord, listOf } from "../../bridge/lenient.ts";
import { stripHidden } from "./boardText.ts";
import { fileStamp, loadDurable, saveDurable } from "../jsonFile.ts";
import { MCP_SERVER, toolText, type McpGroup } from "../mcp/mcp.ts";

export interface TaskSuggestion {
  id: string;
  title: string;
  summary: string;
  prompt: string;
  createdAt: string;
}

export const SUGGEST_TOOL = "suggest_task";

// Room for a board ticket: its description is the summary and the prompt, and SAK takes 8000 characters.
export const LIMITS = { title: 120, summary: 1000, prompt: 6000 } as const;

export const MAX_PER_SESSION = 20;

const Stored = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string().catch(""),
  prompt: z.string(),
  createdAt: z.string().catch(""),
});

const SuggestionsFile = z.object({ sessions: z.record(z.string(), listOf(Stored)).catch({}).default({}) });

type Sessions = Record<string, TaskSuggestion[]>;

function parse(value: unknown): Sessions | null {
  const parsed = SuggestionsFile.safeParse(value);
  return parsed.success ? parsed.data.sessions : null;
}

export interface TaskSuggestions {
  list(sessionId: string): TaskSuggestion[];
  add(sessionId: string, input: { title: string; summary: string; prompt: string }): TaskSuggestion;
  // False when the suggestion was not there.
  remove(sessionId: string, id: string): boolean;
  dropSession(sessionId: string): void;
  // True when another host changed the file since the last call.
  changedOnDisk(): boolean;
  onChange(listener: () => void): () => void;
}

export function createTaskSuggestions(file: string): TaskSuggestions {
  let cached: { stamp: string; value: Sessions } | null = null;
  let seenStamp = fileStamp(file);
  const listeners = new Set<() => void>();

  function read(): Sessions {
    const stamp = fileStamp(file);
    if (cached?.stamp !== stamp) cached = { stamp, value: loadDurable(file, parse, {}) };
    return cached.value;
  }

  function write(sessions: Sessions) {
    const saved = saveDurable(file, `${JSON.stringify({ sessions }, null, 2)}\n`, parse);
    cached = null;
    if (!saved) throw new Error(`${path.basename(file)} does not read. Fix or remove it to keep suggestions.`);
    seenStamp = fileStamp(file);
    for (const listener of listeners) listener();
  }

  return {
    list: (sessionId) => [...(read()[sessionId] ?? [])],
    add(sessionId, input) {
      const sessions = { ...read() };
      const current = sessions[sessionId] ?? [];
      if (current.length >= MAX_PER_SESSION) {
        throw new Error(`This chat already has ${MAX_PER_SESSION} suggestions waiting. Let the person go through them first.`);
      }
      const suggestion: TaskSuggestion = {
        id: randomBytes(6).toString("hex"),
        title: input.title,
        summary: input.summary,
        prompt: input.prompt,
        createdAt: new Date().toISOString(),
      };
      sessions[sessionId] = [...current, suggestion];
      write(sessions);
      return suggestion;
    },
    remove(sessionId, id) {
      const sessions = { ...read() };
      const current = sessions[sessionId] ?? [];
      const next = current.filter((item) => item.id !== id);
      if (next.length === current.length) return false;
      if (next.length) sessions[sessionId] = next;
      else delete sessions[sessionId];
      write(sessions);
      return true;
    },
    dropSession(sessionId) {
      const sessions = { ...read() };
      if (!sessions[sessionId]) return;
      delete sessions[sessionId];
      write(sessions);
    },
    changedOnDisk() {
      const stamp = fileStamp(file);
      if (stamp === seenStamp) return false;
      seenStamp = stamp;
      return true;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const SUGGEST_HINT = `When you notice work outside the current task that is worth doing (a bug, stale docs, missing test coverage, a confirmed TODO), suggest it with the ${SUGGEST_TOOL} tool of the ${MCP_SERVER} MCP server instead of doing it. The person sees it under the chat and decides whether to start it.`;

const SUGGEST_DESCRIPTION = [
  "Suggest a follow-up task that is outside what you were asked to do: a bug you noticed, stale docs, missing test coverage, a confirmed TODO.",
  "The person sees it as a card under this chat, and can start it in a new chat, file it as a board ticket, or dismiss it. Nothing starts by itself.",
  "Use it instead of widening the current change. Do not use it for the current task, for trivial fixes you can make now, or for vague hunches.",
  "The prompt must stand alone: a new chat starts with it and has none of this conversation, so name the files and what to change. Give file paths relative to the project root, since the task may run in another checkout of it.",
].join(" ");

const SUGGEST_TOOL_SPEC = {
  name: SUGGEST_TOOL,
  title: "Suggest a follow-up task",
  description: SUGGEST_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: `A short imperative phrase, under 60 characters (at most ${LIMITS.title}), e.g. "Fix the stale README badge".` },
      summary: { type: "string", description: "One or two plain sentences for the card: what you noticed and what the new chat would do." },
      prompt: { type: "string", description: "The whole brief for the new chat, with file paths relative to the project root and enough context to act without this conversation." },
    },
    required: ["title", "summary", "prompt"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

export function suggestTools(store: Pick<TaskSuggestions, "add">): McpGroup {
  return {
    instructions: SUGGEST_HINT,
    tools: [{ spec: SUGGEST_TOOL_SPEC, trusted: true, call: (args, { sessionId }) => suggest(args, sessionId, store) }],
  };
}

function suggest(args: unknown, sessionId: string | null, store: Pick<TaskSuggestions, "add">) {
  if (!sessionId) return toolText("This chat is still opening. Try again in a moment.", true);
  const input = isRecord(args) ? args : {};
  const title = oneLine(input.title);
  const summary = cleanText(input.summary);
  const prompt = cleanText(input.prompt);
  const missing = [!title && "title", !summary && "summary", !prompt && "prompt"].filter(Boolean);
  if (missing.length) return toolText(`Give ${missing.join(", ")}.`, true);
  const values = { title, summary, prompt };
  const long = Object.entries(LIMITS)
    .filter(([key, limit]) => values[key as keyof typeof values].length > limit)
    .map(([key, limit]) => `${key} (at most ${limit} characters)`);
  if (long.length) return toolText(`Too long: ${long.join(", ")}.`, true);
  try {
    const saved = store.add(sessionId, { title, summary, prompt });
    return toolText(`Suggested "${saved.title}". It shows under this chat until the person starts or dismisses it. Carry on with the current task.`, false);
  } catch (error) {
    return toolText(error instanceof Error ? error.message : String(error), true);
  }
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? stripHidden(value).trim() : "";
}

function oneLine(value: unknown): string {
  return cleanText(value).replace(/\s+/g, " ");
}
