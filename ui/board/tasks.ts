import type { BackgroundTask } from "../../bridge/protocol.ts";
import type { ToolFacts } from "../../bridge/tools.ts";

// Live subagents, plus background commands and monitors that outlive the turn.
// The prompt, the plan, and ordinary tool calls stay out of this list.

const LIVE = new Set(["in_progress", "pending", "running"]);

// The fields read from a presented session (OpenSession) and its transcript items.
interface TaskItem extends Partial<Pick<ToolFacts, "role" | "command" | "label" | "background">> {
  type: string;
  id?: string;
  toolCallId?: string;
  status?: string;
  title?: string;
  parentId?: string;
}

interface TaskSession {
  status?: string;
  transcript?: readonly TaskItem[];
  backgroundTasks?: readonly Pick<BackgroundTask, "id" | "status" | "label" | "kind" | "toolCallId" | "canStop">[];
}

export interface RunningTask {
  // Missing only when a subtask item carries neither an id nor a tool call id.
  id: string | undefined;
  label: string;
  agent: boolean;
  // A subagent's latest step, and the id of its row in the thread.
  step?: string;
  rowId?: string;
  canStop?: false;
}

export function runningTasks(session: TaskSession | null | undefined): RunningTask[] {
  if (!session) return [];
  const transcript = session.transcript ?? [];
  const subtasks = new Map(transcript.flatMap((item) => (item.toolCallId && isSubtask(item) ? [[item.toolCallId, item] as const] : [])));
  const running = (session.backgroundTasks ?? []).filter((task) => String(task.status) === "running" && task.id);
  // A subagent with a running background task is listed once, by the task id, which stops it.
  const backed = new Set(running.flatMap((task) => (task.toolCallId && subtasks.has(task.toolCallId) ? [task.toolCallId] : [])));
  const tasks: RunningTask[] = [];
  if (session.status === "running") {
    for (const item of transcript) {
      if (!isSubtask(item) || !isLive(item.status) || backed.has(item.toolCallId ?? "")) continue;
      tasks.push(agentTask(item.id || item.toolCallId, item, transcript, subtasks));
    }
  }
  const seen = new Set(tasks.map((task) => task.id));
  for (const task of running) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    const row = task.toolCallId ? subtasks.get(task.toolCallId) : undefined;
    if (row) tasks.push(agentTask(task.id, row, transcript, subtasks, task.label));
    else tasks.push({ id: task.id, label: task.label || "Background task", agent: task.kind === "local_agent", ...(task.canStop === false ? { canStop: false as const } : {}) });
  }
  for (const item of session.transcript ?? []) {
    if (!isBackgroundCommand(item) || !isLive(item.status)) continue;
    const id = item.id || item.toolCallId;
    const label = backgroundCommandLabel(item);
    if (!id || seen.has(id) || tasks.some((task) => task.label === label)) continue;
    seen.add(id);
    tasks.push({ id, label, agent: false });
  }
  return tasks;
}

function agentTask(id: string | undefined, row: TaskItem, transcript: readonly TaskItem[], subtasks: ReadonlyMap<string, TaskItem>, fallback = ""): RunningTask {
  const last = transcript.findLast((item) => item.type === "tool" && item.parentId && item.parentId === row.toolCallId);
  const step = clip(last?.label) || clip(last?.title) || clip(fallback);
  // A subagent inside a subagent is folded into the outermost one's card, which is the row to show.
  let top = row;
  for (let depth = 0; depth < 20; depth += 1) {
    const parent = top.parentId ? subtasks.get(top.parentId) : undefined;
    if (!parent) break;
    top = parent;
  }
  return { id, label: subtaskLabel(row), agent: true, ...(step ? { step } : {}), ...(top.id ? { rowId: top.id } : {}) };
}

function isBackgroundCommand(item: TaskItem): boolean {
  return item?.type === "tool" && !isSubtask(item) && item.background === true;
}

function backgroundCommandLabel(item: TaskItem): string {
  return clip(item.label) || clip(item.command) || clip(item.title) || "Background task";
}

function isSubtask(item: TaskItem): boolean {
  return item?.type === "tool" && item.role === "subagent";
}

function isLive(status: unknown): boolean {
  if (!status) return true;
  return LIVE.has(String(status));
}

function subtaskLabel(item: TaskItem): string {
  return clip(item.label) || clip(item.title) || "Subtask";
}

function clip(text: unknown, max = 88): string {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}
