import type { FormField, QuestionAction } from "../bridge/elicitation.ts";
import type { FrozenStretch, StretchStart } from "./chat/chatRecords.ts";
import type { Switching } from "./chat/switchChat.ts";
import type { BackgroundTask, FuzzyMatch, PermissionOption, PlanEntry, Usage } from "../bridge/protocol.ts";
import { NAVIGATE_TOOL, pageMarkOf, type PageMark } from "./browser/browserTools.ts";
import { LAUNCH_TOOL, appMarkOf, type AppMark } from "./devices/ios/simulatorTools.ts";
import type {
  Activity,
  Delivery,
  DisplayAttachment,
  PendingElicitation,
  PendingPermission,
  PendingPlan,
  SessionState,
  TextItem,
  ToolItem,
  TranscriptItem,
} from "../bridge/reducer.ts";
import { acpFacts, type ToolFacts } from "../bridge/tools.ts";

// What the page gets for one open session. The host adds the title (OpenSession in
// snapshot.ts) and swaps in the plan from disk when the agent's copy is missing.
export interface PresentedSession {
  id: string;
  cwd: string;
  status: SessionState["status"];
  stopReason: string | null;
  // Why the last turn failed, when it did.
  error: string | null;
  errorProvider?: string;
  revision: number;
  modelId: string | null;
  reasoningEffort: string | null;
  configOptions: PresentedOption[];
  commands: { name: string | undefined; description: string }[];
  plan: PlanEntry[] | null;
  // The plan the agent wrote in plan mode, for the Plan tab.
  planDoc: { id: string; text: string } | null;
  usage: Usage | null;
  context: PresentedContext | null;
  pendingPermission: PresentedPermission | null;
  pendingPlan: PresentedPlan | null;
  pendingQuestion: PresentedQuestion | null;
  mentions: PresentedMention[];
  transcript: PresentedItem[];
  modeId: string;
  activity: PresentedActivity | null;
  backgroundTasks: BackgroundTask[];
  queue: PresentedQueueEntry[];
  suggestion: string | null;
  // A chat that switched provider: the stretches before the one running now, and how this one began.
  stretches?: FrozenStretch[];
  start?: StretchStart | null;
  // A switch to another provider is running.
  switching?: Switching;
}

export interface PresentedOption {
  id: string;
  name: string;
  currentValue: string | number | boolean | null;
  // group names the provider a model belongs to, where a menu lists several. older folds a choice
  // under "More models".
  options: { value: string; name: string; group?: string; older?: boolean }[];
}

export interface PresentedContext {
  used: number;
  size: number;
  compactAt: number;
}

export interface PresentedPermission extends ToolFacts {
  // The agent's request id, which the answer sends back. The app's own prompts have none.
  id?: string;
  toolCallId: string | null;
  title: string;
  name: string;
  kind: string;
  rawInput: unknown;
  options: PermissionOption[];
  // The plan, when the agent asks to leave plan mode through a permission (Claude's ExitPlanMode).
  // The page shows it as a plan, with the agent's own options as the answers.
  plan?: string;
}

export interface PresentedPlan {
  toolCallId: string | null;
  plan: string;
  planMissing: boolean;
}

// A form the agent waits on, such as Claude's AskUserQuestion or Codex's request_user_input.
export interface PresentedQuestion {
  id: string;
  message: string;
  fields: FormField[];
  actions: QuestionAction[];
}

export interface PresentedMention {
  name: string | undefined;
  path: string | undefined;
  type: string;
}

export interface PresentedActivity {
  label: string;
  since: number;
}

export interface PresentedQueueEntry {
  id: string;
  version: number;
  text: string;
  position: number;
  attachments?: PresentedAttachment[];
}

export interface PresentedAttachment {
  name: string;
  kind: "image" | "file";
  mimeType: string;
  preview?: string;
}

// Image bytes stay on the host. The page fetches each one by its index.
export interface PresentedImage {
  index: number;
  mimeType: string;
}

export interface PresentedDiff {
  path: string;
  oldText: string;
  newText: string;
  truncated: boolean;
}

export interface PresentedTextItem {
  id: string;
  type: TextItem["type"];
  text: string;
  streaming: boolean;
  durationMs?: number | null;
  hidden?: true;
  attachments?: PresentedAttachment[];
  images?: PresentedImage[];
  delivery?: Delivery;
}

// The page reads what a tool does from its facts. rawInput is only for the detail view.
export interface PresentedToolItem extends ToolFacts {
  id: string;
  type: "tool";
  toolCallId: string;
  title: string;
  kind: string;
  status: string;
  // The tool's input, trimmed (presentInput): an edit's old and new text are left out when diffs has
  // them, and long strings are cut. The full input stays with the host.
  rawInput: unknown;
  diffs: PresentedDiff[];
  outputPreview: string;
  images?: PresentedImage[];
  // The subagent's tool call this step ran in. The transcript folds it under that row.
  parentId?: string;
  // A page the browser tools opened, drawn as a card.
  page?: PageMark;
  // An app the simulator tools launched, drawn as a card.
  app?: AppMark;
}

export type PresentedItem = PresentedTextItem | PresentedToolItem;

export interface ContextWindow {
  size: number;
  compactAt: number;
}

export type ContextWindows = Record<string, ContextWindow | undefined>;

const DIFF_LIMIT = 20000;

// mentions are the @ file matches the host found for this session's composer.
export function presentSession(session: null | undefined, windows?: ContextWindows | null, mentions?: readonly FuzzyMatch[]): null;
export function presentSession(session: SessionState, windows?: ContextWindows | null, mentions?: readonly FuzzyMatch[]): PresentedSession;
export function presentSession(session: SessionState | null | undefined, windows: ContextWindows | null = null, mentions: readonly FuzzyMatch[] = []): PresentedSession | null {
  if (!session) return null;
  return {
    id: session.id,
    cwd: session.cwd,
    status: session.status,
    stopReason: session.stopReason,
    error: session.error,
    revision: session.revision,
    modelId: session.modelId,
    reasoningEffort: session.reasoningEffort,
    configOptions: session.configOptions.map(presentOption),
    commands: session.commands.map((command) => ({ name: command.name, description: command.description })),
    plan: session.plan,
    planDoc: session.planDoc ? { id: session.planDoc.id, text: session.planDoc.text } : null,
    usage: session.usage,
    context: presentContext(session, windows),
    pendingPermission: presentPermission(session.pendingPermission, session.transcript),
    pendingPlan: presentPlan(session.pendingPlan),
    pendingQuestion: presentQuestion(session.pendingElicitation),
    mentions: mentions.map((match) => ({
      name: match.name,
      path: match.path,
      type: match.type,
    })),
    transcript: session.transcript.map(presentItem),
    modeId: session.modeId || "full",
    activity: presentActivity(session.activity),
    backgroundTasks: session.backgroundTasks.map((task) => ({
      id: task.id,
      kind: task.kind || "",
      status: task.status || "",
      label: task.label || "Background task",
      ...(task.toolCallId ? { toolCallId: task.toolCallId } : {}),
    })),
    queue: session.queue.map(presentQueue),
    suggestion: typeof session.suggestion === "string" && session.suggestion.trim() ? session.suggestion.trim() : null,
  };
}

// The window the harness reported in usage_update, else the size Grok's model cache lists.
function presentContext(session: SessionState, windows: ContextWindows | null): PresentedContext | null {
  const model = session.modelId ? windows?.[session.modelId] : undefined;
  const size = session.contextSize ?? model?.size;
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) return null;
  const raw = session.contextUsed;
  const used = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 0;
  const mark = model?.compactAt;
  const compactAt = typeof mark === "number" && Number.isFinite(mark) && mark > 0 && mark <= 100 ? mark : 80;
  return { used, size, compactAt };
}

function presentActivity(activity: Activity | null): PresentedActivity | null {
  if (!activity?.label || typeof activity.since !== "number") return null;
  return { label: activity.label, since: activity.since };
}

function presentOption(option: SessionState["configOptions"][number]): PresentedOption {
  return {
    id: option.id,
    name: option.name || option.id,
    currentValue: option.currentValue ?? null,
    options: (option.options ?? []).map((choice) => ({
      value: choice.value,
      name: choice.name || choice.value,
      ...(choice.older ? { older: true } : {}),
    })),
  };
}

function presentPlan(plan: PendingPlan | null): PresentedPlan | null {
  if (!plan) return null;
  const text = plan.plan || "";
  return {
    toolCallId: plan.toolCallId,
    plan: text,
    planMissing: !text.trim(),
  };
}

function presentQuestion(question: PendingElicitation | null): PresentedQuestion | null {
  if (!question) return null;
  return { id: String(question.rpcId), message: question.message, fields: question.fields, actions: question.actions };
}

// A permission may send only its tool call's id; what it leaves out comes from that call's tool row.
function presentPermission(permission: PendingPermission | null, transcript: readonly TranscriptItem[]): PresentedPermission | null {
  if (!permission) return null;
  const tool = permission.toolCallId ? transcript.find((item): item is ToolItem => item.type === "tool" && item.toolCallId === permission.toolCallId) : undefined;
  const rawInput = permission.rawInput ?? tool?.rawInput ?? null;
  return {
    id: String(permission.rpcId),
    toolCallId: permission.toolCallId,
    title: permission.title || tool?.title || "",
    name: permission.name || tool?.name || "",
    kind: permission.kind || tool?.kind || "",
    rawInput,
    ...permission.facts,
    options: permission.options,
    ...planOf(rawInput),
  };
}

function planOf(rawInput: unknown): { plan?: string } {
  if (typeof rawInput !== "object" || rawInput === null || !("plan" in rawInput)) return {};
  const plan = rawInput.plan;
  return typeof plan === "string" && plan.trim() ? { plan } : {};
}

function presentItem(item: TranscriptItem): PresentedItem {
  if (item.type !== "tool") {
    const view: PresentedTextItem = { id: item.id, type: item.type, text: item.text, streaming: Boolean(item.streaming) };
    if (item.type === "thought") view.durationMs = thoughtDuration(item);
    if (item.type === "user" && item.hidden) view.hidden = true;
    if (item.type === "user" && item.attachments?.length) view.attachments = item.attachments.map(presentAttachment);
    if (item.type === "user") {
      const images = presentImages(item.images);
      if (images.length) view.images = images;
      if (item.delivery) view.delivery = item.delivery;
    }
    return view;
  }
  const view: PresentedToolItem = {
    id: item.id,
    type: "tool",
    toolCallId: item.toolCallId,
    title: item.title || item.name || "Tool",
    kind: item.kind || "",
    status: item.status || "in_progress",
    rawInput: presentInput(item.rawInput, item.diffs.length > 0),
    ...presentFacts(item.facts),
    diffs: item.diffs.map(presentDiff),
    outputPreview: previewOutput(item.rawOutput),
    ...(item.parentId ? { parentId: item.parentId } : {}),
  };
  const images = presentImages(item.images);
  if (images.length) view.images = images;
  const page = item.status === "completed" && (NAVIGATE_TOOL.test(item.title || "") || NAVIGATE_TOOL.test(item.name || "")) ? pageMarkOf(item.rawOutput) : null;
  if (page) view.page = page;
  const app = item.status === "completed" && LAUNCH_TOOL.test(`${item.title} ${item.name}`) ? appMarkOf(item.rawOutput) : null;
  if (app) view.app = app;
  return view;
}

// Every snapshot carries every tool row, and the page shows an input only in a row's detail view. An
// edit's old and new text come again in its diffs, which is what the page draws, so they are left out
// when the diffs are there, and any other long string is cut.
// The permission card still gets the whole input and its facts (presentPermission).
const INPUT_LIMIT = 4000;
const EDIT_TEXT = new Set(["old_string", "new_string", "content", "edits"]);

export function presentInput(input: unknown, hasDiffs: boolean): unknown {
  if (input === undefined || input === null) return null;
  if (typeof input === "string") return clipInput(input);
  if (typeof input !== "object") return input;
  if (Array.isArray(input)) return input.map((value) => presentInput(value, false));
  const view: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (hasDiffs && EDIT_TEXT.has(key)) continue;
    view[key] = presentInput(value, false);
  }
  return view;
}

function presentFacts(facts: ToolFacts): ToolFacts {
  const view: ToolFacts = { ...facts };
  for (const key of ["path", "command", "query", "label", "agent"] as const) {
    const text = view[key];
    if (text !== undefined) view[key] = clipInput(text);
  }
  if (view.args) view.args = presentInput(view.args, false) as Record<string, unknown>;
  return view;
}

function clipInput(text: string): string {
  return text.length > INPUT_LIMIT ? `${text.slice(0, INPUT_LIMIT)}…` : text;
}

function presentImages(images: ToolItem["images"]): PresentedImage[] {
  if (!Array.isArray(images) || !images.length) return [];
  return images.map((image, index) => ({
    index,
    mimeType: typeof image.mimeType === "string" ? image.mimeType : "",
  }));
}

function presentQueue(entry: SessionState["queue"][number]): PresentedQueueEntry {
  const view: PresentedQueueEntry = {
    id: entry.id,
    version: entry.version,
    text: entry.text,
    position: entry.position,
  };
  if (entry.attachments?.length) view.attachments = entry.attachments.map(presentAttachment);
  return view;
}

function presentAttachment(file: DisplayAttachment): PresentedAttachment {
  const view: PresentedAttachment = {
    name: String(file.name || "file"),
    kind: file.kind === "image" ? "image" : "file",
    mimeType: String(file.mimeType || ""),
  };
  if (typeof file.preview === "string" && file.preview.startsWith("data:image/") && file.preview.length <= 150000) {
    view.preview = file.preview;
  }
  return view;
}

function thoughtDuration(item: TextItem) {
  if (!item.startedAt) return null;
  const end = item.finishedAt || (item.streaming ? Date.now() : null);
  if (!end) return null;
  return Math.max(0, end - item.startedAt);
}

// An earlier stretch saved before edits were capped holds them whole. The page gets them capped like a live session's.
export function presentFrozen(items: readonly PresentedItem[]): PresentedItem[] {
  return items.map((item) => {
    if (item.type !== "tool") return item;
    // A stored item may have no role. Its standard kind names one.
    const tool = item.role ? item : { ...item, role: acpFacts({ kind: item.kind, locations: null, rawInput: item.rawInput }).role };
    return tool.diffs.some((diff) => diff.oldText.length > DIFF_LIMIT || diff.newText.length > DIFF_LIMIT) ? { ...tool, diffs: tool.diffs.map(presentDiff) } : tool;
  });
}

function presentDiff(diff: ToolItem["diffs"][number]): PresentedDiff {
  const oldText = cap(diff.oldText);
  const newText = cap(diff.newText);
  return {
    path: diff.path,
    oldText: oldText.text,
    newText: newText.text,
    truncated: oldText.truncated || newText.truncated,
  };
}

function previewOutput(output: unknown) {
  if (!output) return "";
  if (typeof output === "string") return cap(output, 500).text;
  return cap(findConcise(output), 500).text;
}

function findConcise(value: unknown, depth = 0): string {
  if (!isObject(value) || depth > 4) return "";
  if (typeof value.tool_output_for_prompt_concise === "string") return value.tool_output_for_prompt_concise;
  if (typeof value.tool_output_for_prompt === "string") return value.tool_output_for_prompt;
  for (const child of Object.values(value)) {
    const found = findConcise(child, depth + 1);
    if (found) return found;
  }
  return "";
}

// Arrays count too. The concise output can sit inside a list.
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cap(text: unknown, max = DIFF_LIMIT) {
  const value = String(text);
  if (value.length <= max) return { text: value, truncated: false };
  return { text: value.slice(0, max), truncated: true };
}
