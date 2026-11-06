// routines.json: { "routines": [Routine] }
// Every host on the same home reads and writes it. The page edits it through /api/routines.

import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { listOf } from "../../bridge/lenient.ts";
import { httpError } from "../http.ts";
import { issueText } from "../bodies.ts";
import { withFileLock } from "../../bridge/fileLock.ts";
import { fileStamp, loadDurable, saveDurable } from "../jsonFile.ts";
import { parseSchedule, type Schedule } from "./routineSchedule.ts";

export const ROUTINE_STARTS = ["worktree", "folder"] as const;
export type RoutineStart = (typeof ROUTINE_STARTS)[number];

export const ROUTINE_LIMITS = { routines: 50, name: 120, prompt: 20_000 } as const;

export interface Routine {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  start: RoutineStart;
  provider: string;
  // Empty for the provider's default.
  model: string;
  effort: string;
  mode: string;
  schedule: Schedule;
  // Run once when a scheduled time was missed.
  catchUp: boolean;
  notify: boolean;
  enabled: boolean;
  // Slots at or before this time never run: set on create, on enabling again and on a new schedule.
  armedAt: string;
  createdAt: string;
  updatedAt: string;
  pausedReason?: string;
}

export type RoutineFields = Pick<Routine, "name" | "prompt" | "cwd" | "start" | "provider" | "model" | "effort" | "mode" | "schedule" | "catchUp" | "notify" | "enabled">;

const Stored = z.object({
  id: z.string().min(1),
  name: z.string(),
  prompt: z.string(),
  cwd: z.string(),
  start: z.enum(ROUTINE_STARTS).catch("folder"),
  provider: z.string(),
  model: z.string().catch(""),
  effort: z.string().catch(""),
  mode: z.string().catch(""),
  schedule: z.unknown().transform((value): Schedule => parseSchedule(value) ?? { every: "manual" }),
  catchUp: z.boolean().catch(true),
  notify: z.boolean().catch(true),
  enabled: z.boolean().catch(false),
  armedAt: z.string().catch(""),
  createdAt: z.string().catch(""),
  updatedAt: z.string().catch(""),
  pausedReason: z.string().optional().catch(undefined),
});

const RoutinesFile = z.object({
  routines: listOf(Stored).catch([]).default([]),
});

interface FileState {
  routines: Routine[];
}

function parse(value: unknown): FileState | null {
  const parsed = RoutinesFile.safeParse(value);
  if (!parsed.success) return null;
  return { routines: parsed.data.routines.map(({ pausedReason, ...routine }) => (pausedReason ? { ...routine, pausedReason } : routine)) };
}

function refuse(message: string): Error {
  return httpError(message, 400);
}

const ScheduleField = z.unknown().transform((value, context): Schedule => {
  const schedule = parseSchedule(value);
  if (!schedule) context.addIssue({ code: "custom", message: "Choose when the routine runs" });
  return schedule ?? { every: "manual" };
});

export const RoutineChange = z.object({
  name: z.string().optional(),
  prompt: z.string().optional(),
  cwd: z.string().optional(),
  chat: z.boolean().optional(),
  start: z.enum(ROUTINE_STARTS).optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  mode: z.string().optional(),
  schedule: ScheduleField.optional(),
  catchUp: z.boolean().optional(),
  notify: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

export type RoutineChange = z.output<typeof RoutineChange>;

export function routineChange(value: unknown): RoutineChange {
  const parsed = RoutineChange.safeParse(value);
  if (!parsed.success) throw refuse(issueText(parsed.error));
  return parsed.data;
}

// Fields left out stay unset unless every field is required.
export function routineFields(body: RoutineChange, required: boolean): Partial<RoutineFields> {
  const fields: Partial<RoutineFields> = {};
  const name = body.name?.trim();
  if (name !== undefined || required) {
    if (!name) throw refuse("Name the routine");
    if (name.length > ROUTINE_LIMITS.name) throw refuse(`Keep the name under ${ROUTINE_LIMITS.name} characters`);
    fields.name = name;
  }
  const { prompt } = body;
  if (prompt !== undefined || required) {
    if (!prompt?.trim()) throw refuse("Write the prompt the routine sends");
    if (prompt.length > ROUTINE_LIMITS.prompt) throw refuse(`Keep the prompt under ${ROUTINE_LIMITS.prompt.toLocaleString("en")} characters`);
    fields.prompt = prompt;
  }
  const { cwd } = body;
  if (cwd !== undefined || required) {
    if (!cwd) throw refuse("Choose a folder");
    fields.cwd = cwd;
  }
  if (body.start !== undefined || required) fields.start = body.start ?? "folder";
  const { provider } = body;
  if (provider !== undefined || required) {
    if (!provider) throw refuse("Choose a model");
    fields.provider = provider;
  }
  for (const key of ["model", "effort", "mode"] as const) {
    const value = body[key];
    if (value !== undefined) fields[key] = value;
    else if (required) fields[key] = "";
  }
  if (body.schedule !== undefined || required) {
    if (!body.schedule) throw refuse("Choose when the routine runs");
    fields.schedule = body.schedule;
  }
  for (const key of ["catchUp", "notify", "enabled"] as const) {
    const value = body[key];
    if (value !== undefined) fields[key] = value;
    else if (required) fields[key] = true;
  }
  return fields;
}

export interface RoutineStore {
  list(): Routine[];
  get(id: string): Routine | null;
  create(fields: RoutineFields): Routine;
  update(id: string, change: Partial<RoutineFields>): Routine | null;
  pause(id: string, reason?: string): void;
  remove(id: string): boolean;
  // True when another host changed the file since the last call.
  changedOnDisk(): boolean;
  onChange(listener: () => void): () => void;
}

export function createRoutineStore(file: string, now: () => Date = () => new Date()): RoutineStore {
  let cached: { stamp: string; value: FileState } | null = null;
  let seenStamp = fileStamp(file);
  const listeners = new Set<() => void>();

  function read(): FileState {
    const stamp = fileStamp(file);
    if (cached?.stamp !== stamp) cached = { stamp, value: loadDurable(file, parse, { routines: [] }) };
    return cached.value;
  }

  function write(state: FileState) {
    const saved = saveDurable(file, `${JSON.stringify(state, null, 2)}\n`, parse);
    cached = null;
    if (!saved) throw new Error(`${path.basename(file)} does not read. Fix or remove it to keep routines.`);
    seenStamp = fileStamp(file);
    for (const listener of listeners) listener();
  }

  // Every host on the home writes this file, so each change reads and writes it under a lock.
  function locked<T>(run: () => T): T {
    return withFileLock(`${file}.lock`, run);
  }

  function change(id: string, edit: (routine: Routine) => Routine): Routine | null {
    return locked(() => {
      const state = read();
      const index = state.routines.findIndex((routine) => routine.id === id);
      const current = state.routines[index];
      if (!current) return null;
      const next = edit(current);
      const routines = state.routines.slice();
      routines[index] = next;
      write({ ...state, routines });
      return next;
    });
  }

  return {
    list: () => read().routines.map((routine) => ({ ...routine })),
    get: (id) => {
      const found = read().routines.find((routine) => routine.id === id);
      return found ? { ...found } : null;
    },
    create(fields) {
      return locked(() => {
        const state = read();
        if (state.routines.length >= ROUTINE_LIMITS.routines) throw refuse(`You have ${ROUTINE_LIMITS.routines} routines. Delete one to add another.`);
        const stamp = now().toISOString();
        const routine: Routine = { id: randomBytes(6).toString("hex"), ...fields, armedAt: stamp, createdAt: stamp, updatedAt: stamp };
        write({ ...state, routines: [...state.routines, routine] });
        return routine;
      });
    },
    update(id, fields) {
      return change(id, (current) => {
        const stamp = now().toISOString();
        const next: Routine = { ...current, ...fields, updatedAt: stamp };
        const rescheduled = JSON.stringify(next.schedule) !== JSON.stringify(current.schedule);
        const enabledAgain = next.enabled && !current.enabled;
        if (rescheduled || enabledAgain) next.armedAt = stamp;
        if (next.enabled) delete next.pausedReason;
        return next;
      });
    },
    pause(id, reason) {
      change(id, (current) => {
        const next: Routine = { ...current, enabled: false, updatedAt: now().toISOString() };
        if (reason) next.pausedReason = reason;
        else delete next.pausedReason;
        return next;
      });
    },
    remove(id) {
      return locked(() => {
        const state = read();
        const routines = state.routines.filter((routine) => routine.id !== id);
        if (routines.length === state.routines.length) return false;
        write({ ...state, routines });
        return true;
      });
    },
    changedOnDisk() {
      const stamp = fileStamp(file);
      if (stamp === seenStamp) return false;
      seenStamp = stamp;
      return true;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
