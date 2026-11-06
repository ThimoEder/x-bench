// The routine editor's state, its schedule presets, and the body it posts to /api/routines.

import type { ComposerCatalog, ProviderView, RoutineView, SidebarProject } from "../../server/snapshot.ts";
import { ALL_DAYS, nextSlot, WEEKDAYS, type Schedule } from "../../server/routines/routineSchedule.ts";
import { draftChoice, type DraftPicks } from "../chat/composer/draftConfig.ts";

export type Preset = "manual" | "hourly" | "daily" | "weekdays" | "weekly" | "custom" | "once";

export const PRESETS: { id: Preset; name: string }[] = [
  { id: "manual", name: "Manual" },
  { id: "hourly", name: "Hourly" },
  { id: "daily", name: "Daily" },
  { id: "weekdays", name: "Weekdays" },
  { id: "weekly", name: "Weekly" },
  { id: "custom", name: "Days" },
  { id: "once", name: "Once" },
];

export const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface RoutineDraft {
  // Missing for a new routine.
  id?: string;
  name: string;
  prompt: string;
  chat: boolean;
  cwd: string;
  start: "worktree" | "folder";
  // The composer's picks: model is "<provider>:<model>".
  picks: DraftPicks;
  // False while an edit leaves the model alone, so saving keeps the routine's own provider, model and effort.
  modelTouched: boolean;
  // The routine's own provider, which an edit keeps until the model changes, also while it is off in Settings.
  provider: string;
  mode: string;
  preset: Preset;
  // The fields every preset reads its own from.
  at: string;
  hours: number;
  minute: number;
  days: number[];
  weekday: number;
  once: string;
  catchUp: boolean;
  notify: boolean;
  enabled: boolean;
}

export interface RoutineSeed {
  name?: string;
  prompt?: string;
  cwd?: string;
  chat?: boolean;
  picks?: DraftPicks;
  mode?: string;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

// Tomorrow at 09:00, as a datetime-local value.
function tomorrowMorning(now: Date): string {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0);
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}T09:00`;
}

export function presetOf(schedule: Schedule): Preset {
  if (schedule.every === "manual") return "manual";
  if (schedule.every === "hours") return "hourly";
  if (schedule.every === "once") return "once";
  const days = schedule.days.join(",");
  if (days === ALL_DAYS.join(",")) return "daily";
  if (days === WEEKDAYS.join(",")) return "weekdays";
  if (schedule.days.length === 1) return "weekly";
  return "custom";
}

export function scheduleOf(draft: Pick<RoutineDraft, "preset" | "at" | "hours" | "minute" | "days" | "weekday" | "once">): Schedule {
  switch (draft.preset) {
    case "manual":
      return { every: "manual" };
    case "hourly":
      return { every: "hours", hours: draft.hours, minute: draft.minute };
    case "daily":
      return { every: "day", at: draft.at, days: [...ALL_DAYS] };
    case "weekdays":
      return { every: "day", at: draft.at, days: [...WEEKDAYS] };
    case "weekly":
      return { every: "day", at: draft.at, days: [draft.weekday] };
    case "custom":
      return { every: "day", at: draft.at, days: [...draft.days].sort((a, b) => a - b) };
    case "once":
      return { every: "once", at: draft.once };
  }
}

// A builder session starts in the provider's default mode unless Settings picked another.
function defaultMode(providers: readonly ProviderView[], provider: string): string {
  return providers.find((item) => item.id === provider)?.defaultMode ?? "";
}

export function newDraft(options: { seed?: RoutineSeed | null; projects: readonly SidebarProject[]; catalog: ComposerCatalog; providers: readonly ProviderView[]; now?: Date }): RoutineDraft {
  const { seed, projects, catalog, providers } = options;
  const now = options.now ?? new Date();
  const picks = seed?.picks ?? {};
  const choice = draftChoice(catalog, picks);
  const cwd = seed?.cwd || projects[0]?.cwd || "";
  return {
    name: seed?.name ?? "",
    prompt: seed?.prompt ?? "",
    chat: seed?.chat ?? !cwd,
    cwd,
    start: "worktree",
    picks,
    modelTouched: true,
    provider: choice?.provider ?? "",
    mode: seed?.mode || defaultMode(providers, choice?.provider ?? ""),
    preset: "weekdays",
    at: "09:00",
    hours: 1,
    minute: 0,
    days: [...WEEKDAYS],
    weekday: 1,
    once: tomorrowMorning(now),
    catchUp: true,
    notify: true,
    enabled: true,
  };
}

// A routine whose model the menu no longer offers, or that runs on its provider's default, shows that provider's
// first model, so the approval menu lists its provider's modes.
function picksOf(routine: RoutineView, catalog: ComposerCatalog): DraftPicks {
  const value = `${routine.provider}:${routine.model}`;
  if (routine.model && catalog.models.some((item) => item.value === value)) return { model: value, ...(routine.effort ? { effort: routine.effort } : {}) };
  const first = catalog.models.find((item) => item.provider === routine.provider);
  return first ? { model: first.value } : {};
}

export function draftOf(routine: RoutineView, catalog: ComposerCatalog, now = new Date()): RoutineDraft {
  const schedule = routine.schedule;
  const at = schedule.every === "day" ? schedule.at : "09:00";
  return {
    id: routine.id,
    name: routine.name,
    prompt: routine.prompt,
    chat: routine.chat,
    cwd: routine.cwd,
    start: routine.start,
    picks: picksOf(routine, catalog),
    modelTouched: false,
    provider: routine.provider,
    mode: routine.mode,
    preset: presetOf(schedule),
    at,
    hours: schedule.every === "hours" ? schedule.hours : 1,
    minute: schedule.every === "hours" ? schedule.minute : 0,
    days: schedule.every === "day" ? [...schedule.days] : [...WEEKDAYS],
    weekday: schedule.every === "day" && schedule.days.length === 1 ? (schedule.days[0] ?? 1) : 1,
    once: schedule.every === "once" ? schedule.at : tomorrowMorning(now),
    catchUp: routine.catchUp,
    notify: routine.notify,
    enabled: routine.enabled,
  };
}

// The approval modes a routine can run in: the provider's, without Plan, which waits for approval.
export function routineModes(providers: readonly ProviderView[], provider: string): { value: string; name: string }[] {
  return (providers.find((item) => item.id === provider)?.modes ?? []).filter((mode) => mode.id !== "plan").map((mode) => ({ value: mode.id, name: mode.name }));
}

export function modeHint(mode: string, providerLabel: string): string {
  if (mode === "full") return "Runs to the end without asking. With a worktree, its edits land on the worktree's own branch.";
  if (mode === "auto") return `${providerLabel} decides, and the run stops and waits for you on steps it judges risky.`;
  if (mode === "acceptEdits") return "The run stops and waits for you before every command.";
  if (mode === "ask") return `The run stops and waits whenever ${providerLabel} asks first.`;
  return "";
}

export function problemOf(draft: RoutineDraft, catalog: ComposerCatalog, now = new Date()): string {
  if (!draft.name.trim()) return "Name the routine";
  if (!draft.prompt.trim()) return "Write the prompt the routine sends";
  if (!draft.chat && !draft.cwd) return "Choose a folder";
  if (!draftChoice(catalog, draft.picks)) return "Turn a provider on in Settings to choose a model";
  if (draft.preset === "custom" && !draft.days.length) return "Pick at least one day";
  if (draft.preset === "once" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(draft.once)) return "Choose the day and time";
  if (draft.preset === "once" && draft.enabled && !nextSlot(scheduleOf(draft), now)) return "Pick a time that has not passed";
  return "";
}

export function bodyOf(draft: RoutineDraft, catalog: ComposerCatalog): Record<string, unknown> {
  const choice = draftChoice(catalog, draft.picks);
  const keepModel = Boolean(draft.id) && !draft.modelTouched;
  return {
    ...(draft.id ? { id: draft.id } : {}),
    name: draft.name.trim(),
    prompt: draft.prompt,
    ...(draft.chat ? { chat: true } : { cwd: draft.cwd }),
    start: draft.chat ? "folder" : draft.start,
    ...(keepModel ? {} : { provider: choice?.provider ?? "", model: choice?.model ?? "", effort: choice?.effort ?? "" }),
    mode: draft.mode,
    schedule: scheduleOf(draft),
    catchUp: draft.catchUp,
    notify: draft.notify,
    enabled: draft.enabled,
  };
}

export const STARTERS: { name: string; prompt: string; preset: Preset; at: string }[] = [
  {
    name: "Morning PR summary",
    prompt: "List the open pull requests in this repository with gh. For each, say in one line what it changes, whether checks pass, and whether it waits on me. Change nothing.",
    preset: "weekdays",
    at: "08:30",
  },
  {
    name: "Dependency check",
    prompt: "Look for outdated npm dependencies that have security fixes. Update them on this branch, run npm test, and commit if the tests pass. Say what you updated and what you left.",
    preset: "weekly",
    at: "09:00",
  },
  {
    name: "Nightly tests",
    prompt: "Run the full test suite. If something fails, find the cause and fix it on this branch when the fix is small and clear. Otherwise describe the failure and where it starts.",
    preset: "daily",
    at: "02:00",
  },
  {
    name: "Ticket triage",
    prompt: "Read the open tickets on this folder's board. Point out duplicates, tickets missing a clear next step, and anything that looks urgent. Change nothing on the board.",
    preset: "weekdays",
    at: "09:30",
  },
];
