// Creating, changing and deleting routines, checked the same way for the Routines page and the agent's tools.

import fs from "node:fs";
import path from "node:path";
import { httpError } from "../http.ts";
import { routineFields, type Routine, type RoutineChange, type RoutineFields, type RoutineStore } from "./routines.ts";
import { nextSlot } from "./routineSchedule.ts";
import type { RoutineScheduler } from "./routineScheduler.ts";
import { canonicalCwd, isDirectory } from "../chat/sessions.ts";
import type { Providers } from "../providers/providers.ts";

export interface RoutineEdits {
  list(): Routine[];
  get(id: string): Routine | null;
  // The checked fields of a new routine, without saving it.
  draft(body: RoutineChange): RoutineFields;
  // The routine with the change applied and checked, without saving it.
  draftChange(id: string, body: RoutineChange): Routine;
  // body is what the page sends: the routine's fields, a cwd, or chat: true for a chat outside any project.
  create(body: RoutineChange): Routine;
  update(id: string, body: RoutineChange): Routine;
  remove(id: string): void;
}

function refuse(message: string): Error {
  return httpError(message, 400);
}

function gone(): Error {
  return httpError("That routine is gone", 404);
}

export function createRoutineEdits({ providers, store, scheduler, chatHome }: { providers: Pick<Providers, "get">; store: RoutineStore; scheduler: Pick<RoutineScheduler, "forget">; chatHome: string }): RoutineEdits {
  function folderOf(body: RoutineChange): string | undefined {
    if (body.chat === true) {
      fs.mkdirSync(chatHome, { recursive: true });
      return canonicalCwd(chatHome);
    }
    if (body.cwd === undefined) return undefined;
    const folder = path.resolve(body.cwd);
    if (!body.cwd || !isDirectory(folder)) throw refuse("Folder does not exist");
    return canonicalCwd(folder);
  }

  function fieldsOf(body: RoutineChange, required: boolean): Partial<RoutineFields> {
    const cwd = folderOf(body);
    return routineFields(cwd === undefined ? body : { ...body, cwd }, required);
  }

  // The provider has to exist, the mode has to be one it offers, other than Plan, and a Once routine that is on needs
  // a time still ahead: one already past would stay on and never run.
  function check(routine: Pick<Routine, "provider" | "mode" | "schedule" | "enabled">) {
    if (routine.enabled && routine.schedule.every === "once" && !nextSlot(routine.schedule, new Date())) throw refuse("Pick a time that has not passed");
    const provider = providers.get(routine.provider);
    if (!provider) throw refuse("Choose a model");
    if (routine.mode && (routine.mode === "plan" || !provider.modes.some((choice) => choice.id === routine.mode))) throw refuse(`${provider.label} has no approval mode ${routine.mode}`);
  }

  function draft(body: RoutineChange): RoutineFields {
    const fields = fieldsOf(body, true) as RoutineFields;
    check(fields);
    return fields;
  }

  function change(id: string, body: RoutineChange) {
    const current = store.get(id);
    if (!current) throw gone();
    const fields = fieldsOf(body, false);
    const next = { ...current, ...fields };
    check(next);
    return { fields, next };
  }

  return {
    list: () => store.list(),
    get: (id) => store.get(id),
    draft,
    draftChange: (id, body) => change(id, body).next,
    create: (body) => store.create(draft(body)),
    update(id, body) {
      const routine = store.update(id, change(id, body).fields);
      if (!routine) throw gone();
      return routine;
    },
    remove(id) {
      if (!store.remove(id)) throw gone();
      scheduler.forget(id);
    },
  };
}
