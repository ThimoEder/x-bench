// Turns standard ACP notifications into reducer events, for every provider.
// Harness extensions (Grok's _x.ai/*) translate in their provider and plug in here.
//
// Schemas here are lenient. Unknown fields never fail a message, and a field with
// the wrong type reads as missing. A message that still fails is dropped. Schemas
// for data forwarded to the page are plain objects, so they keep only listed fields.

import type { InitializeRequest } from "@agentclientprotocol/sdk";
import { z } from "zod";
import { fields, isRecord, listOf, maybe } from "./lenient.ts";
import type { EventStamp, PermissionEvent, ReducerEvent, ToolEvent } from "./reducer.ts";
import type { RpcRequest } from "./rpc.ts";

export { isRecord };

const Envelope = z.looseObject({
  method: z.string().min(1),
  params: z.unknown().optional(),
  timestamp: z.unknown().optional(),
});

export const NotificationParams = fields({
  sessionId: maybe(z.string()),
  update: maybe(z.looseObject({ sessionUpdate: maybe(z.string()), sessionId: maybe(z.string()) })),
  _meta: maybe(z.looseObject({ agentTimestampMs: z.unknown().optional(), totalTokens: z.unknown().optional() })),
});

export type NotificationFields = z.output<typeof NotificationParams>;

// Grok puts a tool's label, name and kind in _meta. Other harnesses leave it out.
const ToolMeta = maybe(
  z.looseObject({
    "x.ai/tool": maybe(
      z.looseObject({ label: maybe(z.string()), name: maybe(z.string()), kind: maybe(z.string()) }),
    ),
  }),
);

const LocationInput = z.object({ path: maybe(z.string()), line: maybe(z.number().nullable()) });

const ToolUpdate = fields({
  toolCallId: maybe(z.string()),
  title: maybe(z.string()),
  kind: maybe(z.string()),
  // null is kept. It marks the status as explicit, like any other value.
  status: maybe(z.string().nullable()),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
  locations: maybe(listOf(LocationInput).nullable()),
  content: z.unknown().optional(),
  _meta: ToolMeta,
});

const UserChunkUpdate = fields({
  content: z.unknown().optional(),
  _meta: maybe(z.looseObject({ promptIndex: z.unknown().optional(), hideFromScrollback: z.unknown().optional() })),
});

const ChunkUpdate = fields({ content: z.unknown().optional(), messageId: maybe(z.string()) });

const PlanEntryInput = z.object({
  content: maybe(z.string()),
  priority: maybe(z.string()),
  status: maybe(z.string()),
});

// A written plan (Codex's proposed plan in plan mode), the whole markdown text each time it grows.
const PlanDocUpdate = fields({
  plan: maybe(fields({ type: maybe(z.string()), planId: maybe(z.string()), content: maybe(z.string()) })),
});

const PlanUpdate = fields({
  entries: maybe(listOf(PlanEntryInput)),
  plan: maybe(z.looseObject({ entries: maybe(listOf(PlanEntryInput)) })),
});

const ModeUpdate = fields({ currentModeId: maybe(z.string()), current_mode_id: maybe(z.string()) });

const CommandInput = z.object({ name: maybe(z.string()), description: maybe(z.string()) });
const CommandsUpdate = fields({ availableCommands: maybe(listOf(CommandInput)) });

const SessionInfoUpdate = fields({ title: maybe(z.string().nullable()) });

// used and size are tokens in the context window.
const ContextUpdate = fields({ used: maybe(z.number()), size: maybe(z.number()) });

const PermissionOptionInput = z.object({ optionId: z.string(), name: maybe(z.string()), kind: maybe(z.string()) });

const PermissionTool = z.looseObject({
  toolCallId: maybe(z.string()),
  title: maybe(z.string()),
  toolName: maybe(z.string()),
  kind: maybe(z.string()),
  rawInput: z.unknown().optional(),
  _meta: ToolMeta,
});

const PermissionParams = fields({
  sessionId: maybe(z.string()),
  toolCall: maybe(PermissionTool),
  options: maybe(listOf(PermissionOptionInput)),
});

export const ElicitationParams = fields({
  sessionId: maybe(z.string()),
  message: maybe(z.string()),
  mode: maybe(z.string()),
  requestedSchema: z.unknown().optional(),
});

// older is set by a provider, never read from the agent: the menu folds those choices away.
const ConfigChoiceInput = z.object({ value: z.string(), name: maybe(z.string()), older: maybe(z.boolean()) });

const ConfigOptionInput = z.object({
  id: z.string(),
  name: maybe(z.string()),
  currentValue: maybe(z.union([z.string(), z.number(), z.boolean()]).nullable()),
  options: maybe(listOf(ConfigChoiceInput)),
});

export const ConfigOptionList = listOf(ConfigOptionInput);

const ConfigUpdate = fields({ configOptions: maybe(ConfigOptionList) });

const ModeInput = z.object({ id: z.string(), name: maybe(z.string()) });

export const SessionResult = fields({
  sessionId: maybe(z.string()),
  configOptions: maybe(ConfigOptionList),
  models: maybe(z.looseObject({ currentModelId: maybe(z.string()) })),
  modes: maybe(z.looseObject({ currentModeId: maybe(z.string()), availableModes: maybe(listOf(ModeInput)) })),
});

export const SetConfigResult = z.union([
  ConfigOptionList,
  fields({ configOptions: maybe(ConfigOptionList) }),
]);

export const PromptResult = fields({ stopReason: maybe(z.string()) });

const ListedSession = z.object({
  sessionId: z.string(),
  cwd: maybe(z.string()),
  title: maybe(z.string().nullable()),
  updatedAt: maybe(z.string().nullable()),
});

export const SessionList = fields({ sessions: maybe(listOf(ListedSession)), nextCursor: maybe(z.string().nullable()) });

export type PlanEntry = z.output<typeof PlanEntryInput>;
export type ConfigOption = z.output<typeof ConfigOptionInput>;
export type PermissionOption = z.output<typeof PermissionOptionInput>;

export interface Image {
  mimeType: string;
  data: string;
}

export interface Diff {
  path: string;
  oldText: string;
  newText: string;
}

export type Location = z.output<typeof LocationInput>;

export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  modelCalls: number | null;
}

export interface QueueAttachment {
  name: string;
  kind: "image" | "file";
  mimeType: string;
  preview?: string;
}

export interface QueueEntry {
  id: string;
  version: number;
  text: string;
  position: number;
  // The picture or file sent with this follow-up. Grok's queue notice has the text only.
  attachments?: QueueAttachment[];
}

export interface Command {
  name: string | undefined;
  description: string;
}

export interface BackgroundTask {
  id: string;
  kind: string;
  status: string;
  label: string;
  // The tool call that started the task, when the harness names it: a subagent's Agent call.
  toolCallId?: string;
}

export interface CatalogEntry {
  sessionId: string | undefined;
  title: string | null;
  cwd: string | null;
  isWorktree: boolean;
  sessionKind: string | null;
  // When the harness last changed the session, if it says.
  updatedAt?: string | null;
}

export interface FuzzyMatch {
  name: string | undefined;
  path: string | undefined;
  type: string;
}

// Fields left out of an entry stay as the catalog had them.
export type CatalogEvent = EventStamp & { type: "catalog"; upserted: (Partial<CatalogEntry> & { sessionId?: string })[] };
export type ProtocolEvent = ReducerEvent | CatalogEvent;

export interface Translated {
  sessionId: string | null;
  event: ProtocolEvent;
}

export type Update = NotificationFields["update"] & {};

// A harness's own notifications: method, the raw params, the parsed common fields, and the session they name.
export type ExtensionTranslator = (
  method: string,
  raw: unknown,
  params: NotificationFields,
  sessionId: string | null,
) => Translated | null;

export function initializeParams(): InitializeRequest {
  return {
    protocolVersion: 1,
    clientInfo: { name: "x-bench", version: "0.0.0" },
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
  };
}

// Standard session/update notifications, plus whatever the harness's own translator knows.
export function eventFromNotification(message: unknown, extension?: ExtensionTranslator): Translated | null {
  const envelope = Envelope.safeParse(message);
  if (!envelope.success) return null;
  const params = NotificationParams.parse(envelope.data.params);
  const update = params.update;
  const sessionId = params.sessionId ?? update?.sessionId ?? null;
  const translated =
    envelope.data.method === "session/update" && update
      ? fromUpdate(sessionId, update)
      : (extension?.(envelope.data.method, envelope.data.params, params, sessionId) ?? null);
  if (!translated?.event) return translated;
  const at = eventTime(params, envelope.data.timestamp);
  if (typeof at === "number") translated.event.at = at;
  const used = params._meta?.totalTokens;
  if (typeof used === "number" && Number.isFinite(used) && used >= 0) translated.event.contextUsed = used;
  return translated;
}

export function permissionFromRequest(message: RpcRequest): PermissionEvent & { sessionId: string | null } {
  const params = PermissionParams.parse(message.params);
  const tool = params.toolCall ?? PermissionTool.parse({});
  const meta = tool._meta?.["x.ai/tool"];
  return {
    type: "permission",
    rpcId: message.id,
    sessionId: params.sessionId ?? null,
    toolCallId: tool.toolCallId ?? null,
    title: tool.title || meta?.label || "",
    name: meta?.name || tool.toolName || "",
    kind: tool.kind || meta?.kind || "",
    rawInput: tool.rawInput ?? null,
    options: (params.options ?? []).map((option) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind,
    })),
  };
}

// The standard session/update kinds.
export function fromUpdate(sessionId: string | null, update: Update): Translated | null {
  const kind = update.sessionUpdate;
  if (kind === "agent_message_chunk") return chunk(sessionId, "assistant", ChunkUpdate.parse(update));
  if (kind === "agent_thought_chunk") return chunk(sessionId, "thought", ChunkUpdate.parse(update));
  if (kind === "user_message_chunk") return userChunk(sessionId, update);
  if (kind === "tool_call" || kind === "tool_call_update") return { sessionId, event: toolEvent(update) };
  if (kind === "plan") {
    const plan = PlanUpdate.parse(update);
    return { sessionId, event: { type: "plan", entries: plan.entries ?? plan.plan?.entries ?? [] } };
  }
  if (kind === "plan_update") {
    const plan = PlanDocUpdate.parse(update).plan;
    if (plan?.type !== "markdown" || !plan.planId || typeof plan.content !== "string") return null;
    return { sessionId, event: { type: "plan-doc", id: plan.planId, text: plan.content } };
  }
  if (kind === "current_mode_update") {
    const mode = ModeUpdate.parse(update);
    return {
      sessionId,
      event: { type: "mode", modeId: mode.currentModeId ?? mode.current_mode_id ?? null },
    };
  }
  if (kind === "available_commands_update") {
    return {
      sessionId,
      event: {
        type: "commands",
        commands: (CommandsUpdate.parse(update).availableCommands ?? []).map(
          (command): Command => ({
            name: command.name,
            description: command.description ?? "",
          }),
        ),
      },
    };
  }
  if (kind === "config_option_update") {
    const options = ConfigUpdate.parse(update).configOptions;
    return options ? { sessionId, event: { type: "config", configOptions: options } } : null;
  }
  if (kind === "session_info_update") {
    const title = SessionInfoUpdate.parse(update).title;
    if (!sessionId || typeof title !== "string" || !title.trim()) return null;
    return { sessionId, event: { type: "catalog", upserted: [{ sessionId, title: title.trim() }] } };
  }
  if (kind === "usage_update") {
    const context = ContextUpdate.parse(update);
    if (context.used === undefined && context.size === undefined) return null;
    return { sessionId, event: { type: "context", used: context.used ?? null, size: context.size ?? null } };
  }
  return null;
}

function eventTime(params: NotificationFields, stamp: unknown) {
  const meta = params._meta?.agentTimestampMs;
  if (typeof meta === "number" && Number.isFinite(meta)) return meta;
  if (typeof stamp !== "number" || !Number.isFinite(stamp)) return null;
  return stamp > 1e12 ? stamp : stamp * 1000;
}

function chunk(sessionId: string | null, role: "assistant" | "thought", update: z.output<typeof ChunkUpdate>): Translated {
  const event: ReducerEvent & { type: "chunk" } = { type: "chunk", role, text: textOf(update.content) };
  if (update.messageId) event.messageId = update.messageId;
  return { sessionId, event };
}

function userChunk(sessionId: string | null, raw: Update): Translated {
  const update = UserChunkUpdate.parse(raw);
  const event: ReducerEvent & { type: "chunk" } = { type: "chunk", role: "user", text: textOf(update.content) };
  const images = imagesOf(update);
  if (images.length) event.images = images;
  const promptIndex = update._meta?.promptIndex;
  if (typeof promptIndex === "number" && Number.isInteger(promptIndex) && promptIndex >= 0) event.promptIndex = promptIndex;
  if (update._meta?.hideFromScrollback === true) event.hidden = true;
  return { sessionId, event };
}

function toolEvent(raw: Update): ToolEvent {
  const update = ToolUpdate.parse(raw);
  const meta = update._meta?.["x.ai/tool"];
  const event: ToolEvent = {
    type: "tool",
    toolCallId: update.toolCallId,
    title: update.title ?? meta?.label,
    name: meta?.name,
    kind: update.kind ?? meta?.kind,
    status: update.status,
    rawInput: update.rawInput,
    rawOutput: update.rawOutput ?? contentText(update.content),
    locations: update.locations,
  };
  if (Array.isArray(update.content)) event.diffs = diffsOf(update.content);
  const images = imagesOf(update);
  if (images.length) event.images = images;
  return event;
}

const RASTER = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);
const MAX_IMAGE_CHARS = 12_000_000;

export function imagesOf(update: unknown): Image[] {
  const found: Image[] = [];
  if (!isRecord(update)) return found;
  collectImages(update.content, found);
  const embedded = isRecord(update.rawOutput) ? update.rawOutput.ImageContent : undefined;
  if (embedded) pushImage(found, embedded);
  return found;
}

function collectImages(value: unknown, found: Image[], depth = 0) {
  if (!value || depth > 6) return;
  if (Array.isArray(value)) {
    for (const item of value) collectImages(item, found, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  if (value.type === "image") {
    pushImage(found, value);
    return;
  }
  if (value.content && value.content !== value) collectImages(value.content, found, depth + 1);
}

function pushImage(found: Image[], block: unknown) {
  if (!isRecord(block)) return;
  const data = block.data;
  if (typeof data !== "string" || data.length < 16 || data.length > MAX_IMAGE_CHARS) return;
  const mimeType = typeof block.mimeType === "string" && RASTER.has(block.mimeType) ? block.mimeType : sniffImage(data);
  if (!mimeType) return;
  if (found.some((image) => image.data === data)) return;
  found.push({ mimeType, data });
}

function sniffImage(data: string) {
  if (data.startsWith("iVBORw0KGgo")) return "image/png";
  if (data.startsWith("/9j/")) return "image/jpeg";
  if (data.startsWith("R0lGOD")) return "image/gif";
  if (data.startsWith("UklGR")) return "image/webp";
  return "";
}

const DiffBlock = z.object({
  type: z.literal("diff"),
  path: maybe(z.string()),
  oldText: maybe(z.string()),
  newText: maybe(z.string()),
});

const DiffBlocks = listOf(DiffBlock);

export function diffsOf(content: unknown): Diff[] {
  if (!Array.isArray(content)) return [];
  return DiffBlocks.parse(content).map((block) => ({
    path: block.path ?? "",
    oldText: block.oldText ?? "",
    newText: block.newText ?? "",
  }));
}

// The text blocks of a tool's content, for a harness that sends its output only there (Claude's MCP tools).
function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) => (isRecord(block) && block.type === "content" ? block.content : null))
    .filter((block) => isRecord(block) && block.type === "text")
    .map((block) => textOf(block))
    .join("\n");
  return text || undefined;
}

export function textOf(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((block) => textOf(block)).join("");
  if (isRecord(content) && typeof content.text === "string") return content.text;
  return "";
}
