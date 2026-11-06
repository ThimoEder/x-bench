// Runs routines: on schedule on the host that holds the lock, and with Run now on any host.

import fs from "node:fs";
import path from "node:path";
import type { Mode, Provider } from "../../bridge/provider.ts";
import type { SessionState } from "../../bridge/reducer.ts";
import { startChat, type ChatStartHost, type StartedChat } from "../chat/chatStart.ts";
import { httpError, messageOf, statusOf } from "../http.ts";
import type { Host } from "../app.ts";
import type { SchedulerLock } from "./routineLock.ts";
import { dueSlot, nextSlot, runLabel } from "./routineSchedule.ts";
import { unfinished, type RoutineRun, type RoutineRunStore, type RunOutcome, type RunTrigger } from "./routineRuns.ts";
import type { Routine, RoutineStore } from "./routines.ts";
import { canonicalCwd, isDirectory } from "../chat/sessions.ts";
import { branchSlug } from "../git/branch.ts";
import { appWorktreeOf, removeChatWorktree } from "../git/worktree.ts";
import { pidAlive } from "../../bridge/fileLock.ts";

export type RoutineHost = ChatStartHost & Pick<Host, "desk" | "surfaces" | "browser" | "chatRows">;

export type RunState = "working" | "waiting" | "done" | "error" | "cancelled" | "started" | "skipped" | "failed";

export interface RoutineRunView {
  id: string;
  trigger: RunTrigger;
  startedAt: string;
  state: RunState;
  reason?: string;
  sessionId?: string;
  cwd?: string;
  // It ran in the chat home, so it opens on the Chat surface.
  chat: boolean;
  endedAt?: string;
  // The worktree the run made is still there.
  ownWorktree?: true;
  worktreeRemoved?: true;
  worktreeKept?: string;
}

export type RoutineView = Routine & {
  // It runs in the chat home, as a plain chat.
  chat: boolean;
  nextRunAt: string | null;
  queued: boolean;
  // The newest runs first.
  runs: RoutineRunView[];
};

export interface RoutinesView {
  scheduler: {
    // This host runs the schedule.
    here: boolean;
    // This host may run it. X Bench Dev windows stay out unless started with --routines.
    takesPart: boolean;
    port: number | null;
  };
  // In the app, where notifications work.
  desktop: boolean;
  list: RoutineView[];
}

export interface RoutineNote {
  title: string;
  body: string;
  sessionId?: string;
}

export interface SchedulerOptions {
  host: RoutineHost;
  routines: RoutineStore;
  runs: RoutineRunStore;
  schedule: boolean;
  lock: SchedulerLock;
  publish(view: RoutinesView): void;
  notify?: (note: RoutineNote) => void;
  now?: () => Date;
  start?: (host: ChatStartHost, options: Parameters<typeof startChat>[1]) => Promise<StartedChat>;
  // How long a finished run stays loaded off the desk.
  closeAfterMs?: number;
  // Routine runs that work at once. Due runs past it wait.
  maxWorking?: number;
}

export interface RoutineScheduler {
  tick(): void;
  // Errors carry the status to answer with.
  runNow(routineId: string): Promise<{ sessionId: string; cwd: string }>;
  sessionChanged(session: SessionState): void;
  promptsChanged(): void;
  view(): RoutinesView;
  // Another host changed a routine file.
  refresh(): void;
  // A deleted routine: its queued runs and its history go. Its chats stay.
  forget(routineId: string): void;
  // A run's chat was deleted, so its row no longer opens it.
  sessionDeleted(sessionId: string): void;
  // The worktree the run of this chat made, while it is there.
  worktreeOf(sessionId: string): string | null;
  runOf(sessionId: string): { routineId: string; run: RoutineRun } | null;
  stop(): void;
}

export const MAX_WORKING = 3;
// Runs the page shows per routine, besides any that are unfinished.
export const SHOWN_RUNS = 10;
export const CLOSE_AFTER_MS = 10 * 60_000;
export const FAILURES_TO_PAUSE = 3;
export const KEEP_WORKTREE_MS = 24 * 3_600_000;
export const WORKTREE_CHECK_MS = 3_600_000;
export const STILL_GOING = "The last run is still going";
export const STOPPED_WITH_HOST = "X Bench quit while the run was going";
export const PAUSED_WHILE_QUEUED = "The routine was paused while the run waited for a free slot";
export const ONCE_SKIPPED = "Paused: its time came while the last run was still going";
export const RESCHEDULED_WHILE_QUEUED = "The schedule changed while the run waited for a free slot";

interface Tracked {
  sessionId: string;
  routineId: string;
  runId: string;
  provider: Provider;
  ended: boolean;
  // The turn began. A session that is idle before then has not run yet.
  sawWork: boolean;
  waitingNoted: boolean;
  state: RunState;
  closer?: ReturnType<typeof setTimeout>;
}

interface Queued {
  routineId: string;
  trigger: RunTrigger;
  key: string;
  slot: Date;
}

function outcomeOf(session: SessionState): RunOutcome {
  if (session.stopReason === "cancelled") return "cancelled";
  if (session.error || session.stopReason === "error" || session.stopReason === "refusal") return "error";
  return "done";
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function routineBranch(name: string, when: Date): string {
  const day = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  return `routine/${branchSlug(name, 36) || "run"}-${day}`;
}

export function runNote(name: string): string {
  return `This chat is a run of the routine "${name}", which X Bench starts on a schedule. Nobody may be watching it live. End with a short summary of what you found and what you changed.`;
}

// A run never starts in Plan, which waits for approval of a plan.
export function runMode(provider: Provider, mode: string, defaultMode: string): string {
  const usable = (choice: string) => choice !== "plan" && provider.modes.some((item) => item.id === choice);
  if (usable(mode)) return mode;
  return usable(defaultMode) ? defaultMode : (provider.modes.find((item) => item.id !== "plan")?.id ?? defaultMode);
}

function offered(provider: Provider, model: string): boolean {
  try {
    return provider.models().models.some((item) => item.value === model);
  } catch {
    return true;
  }
}

export function createRoutineScheduler(options: SchedulerOptions): RoutineScheduler {
  const { host, routines, runs, lock } = options;
  const now = options.now ?? (() => new Date());
  const start = options.start ?? startChat;
  const closeAfterMs = options.closeAfterMs ?? CLOSE_AFTER_MS;
  const maxWorking = options.maxWorking ?? MAX_WORKING;
  const tracked = new Map<string, Tracked>();
  const queue: Queued[] = [];
  // Routines whose queued run is starting, so a tick meanwhile does not queue its slot again.
  const starting = new Set<string>();
  let pumping = false;
  let stopped = false;
  let worktreesCheckedAt = 0;
  let checkingWorktrees = false;

  function publish() {
    options.publish(view());
  }

  // A routine's own notify setting decides. A routine that is gone sends nothing.
  function notify(routine: Routine | null, note: Omit<RoutineNote, "title">) {
    if (!options.notify || !routine?.notify) return;
    options.notify({ title: routine.name, ...note });
  }

  // The harness asks, or a browser or simulator tool waits in the host's permission card.
  function pending(session: SessionState): boolean {
    return Boolean(session.pendingPermission || session.pendingPlan || session.pendingElicitation || host.browser.prompt(session.id));
  }

  function backgroundWork(session: SessionState): boolean {
    return session.backgroundTasks.some((task) => task.status === "running");
  }

  function liveSession(sessionId: string | undefined): SessionState | null {
    if (!sessionId) return null;
    return host.providers.getSession(sessionId) ?? null;
  }

  function active(entry: Tracked): boolean {
    return !entry.ended && Boolean(liveSession(entry.sessionId));
  }

  function activeRuns(): Tracked[] {
    return [...tracked.values()].filter(active);
  }

  // A run this host started that is still going, or one another open host started and has not ended.
  function busy(routineId: string): boolean {
    return activeRuns().some((entry) => entry.routineId === routineId) || runs.runs(routineId).some((run) => run.pid !== process.pid && unfinished(run));
  }

  function stateOf(run: RoutineRun): RunState {
    if (run.status !== "started") return run.status;
    if (run.outcome) return run.outcome;
    const session = liveSession(run.sessionId);
    const entry = run.sessionId ? tracked.get(run.sessionId) : undefined;
    if (session && pending(session)) return "waiting";
    if (session?.status === "running" || (entry && !entry.ended && session)) return "working";
    return "started";
  }

  function present(run: RoutineRun, chatHome: string): RoutineRunView {
    return {
      id: run.id,
      trigger: run.trigger,
      startedAt: run.startedAt,
      state: stateOf(run),
      chat: Boolean(run.cwd) && canonicalCwd(run.cwd as string) === chatHome,
      ...(run.reason ? { reason: run.reason } : {}),
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      ...(run.cwd ? { cwd: run.cwd } : {}),
      ...(run.endedAt ? { endedAt: run.endedAt } : {}),
      ...(ownWorktree(run) ? { ownWorktree: true as const } : {}),
      ...(run.worktreeRemoved ? { worktreeRemoved: true as const } : {}),
      ...(run.worktreeKept ? { worktreeKept: run.worktreeKept } : {}),
    };
  }

  function ownWorktree(run: RoutineRun): string | null {
    if (!run.cwd || run.worktreeRemoved) return null;
    const worktree = appWorktreeOf(canonicalCwd(run.cwd), canonicalCwd(host.paths.worktrees));
    // Only a worktree a run made is named after its routine/… branch, so a run that started in a chat's worktree leaves it alone.
    return worktree && path.basename(worktree).startsWith("routine-") && isDirectory(worktree) ? worktree : null;
  }

  function view(): RoutinesView {
    const at = now();
    const chatHome = canonicalCwd(host.paths.chatHome);
    const holder = lock.holder();
    return {
      scheduler: { here: lock.held(), takesPart: options.schedule, port: holder?.port ?? null },
      desktop: Boolean(options.notify),
      list: routines.list().map((routine) => ({
        ...routine,
        chat: canonicalCwd(routine.cwd) === chatHome,
        nextRunAt: routine.enabled ? (nextSlot(routine.schedule, at)?.toISOString() ?? null) : null,
        queued: queue.some((item) => item.routineId === routine.id),
        runs: runs
          .runs(routine.id)
          .filter((run, index) => index < SHOWN_RUNS || unfinished(run))
          .map((run) => present(run, chatHome)),
      })),
    };
  }

  async function removeOldWorktrees() {
    const at = now().getTime();
    if (checkingWorktrees || at - worktreesCheckedAt < WORKTREE_CHECK_MS) return;
    checkingWorktrees = true;
    worktreesCheckedAt = at;
    let changed = false;
    try {
      const root = canonicalCwd(host.paths.worktrees);
      for (const routine of routines.list()) {
        for (const run of runs.runs(routine.id)) {
          const worktree = ownWorktree(run);
          if (stopped || !worktree || !run.endedAt || at - Date.parse(run.endedAt) < KEEP_WORKTREE_MS || inUse(run)) continue;
          // Git's reason starts with the folder's path, which would fill the run's row.
          const kept = (await removeChatWorktree(worktree, run.sessionId ?? "", host.chatRows(), root)).replace(`'${worktree}'`, "it");
          if (kept && kept === run.worktreeKept) continue;
          runs.update(routine.id, run.id, kept ? { worktreeKept: kept } : { worktreeRemoved: true, worktreeKept: undefined });
          changed = true;
        }
      }
    } catch (error) {
      console.error(`removing routine worktrees failed: ${messageOf(error)}`);
    } finally {
      checkingWorktrees = false;
    }
    if (changed) publish();
  }

  function inUse(run: RoutineRun): boolean {
    const session = liveSession(run.sessionId);
    if (session && (session.status === "running" || backgroundWork(session) || pending(session))) return true;
    return Boolean(run.sessionId && shown(run.sessionId)) || (run.pid !== process.pid && pidAlive(run.pid));
  }

  function afterFailure(routine: Routine, reason: string, gone: boolean) {
    if (!routine.enabled) return;
    if (gone) {
      routines.pause(routine.id, `Paused: ${reason}`);
      return;
    }
    let failed = 0;
    for (const run of runs.runs(routine.id)) {
      if (run.status === "skipped") continue;
      if (run.status !== "failed") break;
      failed += 1;
    }
    if (failed >= FAILURES_TO_PAUSE) routines.pause(routine.id, `Paused after ${FAILURES_TO_PAUSE} failed starts: ${reason}`);
  }

  // Open on either surface, so closing it would take it from the page.
  function shown(sessionId: string): boolean {
    return host.desk.has(sessionId) || host.surfaces.parked("builder").includes(sessionId) || host.surfaces.parked("chat").includes(sessionId);
  }

  // Closes a finished run once it is off the page and quiet, checking again later while it is not.
  function scheduleClose(sessionId: string, entry: Tracked) {
    clearTimeout(entry.closer);
    entry.closer = setTimeout(() => {
      const session = liveSession(sessionId);
      if (!session || stopped) return;
      if (session.status === "running" || backgroundWork(session) || pending(session) || shown(sessionId)) {
        scheduleClose(sessionId, entry);
        return;
      }
      entry.provider.forgetSession(sessionId).catch(() => {});
    }, closeAfterMs);
    entry.closer.unref?.();
  }

  function end(sessionId: string, entry: Tracked, outcome: RunOutcome, detail = "") {
    if (entry.ended) return;
    entry.ended = true;
    entry.state = outcome;
    const routine = routines.get(entry.routineId);
    try {
      runs.update(entry.routineId, entry.runId, { endedAt: now().toISOString(), outcome, ...(outcome === "error" && detail ? { reason: detail } : {}) });
    } catch {
      // The run still ended. The page shows it as started.
    }
    const body = outcome === "done" ? "Finished. Open it to read what it found." : outcome === "cancelled" ? "Stopped." : `Ended with an error${detail ? `: ${detail}` : "."}`;
    notify(routine, { body, sessionId });
    scheduleClose(sessionId, entry);
    publish();
    void pump();
  }

  async function startRun(routine: Routine, trigger: RunTrigger, slot: { key: string; date: Date } | null): Promise<{ sessionId: string; cwd: string }> {
    const at = now();
    const base = { trigger, startedAt: at.toISOString(), ...(slot ? { slot: slot.key } : {}) };
    // A scheduled slot counts as handled once its run is on record, so a run that never got this far comes again.
    const record = (run: Omit<RoutineRun, "id">): RoutineRun => (slot ? (runs.handle(routine.id, slot.key, run) as RoutineRun) : runs.add(routine.id, run));
    const fail = (reason: string, status: number, gone = false): never => {
      // A routine deleted meanwhile keeps no history.
      if (!routines.get(routine.id)) throw httpError(reason, status);
      try {
        record({ ...base, status: "failed", reason });
        afterFailure(routine, reason, gone);
        // A once routine has no later time to try again.
        if (routine.schedule.every === "once" && trigger !== "manual" && routines.get(routine.id)?.enabled) routines.pause(routine.id, `Paused: ${reason}`);
      } catch {
        // The failure is still answered and shown.
      }
      if (trigger !== "manual") notify(routine, { body: `Did not start: ${reason}` });
      publish();
      throw httpError(reason, status);
    };
    const provider = host.providers.get(routine.provider);
    if (!provider) return fail(`${routine.provider} is not a provider X Bench knows`, 400);
    if (!host.providers.isEnabled(provider)) return fail(`${provider.label} is off in Settings`, 409);
    const chat = canonicalCwd(routine.cwd) === canonicalCwd(host.paths.chatHome);
    if (chat) fs.mkdirSync(host.paths.chatHome, { recursive: true });
    if (!isDirectory(routine.cwd)) return fail(`the folder ${routine.cwd} is gone`, 400, true);
    let model = routine.model;
    let reason = "";
    if (model && !offered(provider, model)) {
      reason = `${model} is no longer offered, so it ran on ${provider.label}'s default model`;
      model = "";
    }
    const mode = runMode(provider, routine.mode, host.providers.defaultMode(provider));
    let started: StartedChat;
    try {
      started = await start(host, {
        provider,
        folder: routine.cwd,
        where: chat ? "folder" : routine.start,
        branch: routineBranch(routine.name, at),
        // A run started by hand carries its time, since it can come next to the day's scheduled run.
        title: `${routine.name} · ${slot ? runLabel(routine.schedule, slot.date) : runLabel({ every: "manual" }, at)}`,
        ...(model ? { model, ...(routine.effort ? { effort: routine.effort } : {}) } : {}),
        mode: mode as Mode,
        note: runNote(routine.name),
        prompt: () => routine.prompt,
        listed: false,
        stillWanted: () => Boolean(routines.get(routine.id)),
        onCreated(session, cwd) {
          const run = record({ ...base, status: "started", sessionId: session.id, cwd, pid: process.pid, ...(reason ? { reason } : {}) });
          const entry: Tracked = { sessionId: session.id, routineId: routine.id, runId: run.id, provider, ended: false, sawWork: false, waitingNoted: false, state: "working" };
          tracked.set(session.id, entry);
        },
      });
    } catch (error) {
      return fail(messageOf(error) || "The run did not start", statusOf(error, 500));
    }
    const sessionId = started.session.id;
    void started.sent.then((sent) => {
      const current = tracked.get(sessionId);
      if (!sent && current) end(sessionId, current, "error", liveSession(sessionId)?.error ?? "");
    });
    if (routine.schedule.every === "once" && trigger !== "manual") routines.pause(routine.id);
    publish();
    return { sessionId, cwd: started.cwd };
  }

  async function pump() {
    if (pumping || stopped) return;
    pumping = true;
    try {
      while (queue.length && activeRuns().length < maxWorking && !stopped) {
        const item = queue.shift() as Queued;
        const routine = routines.get(item.routineId);
        if (!routine) continue;
        // The routine may have changed while its run waited.
        const skip = !routine.enabled
          ? PAUSED_WHILE_QUEUED
          : Date.parse(routine.armedAt) >= item.slot.getTime()
            ? RESCHEDULED_WHILE_QUEUED
            : busy(routine.id)
              ? STILL_GOING
              : "";
        if (skip) {
          try {
            runs.handle(routine.id, item.key, { trigger: item.trigger, slot: item.key, startedAt: now().toISOString(), status: "skipped", reason: skip });
            if (skip === STILL_GOING && routine.schedule.every === "once") routines.pause(routine.id, ONCE_SKIPPED);
          } catch {
            // The skip still happens.
          }
          continue;
        }
        starting.add(routine.id);
        try {
          await startRun(routine, item.trigger, { key: item.key, date: item.slot });
        } catch {
          // Recorded as a failed run.
        } finally {
          starting.delete(routine.id);
        }
      }
    } finally {
      pumping = false;
      publish();
    }
  }

  function tick() {
    if (!options.schedule || stopped) return;
    const wasHere = lock.held();
    if (!lock.take()) return;
    if (!wasHere) publish();
    void removeOldWorktrees();
    const at = now();
    let changed = false;
    for (const routine of routines.list()) {
      if (!routine.enabled || starting.has(routine.id) || queue.some((item) => item.routineId === routine.id)) continue;
      const due = dueSlot({ schedule: routine.schedule, catchUp: routine.catchUp, armedAt: routine.armedAt, lastSlot: runs.lastSlot(routine.id) }, at);
      if (!due) continue;
      changed = true;
      const base = { trigger: "schedule" as const, slot: due.key, startedAt: at.toISOString() };
      if ("skip" in due) {
        runs.handle(routine.id, due.key, { ...base, status: "skipped", reason: due.skip });
        if (routine.schedule.every === "once") routines.pause(routine.id);
        continue;
      }
      if (busy(routine.id)) {
        runs.handle(routine.id, due.key, { ...base, status: "skipped", reason: STILL_GOING });
        if (routine.schedule.every === "once") routines.pause(routine.id, ONCE_SKIPPED);
        continue;
      }
      queue.push({ routineId: routine.id, trigger: due.trigger, key: due.key, slot: due.slot });
      if (due.trigger === "catch-up") notify(routine, { body: "Catching up on the run X Bench missed while it was closed." });
    }
    if (changed) publish();
    void pump();
  }

  function sessionChanged(session: SessionState) {
    const entry = tracked.get(session.id);
    if (!entry || entry.ended) return;
    const waiting = pending(session);
    const working = session.status === "running" || backgroundWork(session);
    if (working) entry.sawWork = true;
    if (waiting && !entry.waitingNoted) {
      entry.waitingNoted = true;
      notify(routines.get(entry.routineId), { body: "Waiting for you to answer.", sessionId: session.id });
    }
    if (!waiting) entry.waitingNoted = false;
    if (!working && entry.sawWork && !waiting) {
      end(session.id, entry, outcomeOf(session), session.error ?? "");
      return;
    }
    const state: RunState = waiting ? "waiting" : "working";
    if (state === entry.state) return;
    entry.state = state;
    publish();
  }

  return {
    tick() {
      try {
        tick();
      } catch (error) {
        console.error(`routines tick failed: ${messageOf(error)}`);
      }
    },
    async runNow(routineId) {
      const routine = routines.get(routineId);
      if (!routine) throw httpError("That routine is gone", 404);
      return startRun(routine, "manual", null);
    },
    sessionChanged,
    promptsChanged() {
      for (const entry of tracked.values()) {
        const session = entry.ended ? null : liveSession(entry.sessionId);
        if (session) sessionChanged(session);
      }
    },
    view,
    refresh() {
      publish();
    },
    forget(routineId) {
      for (let index = queue.length - 1; index >= 0; index -= 1) if (queue[index]?.routineId === routineId) queue.splice(index, 1);
      runs.drop(routineId);
      publish();
    },
    sessionDeleted(sessionId) {
      const entry = tracked.get(sessionId);
      if (entry) clearTimeout(entry.closer);
      tracked.delete(sessionId);
      if (!runs.findSession(sessionId)) return;
      try {
        runs.dropSession(sessionId);
      } catch {
        // The row keeps its link, and opening it says the chat is gone.
      }
      publish();
    },
    runOf(sessionId) {
      return runs.findSession(sessionId);
    },
    worktreeOf(sessionId) {
      const found = runs.findSession(sessionId);
      return found ? ownWorktree(found.run) : null;
    },
    stop() {
      stopped = true;
      // The agent stops with the host, so a run still going ends here.
      const at = now().toISOString();
      for (const entry of tracked.values()) {
        clearTimeout(entry.closer);
        if (!active(entry)) continue;
        entry.ended = true;
        try {
          runs.update(entry.routineId, entry.runId, { endedAt: at, outcome: "cancelled", reason: STOPPED_WITH_HOST });
        } catch {
          // The run still shows as started.
        }
      }
      lock.release();
    },
  };
}
