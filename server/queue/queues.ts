// queues.json: { "queues": [Queue] }, one per run of a parent ticket's sub-tickets. pid and port name the host that
// runs the queue. Every host on the home may write the file, so each change reads and writes it under a lock.

import { z } from "zod";
import { listOf } from "../../bridge/lenient.ts";
import { withFileLock } from "../../bridge/fileLock.ts";
import { watchedJson } from "../jsonFile.ts";
import { FINISH_MODES, type FinishMode, type StoredState } from "./queuePlan.ts";

export interface QueueItem {
  id: string;
  title: string;
  needs: string[];
  state: StoredState;
  sessionId?: string;
  cwd?: string;
  branch?: string;
  // The branch its worktree started from, for a stacked chat.
  base?: string;
  // Its chat's model and effort, where the sheet picked others than the run's.
  picks?: Queue["picks"];
  // Its chat's first prompt, where the sheet edited the ticket's brief.
  prompt?: string;
  // The pull request as last read.
  pr?: { number: number; url: string; status: string; draft?: boolean | undefined };
  // Why the start failed.
  reason?: string;
  // The chat's last reply, for the main chat's tool.
  result?: string;
  // Its turn ran when the host quit, so the next host tells it to go on.
  interrupted?: boolean;
}

// A prerequisite that is no sub-ticket of the parent.
export interface OutsideTicket {
  id: string;
  title: string;
  done: boolean;
}

export interface Queue {
  id: string;
  // The folder whose board holds the tickets.
  cwd: string;
  parent: { id: string; title: string };
  mode: FinishMode;
  slots: number;
  picks: { provider: string; model: string; effort: string };
  // The sidebar folder the run's chats sit in.
  folderId: string;
  mainChat?: string;
  items: QueueItem[];
  outside: OutsideTicket[];
  startedAt: string;
  pid: number;
  port: number;
}

const Picks = z.object({ provider: z.string().catch(""), model: z.string().catch(""), effort: z.string().catch("") });

const Item = z.object({
  id: z.string().min(1),
  title: z.string().catch(""),
  needs: listOf(z.string()).catch([]),
  state: z.enum(["queued", "started", "done", "failed"]),
  sessionId: z.string().optional().catch(undefined),
  cwd: z.string().optional().catch(undefined),
  branch: z.string().optional().catch(undefined),
  base: z.string().optional().catch(undefined),
  picks: Picks.optional().catch(undefined),
  prompt: z.string().optional().catch(undefined),
  pr: z.object({ number: z.number(), url: z.string(), status: z.string(), draft: z.boolean().optional() }).optional().catch(undefined),
  reason: z.string().optional().catch(undefined),
  result: z.string().optional().catch(undefined),
  interrupted: z.boolean().optional().catch(undefined),
});

const Stored = z.object({
  id: z.string().min(1),
  cwd: z.string().min(1),
  parent: z.object({ id: z.string().min(1), title: z.string().catch("") }),
  mode: z.enum(FINISH_MODES),
  slots: z.number().int().min(1),
  picks: Picks,
  folderId: z.string(),
  mainChat: z.string().optional().catch(undefined),
  items: listOf(Item),
  outside: listOf(z.object({ id: z.string(), title: z.string().catch(""), done: z.boolean().catch(false) })).catch([]),
  startedAt: z.string().catch(""),
  pid: z.number().int(),
  port: z.number().int(),
});

const QueuesFile = z.object({ queues: listOf(Stored).catch([]).default([]) });

// Fields Zod read as missing are dropped, so a write keeps the file free of nulls.
function clean<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function parse(value: unknown): Queue[] | null {
  const parsed = QueuesFile.safeParse(value);
  return parsed.success ? parsed.data.queues.map((queue) => clean({ ...queue, items: queue.items.map(clean) })) : null;
}

export interface QueueStore {
  list(): Queue[];
  get(id: string): Queue | null;
  add(queue: Queue): void;
  // Changes one queue as the file holds it now, and answers the changed queue, or null when it is gone.
  change(id: string, change: (queue: Queue) => Queue): Queue | null;
  changeItem(id: string, itemId: string, change: Partial<QueueItem>): Queue | null;
  remove(id: string): void;
  changedOnDisk(): boolean;
}

export function createQueueStore(file: string): QueueStore {
  const json = watchedJson<Queue[]>(file, parse, [], "keep the queues");

  function edit<T>(change: (queues: Queue[]) => { queues: Queue[]; answer: T }): T {
    return withFileLock(`${file}.lock`, () => {
      const { queues, answer } = change(json.read());
      json.write({ queues });
      return answer;
    });
  }

  function change(id: string, update: (queue: Queue) => Queue): Queue | null {
    return edit((queues) => {
      const found = queues.find((queue) => queue.id === id);
      if (!found) return { queues, answer: null };
      const next = update(found);
      return { queues: queues.map((queue) => (queue === found ? next : queue)), answer: next };
    });
  }

  return {
    list: () => json.read(),
    get: (id) => json.read().find((queue) => queue.id === id) ?? null,
    add(queue) {
      edit((queues) => ({ queues: [...queues, queue], answer: null }));
    },
    change,
    changeItem(id, itemId, fields) {
      return change(id, (queue) => ({ ...queue, items: queue.items.map((item) => (item.id === itemId ? clean({ ...item, ...fields }) : item)) }));
    },
    remove(id) {
      edit((queues) => ({ queues: queues.filter((queue) => queue.id !== id), answer: null }));
    },
    changedOnDisk: json.changedOnDisk,
  };
}
