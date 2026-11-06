// routine-runs.json: { "routines": { "<routine id>": { "lastSlot": "2026-10-03T09:00", "runs": [RoutineRun], "sessions": ["<id>"] } } }
// Runs are newest first, the newest MAX_RUNS of them and every unfinished one. sessions names the chat of every run the routine ever started,
// so a run that left the history still stays out of the sidebar. The host that runs the schedule writes the slots, and the host that starts a run writes
// the run. It is a separate file from routines.json, so these writes never overwrite an edit saved on another host.

import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { listOf } from "../../bridge/lenient.ts";
import { pidAlive, withFileLock } from "../../bridge/fileLock.ts";
import { fileStamp, loadDurable, saveDurable } from "../jsonFile.ts";

export const RUN_TRIGGERS = ["schedule", "catch-up", "manual"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export type RunOutcome = "done" | "error" | "cancelled";

export interface RoutineRun {
  id: string;
  trigger: RunTrigger;
  // The slot's key, for a scheduled run or a skip.
  slot?: string;
  startedAt: string;
  status: "started" | "skipped" | "failed";
  // Why it was skipped or failed, or what the start changed.
  reason?: string;
  sessionId?: string;
  cwd?: string;
  endedAt?: string;
  outcome?: RunOutcome;
  // The host that started it, which records how it ends.
  pid?: number;
  // The worktree it ran in was removed, or why it stays.
  worktreeRemoved?: boolean;
  worktreeKept?: string;
}

export const MAX_RUNS = 30;

// A started run with no outcome whose host is still open: working, or waiting for an answer.
export function unfinished(run: RoutineRun): boolean {
  return run.status === "started" && !run.outcome && pidAlive(run.pid);
}

const Run = z.object({
  id: z.string().min(1),
  trigger: z.enum(RUN_TRIGGERS).catch("manual"),
  slot: z.string().optional().catch(undefined),
  startedAt: z.string().catch(""),
  status: z.enum(["started", "skipped", "failed"]),
  reason: z.string().optional().catch(undefined),
  sessionId: z.string().optional().catch(undefined),
  cwd: z.string().optional().catch(undefined),
  endedAt: z.string().optional().catch(undefined),
  outcome: z.enum(["done", "error", "cancelled"]).optional().catch(undefined),
  pid: z.number().int().optional().catch(undefined),
  worktreeRemoved: z.boolean().optional().catch(undefined),
  worktreeKept: z.string().optional().catch(undefined),
});

const Entry = z.object({
  lastSlot: z.string().optional().catch(undefined),
  runs: listOf(Run).catch([]).default([]),
  sessions: listOf(z.string()).catch([]).default([]),
});

const RunsFile = z.object({ routines: z.record(z.string(), Entry).catch({}).default({}) });

interface Entry {
  lastSlot?: string;
  runs: RoutineRun[];
  sessions: string[];
}

type Entries = Record<string, Entry>;

// Fields Zod read as missing are dropped, so a write keeps the file free of nulls.
function clean<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function parse(value: unknown): Entries | null {
  const parsed = RunsFile.safeParse(value);
  if (!parsed.success) return null;
  return Object.fromEntries(
    Object.entries(parsed.data.routines).map(([id, entry]) => {
      // A file from before sessions existed names its runs' chats only in runs.
      const sessions = [...new Set([...entry.sessions, ...entry.runs.flatMap((run) => (run.sessionId ? [run.sessionId] : []))])];
      return [id, clean({ lastSlot: entry.lastSlot, runs: entry.runs.map(clean), sessions })];
    }),
  );
}

export interface RoutineRunStore {
  lastSlot(routineId: string): string | null;
  // Newest first.
  runs(routineId: string): RoutineRun[];
  // Records a slot as handled, with the run that came of it if any.
  handle(routineId: string, key: string, run?: Omit<RoutineRun, "id">): RoutineRun | null;
  add(routineId: string, run: Omit<RoutineRun, "id">): RoutineRun;
  update(routineId: string, runId: string, change: Partial<Omit<RoutineRun, "id">>): void;
  drop(routineId: string): void;
  // A run's chat was deleted: its run keeps its record without the chat.
  dropSession(sessionId: string): void;
  findSession(sessionId: string): { routineId: string; run: RoutineRun } | null;
  sessionIds(): Set<string>;
  changedOnDisk(): boolean;
}

export function createRoutineRunStore(file: string): RoutineRunStore {
  let cached: { stamp: string; value: Entries } | null = null;
  let seenStamp = fileStamp(file);
  // The session ids of the file as last read, rebuilt only when it changes.
  let known: { entries: Entries; ids: Set<string> } | null = null;

  function read(): Entries {
    const stamp = fileStamp(file);
    if (cached?.stamp !== stamp) cached = { stamp, value: loadDurable(file, parse, {}) };
    return cached.value;
  }

  function write(entries: Entries) {
    const saved = saveDurable(file, `${JSON.stringify({ routines: entries }, null, 2)}\n`, parse);
    cached = null;
    if (!saved) throw new Error(`${path.basename(file)} does not read. Fix or remove it to keep the routine history.`);
    seenStamp = fileStamp(file);
  }

  // The scheduling host and a host that runs a routine by hand write this file, so each change reads and writes it
  // under a lock.
  function edit(routineId: string, change: (entry: Entry) => Entry) {
    withFileLock(`${file}.lock`, () => {
      const entries = { ...read() };
      entries[routineId] = change(entries[routineId] ?? { runs: [], sessions: [] });
      write(entries);
    });
  }

  function findSession(sessionId: string): { routineId: string; run: RoutineRun } | null {
    for (const [routineId, entry] of Object.entries(read())) {
      const run = entry.runs.find((item) => item.sessionId === sessionId);
      if (run) return { routineId, run };
    }
    return null;
  }

  function withRun(entry: Entry, run: RoutineRun): Entry {
    const sessions = run.sessionId && !entry.sessions.includes(run.sessionId) ? [...entry.sessions, run.sessionId] : entry.sessions;
    return { ...entry, runs: [run, ...entry.runs].filter((item, index) => index < MAX_RUNS || unfinished(item)), sessions };
  }

  function withId(run: Omit<RoutineRun, "id">): RoutineRun {
    return clean({ id: randomBytes(4).toString("hex"), ...run });
  }

  return {
    lastSlot: (routineId) => read()[routineId]?.lastSlot ?? null,
    runs: (routineId) => [...(read()[routineId]?.runs ?? [])],
    handle(routineId, key, run) {
      const added = run ? withId(run) : null;
      edit(routineId, (entry) => ({ ...(added ? withRun(entry, added) : entry), lastSlot: key }));
      return added;
    },
    add(routineId, run) {
      const added = withId(run);
      edit(routineId, (entry) => withRun(entry, added));
      return added;
    },
    update(routineId, runId, change) {
      if (!read()[routineId]?.runs.some((run) => run.id === runId)) return;
      edit(routineId, (entry) => ({ ...entry, runs: entry.runs.map((run) => (run.id === runId ? clean({ ...run, ...change }) : run)) }));
    },
    drop(routineId) {
      withFileLock(`${file}.lock`, () => {
        const entries = { ...read() };
        if (!entries[routineId]) return;
        delete entries[routineId];
        write(entries);
      });
    },
    dropSession(sessionId) {
      const found = findSession(sessionId);
      if (!found) return;
      edit(found.routineId, (entry) => ({ ...entry, runs: entry.runs.map((run) => (run.sessionId === sessionId ? clean({ ...run, sessionId: undefined, cwd: undefined }) : run)) }));
    },
    findSession,
    sessionIds() {
      const entries = read();
      if (known?.entries !== entries) known = { entries, ids: new Set(Object.values(entries).flatMap((entry) => entry.sessions)) };
      return known.ids;
    },
    changedOnDisk() {
      const stamp = fileStamp(file);
      if (stamp === seenStamp) return false;
      seenStamp = stamp;
      return true;
    },
  };
}
