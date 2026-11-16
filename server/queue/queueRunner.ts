// Runs queues: one chat per sub-ticket of a parent, each started once the tickets it waits on are finished, as many
// at once as the run has slots. The host a queue names runs it, and another host takes it over once that one is gone.

import { randomBytes } from "node:crypto";
import { isRecord } from "../../bridge/lenient.ts";
import { pidAlive } from "../../bridge/fileLock.ts";
import type { SessionState } from "../../bridge/reducer.ts";
import type { BoardCall, BoardReply } from "../board/boardTools.ts";
import { httpError, messageOf } from "../http.ts";
import { finishes, nextStarts, type EventKind, type FinishMode, type StoredState } from "./queuePlan.ts";
import { doneOnBoard, readPlan, type QueuePlan } from "./queueRead.ts";
import { allDoneNote, eventMessage, failedNote, finishedNote, mainPrompt, mainRules, RESUME, stoppedNote, subRules, unreadNote, waitingNote } from "./queueText.ts";
import type { OutsideTicket, Queue, QueueItem, QueueStore } from "./queues.ts";

// review: its pull request waits to be merged. idle: its turn ended without a pull request.
export type ItemState = Exclude<StoredState, "started"> | "working" | "waiting" | "review" | "idle";

export interface QueueItemView extends Pick<QueueItem, "id" | "title" | "needs" | "sessionId" | "cwd" | "pr" | "reason"> {
  state: ItemState;
}

export interface QueueView extends Pick<Queue, "id" | "cwd" | "parent" | "mode" | "slots" | "folderId"> {
  mainChat: string | null;
  // This host runs it.
  here: boolean;
  items: QueueItemView[];
  outside: OutsideTicket[];
}

export interface QueueStart {
  cwd: string;
  taskId: string;
  mode: FinishMode;
  slots: number;
  picks: Queue["picks"];
  // The main chat's model and effort, and a single sub-ticket's with its prompt, where they are others than the run's.
  main?: Queue["picks"] | undefined;
  tickets?: Record<string, { picks?: Queue["picks"] | undefined; prompt?: string | undefined }> | undefined;
}

export interface QueueHost {
  port: number;
  // This host takes over a queue of any host that is gone. Otherwise only one that ran on its own port.
  adopts: boolean;
  board: BoardCall;
  session(sessionId: string): SessionState | null;
  // The app's own permission card waits in the chat.
  hostPrompt(sessionId: string): boolean;
  // A worktree of folder on a new branch at gitRef, or at the latest main for an empty one.
  worktree(folder: string, gitRef: string, provider: string, name: string): Promise<{ path: string; branch: string }>;
  // Rejects when the pull request could not be read.
  pullRequest(cwd: string): Promise<NonNullable<QueueItem["pr"]> | null>;
  // Sends a message into a chat, opened in cwd first when it is closed.
  tell(sessionId: string, cwd: string, text: string): Promise<void>;
  // Puts a chat into the run's sidebar folder, made when it is missing.
  file(queue: Queue, sessionId: string): void;
  publish(view: QueueView[]): void;
}

export interface QueueRunner {
  check(taskId: string): Promise<QueuePlan>;
  // Errors carry the status to answer with.
  start(request: QueueStart): Promise<QueueView>;
  // Forgets the run. Its chats and its folder stay.
  end(id: string): void;
  retry(id: string, itemId: string): void;
  tick(): void;
  sessionChanged(session: SessionState): void;
  promptsChanged(): void;
  view(): QueueView[];
  // Another host changed the file.
  refresh(): void;
  // The queue a chat belongs to, as its main chat or as a sub-ticket's chat.
  queueOf(sessionId: string): Queue | null;
  // The run's lines for a chat's system prompt, empty for a chat of no run.
  rulesOf(sessionId: string): string;
  stop(): void;
}

// A chat counts as working this long after its start, until its first turn shows.
export const FRESH_MS = 120_000;
export const RESULT_LIMIT = 6000;

interface Track {
  queueId: string;
  itemId: string;
  sawWork: boolean;
  startedAt: number;
  state: "working" | "waiting" | "idle";
  // The main chat heard that this turn waits on the person.
  told: boolean;
}

function errorOf(reply: BoardReply): string {
  return isRecord(reply.body) && typeof reply.body.error === "string" ? reply.body.error : `The board answered ${reply.status}`;
}

function lastReply(session: SessionState): string {
  const reply = session.transcript.findLast((item) => item.type === "assistant" && item.text);
  return (reply?.text ?? "").slice(-RESULT_LIMIT);
}

async function briefOf(board: BoardCall, cwd: string, ticket: string): Promise<string> {
  const brief = await board("GET", `/api/board/tasks/${encodeURIComponent(ticket)}/brief?${new URLSearchParams({ cwd })}`);
  if (brief.status >= 400 || !isRecord(brief.body)) throw new Error(errorOf(brief));
  return String(brief.body.draft ?? "");
}

// The branches of the tickets a stacked chat waits on.
function stackOf(queue: Queue, item: QueueItem): string[] {
  return queue.mode === "pr" ? queue.items.flatMap((other) => (item.needs.includes(other.id) && other.branch ? [other.branch] : [])) : [];
}

function turnOf(host: QueueHost, session: SessionState): Track["state"] {
  if (session.pendingPermission || session.pendingPlan || session.pendingElicitation || host.hostPrompt(session.id)) return "waiting";
  return session.status === "running" || session.backgroundTasks.some((task) => task.status === "running") ? "working" : "idle";
}

// Takes over the queues whose host is gone, and tells each chat whose turn ran at the quit to go on.
function adopt(host: QueueHost, store: QueueStore, tracked: Map<string, Track>, now: number) {
  for (const queue of store.list()) {
    const gone = queue.port === host.port || (host.adopts && !pidAlive(queue.pid));
    if (queue.pid === process.pid || !gone) continue;
    const taken = store.change(queue.id, (current) => (current.pid === queue.pid ? { ...current, pid: process.pid, port: host.port } : current));
    if (taken?.pid !== process.pid) continue;
    for (const item of taken.items) {
      if (item.state !== "started" || !item.sessionId || !item.cwd) continue;
      // A chat told to go on holds its slot while it loads.
      tracked.set(item.sessionId, { queueId: taken.id, itemId: item.id, sawWork: false, startedAt: item.interrupted ? now : 0, state: "idle", told: false });
      if (!item.interrupted) continue;
      store.changeItem(taken.id, item.id, { interrupted: undefined });
      host.tell(item.sessionId, item.cwd, RESUME).catch((error: unknown) => console.error(`queue ${taken.id}: ticket ${item.id} did not go on: ${messageOf(error)}`));
    }
  }
}

export function createQueueRunner({ host, store, now = Date.now }: { host: QueueHost; store: QueueStore; now?: () => number }): QueueRunner {
  const tracked = new Map<string, Track>();
  const busy = new Set<string>();
  let stopped = false;

  const mine = () => store.list().filter((queue) => queue.pid === process.pid);
  const publish = () => host.publish(view());
  const itemOf = (queueId: string, itemId: string) => store.get(queueId)?.items.find((item) => item.id === itemId);
  const queueOf = (sessionId: string) => store.list().find((queue) => queue.mainChat === sessionId || queue.items.some((item) => item.sessionId === sessionId)) ?? null;

  function live(sessionId: string | undefined): Track["state"] {
    const session = sessionId ? host.session(sessionId) : null;
    const state = session ? turnOf(host, session) : "idle";
    if (state !== "idle") return state;
    const entry = sessionId ? tracked.get(sessionId) : undefined;
    return entry && !entry.sawWork && now() - entry.startedAt < FRESH_MS ? "working" : "idle";
  }

  function stateOf(item: QueueItem): ItemState {
    if (item.state !== "started") return item.state;
    const state = live(item.sessionId);
    return state === "idle" ? (item.pr ? "review" : "idle") : state;
  }

  function view(): QueueView[] {
    return store.list().map(({ id, cwd, parent, mode, slots, folderId, mainChat, items, outside, pid }) => ({
      id, cwd, parent, mode, slots, folderId, mainChat: mainChat ?? null, here: pid === process.pid, outside,
      items: items.map((item) => ({ id: item.id, title: item.title, needs: item.needs, state: stateOf(item), ...(item.sessionId ? { sessionId: item.sessionId } : {}), ...(item.cwd ? { cwd: item.cwd } : {}), ...(item.pr ? { pr: item.pr } : {}), ...(item.reason ? { reason: item.reason } : {}) })),
    }));
  }

  function tell(queue: Queue, kind: EventKind, text: string) {
    if (!queue.mainChat || stopped) return;
    host.tell(queue.mainChat, queue.cwd, eventMessage(kind, text)).catch((error: unknown) => console.error(`queue ${queue.id}: the main chat was not told: ${messageOf(error)}`));
  }

  function finish(queueId: string, itemId: string, pr?: QueueItem["pr"]) {
    if (itemOf(queueId, itemId)?.state === "done") return;
    const queue = store.changeItem(queueId, itemId, { state: "done", ...(pr ? { pr } : {}) });
    const item = queue?.items.find((entry) => entry.id === itemId);
    if (!queue || !item) return;
    tell(queue, "finished", [finishedNote(item, pr), ...(queue.items.every((entry) => entry.state === "done") ? [allDoneNote(queue)] : [])].join(" "));
  }

  // Reads one started ticket's pull request and finishes the ticket when the run's mode says so.
  async function settle(queueId: string, itemId: string, turnEnded = false) {
    const queue = store.get(queueId);
    const item = queue?.items.find((entry) => entry.id === itemId);
    if (!queue || item?.state !== "started" || !item.cwd) return;
    let pr: QueueItem["pr"];
    try {
      pr = (await host.pullRequest(item.cwd)) ?? undefined;
    } catch (error) {
      if (turnEnded) tell(queue, "stopped", unreadNote(item, messageOf(error)));
      return;
    }
    if (finishes(queue.mode, pr)) return finish(queueId, itemId, pr);
    if (pr && JSON.stringify(pr) !== JSON.stringify(item.pr)) store.changeItem(queueId, itemId, { pr });
    if (turnEnded) tell(queue, "stopped", stoppedNote(item, pr));
  }

  async function review(queue: Queue) {
    if (queue.items.every((item) => item.state === "done")) return;
    for (const item of queue.items) if (item.state === "started") await settle(queue.id, item.id);
    const done = await doneOnBoard(host.board, queue).catch(() => new Set<string>());
    for (const item of queue.items) if (done.has(item.id)) finish(queue.id, item.id);
    if (queue.outside.some((ticket) => !ticket.done && done.has(ticket.id))) {
      store.change(queue.id, (current) => ({ ...current, outside: current.outside.map((ticket) => (done.has(ticket.id) ? { ...ticket, done: true } : ticket)) }));
    }
  }

  async function startItem(queue: Queue, item: QueueItem) {
    let kept = "";
    try {
      const prompt = item.prompt ?? (await briefOf(host.board, queue.cwd, item.id));
      // A stacked chat starts from the branch of the last ticket it waits on.
      const branches = stackOf(queue, item);
      const base = branches.at(-1) ?? "";
      const picks = item.picks ?? queue.picks;
      const made = await host.worktree(queue.cwd, base, picks.provider, item.title || `Ticket ${item.id}`);
      kept = ` The worktree is at ${made.path}.`;
      // The run may have ended, or moved to another host, while the worktree was made.
      if (stopped || store.get(queue.id)?.pid !== process.pid) return;
      const opened = await host.board("POST", "/api/board/threads", { cwd: made.path, taskId: item.id, prompt, rules: subRules(queue, base, branches.slice(0, -1)), session: picks });
      const sessionId = isRecord(opened.body) && typeof opened.body.sessionId === "string" ? opened.body.sessionId : "";
      if (opened.status >= 400 || !sessionId) throw new Error(errorOf(opened));
      // The run may have ended while the chat opened. The chat stays, outside any run.
      if (stopped || store.get(queue.id)?.pid !== process.pid) return;
      tracked.set(sessionId, { queueId: queue.id, itemId: item.id, sawWork: host.session(sessionId)?.status === "running", startedAt: now(), state: "working", told: false });
      store.changeItem(queue.id, item.id, { state: "started", sessionId, cwd: made.path, branch: made.branch, ...(base ? { base } : {}), reason: undefined });
      host.file(queue, sessionId);
    } catch (error) {
      const reason = `${messageOf(error) || "The chat did not start"}${kept}`;
      store.changeItem(queue.id, item.id, { state: "failed", reason });
      tell(queue, "failed", failedNote(item, reason));
    }
  }

  // One job per queue at a time: reading what finished, then starting what may start. A call that comes meanwhile
  // is covered by the running one, which reads the queue again before every start.
  async function advance(queueId: string, read = false) {
    if (stopped || busy.has(queueId)) return;
    busy.add(queueId);
    try {
      const first = store.get(queueId);
      if (read && first?.pid === process.pid) await review(first);
      for (;;) {
        const queue = store.get(queueId);
        if (stopped || queue?.pid !== process.pid) break;
        // A chat that works on after its ticket finished still holds its slot.
        const working = queue.items.filter((item) => item.sessionId && live(item.sessionId) === "working").length;
        const open = new Set(queue.outside.filter((ticket) => !ticket.done).map((ticket) => ticket.id));
        const next = nextStarts(queue.items, open, queue.slots, working)[0];
        if (!next) break;
        await startItem(queue, next);
        publish();
      }
    } catch (error) {
      console.error(`queue ${queueId} failed: ${messageOf(error)}`);
    } finally {
      busy.delete(queueId);
      publish();
    }
  }

  function sessionChanged(session: SessionState) {
    const entry = tracked.get(session.id);
    if (!entry || stopped) return;
    const state = turnOf(host, session);
    if (state === "working") entry.sawWork = true;
    if (state === entry.state) return;
    entry.state = state;
    const queue = store.get(entry.queueId);
    const item = queue?.items.find((other) => other.id === entry.itemId);
    if (!queue || !item || queue.pid !== process.pid) return;
    if (state === "waiting" && !entry.told) {
      entry.told = true;
      tell(queue, "waiting", waitingNote(item));
    }
    if (state === "idle" && entry.sawWork) {
      entry.told = false;
      store.changeItem(queue.id, item.id, { result: lastReply(session) });
      void settle(queue.id, item.id, true).then(() => advance(queue.id));
      return;
    }
    // A chat that waits lends its slot.
    void advance(queue.id);
  }

  return {
    check: (taskId) => readPlan(host.board, taskId, store.list()),
    async start({ cwd, taskId, mode, slots, picks, main, tickets = {} }) {
      const plan = await readPlan(host.board, taskId, store.list());
      if (!plan.items.length) throw httpError("This ticket has no sub-tickets", 400);
      if (plan.cycle) throw httpError(`These tickets wait on each other: ${plan.cycle.join(" → ")}`, 409);
      if (plan.items.every((item) => item.done)) throw httpError("Every sub-ticket is done", 409);
      // A run whose tickets are all finished gives way to the new one.
      const earlier = store.list().filter((queue) => queue.cwd === cwd && queue.parent.id === plan.parent.id);
      if (earlier.some((queue) => queue.items.some((item) => item.state !== "done"))) throw httpError("This ticket's queue runs already", 409);
      const queue: Queue = {
        id: randomBytes(4).toString("hex"), cwd, parent: plan.parent, mode, slots, picks, folderId: randomBytes(6).toString("hex"), startedAt: new Date(now()).toISOString(), pid: process.pid, port: host.port,
        items: plan.items.map(({ id, title, needs, done }) => ({ id, title, needs, state: done ? "done" : "queued", ...(tickets[id]?.picks ? { picks: tickets[id].picks } : {}), ...(tickets[id]?.prompt?.trim() ? { prompt: tickets[id].prompt.trim() } : {}) })),
        outside: plan.outside.map(({ id, title, done }) => ({ id, title, done })),
      };
      const opened = await host.board("POST", "/api/board/threads", { cwd, taskId, prompt: mainPrompt(queue), rules: mainRules(queue), session: main ?? picks });
      const mainChat = isRecord(opened.body) && typeof opened.body.sessionId === "string" ? opened.body.sessionId : "";
      if (opened.status >= 400 || !mainChat) throw httpError(errorOf(opened), opened.status >= 400 ? opened.status : 502);
      for (const old of earlier) store.remove(old.id);
      store.add({ ...queue, mainChat });
      host.file(queue, mainChat);
      void advance(queue.id);
      return view().find((entry) => entry.id === queue.id) as QueueView;
    },
    end(id) {
      for (const [sessionId, entry] of tracked) if (entry.queueId === id) tracked.delete(sessionId);
      store.remove(id);
      publish();
    },
    retry(id, itemId) {
      if (itemOf(id, itemId)?.state !== "failed") throw httpError("That ticket did not fail", 409);
      store.changeItem(id, itemId, { state: "queued", reason: undefined });
      void advance(id);
    },
    tick() {
      if (stopped) return;
      adopt(host, store, tracked, now());
      for (const queue of mine()) void advance(queue.id, true);
    },
    sessionChanged,
    promptsChanged() {
      for (const sessionId of tracked.keys()) {
        const session = host.session(sessionId);
        if (session) sessionChanged(session);
      }
    },
    view,
    refresh: publish,
    queueOf,
    rulesOf(sessionId) {
      const queue = queueOf(sessionId);
      const item = queue?.items.find((entry) => entry.sessionId === sessionId);
      if (!queue) return "";
      return item ? subRules(queue, item.base ?? "", stackOf(queue, item).filter((branch) => branch !== item.base)) : mainRules(queue);
    },
    stop() {
      for (const queue of mine()) {
        for (const item of queue.items) {
          if (item.state !== "started" || live(item.sessionId) !== "working") continue;
          try {
            store.changeItem(queue.id, item.id, { interrupted: true });
          } catch {
            // The chat then shows as stopped.
          }
        }
      }
      stopped = true;
    },
  };
}
