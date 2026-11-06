import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SessionState } from "../../bridge/reducer.ts";
import type { ChatStartOptions, StartedChat } from "../chat/chatStart.ts";
import { addWorktree } from "../git/worktree.ts";
import type { SchedulerLock } from "./routineLock.ts";
import { createRoutineRunStore, MAX_RUNS, type RoutineRun } from "./routineRuns.ts";
import { createRoutineScheduler, FAILURES_TO_PAUSE, KEEP_WORKTREE_MS, ONCE_SKIPPED, PAUSED_WHILE_QUEUED, RESCHEDULED_WHILE_QUEUED, STILL_GOING, STOPPED_WITH_HOST, WORKTREE_CHECK_MS, type RoutineHost, type RoutineNote, type RoutinesView } from "./routineScheduler.ts";
import { MISSED } from "./routineSchedule.ts";
import { createRoutineStore, type RoutineFields } from "./routines.ts";

process.env.TZ = "Europe/Berlin";

function scratch() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-routines-")));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function session(id: string, cwd: string, change: Partial<SessionState> = {}): SessionState {
  return { id, cwd, status: "running", stopReason: null, error: null, pendingPermission: null, pendingPlan: null, pendingElicitation: null, backgroundTasks: [], ...change } as SessionState;
}

interface World {
  scheduler: ReturnType<typeof createRoutineScheduler>;
  routines: ReturnType<typeof createRoutineStore>;
  runs: ReturnType<typeof createRoutineRunStore>;
  starts: ChatStartOptions[];
  notes: RoutineNote[];
  views: RoutinesView[];
  sessions: Map<string, SessionState>;
  forgotten: string[];
  archived: string[];
  unread: Set<string>;
  clock: { now: Date };
  lock: { free: boolean; held: boolean };
  dir: string;
  enabled: { value: boolean };
  // Sessions with a browser or simulator prompt waiting in the host's card.
  hostPrompts: Set<string>;
  onDesk: Set<string>;
  add(fields?: Partial<RoutineFields>): string;
  finish(id: string, change?: Partial<SessionState>): void;
}

function world(options: { maxWorking?: number; failStart?: string; at?: string; defaultMode?: string; onStart?: () => void } = {}): World {
  const dir = scratch();
  const clock = { now: new Date(options.at ?? "2026-10-01T12:00:00") };
  const routines = createRoutineStore(path.join(dir, "routines.json"), () => clock.now);
  const runs = createRoutineRunStore(path.join(dir, "routine-runs.json"));
  const sessions = new Map<string, SessionState>();
  const starts: ChatStartOptions[] = [];
  const notes: RoutineNote[] = [];
  const views: RoutinesView[] = [];
  const forgotten: string[] = [];
  const archived: string[] = [];
  const unread = new Set<string>();
  const enabled = { value: true };
  const hostPrompts = new Set<string>();
  const onDesk = new Set<string>();
  const lockState = { free: true, held: false };
  const lock: SchedulerLock = {
    take: () => {
      if (lockState.held) return true;
      lockState.held = lockState.free;
      return lockState.held;
    },
    held: () => lockState.held,
    holder: () => (lockState.held ? { port: 8797, pid: process.pid } : lockState.free ? null : { port: 8787, pid: 1 }),
    release: () => {
      lockState.held = false;
    },
  };
  const provider = {
    id: "grok",
    label: "Grok",
    modes: [{ id: "full" }, { id: "acceptEdits" }, { id: "plan" }],
    models: () => ({ models: [{ value: "grok-build" }] }),
    getSession: (id: string) => sessions.get(id),
    forgetSession: async (id: string) => {
      forgotten.push(id);
      sessions.delete(id);
    },
  };
  const host = {
    providers: {
      get: (id: string) => (id === "grok" ? provider : undefined),
      isEnabled: () => enabled.value,
      defaultMode: () => options.defaultMode ?? "full",
      getSession: (id: string) => sessions.get(id),
    },
    store: { sidebarState: { archived }, unreadIds: unread },
    paths: { chatHome: path.join(dir, "chat"), worktrees: path.join(dir, "worktrees") },
    chatRows: () => [],
    desk: { has: (id: string) => onDesk.has(id) },
    surfaces: { parked: () => [] },
    browser: { prompt: (id: string) => (hostPrompts.has(id) ? {} : null) },
    changeSidebar: (change: (state: { archived: string[] }) => { archived: string[] }) => {
      const next = change({ archived: [...archived] });
      archived.splice(0, archived.length, ...next.archived);
    },
    publish: () => {},
    catalogSnapshot: () => ({}),
  } as unknown as RoutineHost;
  let count = 0;
  const scheduler = createRoutineScheduler({
    host,
    routines,
    runs,
    schedule: true,
    lock,
    publish: (view) => views.push(view),
    notify: (note) => notes.push(note),
    now: () => clock.now,
    closeAfterMs: 0,
    ...(options.maxWorking ? { maxWorking: options.maxWorking } : {}),
    async start(_host, chat): Promise<StartedChat> {
      starts.push(chat);
      if (options.failStart) throw Object.assign(new Error(options.failStart), { status: 500 });
      count += 1;
      const created = session(`run-${count}`, chat.folder);
      options.onStart?.();
      if (chat.stillWanted && !chat.stillWanted()) throw Object.assign(new Error("called off"), { status: 409 });
      sessions.set(created.id, { ...created, status: "idle" });
      chat.onCreated?.(created, chat.folder);
      sessions.set(created.id, created);
      scheduler.sessionChanged(created);
      return { session: created, cwd: chat.folder, sent: Promise.resolve(true) };
    },
  });
  return {
    scheduler,
    routines,
    runs,
    starts,
    notes,
    views,
    sessions,
    forgotten,
    archived,
    unread,
    clock,
    lock: lockState,
    dir,
    enabled,
    hostPrompts,
    onDesk,
    add(fields = {}) {
      return routines.create({
        name: "Dependency check",
        prompt: "Check the dependencies.",
        cwd: dir,
        start: "worktree",
        provider: "grok",
        model: "grok-build",
        effort: "",
        mode: "full",
        schedule: { every: "day", at: "09:00", days: [0, 1, 2, 3, 4, 5, 6] },
        catchUp: true,
        notify: true,
        enabled: true,
        ...fields,
      }).id;
    },
    finish(id, change = {}) {
      const done = { ...session(id, dir), status: "idle" as const, stopReason: "end_turn", ...change };
      sessions.set(id, done);
      scheduler.sessionChanged(done);
    },
  };
}

async function until(check: () => boolean) {
  for (let round = 0; round < 500 && !check(); round += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  assert.ok(check(), "timed out");
}

function gitRepo(dir: string): string {
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "note.txt"), "one\n");
  git("add", "note.txt");
  git("commit", "-m", "init");
  return repo;
}

// Lets the scheduler's queued starts run.
async function settle() {
  for (let round = 0; round < 5; round += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

test("a routine runs at its time once, as a chat named after it on a dated branch", async () => {
  const w = world();
  const id = w.add();
  w.clock.now = new Date("2026-10-02T09:00:20");
  w.scheduler.tick();
  await settle();
  assert.equal(w.starts.length, 1);
  const [chat] = w.starts;
  assert.equal(chat?.title, "Dependency check · Oct 2");
  assert.equal(chat?.branch, "routine/dependency-check-2026-10-02");
  assert.equal(chat?.where, "worktree");
  assert.equal(chat?.mode, "full");
  assert.equal(chat?.model, "grok-build");
  assert.match(chat?.note ?? "", /routine "Dependency check"/);
  assert.equal(chat?.prompt(w.dir), "Check the dependencies.");
  assert.equal(chat?.listed, false, "a run stays out of the sidebar");
  const [run] = w.runs.runs(id);
  assert.deepEqual([run?.trigger, run?.status, run?.slot, run?.sessionId], ["schedule", "started", "2026-10-02T09:00", "run-1"]);

  w.clock.now = new Date("2026-10-02T09:05:00");
  w.scheduler.tick();
  await settle();
  assert.equal(w.starts.length, 1, "a handled slot does not run again");
  assert.equal(w.scheduler.view().list[0]?.runs[0]?.state, "working");
  assert.equal(w.scheduler.view().list[0]?.nextRunAt, new Date("2026-10-03T09:00:00").toISOString());
});

test("a routine created after its time today first runs tomorrow", async () => {
  const w = world({ at: "2026-10-02T15:00:00" });
  w.add();
  w.clock.now = new Date("2026-10-02T15:00:30");
  w.scheduler.tick();
  await settle();
  assert.equal(w.starts.length, 0);
});

test("a missed time catches up once, or is skipped without catch-up", async () => {
  const w = world();
  const caught = w.add();
  const skipped = w.add({ name: "Nightly tests", catchUp: false });
  // A week away from the Mac.
  w.clock.now = new Date("2026-10-08T13:00:00");
  w.scheduler.tick();
  await settle();
  assert.equal(w.starts.length, 1, "one catch-up for the week");
  assert.equal(w.runs.runs(caught)[0]?.trigger, "catch-up");
  assert.equal(w.runs.runs(caught)[0]?.slot, "2026-10-08T09:00");
  assert.ok(w.notes.some((note) => note.body.startsWith("Catching up")));
  assert.deepEqual([w.runs.runs(skipped)[0]?.status, w.runs.runs(skipped)[0]?.reason], ["skipped", MISSED]);
  w.clock.now = new Date("2026-10-08T13:01:00");
  w.scheduler.tick();
  await settle();
  assert.equal(w.starts.length, 1);
});

test("a run still going skips the routine's next time", async () => {
  const w = world();
  const id = w.add({ schedule: { every: "hours", hours: 1, minute: 0 } });
  w.clock.now = new Date("2026-10-02T09:00:10");
  w.scheduler.tick();
  await settle();
  w.clock.now = new Date("2026-10-02T10:00:10");
  w.scheduler.tick();
  await settle();
  assert.equal(w.starts.length, 1);
  assert.deepEqual([w.runs.runs(id)[0]?.status, w.runs.runs(id)[0]?.reason], ["skipped", STILL_GOING]);
  w.finish("run-1");
  w.clock.now = new Date("2026-10-02T11:00:10");
  w.scheduler.tick();
  await settle();
  assert.equal(w.starts.length, 2, "it runs again once the last run ended");
});

test("a run waiting for an answer outlasts the history limit and keeps its routine busy", async () => {
  const w = world();
  const id = w.add({ schedule: { every: "hours", hours: 1, minute: 0 } });
  w.clock.now = new Date("2026-10-02T09:00:10");
  w.scheduler.tick();
  await settle();
  const waiting = { ...session("run-1", w.dir), pendingPermission: { toolCallId: "t" } } as unknown as SessionState;
  w.sessions.set("run-1", waiting);
  w.scheduler.sessionChanged(waiting);
  for (let hour = 1; hour <= MAX_RUNS + 5; hour += 1) {
    w.clock.now = new Date(Date.parse("2026-10-02T09:00:10") + hour * 3_600_000);
    w.scheduler.tick();
  }
  await settle();
  assert.equal(w.starts.length, 1);
  assert.ok(w.runs.runs(id).some((run) => run.sessionId === "run-1"), "the store keeps it");
  assert.equal(w.scheduler.view().list[0]?.runs.find((run) => run.sessionId === "run-1")?.state, "waiting");
});

test("a browser or simulator prompt counts as waiting", async () => {
  const w = world();
  const id = w.add();
  w.clock.now = new Date("2026-10-02T09:00:10");
  w.scheduler.tick();
  await settle();
  w.hostPrompts.add("run-1");
  w.scheduler.promptsChanged();
  assert.equal(w.notes.filter((note) => note.body.startsWith("Waiting")).length, 1);
  assert.equal(w.scheduler.view().list.find((routine) => routine.id === id)?.runs[0]?.state, "waiting");
  w.hostPrompts.delete("run-1");
  w.scheduler.promptsChanged();
  assert.equal(w.scheduler.view().list.find((routine) => routine.id === id)?.runs[0]?.state, "working");
});

test("a run another open host started keeps its routine from running again", async () => {
  const w = world();
  const id = w.add();
  w.runs.add(id, { trigger: "manual", startedAt: "2026-10-02T08:59:00.000Z", status: "started", sessionId: "elsewhere", pid: process.ppid });
  w.clock.now = new Date("2026-10-02T09:00:10");
  w.scheduler.tick();
  await settle();
  assert.equal(w.starts.length, 0);
  assert.deepEqual([w.runs.runs(id)[0]?.status, w.runs.runs(id)[0]?.reason], ["skipped", STILL_GOING]);
});

test("a background task keeps the run going after its turn ends", async () => {
  const w = world();
  const id = w.add();
  w.clock.now = new Date("2026-10-02T09:00:10");
  w.scheduler.tick();
  await settle();
  w.finish("run-1", { backgroundTasks: [{ id: "t", kind: "local_bash", status: "running", label: "npm test" }] });
  assert.equal(w.runs.runs(id)[0]?.outcome, undefined);
  assert.equal(w.scheduler.view().list[0]?.runs[0]?.state, "working");
  w.finish("run-1", { backgroundTasks: [{ id: "t", kind: "local_bash", status: "completed", label: "npm test" }] });
  assert.equal(w.runs.runs(id)[0]?.outcome, "done");
});

test("a routine deleted while its run starts keeps no history", async () => {
  let id = "";
  const w = world({
    onStart: () => {
      w.routines.remove(id);
      w.scheduler.forget(id);
    },
  });
  id = w.add();
  w.clock.now = new Date("2026-10-02T09:00:10");
  w.scheduler.tick();
  await settle();
  assert.equal(w.starts.length, 1);
  assert.deepEqual(w.runs.runs(id), []);
  assert.equal(w.runs.sessionIds().size, 0);
  assert.deepEqual(w.notes, []);
});

test("a once routine whose time comes while a run by hand still works pauses", async () => {
  const w = world();
  const id = w.add({ schedule: { every: "once", at: "2026-10-02T09:00" } });
  w.clock.now = new Date("2026-10-02T08:59:00");
  await w.scheduler.runNow(id);
  w.clock.now = new Date("2026-10-02T09:00:10");
  w.scheduler.tick();
  await settle();
  assert.equal(w.starts.length, 1);
  assert.deepEqual([w.routines.get(id)?.enabled, w.routines.get(id)?.pausedReason], [false, ONCE_SKIPPED]);
});

test("runs past the limit wait their turn", async () => {
  const w = world({ maxWorking: 1 });
  const first = w.add({ name: "First" });
  const second = w.add({ name: "Second" });
  w.clock.now = new Date("2026-10-02T09:00:10");
  w.scheduler.tick();
  await settle();
  assert.deepEqual(w.starts.map((chat) => chat.title), ["First · Oct 2"]);
  assert.equal(w.scheduler.view().list.find((routine) => routine.id === second)?.queued, true);
  w.scheduler.tick();
  await settle();
  assert.equal(w.starts.length, 1, "a queued run is not queued twice");
  assert.equal(w.runs.lastSlot(second), null, "a host that quits now runs the slot when it opens again");
  w.finish("run-1");
  await settle();
  assert.deepEqual(w.starts.map((chat) => chat.title), ["First · Oct 2", "Second · Oct 2"]);
  assert.equal(w.runs.runs(first)[0]?.outcome, "done");
  assert.equal(w.runs.lastSlot(second), w.runs.lastSlot(first));
});

test("a queued run is skipped when its routine was paused, rescheduled or started by hand meanwhile", async () => {
  const w = world({ maxWorking: 1 });
  w.add({ name: "First" });
  const paused = w.add({ name: "Paused" });
  w.clock.now = new Date("2026-10-02T09:00:10");
  w.scheduler.tick();
  await settle();
  w.routines.update(paused, { enabled: false });
  w.finish("run-1");
  await settle();
  assert.deepEqual(w.starts.map((chat) => chat.title), ["First · Oct 2"]);
  assert.deepEqual([w.runs.runs(paused)[0]?.status, w.runs.runs(paused)[0]?.reason], ["skipped", PAUSED_WHILE_QUEUED]);

});

test("a queued run is skipped when its schedule changed or a run started by hand still works", async () => {
  const w = world({ maxWorking: 2 });
  w.add({ name: "One" });
  w.add({ name: "Two" });
  const moved = w.add({ name: "Moved" });
  const manual = w.add({ name: "Manual" });
  w.clock.now = new Date("2026-10-02T09:00:10");
  w.scheduler.tick();
  await settle();
  assert.equal(w.starts.length, 2, "two run, two wait");
  w.clock.now = new Date("2026-10-02T09:01:00");
  w.routines.update(moved, { schedule: { every: "day", at: "10:00", days: [0, 1, 2, 3, 4, 5, 6] } });
  await w.scheduler.runNow(manual);
  w.finish("run-1");
  w.finish("run-2");
  await settle();
  assert.equal(w.starts.length, 3, "nothing started after the run by hand");
  assert.deepEqual([w.runs.runs(moved)[0]?.status, w.runs.runs(moved)[0]?.reason], ["skipped", RESCHEDULED_WHILE_QUEUED]);
  assert.deepEqual([w.runs.runs(manual)[0]?.status, w.runs.runs(manual)[0]?.reason], ["skipped", STILL_GOING]);
  assert.equal(w.runs.runs(manual)[1]?.trigger, "manual");
});

test("a run still going when the host stops is recorded as stopped", async () => {
  const w = world();
  const id = w.add({ schedule: { every: "manual" } });
  await w.scheduler.runNow(id);
  w.scheduler.stop();
  const [run] = w.runs.runs(id);
  assert.deepEqual([run?.outcome, run?.reason], ["cancelled", STOPPED_WITH_HOST]);
  assert.ok(run?.endedAt);
  assert.equal(w.scheduler.view().list[0]?.runs[0]?.state, "cancelled");
});

test("deleting a run's chat leaves the run without a link", async () => {
  const w = world();
  const id = w.add({ schedule: { every: "manual" } });
  await w.scheduler.runNow(id);
  w.scheduler.sessionDeleted("run-1");
  assert.equal(w.scheduler.view().list[0]?.runs[0]?.sessionId, undefined);
});

test("a run never starts in Plan, even when Plan is the provider's default", async () => {
  const w = world({ defaultMode: "plan" });
  const id = w.add({ mode: "" });
  await w.scheduler.runNow(id);
  assert.equal(w.starts[0]?.mode, "full");
});

test("only the host that holds the lock runs the schedule", async () => {
  const w = world();
  w.add();
  w.lock.free = false;
  w.clock.now = new Date("2026-10-02T09:00:10");
  w.scheduler.tick();
  await settle();
  assert.equal(w.starts.length, 0);
  assert.deepEqual(w.scheduler.view().scheduler, { here: false, takesPart: true, port: 8787 });
  // The other host quit.
  w.lock.free = true;
  w.scheduler.tick();
  await settle();
  assert.equal(w.starts.length, 1);
  assert.equal(w.scheduler.view().scheduler.here, true);
});

test("a finished run open on the page is closed once it leaves", async () => {
  const w = world();
  w.add();
  w.clock.now = new Date("2026-10-02T09:00:10");
  w.scheduler.tick();
  await settle();
  w.onDesk.add("run-1");
  w.finish("run-1");
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 5);
  });
  assert.deepEqual(w.forgotten, [], "it stays while it is open");
  w.onDesk.delete("run-1");
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 5);
  });
  assert.deepEqual(w.forgotten, ["run-1"]);
});

test("a run that ends is recorded and notified, waiting notifies once, and the finished run is closed", async () => {
  const w = world();
  const id = w.add();
  w.clock.now = new Date("2026-10-02T09:00:10");
  w.scheduler.tick();
  await settle();
  const waiting = { ...session("run-1", w.dir), pendingPermission: { toolCallId: "t" } } as unknown as SessionState;
  w.sessions.set("run-1", waiting);
  w.scheduler.sessionChanged(waiting);
  w.scheduler.sessionChanged(waiting);
  assert.equal(w.notes.filter((note) => note.body.startsWith("Waiting")).length, 1);
  assert.equal(w.scheduler.view().list[0]?.runs[0]?.state, "waiting");
  w.finish("run-1", { stopReason: "cancelled" });
  assert.equal(w.runs.runs(id)[0]?.outcome, "cancelled");
  assert.equal(w.scheduler.view().list[0]?.runs[0]?.state, "cancelled");
  assert.ok(w.notes.some((note) => note.body === "Stopped." && note.sessionId === "run-1"));
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 5);
  });
  assert.deepEqual(w.forgotten, ["run-1"]);
});

test("a run that ends with an error keeps the error as its reason", async () => {
  const w = world();
  const id = w.add();
  w.clock.now = new Date("2026-10-02T09:00:10");
  w.scheduler.tick();
  await settle();
  w.finish("run-1", { stopReason: "rate_limit", error: "API error (status 429 Too Many Requests)" });
  assert.deepEqual([w.runs.runs(id)[0]?.outcome, w.runs.runs(id)[0]?.reason], ["error", "API error (status 429 Too Many Requests)"]);
  assert.ok(w.notes.some((note) => note.body === "Ended with an error: API error (status 429 Too Many Requests)"));
});

test("a routine with notifications off sends none", async () => {
  const w = world();
  w.add({ notify: false });
  w.clock.now = new Date("2026-10-08T13:00:00");
  w.scheduler.tick();
  await settle();
  w.finish("run-1");
  assert.equal(w.starts.length, 1);
  assert.deepEqual(w.notes, []);
});

test("starts that keep failing pause the routine, and a gone folder pauses it at once", async () => {
  const w = world();
  const id = w.add();
  w.enabled.value = false;
  for (let day = 2; day < 2 + FAILURES_TO_PAUSE; day += 1) {
    w.clock.now = new Date(`2026-10-0${day}T09:00:10`);
    w.scheduler.tick();
    await settle();
  }
  const routine = w.routines.get(id);
  assert.equal(routine?.enabled, false);
  assert.equal(routine?.pausedReason, `Paused after ${FAILURES_TO_PAUSE} failed starts: Grok is off in Settings`);
  assert.equal(w.runs.runs(id).filter((run) => run.status === "failed").length, FAILURES_TO_PAUSE);

  w.enabled.value = true;
  const gone = w.add({ name: "Gone", cwd: path.join(w.dir, "missing") });
  w.clock.now = new Date("2026-10-06T09:00:10");
  w.scheduler.tick();
  await settle();
  assert.match(w.routines.get(gone)?.pausedReason ?? "", /^Paused: the folder .*missing is gone$/);
});

test("Run now starts a run on any host, and a once routine pauses after its run", async () => {
  const w = world();
  const id = w.add({ schedule: { every: "manual" }, start: "folder" });
  w.lock.free = false;
  assert.deepEqual(await w.scheduler.runNow(id), { sessionId: "run-1", cwd: w.dir });
  assert.equal(w.runs.runs(id)[0]?.trigger, "manual");
  assert.equal(w.starts[0]?.title, `Dependency check · Oct 1 12:00`);
  await assert.rejects(w.scheduler.runNow("gone"), /That routine is gone/);

  w.lock.free = true;
  const once = w.add({ name: "Once", schedule: { every: "once", at: "2026-10-02T18:00" } });
  w.clock.now = new Date("2026-10-02T18:00:10");
  w.scheduler.tick();
  await settle();
  assert.equal(w.routines.get(once)?.enabled, false);
  assert.equal(w.routines.get(once)?.pausedReason, undefined);
});

test("a once routine whose start fails pauses with the reason", async () => {
  const w = world({ failStart: "no room" });
  const id = w.add({ schedule: { every: "once", at: "2026-10-02T18:00" } });
  w.clock.now = new Date("2026-10-02T18:00:10");
  w.scheduler.tick();
  await settle();
  assert.deepEqual([w.routines.get(id)?.enabled, w.routines.get(id)?.pausedReason], [false, "Paused: no room"]);
  assert.ok(w.notes.some((note) => note.body === "Did not start: no room"));
});

test("a start that fails is recorded with its reason and answered", async () => {
  const w = world({ failStart: "no room" });
  const id = w.add();
  await assert.rejects(w.scheduler.runNow(id), /no room/);
  assert.deepEqual([w.runs.runs(id)[0]?.status, w.runs.runs(id)[0]?.reason], ["failed", "no room"]);
  w.scheduler.forget(id);
  assert.deepEqual(w.runs.runs(id), []);
});

test("a finished run's worktree goes a day after the run, unless its chat works, waits or is open, or git keeps it", async () => {
  const w = world({ at: "2026-10-03T12:00:00" });
  const id = w.add({ schedule: { every: "manual" } });
  const repo = gitRepo(w.dir);
  const ago = (ms: number) => new Date(w.clock.now.getTime() - ms).toISOString();
  const day = KEEP_WORKTREE_MS + 60_000;
  const run = async (sessionId: string, branch: string, endedAt: string, change: Partial<RoutineRun> = {}) => {
    const made = await addWorktree(repo, "main", branch, path.join(w.dir, "worktrees"));
    w.runs.add(id, { trigger: "manual", startedAt: endedAt, endedAt, outcome: "done", status: "started", sessionId, cwd: made.path, ...change });
    return made.path;
  };
  const clean = await run("clean", "routine/clean", ago(day));
  const fresh = await run("fresh", "routine/fresh", ago(3_600_000));
  const dirty = await run("dirty", "routine/dirty", ago(day));
  fs.writeFileSync(path.join(dirty, "draft.txt"), "");
  const working = await run("working", "routine/working", ago(day));
  w.sessions.set("working", session("working", working));
  const waiting = await run("waiting", "routine/waiting", ago(day));
  w.sessions.set("waiting", session("waiting", waiting, { status: "idle", pendingPermission: { toolCallId: "t" } } as unknown as Partial<SessionState>));
  const open = await run("open", "routine/open", ago(day));
  w.onDesk.add("open");
  const elsewhere = await run("elsewhere", "routine/elsewhere", ago(day), { pid: process.ppid });
  // A run that started in the folder of a chat's worktree.
  const chatTree = await run("chat", "claude/chat", ago(day));

  w.scheduler.tick();
  const shown = (sessionId: string) => w.views.at(-1)?.list[0]?.runs.find((item) => item.sessionId === sessionId);
  await until(() => Boolean(shown("clean")?.worktreeRemoved));
  assert.equal(fs.existsSync(clean), false);
  assert.match(execFileSync("git", ["branch", "--list", "routine/clean"], { cwd: repo, encoding: "utf8" }), /routine\/clean/, "its branch stays");
  assert.equal(shown("clean")?.ownWorktree, undefined);
  assert.equal(shown("dirty")?.worktreeKept, "The worktree stays: it contains modified or untracked files");
  for (const kept of [fresh, dirty, working, waiting, open, elsewhere, chatTree]) assert.equal(fs.existsSync(kept), true, kept);
  assert.equal(shown("fresh")?.ownWorktree, true);
  assert.equal(shown("fresh")?.worktreeKept, undefined);
  assert.equal(w.scheduler.worktreeOf("fresh"), fresh, "deleting the run's chat can remove it");
  assert.equal(w.scheduler.worktreeOf("clean"), null);
  assert.equal(w.scheduler.worktreeOf("chat"), null);

  w.sessions.set("working", session("working", working, { status: "idle" }));
  w.onDesk.delete("open");
  w.clock.now = new Date(w.clock.now.getTime() + WORKTREE_CHECK_MS / 2);
  w.scheduler.tick();
  await settle();
  assert.equal(fs.existsSync(open), true, "it looks again only after an hour");
  w.clock.now = new Date(w.clock.now.getTime() + WORKTREE_CHECK_MS);
  w.scheduler.tick();
  await until(() => Boolean(shown("working")?.worktreeRemoved && shown("open")?.worktreeRemoved));
  assert.equal(fs.existsSync(working), false);
  assert.equal(fs.existsSync(open), false);
  assert.equal(fs.existsSync(dirty), true);
});
