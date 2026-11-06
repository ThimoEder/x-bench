// Grok's own notifications and results (_x.ai/*), on top of the standard ACP translation
// in ../protocol.ts. Only the Grok provider and the readers of Grok's update logs use this.

import { z } from "zod";
import { fields, isRecord, listOf, maybe } from "../lenient.ts";
import {
  eventFromNotification,
  fromUpdate,
  type BackgroundTask,
  type CatalogEntry,
  type QueueEntry,
  type Translated,
  type Update,
  type Usage,
} from "../protocol.ts";

const PromptCompleteParams = fields({ stopReason: maybe(z.string()) });

const QueueEntryInput = z.object({
  id: z.unknown().optional(),
  version: maybe(z.number()),
  text: z.unknown().optional(),
  position: maybe(z.number()),
});

// Queue ids are compared as strings, like the entry ids.
const QueueParams = fields({
  entries: maybe(listOf(QueueEntryInput)),
  runningPromptId: maybe(z.union([z.string(), z.number()]).transform(String)),
  runningText: z.unknown().optional(),
});

const InterjectionParams = fields({ text: z.unknown().optional() });
const ModelsParams = fields({ currentModelId: maybe(z.string()) });

const CatalogInput = z.object({
  sessionId: maybe(z.string()),
  title: maybe(z.string()),
  cwd: maybe(z.string()),
  isWorktree: z.unknown().optional(),
  sessionKind: maybe(z.string()),
  session_kind: maybe(z.string()),
});

const SessionsChangedParams = fields({ upserted: maybe(listOf(CatalogInput)) });

const TurnCompletedUpdate = fields({
  stop_reason: maybe(z.string()),
  stopReason: maybe(z.string()),
  usage: z.unknown().optional(),
});

const InteractionResolvedUpdate = fields({ tool_call_id: maybe(z.string()), toolCallId: maybe(z.string()) });

const ModelChangedUpdate = fields({
  model_id: maybe(z.string()),
  // undefined keeps the current effort. null clears it.
  reasoning_effort: maybe(z.string().nullable()),
});

const RetryUpdate = fields({
  type: z.unknown().optional(),
  reason: maybe(z.string()),
  attempt: maybe(z.number()),
  max_retries: maybe(z.number()),
  maxRetries: maybe(z.number()),
});

const BackgroundTaskInput = z.object({
  task_id: z.unknown().optional(),
  taskId: z.unknown().optional(),
  kind: z.unknown().optional(),
  status: z.unknown().optional(),
  description: z.unknown().optional(),
  display_command: z.unknown().optional(),
  displayCommand: z.unknown().optional(),
  command: z.unknown().optional(),
});

const BackgroundTasksUpdate = fields({ tasks: maybe(listOf(BackgroundTaskInput)) });

const UsageInput = z.looseObject({
  inputTokens: maybe(z.number()),
  input_tokens: maybe(z.number()),
  outputTokens: maybe(z.number()),
  output_tokens: maybe(z.number()),
  totalTokens: maybe(z.number()),
  total_tokens: maybe(z.number()),
  modelCalls: maybe(z.number()),
});

export const ExitPlanParams = fields({
  sessionId: maybe(z.string()),
  toolCallId: maybe(z.string()),
  planContent: z.unknown().optional(),
});

export const SettingsParams = fields({ prompt_suggestions_enabled: z.unknown().optional() });

// RPC results. Grok answers some methods with { result: body }.
export function rpcBody(result: unknown): unknown {
  return isRecord(result) ? (result.result ?? result) : result;
}

export const SuggestResult = fields({
  suggestion: z.unknown().optional(),
  result: maybe(z.looseObject({ suggestion: z.unknown().optional() })),
});

// Standard ACP plus Grok's _x.ai/* notifications. Also reads the lines of Grok's update logs.
export function grokEventFromNotification(message: unknown): Translated | null {
  return eventFromNotification(message, fromGrok);
}

function fromGrok(method: string, raw: unknown, params: { update?: Update }, sessionId: string | null): Translated | null {
  const update = params.update;
  if ((method === "_x.ai/session/update" || method === "_x.ai/session_notification") && update) {
    return fromUpdate(sessionId, update) ?? fromExtension(sessionId, update);
  }

  switch (method) {
    case "_x.ai/session/prompt_complete":
      return { sessionId, event: { type: "turn-finished", stopReason: PromptCompleteParams.parse(raw).stopReason ?? null } };
    case "_x.ai/queue/changed": {
      const queue = QueueParams.parse(raw);
      return {
        sessionId,
        event: {
          type: "queue",
          entries: (queue.entries ?? []).map(
            (entry): QueueEntry => ({
              id: String(entry.id),
              version: entry.version ?? 0,
              text: String(entry.text ?? ""),
              position: entry.position ?? 0,
            }),
          ),
          runningPromptId: queue.runningPromptId ?? null,
          runningText: typeof queue.runningText === "string" ? queue.runningText : null,
        },
      };
    }
    case "_x.ai/session/interjection":
      return { sessionId, event: { type: "user", text: String(InterjectionParams.parse(raw).text ?? "") } };
    case "_x.ai/models/update":
      return { sessionId, event: { type: "model", modelId: ModelsParams.parse(raw).currentModelId ?? null } };
    case "_x.ai/sessions/changed":
      return {
        sessionId: null,
        event: {
          type: "catalog",
          upserted: (SessionsChangedParams.parse(raw).upserted ?? []).map(
            (session): CatalogEntry => ({
              sessionId: session.sessionId,
              title: session.title ?? null,
              cwd: session.cwd ?? null,
              isWorktree: Boolean(session.isWorktree),
              sessionKind: session.sessionKind || session.session_kind || null,
            }),
          ),
        },
      };
    default:
      return null;
  }
}

function fromExtension(sessionId: string | null, update: Update): Translated | null {
  if (update.sessionUpdate === "turn_completed") {
    const turn = TurnCompletedUpdate.parse(update);
    return {
      sessionId,
      event: {
        type: "turn-finished",
        stopReason: turn.stop_reason ?? turn.stopReason ?? null,
        usage: compactUsage(turn.usage),
      },
    };
  }
  if (update.sessionUpdate === "interaction_resolved") {
    const resolved = InteractionResolvedUpdate.parse(update);
    return {
      sessionId,
      event: { type: "permission-resolved", toolCallId: resolved.tool_call_id ?? resolved.toolCallId ?? null },
    };
  }
  if (update.sessionUpdate === "model_changed") {
    const model = ModelChangedUpdate.parse(update);
    return {
      sessionId,
      event: {
        type: "model",
        modelId: model.model_id ?? null,
        reasoningEffort: model.reasoning_effort,
      },
    };
  }
  if (update.sessionUpdate === "retry_state") {
    const retry = RetryUpdate.parse(update);
    return {
      sessionId,
      event: {
        type: "retry",
        active: retry.type !== "cleared" && retry.type !== "idle" && retry.type !== "exhausted",
        attempt: retry.attempt ?? null,
        max: retry.max_retries ?? retry.maxRetries ?? null,
        // Grok gave up, such as on a rate limit: the reason is why the turn ends.
        ...(retry.type === "exhausted" && retry.reason ? { error: retry.reason } : {}),
      },
    };
  }
  if (update.sessionUpdate === "background_tasks") {
    return {
      sessionId,
      event: {
        type: "background-tasks",
        tasks: (BackgroundTasksUpdate.parse(update).tasks ?? []).map(backgroundTask),
      },
    };
  }
  return null;
}

type BackgroundTaskFields = z.output<typeof BackgroundTaskInput>;

function backgroundTask(task: BackgroundTaskFields): BackgroundTask {
  return {
    id: String(task.task_id ?? task.taskId ?? ""),
    kind: String(task.kind || ""),
    status: String(task.status || ""),
    label: backgroundLabel(task),
  };
}

function backgroundLabel(task: BackgroundTaskFields) {
  const description = clipTask(task.description);
  if (description) return description;
  const display = clipTask(task.display_command ?? task.displayCommand);
  if (display) return display;
  return clipTask(task.command) || "Background task";
}

function clipTask(text: unknown, max = 88) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

export function compactUsage(usage: unknown): Usage | null {
  if (!usage || typeof usage !== "object") return null;
  const parsed = UsageInput.safeParse(usage);
  if (!parsed.success) return null;
  const value = parsed.data;
  return {
    inputTokens: value.inputTokens ?? value.input_tokens ?? null,
    outputTokens: value.outputTokens ?? value.output_tokens ?? null,
    totalTokens: value.totalTokens ?? value.total_tokens ?? null,
    modelCalls: value.modelCalls ?? null,
  };
}
