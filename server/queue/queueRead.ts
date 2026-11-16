// What a queue reads from the board, through the routes the page uses: a parent's sub-tickets with what each waits
// on, and which tickets are done.

import { isRecord } from "../../bridge/lenient.ts";
import type { BoardCall } from "../board/boardTools.ts";
import { httpError } from "../http.ts";
import { cycleIn, needsOf } from "./queuePlan.ts";
import type { Queue } from "./queues.ts";

export interface PlanTicket {
  id: string;
  title: string;
  needs: string[];
  done: boolean;
}

export interface QueuePlan {
  parent: { id: string; title: string };
  items: PlanTicket[];
  // Prerequisites that are no sub-ticket of the parent. queued: another run has it in its queue.
  outside: { id: string; title: string; done: boolean; queued: boolean }[];
  cycle: string[] | null;
}

interface Linked {
  id: string;
  title: string;
  done: boolean;
  relation: unknown;
}

function linked(value: unknown): Linked[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (isRecord(item) && item.id ? [{ id: String(item.id), title: String(item.title ?? ""), done: item.done === true, relation: item.relation }] : []));
}

async function readTicket(board: BoardCall, id: string): Promise<{ title: string; subtasks: Linked[]; related: Linked[] }> {
  const reply = await board("GET", `/api/board/tasks/${encodeURIComponent(id)}`);
  const task = isRecord(reply.body) && isRecord(reply.body.task) ? reply.body.task : null;
  if (reply.status >= 400 || !task) throw httpError(isRecord(reply.body) && typeof reply.body.error === "string" ? reply.body.error : `Couldn't read ticket ${id}`, reply.status >= 400 ? reply.status : 502);
  return { title: String(task.title ?? ""), subtasks: linked(task.subtasks), related: linked(task.related) };
}

export async function readPlan(board: BoardCall, parentId: string, running: readonly Queue[]): Promise<QueuePlan> {
  const parent = await readTicket(board, parentId);
  const reads = await Promise.all(parent.subtasks.map((sub) => readTicket(board, sub.id)));
  const items = parent.subtasks.map((sub, index) => ({ id: sub.id, title: sub.title, done: sub.done, needs: needsOf(reads[index]?.related ?? []) }));
  const inside = new Set(items.map((item) => item.id));
  const queued = new Set(running.flatMap((queue) => queue.items.filter((item) => item.state !== "done").map((item) => item.id)));
  const outside = new Map<string, QueuePlan["outside"][number]>();
  for (const [index, item] of items.entries()) {
    if (item.done) continue;
    for (const other of reads[index]?.related ?? []) {
      if (!item.needs.includes(other.id) || inside.has(other.id)) continue;
      outside.set(other.id, { id: other.id, title: other.title, done: other.done, queued: queued.has(other.id) });
    }
  }
  return { parent: { id: parentId, title: parent.title }, items, outside: [...outside.values()], cycle: cycleIn(items.filter((item) => !item.done)) };
}

// The ids among the queue's tickets and its outside prerequisites that the board holds as done now.
export async function doneOnBoard(board: BoardCall, queue: Queue): Promise<Set<string>> {
  const parent = await readTicket(board, queue.parent.id);
  const done = new Set(parent.subtasks.filter((sub) => sub.done).map((sub) => sub.id));
  // An open prerequisite outside the parent shows on the sub-tickets that wait on it.
  const open = new Set(queue.outside.filter((ticket) => !ticket.done).map((ticket) => ticket.id));
  const waiting = queue.items.filter((item) => item.state === "queued" && item.needs.some((need) => open.has(need)));
  for (const item of waiting) {
    const read = await readTicket(board, item.id);
    for (const other of read.related) if (open.has(other.id) && other.done) done.add(other.id);
  }
  return done;
}
