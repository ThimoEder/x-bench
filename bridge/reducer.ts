// Session state the UI renders. Events come from bridge/protocol.ts.

import type {
  BackgroundTask,
  Command,
  ConfigOption,
  Diff,
  Image,
  Location,
  PermissionOption,
  PlanEntry,
  QueueEntry,
  Usage,
} from "./protocol.ts";
import type { FormField, QuestionAction } from "./elicitation.ts";
import type { RpcId } from "./rpc.ts";
import { acpFacts, toolPhase, type ToolClassifier, type ToolFacts } from "./tools.ts";

export interface DisplayAttachment {
  name: string;
  kind: "image" | "file";
  mimeType: string;
  preview?: string;
}

interface TextItemFields {
  id: string;
  text: string;
  streaming: boolean;
  hidden?: boolean;
  startedAt?: number;
  finishedAt?: number;
  attachments?: DisplayAttachment[];
  // The harness's id for the message this text came in (Claude's). A new id starts a new reply.
  messageId?: string;
}

export interface UserItem extends TextItemFields {
  type: "user";
  promptIndex?: number;
  images?: Image[];
  // A message steered into the running turn, while the harness reports when it takes it in.
  delivery?: Delivery;
}

// unread: Claude Code dropped the message, or the turn ended while it waited.
export interface Delivery {
  id: string;
  state: "waiting" | "read" | "unread";
}

export interface AssistantItem extends TextItemFields {
  type: "assistant";
}

export interface ThoughtItem extends TextItemFields {
  type: "thought";
}

export interface ToolItem {
  id: string;
  type: "tool";
  toolCallId: string;
  // The tool call of the subagent this call ran in, when a subagent made it.
  parentId?: string;
  title: string;
  name: string;
  kind: string;
  status: string | null;
  rawInput: unknown;
  rawOutput: unknown;
  // What the call does. The provider's classifier reads it again from the fields above on every update.
  facts: ToolFacts;
  diffs: Diff[];
  locations: Location[] | null;
  images?: Image[];
  statusExplicit?: boolean;
  startedAt?: number;
  finishedAt?: number;
  // Tools never stream text. These keep reads over the whole transcript simple.
  text?: undefined;
  streaming?: false;
}

export type TextItem = UserItem | AssistantItem | ThoughtItem;
export type TranscriptItem = TextItem | ToolItem;

export interface PendingPermission {
  rpcId: RpcId;
  toolCallId: string | null;
  title: string;
  name: string;
  kind: string;
  rawInput: unknown;
  facts: ToolFacts;
  options: PermissionOption[];
}

export interface PendingPlan {
  rpcId: RpcId;
  toolCallId: string | null;
  plan: string;
}

export interface PendingElicitation {
  rpcId: RpcId;
  message: string;
  fields: FormField[];
  actions: QuestionAction[];
}

export interface RetryState {
  attempt: number | null;
  max: number | null;
  since: number;
}

export interface Activity {
  key: string;
  label: string;
  since: number;
}

export interface SessionState {
  id: string;
  cwd: string;
  status: "idle" | "running";
  stopReason: string | null;
  revision: number;
  seq: number;
  transcript: TranscriptItem[];
  pendingPermission: PendingPermission | null;
  pendingPlan: PendingPlan | null;
  pendingElicitation: PendingElicitation | null;
  configOptions: ConfigOption[];
  modelId: string | null;
  reasoningEffort: string | null;
  commands: Command[];
  plan: PlanEntry[] | null;
  // The plan the agent wrote in plan mode (Codex's proposed plan), as it grows. The transcript shows it too.
  planDoc: { id: string; text: string } | null;
  usage: Usage | null;
  contextUsed: number | null;
  // The context window in tokens, when the harness reports it in usage_update.
  contextSize: number | null;
  // Why the last turn failed, when it did. Cleared by the next turn.
  error: string | null;
  queue: QueueEntry[];
  queueRunningId: string | null;
  modeId: string;
  retry: RetryState | null;
  activity: Activity | null;
  backgroundTasks: BackgroundTask[];
  suggestion: string | null;
  turnIndex?: number;
}

// Every event can carry the agent's timestamp and the context size it reported.
export interface EventStamp {
  at?: number;
  contextUsed?: number;
}

export interface ToolEvent {
  type: "tool";
  toolCallId?: string;
  title?: string;
  name?: string;
  kind?: string;
  status?: string | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: Location[] | null;
  diffs?: Diff[];
  images?: Image[];
  // The tool call of the subagent this call ran in, when a subagent made it.
  parentId?: string;
}

export interface PermissionEvent {
  type: "permission";
  rpcId: RpcId;
  toolCallId: string | null;
  title: string;
  name?: string;
  kind: string;
  rawInput?: unknown;
  options: PermissionOption[];
}

export type ReducerEvent = EventStamp &
  (
    | { type: "reset"; cwd?: string }
    | { type: "begin-turn" }
    | { type: "error-cleared" }
    | { type: "user"; text: string; attachments?: DisplayAttachment[]; deliveryId?: string }
    | { type: "delivery"; id: string; state: "read" | "unread" }
    | { type: "delivery-removed"; id: string }
    // The message went again under a new delivery id. It keeps its place in the transcript.
    | { type: "delivery-resent"; id: string; newId: string }
    | {
        type: "chunk";
        role: "user" | "assistant" | "thought";
        text: string;
        images?: Image[];
        promptIndex?: number;
        hidden?: boolean;
        attachments?: DisplayAttachment[];
        messageId?: string;
      }
    | { type: "user-images"; promptIndex: number; images: Image[] }
    | ToolEvent
    | { type: "retry"; active?: boolean; attempt?: number | null; max?: number | null; error?: string }
    | { type: "turn-finished"; stopReason?: string | null; usage?: Usage | null; error?: string | null }
    | { type: "context"; used: number | null; size: number | null }
    // A line from the harness, not from the model (Claude's "Task stopped by user"). It starts no turn.
    | { type: "notice"; text: string }
    | { type: "settle" }
    | { type: "queue"; entries: QueueEntry[]; runningPromptId: string | null; runningText: string | null }
    | PermissionEvent
    | { type: "permission-cleared" }
    | { type: "plan-approval"; rpcId: RpcId; toolCallId: string | null; plan: string }
    | { type: "plan-cleared" }
    | { type: "permission-resolved"; toolCallId: string | null }
    | { type: "elicitation"; rpcId: RpcId; message: string; fields: FormField[]; actions: QuestionAction[] }
    | { type: "elicitation-cleared" }
    | { type: "config"; configOptions?: ConfigOption[]; modelId?: string | null }
    | { type: "model"; modelId: string | null; reasoningEffort?: string | null }
    | { type: "commands"; commands: Command[] }
    | { type: "mode"; modeId: string | null }
    | { type: "plan"; entries: PlanEntry[] }
    | { type: "plan-doc"; id: string; text: string }
    | { type: "background-tasks"; tasks: BackgroundTask[] }
    | { type: "suggestion"; text: string | null }
    | { type: "cwd"; cwd: string }
  );

type EventOf<T extends ReducerEvent["type"]> = Extract<ReducerEvent, { type: T }>;

export function emptySession({
  id,
  cwd,
  configOptions = [],
  modelId = null,
}: {
  id: string;
  cwd: string;
  configOptions?: ConfigOption[];
  modelId?: string | null;
}): SessionState {
  return {
    id,
    cwd,
    status: "idle",
    stopReason: null,
    revision: 0,
    seq: 0,
    transcript: [],
    pendingPermission: null,
    pendingPlan: null,
    pendingElicitation: null,
    configOptions,
    modelId: modelId ?? optionValue(configOptions, "model"),
    reasoningEffort: optionValue(configOptions, "effort"),
    commands: [],
    plan: null,
    planDoc: null,
    usage: null,
    contextUsed: null,
    contextSize: null,
    error: null,
    queue: [],
    queueRunningId: null,
    // The approval mode in the app's names (provider.ts MODES).
    modeId: "full",
    retry: null,
    activity: null,
    backgroundTasks: [],
    suggestion: null,
  };
}

// The agent answers NONE when it has no next line. Anything longer than a short prompt is not ghost text.
export function cleanSuggestion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.toUpperCase() === "NONE" || text.length > 240) return null;
  return text;
}

export function reduce(session: SessionState, event: ReducerEvent, classify: ToolClassifier = acpFacts): SessionState {
  const next = reduceEvent(session, event, classify);
  if (event.type === "reset") return next;
  const used = event.contextUsed;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used === next.contextUsed) return next;
  if (next === session) return bump(session, { contextUsed: used });
  return { ...next, contextUsed: used };
}

function reduceEvent(session: SessionState, event: ReducerEvent, classify: ToolClassifier): SessionState {
  switch (event.type) {
    case "reset":
      return {
        ...emptySession({
          id: session.id,
          cwd: event.cwd ?? session.cwd,
          configOptions: session.configOptions,
          modelId: session.modelId,
        }),
        reasoningEffort: session.reasoningEffort,
        contextSize: session.contextSize,
        // A reload after the agent restarted keeps the error that ended the last turn.
        error: session.error,
        revision: session.revision + 1,
      };
    case "error-cleared":
      return bump(session, { error: null });
    case "begin-turn":
      return bump(session, {
        status: "running",
        stopReason: null,
        error: null,
        suggestion: null,
        turnIndex: session.transcript.length,
        plan: unfinishedPlan(session.plan),
      });
    case "user": {
      const next = appendText(session, "user", event.text, event.attachments);
      return event.deliveryId ? withDelivery(next, event.deliveryId) : next;
    }
    // A message only becomes unread while it waits. Claude can still read one marked unread.
    case "delivery": {
      const transcript = mapDeliveries(session.transcript, (delivery) =>
        delivery.id === event.id && (event.state === "read" || delivery.state === "waiting") ? event.state : null,
      );
      return transcript === session.transcript ? session : bump(session, {}, transcript);
    }
    case "delivery-resent": {
      if (!session.transcript.some((item) => item.type === "user" && item.delivery?.id === event.id)) return session;
      const transcript = session.transcript.map((item) =>
        item.type === "user" && item.delivery?.id === event.id ? { ...item, delivery: { id: event.newId, state: "waiting" as const } } : item,
      );
      return bump(session, {}, transcript);
    }
    case "delivery-removed": {
      const transcript = session.transcript.filter((item) => item.type !== "user" || item.delivery?.id !== event.id);
      return transcript.length === session.transcript.length ? session : bump(session, {}, transcript);
    }
    case "chunk": {
      if (event.role === "user") return applyUserChunk(session, event);
      const base = session.retry ? { ...session, retry: null } : session;
      return appendText(base, event.role, event.text, undefined, event.at, event.hidden, event.messageId);
    }
    case "user-images":
      return attachUserImages(session, event);
    case "tool":
      return applyTool(session.retry ? { ...session, retry: null } : session, event, classify);
    case "retry":
      if (event.active === false) return bump(session, { retry: null, ...(event.error ? { error: event.error } : {}) });
      return bump(session, {
        retry: {
          attempt: event.attempt ?? null,
          max: event.max ?? null,
          since: event.at ?? Date.now(),
        },
      });
    case "turn-finished":
      return bump(session, {
        status: "idle",
        stopReason: event.stopReason ?? session.stopReason,
        // A turn that ends any other way keeps the error it ran into, such as retries Grok gave up on.
        error: event.error ?? (event.stopReason === "end_turn" ? null : session.error),
        usage: event.usage ?? session.usage,
        queueRunningId: null,
        retry: null,
        transcript: closeStreaming(mapDeliveries(session.transcript, (delivery) => (delivery.state === "waiting" ? "unread" : null))),
      });
    case "settle":
      if (session.status === "running") return session;
      if (!session.transcript.some((item) => item.streaming)) return session;
      return bump(session, { transcript: closeStreaming(session.transcript) });
    case "queue": {
      const entries = [...event.entries].sort((a, b) => a.position - b.position);
      const switched = Boolean(event.runningPromptId) && event.runningPromptId !== session.queueRunningId;
      const transcript = switched ? closeStreaming(session.transcript) : session.transcript;
      let next = bump(session, {
        queue: entries,
        queueRunningId: event.runningPromptId ?? null,
        status: event.runningPromptId ? "running" : session.status,
        transcript,
        ...(switched ? { turnIndex: transcript.length, plan: unfinishedPlan(session.plan) } : {}),
      });
      if (!switched || !event.runningText) return next;
      const lastUser = [...next.transcript].reverse().find((item) => item.type === "user");
      if (lastUser?.text === event.runningText) return next;
      return appendText(next, "user", event.runningText);
    }
    case "permission": {
      // A permission may name only its tool call. What it leaves out comes from that call's row.
      const row = session.transcript.find((item): item is ToolItem => item.type === "tool" && item.toolCallId === event.toolCallId);
      const asked = {
        name: event.name || row?.name || "",
        kind: event.kind || row?.kind || "",
        title: event.title || row?.title || "",
        rawInput: event.rawInput ?? row?.rawInput ?? null,
        locations: row?.locations ?? null,
      };
      return bump(session, {
        pendingPermission: {
          rpcId: event.rpcId,
          toolCallId: event.toolCallId,
          title: event.title,
          name: event.name || "",
          kind: event.kind,
          rawInput: event.rawInput,
          facts: classify(asked),
          options: event.options,
        },
      });
    }
    case "permission-cleared":
      return bump(session, { pendingPermission: null });
    case "plan-approval":
      return bump(session, {
        pendingPlan: {
          rpcId: event.rpcId,
          toolCallId: event.toolCallId,
          plan: event.plan || "",
        },
      });
    case "plan-cleared":
      return bump(session, { pendingPlan: null });
    case "permission-resolved":
      if (event.toolCallId && session.pendingPermission?.toolCallId !== event.toolCallId) return session;
      return bump(session, { pendingPermission: null });
    case "elicitation":
      return bump(session, {
        pendingElicitation: {
          rpcId: event.rpcId,
          message: event.message,
          fields: event.fields,
          actions: event.actions,
        },
      });
    case "elicitation-cleared":
      return bump(session, { pendingElicitation: null });
    case "config":
      return bump(session, {
        configOptions: event.configOptions ?? session.configOptions,
        modelId: event.modelId ?? optionValue(event.configOptions, "model") ?? session.modelId,
        reasoningEffort: optionValue(event.configOptions, "effort") ?? session.reasoningEffort,
      });
    case "model":
      return bump(session, {
        modelId: event.modelId ?? session.modelId,
        reasoningEffort: event.reasoningEffort === undefined ? session.reasoningEffort : event.reasoningEffort,
      });
    case "commands":
      return bump(session, { commands: event.commands });
    case "mode":
      return bump(session, { modeId: event.modeId || session.modeId });
    case "plan":
      return bump(session, { plan: event.entries });
    case "plan-doc":
      return applyPlanDoc(session, event);
    case "background-tasks":
      return bump(session, { backgroundTasks: Array.isArray(event.tasks) ? event.tasks : [] });
    case "suggestion":
      return bump(session, { suggestion: cleanSuggestion(event.text) });
    case "notice": {
      // A line of its own: a reply still streaming ends first, so the notice does not join its text.
      const ended = bump(session, {}, closeStreaming(session.transcript));
      const noted = appendText(ended, "assistant", event.text, undefined, event.at);
      return bump(noted, {}, closeStreaming(noted.transcript));
    }
    case "context": {
      const used = validTokens(event.used) ?? session.contextUsed;
      const size = validTokens(event.size) ?? session.contextSize;
      if (used === session.contextUsed && size === session.contextSize) return session;
      return bump(session, { contextUsed: used, contextSize: size });
    }
    case "cwd": {
      const cwd = String(event.cwd || "");
      if (!cwd || cwd === session.cwd) return session;
      return bump(session, { cwd });
    }
    default:
      return session;
  }
}

function validTokens(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

// Model and effort are select options, so their values are strings.
function optionValue(options: ConfigOption[] | undefined, id: string): string | null {
  const value = options?.find((option) => option.id === id)?.currentValue;
  return typeof value === "string" ? value : null;
}

function bump(
  session: SessionState,
  patch: Partial<SessionState>,
  transcript: TranscriptItem[] = patch.transcript ?? session.transcript,
): SessionState {
  const next = { ...session, ...patch, transcript };
  return { ...next, activity: syncActivity(next), revision: session.revision + 1 };
}

// A finished plan ends with its turn. An unfinished one stays into the next.
function unfinishedPlan(plan: PlanEntry[] | null): PlanEntry[] | null {
  return plan?.every((step) => step.status === "completed") ? null : plan;
}

function applyUserChunk(session: SessionState, event: EventOf<"chunk">): SessionState {
  const text = typeof event.text === "string" ? event.text : "";
  const images = Array.isArray(event.images) ? event.images : [];
  const promptIndex =
    typeof event.promptIndex === "number" && Number.isInteger(event.promptIndex) && event.promptIndex >= 0
      ? event.promptIndex
      : null;
  const hidden = Boolean(event.hidden);
  if (promptIndex != null) {
    for (let index = session.transcript.length - 1; index >= 0; index -= 1) {
      const item = session.transcript[index];
      if (item?.type === "user" && item.promptIndex === promptIndex) {
        return mergeUserChunk(session, index, { text, images, hidden, promptIndex });
      }
    }
  }
  const tailIndex = session.transcript.length - 1;
  const tail = session.transcript[tailIndex];
  if (sameOutgoing(tail, { text, images, hidden })) {
    return mergeUserChunk(session, tailIndex, { text, images, hidden, promptIndex });
  }
  const base = session.retry ? { ...session, retry: null } : session;
  return appendUser(base, { text, images, hidden, promptIndex, attachments: event.attachments });
}

// A picture is its own user_message_chunk. It belongs on the prompt just sent, or on the
// caption chunk that shares its promptIndex. A later picture stays its own message.
function sameOutgoing(
  tail: TranscriptItem | undefined,
  { text, images, hidden }: { text: string; images: Image[]; hidden: boolean },
) {
  if (tail?.type !== "user" || tail.promptIndex != null || hidden || tail.hidden) return false;
  if (tail.text === text) return true;
  return text === "" && images.length > 0 && hasPicture(tail);
}

function hasPicture(item: UserItem) {
  if ((item.images || []).length > 0) return true;
  return (item.attachments || []).some((file) => file.kind === "image");
}

interface UserChunk {
  text: string;
  images: Image[];
  hidden: boolean;
  promptIndex: number | null;
}

function mergeUserChunk(session: SessionState, index: number, { text, images, hidden, promptIndex }: UserChunk) {
  const current = session.transcript[index];
  if (current?.type !== "user") return session;
  const next = { ...current };
  let changed = false;
  if (text && !current.text) {
    next.text = text;
    changed = true;
  }
  if (promptIndex != null && current.promptIndex == null) {
    next.promptIndex = promptIndex;
    changed = true;
  }
  if (hidden && !current.hidden) {
    next.hidden = true;
    changed = true;
  }
  const pictures = pictureList([...(current.images || []), ...images]);
  if (pictures.length !== (current.images?.length || 0)) {
    next.images = pictures;
    changed = true;
  }
  if (!changed) return session;
  const transcript = session.transcript.slice();
  transcript[index] = next;
  return bump(session, {}, transcript);
}

function attachUserImages(session: SessionState, event: EventOf<"user-images">): SessionState {
  if (!Number.isInteger(event.promptIndex) || event.promptIndex < 0) return session;
  const index = session.transcript.findIndex((item) => item.type === "user" && item.promptIndex === event.promptIndex);
  if (index < 0) return session;
  return mergeUserChunk(session, index, { text: "", images: event.images, hidden: false, promptIndex: event.promptIndex });
}

function appendUser(
  session: SessionState,
  { text, images, hidden, promptIndex, attachments }: UserChunk & { attachments?: DisplayAttachment[] },
) {
  const seq = session.seq + 1;
  const transcript = closeStreaming(session.transcript);
  const entry: UserItem = { id: `user-${seq}`, type: "user", text, streaming: false };
  if (hidden) entry.hidden = true;
  if (promptIndex != null) entry.promptIndex = promptIndex;
  const shown = displayAttachments(attachments);
  if (shown.length) entry.attachments = shown;
  const pictures = pictureList(images);
  if (pictures.length) entry.images = pictures;
  transcript.push(entry);
  return bump(session, { seq }, transcript);
}

function pictureList(images: Image[] | undefined): Image[] {
  if (!Array.isArray(images)) return [];
  const pictures: Image[] = [];
  for (const image of images) {
    if (typeof image.data !== "string" || !image.data) continue;
    if (pictures.some((item) => item.data === image.data)) continue;
    pictures.push({
      mimeType: typeof image.mimeType === "string" ? image.mimeType : "",
      data: image.data,
    });
  }
  return pictures;
}

function appendText(
  session: SessionState,
  type: TextItem["type"],
  text: string,
  attachments?: DisplayAttachment[],
  at?: number,
  hidden?: boolean,
  messageId?: string,
) {
  const tail = session.transcript.at(-1);
  if (type !== "user" && tail?.type === type && tail.streaming && (!messageId || !tail.messageId || tail.messageId === messageId)) {
    const transcript = session.transcript.slice(0, -1).concat({ ...tail, text: tail.text + text });
    return bump(session, {}, transcript);
  }
  const seq = session.seq + 1;
  const transcript = closeStreaming(session.transcript);
  const entry = { id: `${type}-${seq}`, type, text, streaming: type !== "user" } as TextItem;
  if (hidden) entry.hidden = true;
  if (messageId) entry.messageId = messageId;
  if (type === "thought" || type === "assistant") entry.startedAt = at ?? Date.now();
  const shown = displayAttachments(attachments);
  if (shown.length) entry.attachments = shown;
  transcript.push(entry);
  return bump(session, { seq }, transcript);
}

function withDelivery(session: SessionState, id: string): SessionState {
  const last = session.transcript.at(-1);
  if (last?.type !== "user") return session;
  const delivery: Delivery = { id, state: "waiting" };
  return { ...session, transcript: [...session.transcript.slice(0, -1), { ...last, delivery }] };
}

// Gives each steered message the state `stateOf` returns for it, or leaves it on null. The same array
// comes back when nothing changed.
function mapDeliveries(transcript: TranscriptItem[], stateOf: (delivery: Delivery) => Delivery["state"] | null): TranscriptItem[] {
  let changed = false;
  const next = transcript.map((item) => {
    if (item.type !== "user" || !item.delivery) return item;
    const state = stateOf(item.delivery);
    if (!state || state === item.delivery.state) return item;
    changed = true;
    return { ...item, delivery: { ...item.delivery, state } };
  });
  return changed ? next : transcript;
}

function displayAttachments(attachments: DisplayAttachment[] | undefined): DisplayAttachment[] {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .filter((file) => typeof file.name === "string" && file.name)
    .map((file) => {
      const shown: DisplayAttachment = {
        name: file.name,
        kind: file.kind === "image" ? "image" : "file",
        mimeType: typeof file.mimeType === "string" ? file.mimeType : "",
      };
      if (typeof file.preview === "string" && file.preview.startsWith("data:image/") && file.preview.length <= 150000) {
        shown.preview = file.preview;
      }
      return shown;
    });
}

// The whole plan text each time it grows. It is one reply in the transcript, rewritten in place, and the
// session's plan document, which the Plan tab shows. The reply is never streaming: each update brings the
// whole text, and a streaming reply would take in the next reply's chunks. It ends the thought before it.
function applyPlanDoc(session: SessionState, event: EventOf<"plan-doc">): SessionState {
  const id = `plan:${event.id}`;
  const index = session.transcript.findIndex((item) => item.id === id);
  const current = index >= 0 ? session.transcript[index] : undefined;
  const item: AssistantItem = {
    id,
    type: "assistant",
    text: event.text,
    streaming: false,
    startedAt: current?.type === "assistant" && current.startedAt !== undefined ? current.startedAt : Date.now(),
  };
  const transcript = index >= 0 ? session.transcript.map((entry, at) => (at === index ? item : entry)) : [...closeStreaming(session.transcript), item];
  return bump(session, { planDoc: { id: event.id, text: event.text }, transcript });
}

function applyTool(session: SessionState, event: EventOf<"tool">, classify: ToolClassifier): SessionState {
  if (!event.toolCallId) return session;
  const transcript = closeStreaming(session.transcript);
  const index = transcript.findIndex((item) => item.type === "tool" && item.toolCallId === event.toolCallId);
  const found = transcript[index];
  const previous = found?.type === "tool" ? found : blankTool(event.toolCallId);
  const next: ToolItem = { ...previous };
  for (const key of TOOL_FIELDS) {
    if (event[key] !== undefined) Object.assign(next, { [key]: event[key] });
  }
  if (event.status !== undefined) next.statusExplicit = true;
  next.facts = classify(next);
  if (!next.startedAt && isLiveStatus(next.status)) next.startedAt = event.at ?? Date.now();
  if (event.status !== undefined && !isLiveStatus(next.status)) next.finishedAt = event.at ?? next.finishedAt ?? Date.now();
  if (index >= 0) transcript[index] = next;
  else transcript.push(next);
  return bump(session, {}, transcript);
}

const TOOL_FIELDS = [
  "title",
  "name",
  "kind",
  "status",
  "rawInput",
  "rawOutput",
  "locations",
  "diffs",
  "images",
  "parentId",
] as const satisfies readonly (keyof ToolEvent & keyof ToolItem)[];

function blankTool(toolCallId: string): ToolItem {
  return {
    id: `tool:${toolCallId}`,
    type: "tool",
    toolCallId,
    title: "",
    name: "",
    kind: "",
    status: "in_progress",
    rawInput: null,
    rawOutput: null,
    facts: { role: "other" },
    diffs: [],
    locations: [],
  };
}

function closeStreaming(transcript: TranscriptItem[]): TranscriptItem[] {
  return transcript.map((item) => {
    if (!item.streaming) return item;
    const next = { ...item, streaming: false };
    if (item.type === "thought" && item.startedAt) next.finishedAt = Date.now();
    return next;
  });
}

const LIVE = new Set(["in_progress", "pending", "running"]);

function syncActivity(session: SessionState): Activity | null {
  const phase = phaseOf(session);
  if (!phase) return null;
  const current = session.activity;
  if (current?.key === phase.key) {
    if (current.label === phase.label) return current;
    return { ...current, label: phase.label };
  }
  return { key: phase.key, label: phase.label, since: phase.since ?? Date.now() };
}

interface Phase {
  key: string;
  label: string;
  since?: number | null;
}

// A permission, plan or question the agent waits on the person to answer.
export function waitsOnPerson(session: SessionState): boolean {
  return Boolean(session.pendingPermission || session.pendingPlan || session.pendingElicitation);
}

function phaseOf(session: SessionState): Phase | null {
  if (session.pendingPermission || session.pendingPlan) return { key: "approval", label: "Waiting for approval" };
  if (session.pendingElicitation) return { key: "question", label: "Waiting for your answer" };
  if (session.retry) {
    const attempt = session.retry.attempt;
    const max = session.retry.max;
    const label = attempt && max ? `Retrying (${attempt}/${max})` : "Retrying";
    return { key: `retry:${attempt ?? 0}`, label, since: session.retry.since };
  }
  const open = latestOpen(session.transcript);
  if (open) return open;
  if (session.status === "running") {
    return { key: `wait:${session.turnIndex ?? "open"}`, label: "Waiting for response", since: waitSince(session) };
  }
  return null;
}

// Stamps from before this turn are the session age. No stamp yet starts the wait from now.
function waitSince(session: SessionState) {
  if (typeof session.turnIndex !== "number") return null;
  for (let index = session.transcript.length - 1; index >= session.turnIndex; index -= 1) {
    const item = session.transcript[index];
    if (item === undefined) continue;
    if (typeof item.finishedAt === "number") return item.finishedAt;
    if (typeof item.startedAt === "number") return item.startedAt;
  }
  return null;
}

function latestOpen(transcript: TranscriptItem[]): Phase | null {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (item === undefined) continue;
    if (item.type === "thought" && item.streaming) {
      return { key: `think:${item.id}`, label: "Thinking...", since: item.startedAt };
    }
    if (item.type === "assistant" && item.streaming) {
      return { key: `text:${item.id}`, label: "Responding", since: item.startedAt };
    }
    if (item.type === "tool" && isLiveStatus(item.status)) {
      return { key: `tool:${item.toolCallId}`, label: toolPhase(item.facts), since: item.startedAt };
    }
  }
  return null;
}

function isLiveStatus(status: string | null | undefined) {
  if (!status) return true;
  return LIVE.has(status);
}
