import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SessionState } from "../../bridge/reducer.ts";
import type { BoardCall } from "../board/boardTools.ts";
import { presentIssue } from "../board/jira/jira.ts";
import { statusOf } from "../http.ts";
import { needsOf, type FinishMode } from "./queuePlan.ts";
import { createQueueRunner, type QueueHost, type QueueStart, type QueueView } from "./queueRunner.ts";
import { createQueueStore, type Queue } from "./queues.ts";
import { queueTools } from "./queueTools.ts";
import { RESUME } from "./queueText.ts";

interface Ticket {
  title: string;
  done?: boolean;
  subtasks?: string[];
  // The other ticket's id to the relation, as this ticket's read names it.
  related?: Record<string, string>;
}

function session(id: string, change: Partial<SessionState> = {}): SessionState {
  return { id, cwd: "", status: "running", stopReason: null, error: null, transcript: [], pendingPermission: null, pendingPlan: null, pendingElicitation: null, backgroundTasks: [], ...change } as SessionState;
}

function world(tickets: Record<string, Ticket>, options: { port?: number; adopts?: boolean; failWorktree?: string } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-queue-")));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "queues.json");
  const store = createQueueStore(file);
  const sessions = new Map<string, SessionState>();
  const threads: { cwd: string; taskId: string; prompt: string; rules: string; model: string }[] = [];
  const worktrees: { gitRef: string; name: string }[] = [];
  const told: { sessionId: string; text: string }[] = [];
  const filed: string[] = [];
  const prs = new Map<string, string>();
  const drafts = new Set<string>();
  // A worktree waits for hold.worktree while one is set.
  const hold: { worktree: Promise<void> | null; thread: Promise<void> | null } = { worktree: null, thread: null };
  const fail = { worktree: options.failWorktree ?? "", pr: "" };
  let views: QueueView[] = [];

  const linked = (id: string, relation?: string) => ({ id: /^\d+$/.test(id) ? Number(id) : id, title: tickets[id]?.title ?? "", done: Boolean(tickets[id]?.done), ...(relation ? { relation } : {}) });
  const board: BoardCall = async (method, route, body = {}) => {
    const url = new URL(route, "http://board");
    const read = /^\/api\/board\/tasks\/([^/]+)(\/brief)?$/.exec(url.pathname);
    if (method === "GET" && read) {
      const id = decodeURIComponent(read[1] ?? "");
      const ticket = tickets[id];
      if (!ticket) return { status: 404, body: { error: "There is no such ticket" } };
      if (read[2]) return { status: 200, body: { draft: `Implement ticket ${id}.` } };
      const related = Object.entries(ticket.related ?? {}).map(([other, relation]) => linked(other, relation));
      return { status: 200, body: { task: { id, title: ticket.title, subtasks: (ticket.subtasks ?? []).map((sub) => linked(sub, "subtask")), related } } };
    }
    if (method === "POST" && url.pathname === "/api/board/threads") {
      const sessionId = `chat-${String(body.taskId)}`;
      if (String(body.taskId) !== "10") await hold.thread;
      threads.push({ cwd: body.cwd ?? "", taskId: String(body.taskId), prompt: body.prompt ?? "", rules: body.rules ?? "", model: body.session?.model ?? "" });
      sessions.set(sessionId, session(sessionId));
      return { status: 201, body: { sessionId } };
    }
    return { status: 404, body: { error: "No such route" } };
  };
  const host: QueueHost = {
    port: options.port ?? 8787,
    adopts: options.adopts ?? false,
    board,
    session: (id) => sessions.get(id) ?? null,
    hostPrompt: () => false,
    async worktree(_folder, gitRef, _provider, name) {
      if (fail.worktree) throw new Error(fail.worktree);
      await hold.worktree;
      worktrees.push({ gitRef, name });
      return { path: `/wt/${name}`, branch: `claude/${name.toLowerCase()}` };
    },
    async pullRequest(cwd) {
      if (fail.pr) throw new Error(fail.pr);
      const status = prs.get(cwd);
      return status ? { number: 1, url: `https://github.test/pr${cwd}`, status, ...(drafts.has(cwd) ? { draft: true } : {}) } : null;
    },
    async tell(sessionId, _cwd, text) {
      told.push({ sessionId, text });
    },
    file: (_queue, sessionId) => void filed.push(sessionId),
    publish: (view) => void (views = view),
  };
  const runner = createQueueRunner({ host, store });
  // Lets the starts and reads a call set off run to their end.
  const settled = async () => {
    for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  };
  return {
    runner, store, file, sessions, threads, worktrees, told, filed, prs, drafts, hold, fail, tickets, settled,
    states: () => Object.fromEntries((runner.view()[0]?.items ?? []).map((item) => [item.id, item.state])),
    views: () => views,
    start: async (mode: FinishMode, slots = 2, taskId = "10", other: Pick<QueueStart, "main" | "tickets"> = {}) => {
      const queue = await runner.start({ cwd: "/repo", taskId, mode, slots, picks: { provider: "claude", model: "run", effort: "" }, ...other });
      await settled();
      return queue;
    },
    async turn(sessionId: string, change: Partial<SessionState>) {
      const next = session(sessionId, change);
      sessions.set(sessionId, next);
      runner.sessionChanged(next);
      await settled();
    },
    async tick() {
      runner.tick();
      await settled();
    },
  };
}

const idle = { status: "idle" as const, transcript: [{ id: "a", type: "assistant", text: "Opened the pull request." }] as SessionState["transcript"] };

// 1 has no needs, 2 is blocked by 1, and 3 follows 2.
function chain(): Record<string, Ticket> {
  return {
    "10": { title: "Parent", subtasks: ["1", "2", "3"] },
    "1": { title: "One", related: { "2": "blocks", "10": "parent" } },
    "2": { title: "Two", related: { "1": "blocked_by", "3": "precedes" } },
    "3": { title: "Three", related: { "2": "follows" } },
  };
}

test("in Merged mode each chat starts from main once the ticket before it is merged, to the end", async () => {
  const w = world(chain());
  const queue = await w.start("merged");
  assert.equal(queue.mainChat, "chat-10");
  assert.equal(w.threads[0]?.cwd, "/repo");
  assert.equal(w.threads[0]?.prompt, 'Queue run for ticket 10, "Parent".\n\n- 1 One\n- 2 Two (after 1)\n- 3 Three (after 2)');
  assert.match(w.threads[0]?.rules ?? "", /^This chat is the main chat of a queue run for ticket 10\..*once its pull request is merged\. At most 2 of the chats run at once\./);
  assert.equal(w.runner.rulesOf("chat-10"), w.threads[0]?.rules);
  assert.deepEqual(w.states(), { "1": "working", "2": "queued", "3": "queued" });
  assert.deepEqual(w.filed, ["chat-10", "chat-1"]);
  assert.equal(w.threads[1]?.prompt, "Implement ticket 1.");
  assert.match(w.threads[1]?.rules ?? "", /^This chat is part of a queue run of ticket 10\. When the work is done.*once its pull request is merged\.$/);
  assert.equal(w.runner.rulesOf("chat-1"), w.threads[1]?.rules);
  assert.equal(w.runner.rulesOf("chat-99"), "");

  w.prs.set("/wt/One", "ready");
  await w.turn("chat-1", idle);
  assert.deepEqual(w.states(), { "1": "review", "2": "queued", "3": "queued" });
  assert.match(w.told.at(-1)?.text ?? "", /^<x-bench-queue-event kind="stopped">Ticket 1, "One", ended its turn\. Its pull request .* waits to be merged\.<\/x-bench-queue-event>$/);

  w.prs.set("/wt/One", "merged");
  await w.tick();
  assert.deepEqual(w.states(), { "1": "done", "2": "working", "3": "queued" });
  assert.match(w.told.at(-1)?.text ?? "", /^<x-bench-queue-event kind="finished">Ticket 1, "One", is finished: its pull request .* is merged\.<\/x-bench-queue-event>$/);

  w.prs.set("/wt/Two", "merged");
  await w.turn("chat-2", idle);
  w.prs.set("/wt/Three", "merged");
  await w.turn("chat-3", idle);
  assert.deepEqual(w.states(), { "1": "done", "2": "done", "3": "done" });
  assert.deepEqual(w.worktrees.map((made) => made.gitRef), ["", "", ""]);
  assert.match(w.told.at(-1)?.text ?? "", /Every sub-ticket of ticket 10 is finished\. The run is over\.<\/x-bench-queue-event>$/);
  assert.equal(w.told.every((note) => note.sessionId === "chat-10"), true);
});

test("in PR open mode the next chat starts from the branch before it as soon as its pull request opens", async () => {
  const w = world(chain());
  await w.start("pr");
  // A draft does not finish its ticket, also while its checks run.
  w.prs.set("/wt/One", "running");
  w.drafts.add("/wt/One");
  await w.turn("chat-1", idle);
  assert.deepEqual(w.states(), { "1": "review", "2": "queued", "3": "queued" });
  assert.match(w.told.at(-1)?.text ?? "", /Its pull request .* is still a draft\./);
  w.drafts.clear();
  await w.tick();
  assert.deepEqual(w.states(), { "1": "done", "2": "working", "3": "queued" });
  assert.deepEqual(w.worktrees[1], { gitRef: "claude/one", name: "Two" });
  assert.match(w.threads[2]?.rules ?? "", /open a pull request that is not a draft against the branch claude\/one, which this worktree started from\..*once its pull request is open\.$/);
  assert.equal(w.runner.rulesOf("chat-2"), w.threads[2]?.rules);
  w.prs.set("/wt/Two", "ready");
  await w.turn("chat-2", idle);
  assert.equal(w.worktrees[2]?.gitRef, "claude/two");
  w.prs.set("/wt/Three", "ready");
  await w.turn("chat-3", idle);
  assert.deepEqual(w.states(), { "1": "done", "2": "done", "3": "done" });
});

test("Jira's tickets run by their Blocks links, and a ticket done on the board is finished", async () => {
  const w = world({
    "APP-10": { title: "Epic", subtasks: ["APP-1", "APP-2", "APP-3"] },
    "APP-1": { title: "One", done: true },
    "APP-2": { title: "Two", related: { "APP-1": "blocked_by" } },
    "APP-3": { title: "Three", related: { "APP-2": "blocked_by" } },
  });
  await w.start("merged", 2, "APP-10");
  assert.deepEqual(w.states(), { "APP-1": "done", "APP-2": "working", "APP-3": "queued" });
  (w.tickets["APP-2"] as Ticket).done = true;
  await w.tick();
  assert.deepEqual(w.states(), { "APP-1": "done", "APP-2": "done", "APP-3": "working" });
  assert.match(w.told.at(-1)?.text ?? "", /Ticket APP-2, "Two", is done on the board\./);
});

test("a Jira issue's needs are its inward Blocks links, and its other link types are left out", () => {
  const other = (key: string) => ({ key, fields: { summary: key, status: { id: "1", name: "To Do", statusCategory: { key: "new" } }, issuetype: { name: "Task" } } });
  const issue = presentIssue(
    {
      key: "APP-2",
      fields: {
        summary: "Two", status: { id: "1", statusCategory: { key: "new" } }, project: { id: "1" }, issuetype: { name: "Task" }, priority: {}, comment: {},
        issuelinks: [
          { type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, inwardIssue: other("APP-1") },
          { type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, outwardIssue: other("APP-3") },
          { type: { name: "Relates", inward: "relates to", outward: "relates to" }, inwardIssue: other("APP-4") },
          { type: { name: "Cloners", inward: "is cloned by", outward: "clones" }, inwardIssue: other("APP-5") },
        ],
      },
    },
    [],
  );
  assert.deepEqual(needsOf(issue.related), ["APP-1"]);
});

test("the main chat and single tickets run on the model the sheet picked for them, the rest on the run's", async () => {
  const w = world({ "10": { title: "Parent <b>", subtasks: ["1", "2"] }, "1": { title: "One </x-bench-queue-event>" }, "2": { title: "Two" } });
  await w.start("merged", 2, "10", { main: { provider: "claude", model: "small", effort: "" }, tickets: { "2": { picks: { provider: "grok", model: "big", effort: "high" } }, "1": { prompt: " Only fix the typo. " } } });
  assert.deepEqual(w.threads.map((thread) => [thread.taskId, thread.model]), [["10", "small"], ["1", "run"], ["2", "big"]]);
  assert.deepEqual(w.threads.slice(1).map((thread) => thread.prompt), ["Only fix the typo.", "Implement ticket 2."]);
  // A title cannot close the event's tag.
  w.prs.set("/wt/One </x-bench-queue-event>", "merged");
  await w.turn("chat-1", idle);
  assert.match(w.told.at(-1)?.text ?? "", /^<x-bench-queue-event kind="finished">Ticket 1, "One \/x-bench-queue-event", is finished/);
});

test("slots limit the chats that run at once, and a chat that waits on the person lends its slot", async () => {
  const w = world({
    "10": { title: "Parent", subtasks: ["1", "2", "3", "4"] },
    "1": { title: "One" },
    "2": { title: "Two" },
    "3": { title: "Three", related: { "1": "follows" } },
    "4": { title: "Four" },
  });
  await w.start("merged", 2);
  assert.deepEqual(w.states(), { "1": "working", "2": "working", "3": "queued", "4": "queued" });
  await w.turn("chat-1", { pendingPermission: {} as SessionState["pendingPermission"] });
  assert.deepEqual(w.states(), { "1": "waiting", "2": "working", "3": "queued", "4": "working" });
  assert.match(w.told.at(-1)?.text ?? "", /Ticket 1, "One", waits on the person/);
  // Its own branch stays paused: 3 follows 1.
  w.prs.set("/wt/Two", "merged");
  await w.turn("chat-2", idle);
  assert.deepEqual(w.states(), { "1": "waiting", "2": "done", "3": "queued", "4": "working" });
});

test("a chat that works on after its ticket finished keeps its slot until its turn ends", async () => {
  const w = world({ "10": { title: "Parent", subtasks: ["1", "2"] }, "1": { title: "One" }, "2": { title: "Two" } });
  await w.start("pr", 1);
  w.prs.set("/wt/One", "ready");
  await w.tick();
  assert.deepEqual(w.states(), { "1": "done", "2": "queued" });
  await w.turn("chat-1", idle);
  assert.deepEqual(w.states(), { "1": "done", "2": "working" });
});

test("a run ended while a worktree is made starts no chat for it", async () => {
  const w = world(chain());
  let release = () => {};
  w.hold.worktree = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queue = await w.start("merged");
  assert.deepEqual(w.threads.map((thread) => thread.taskId), ["10"]);
  w.runner.end(queue.id);
  release();
  await w.settled();
  assert.deepEqual(w.threads.map((thread) => thread.taskId), ["10"]);
  assert.deepEqual(w.filed, ["chat-10"]);
});

test("a turn that ends while the pull request cannot be read is still told to the main chat", async () => {
  const w = world(chain());
  await w.start("merged");
  w.fail.pr = "gh: not logged in";
  await w.turn("chat-1", idle);
  assert.match(w.told.at(-1)?.text ?? "", /^<x-bench-queue-event kind="stopped">Ticket 1, "One", ended its turn\. Its pull request could not be read: gh: not logged in<\/x-bench-queue-event>$/);
  assert.deepEqual(w.states(), { "1": "idle", "2": "queued", "3": "queued" });
});

test("a finished run gives way to a new run of the same parent, and an unfinished one refuses it", async () => {
  const tickets: Record<string, Ticket> = { "10": { title: "Parent", subtasks: ["1"] }, "1": { title: "One" }, "2": { title: "Two" } };
  const w = world(tickets);
  const first = await w.start("merged");
  await assert.rejects(w.start("merged"), (error) => statusOf(error, 0) === 409);
  w.prs.set("/wt/One", "merged");
  await w.turn("chat-1", idle);
  (tickets["1"] as Ticket).done = true;
  (tickets["10"] as Ticket).subtasks = ["1", "2"];
  const second = await w.start("merged");
  assert.deepEqual(w.runner.view().map((queue) => queue.id), [second.id]);
  assert.notEqual(second.id, first.id);
  assert.deepEqual(w.states(), { "1": "done", "2": "working" });
});

test("a run ended while a ticket's chat opens does not file that chat", async () => {
  const w = world(chain());
  let release = () => {};
  w.hold.thread = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queue = await w.start("merged");
  w.runner.end(queue.id);
  release();
  await w.settled();
  assert.deepEqual(w.threads.map((thread) => thread.taskId), ["10", "1"]);
  assert.deepEqual(w.filed, ["chat-10"]);
  assert.equal(w.runner.queueOf("chat-1"), null);
});

test("a cycle and a parent without sub-tickets are refused", async () => {
  const cycle = world({
    "10": { title: "Parent", subtasks: ["1", "2"] },
    "1": { title: "One", related: { "2": "blocked_by" } },
    "2": { title: "Two", related: { "1": "follows" } },
  });
  await assert.rejects(cycle.start("merged"), (error) => statusOf(error, 0) === 409 && /These tickets wait on each other: 1 → 2 → 1/.test(String(error)));
  assert.deepEqual((await cycle.runner.check("10")).cycle, ["1", "2", "1"]);
  assert.equal(cycle.threads.length, 0);
  const alone = world({ "10": { title: "Parent" } });
  await assert.rejects(alone.start("merged"), (error) => statusOf(error, 0) === 400);
});

test("a prerequisite outside the parent is named as queued or not, and holds its ticket until it is done", async () => {
  const tickets: Record<string, Ticket> = {
    "10": { title: "Parent", subtasks: ["1", "2"] },
    "1": { title: "One", related: { "90": "blocked_by", "91": "follows" } },
    "2": { title: "Two" },
    "90": { title: "Elsewhere" },
    "91": { title: "Shipped", done: true },
    "20": { title: "Other parent", subtasks: ["90"] },
  };
  const w = world(tickets);
  assert.deepEqual((await w.runner.check("10")).outside, [
    { id: "90", title: "Elsewhere", done: false, queued: false },
    { id: "91", title: "Shipped", done: true, queued: false },
  ]);
  await w.start("merged", 2, "20");
  assert.equal((await w.runner.check("10")).outside[0]?.queued, true);
  await w.start("merged", 2, "10");
  const states = () => Object.fromEntries((w.runner.view()[1]?.items ?? []).map((item) => [item.id, item.state]));
  assert.deepEqual(states(), { "1": "queued", "2": "working" });
  (tickets["90"] as Ticket).done = true;
  await w.tick();
  assert.deepEqual(states(), { "1": "working", "2": "working" });
  await assert.rejects(w.start("merged", 2, "10"), (error) => statusOf(error, 0) === 409);
});

test("a start that fails holds back only its own branch, and starts again on retry", async () => {
  const w = world(chain(), { failWorktree: "fatal: not a git repository" });
  await w.start("merged");
  assert.equal(w.runner.view()[0]?.items[0]?.state, "failed");
  assert.equal(w.runner.view()[0]?.items[0]?.reason, "fatal: not a git repository");
  assert.match(w.told.at(-1)?.text ?? "", /Ticket 1, "One", did not start: fatal: not a git repository/);
  assert.throws(() => w.runner.retry(w.runner.view()[0]?.id ?? "", "2"), (error) => statusOf(error, 0) === 409);
  w.fail.worktree = "";
  w.runner.retry(w.runner.view()[0]?.id ?? "", "1");
  await w.settled();
  assert.deepEqual(w.states(), { "1": "working", "2": "queued", "3": "queued" });
});

test("a host that starts on the same port takes the queue over and tells an interrupted chat to go on", async () => {
  const first = world(chain());
  await first.start("merged");
  first.runner.stop();
  const stored = JSON.parse(fs.readFileSync(first.file, "utf8")) as { queues: Queue[] };
  assert.equal(stored.queues[0]?.items[0]?.interrupted, true);
  // The same file as a host that is gone left it.
  const rewrite = (dir: string, port: number) => {
    const file = path.join(dir, "queues.json");
    fs.writeFileSync(file, JSON.stringify({ queues: stored.queues.map((queue) => ({ ...queue, pid: 1, port })) }));
  };

  const next = world(chain(), { port: 8787 });
  rewrite(path.dirname(next.file), 8787);
  assert.equal(next.runner.view()[0]?.here, false);
  next.prs.set("/wt/One", "merged");
  await next.tick();
  assert.equal(next.runner.view()[0]?.here, true);
  assert.deepEqual(next.told[0], { sessionId: "chat-1", text: RESUME });
  assert.deepEqual(next.states(), { "1": "done", "2": "working", "3": "queued" });

  // pid 1 is alive, so a host on another port leaves the queue to it.
  const other = world(chain(), { port: 8798, adopts: true });
  rewrite(path.dirname(other.file), 8797);
  await other.tick();
  assert.equal(other.runner.view()[0]?.here, false);
  assert.equal(other.told.length, 0);
});

test("a chat told to go on after a relaunch holds its slot while it loads", async () => {
  const tickets = { "10": { title: "Parent", subtasks: ["1", "2"] }, "1": { title: "One" }, "2": { title: "Two" } };
  const first = world(tickets);
  await first.start("merged", 1);
  first.runner.stop();
  const stored = JSON.parse(fs.readFileSync(first.file, "utf8")) as { queues: Queue[] };
  const next = world(tickets);
  fs.writeFileSync(next.file, JSON.stringify({ queues: stored.queues.map((queue) => ({ ...queue, pid: 1 })) }));
  await next.tick();
  assert.deepEqual(next.told, [{ sessionId: "chat-1", text: RESUME }]);
  assert.deepEqual(next.states(), { "1": "working", "2": "queued" });
});

test("the main chat reads the queue and a sub-ticket chat's last reply, and ending the run forgets it", async () => {
  const w = world(chain());
  const queue = await w.start("pr");
  const [read, result] = queueTools(() => w.runner).tools;
  const call = async (tool: typeof read, args: unknown, sessionId: string) => (await tool?.call(args, { sessionId, signal: new AbortController().signal }))?.content[0]?.text ?? "";
  w.prs.set("/wt/One", "ready");
  await w.turn("chat-1", idle);
  const text = await call(read, {}, "chat-10");
  assert.match(text, /Queue of ticket 10, "Parent"\. A sub-ticket is finished at: PR open\. Slots: 2\./);
  assert.match(text, /^1 \| One \| done \| - \| chat-1 \| https:\/\/github\.test\/pr\/wt\/One$/m);
  assert.match(text, /^3 \| Three \| queued \| 2 \| - \| -$/m);
  assert.equal(await call(result, { ticket: "1" }, "chat-10"), "Opened the pull request.");
  assert.equal(await call(result, { ticket: "3" }, "chat-10"), "Its chat has not started yet.");
  assert.equal(await call(read, {}, "chat-99"), "This chat belongs to no queue run.");
  w.runner.end(queue.id);
  assert.deepEqual(w.views(), []);
  assert.equal(await call(read, {}, "chat-10"), "This chat belongs to no queue run.");
});
