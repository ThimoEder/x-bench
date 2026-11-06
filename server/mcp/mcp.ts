// The host's MCP server, x_bench, which every session's harness calls over Streamable HTTP at
// /api/mcp/<key>: one JSON reply per POST, no MCP session. Each session/new and session/load gets a fresh
// key, so a call names its session without the session id. Tool groups (task suggestions, the browser)
// plug in their tools and a line for the system prompt.

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { fields, isRecord } from "../../bridge/lenient.ts";
import type { SessionToolGrant, SessionTools } from "../../bridge/provider.ts";
import { TOKEN_HEADER } from "../apiGuard.ts";

export const MCP_SERVER = "x_bench";

const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export interface ToolContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ToolResult {
  content: ToolContent[];
  isError: boolean;
}

export interface McpContext {
  // null while a new session's key is not bound yet.
  sessionId: string | null;
  // Aborted when the harness drops the request.
  signal: AbortSignal;
}

export interface McpTool {
  spec: { name: string; title?: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, boolean> };
  // Runs without the harness's own permission prompt.
  trusted?: boolean;
  call(args: unknown, context: McpContext): ToolResult | Promise<ToolResult>;
}

export interface McpGroup {
  // A line for the session's system prompt, since harnesses hide MCP tools until the agent searches for them.
  instructions: string;
  tools: McpTool[];
  // Drives a dock tab, which only builder chats show.
  builderOnly?: boolean;
}

export interface HostTools {
  sessionTools(origin: { port: number; token: string }): SessionTools;
  // The session an MCP key belongs to, or null for an unknown key and a new session not bound yet.
  sessionFor(key: string): string | null;
  knowsKey(key: string): boolean;
  toolsFor(key: string): McpTool[];
  forget(sessionId: string): void;
}

export interface HostToolOptions {
  // False for a folder whose chats show no review dock.
  builder?: (cwd: string) => boolean;
}

export function createHostTools(groups: McpGroup[], { builder = () => true }: HostToolOptions = {}): HostTools {
  // MCP key to its session (null until session/new answers) and the tools its grant offered.
  const keys = new Map<string, { owner: string | null; tools: McpTool[] }>();

  function forget(sessionId: string) {
    for (const [key, entry] of keys) if (entry.owner === sessionId) keys.delete(key);
  }

  // A session's newest key replaces its older ones, since the harness now calls the new one.
  function claim(key: string, owner: string | null, tools: McpTool[]) {
    if (owner !== null) forget(owner);
    keys.set(key, { owner, tools });
  }

  return {
    sessionTools({ port, token }) {
      return {
        grant(sessionId, cwd): SessionToolGrant {
          const shown = builder(cwd) ? groups : groups.filter((group) => !group.builderOnly);
          const tools = shown.flatMap((group) => group.tools);
          const key = randomBytes(18).toString("base64url");
          claim(key, sessionId, tools);
          return {
            servers: [
              {
                type: "http",
                name: MCP_SERVER,
                url: `http://127.0.0.1:${port}/api/mcp/${key}`,
                headers: [{ name: TOKEN_HEADER, value: token }],
              },
            ],
            trusted: tools.filter((tool) => tool.trusted).map((tool) => ({ server: MCP_SERVER, tool: tool.spec.name })),
            instructions: shown.map((group) => group.instructions).filter(Boolean).join("\n\n"),
            bind: (id) => claim(key, id, tools),
          };
        },
      };
    },
    sessionFor: (key) => keys.get(key)?.owner ?? null,
    knowsKey: (key) => keys.has(key),
    toolsFor: (key) => keys.get(key)?.tools ?? [],
    forget,
  };
}

const Message = fields({
  jsonrpc: z.unknown().optional(),
  id: z.union([z.string(), z.number()]).nullable().optional(),
  method: z.unknown().optional(),
  params: z.unknown().optional(),
});

const CallParams = fields({ name: z.unknown().optional(), arguments: z.unknown().optional() });

export type JsonRpcReply = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

// One JSON-RPC message from the harness. null for a notification or a response, which get no reply.
export async function answerMcp(message: unknown, tools: McpTool[], context: McpContext): Promise<JsonRpcReply | null> {
  if (!isRecord(message)) return rpcError(null, -32600, "Invalid request");
  const parsed = Message.parse(message);
  if (typeof parsed.method !== "string" || parsed.id === undefined) return null;
  const id = parsed.id;
  const params = isRecord(parsed.params) ? parsed.params : {};
  switch (parsed.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "x-bench", title: "X Bench", version: "1" },
          instructions: "Tools from X Bench, the app the person runs this chat in.",
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: tools.map((tool) => tool.spec) } };
    case "tools/call": {
      const call = CallParams.parse(params);
      const tool = tools.find((item) => item.spec.name === call.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(call.name)}`);
      try {
        return { jsonrpc: "2.0", id, result: await tool.call(call.arguments, context) };
      } catch (error) {
        return { jsonrpc: "2.0", id, result: toolText(error instanceof Error ? error.message : String(error), true) };
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${parsed.method}`);
  }
}

export function toolText(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

export function clean(value: unknown, limit = 200): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

export function capText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… (cut at ${limit} characters)` : text;
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

export function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > 200 ? `"${flat.slice(0, 200)}…"` : `"${flat}"`;
}

// The text after the last line of a tool's output that starts with mark, for the cards the transcript draws.
// The mark is a line of its own, after text such as a page title that the tool does not choose.
export function markLine(output: unknown, mark: string, depth = 0): string {
  if (depth > 6 || output == null) return "";
  if (typeof output === "string") {
    const lines = output.split("\n").filter((line) => line.startsWith(mark));
    return (lines.at(-1)?.slice(mark.length) ?? "").trim();
  }
  const children = Array.isArray(output) ? output : isRecord(output) ? Object.values(output) : [];
  for (const child of children) {
    const found = markLine(child, mark, depth + 1);
    if (found) return found;
  }
  return "";
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcReply {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
