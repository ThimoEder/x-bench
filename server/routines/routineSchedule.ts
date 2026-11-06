// When a routine runs: its schedule, the scheduled times around a moment, whether one is due, and the schedule as
// text. Pure and free of Node imports, so the page uses it too. Times are the Mac's local time.

export type Schedule =
  | { every: "manual" }
  // Every `hours` hours from midnight, at `minute` past.
  | { every: "hours"; hours: number; minute: number }
  // At `at` (HH:MM) on each day in `days` (0 = Sunday … 6).
  | { every: "day"; at: string; days: number[] }
  // Once, at `at` (YYYY-MM-DDTHH:MM).
  | { every: "once"; at: string };

export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12] as const;
export const WEEKDAYS = [1, 2, 3, 4, 5] as const;
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6] as const;

// A slot this young runs as scheduled. An older one was missed.
export const ON_TIME_MS = 15 * 60_000;
// A missed slot older than this is skipped, with catch-up or without.
export const CATCH_UP_MS = 7 * 24 * 60 * 60_000;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MOMENT = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSchedule(value: unknown): Schedule | null {
  if (!isRecord(value)) return null;
  if (value.every === "manual") return { every: "manual" };
  if (value.every === "hours") {
    const hours = Number(value.hours);
    const minute = Number(value.minute ?? 0);
    if (!(HOUR_STEPS as readonly number[]).includes(hours) || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
    return { every: "hours", hours, minute };
  }
  if (value.every === "day") {
    if (typeof value.at !== "string" || !TIME.test(value.at) || !Array.isArray(value.days)) return null;
    const days = [...new Set(value.days.map(Number))].filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).sort((a, b) => a - b);
    if (!days.length || days.length !== value.days.length) return null;
    return { every: "day", at: value.at, days };
  }
  if (value.every === "once") {
    if (typeof value.at !== "string" || !momentOf(value.at)) return null;
    return { every: "once", at: value.at };
  }
  return null;
}

function momentOf(text: string): Date | null {
  const match = MOMENT.exec(text);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number) as [number, number, number, number, number, number];
  const date = new Date(year, month - 1, day, hour, minute);
  // 2026-02-30 rolls over into March.
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

function timeOf(text: string): [number, number] {
  const match = TIME.exec(text);
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
}

function at(day: Date, hour: number, minute: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
}

function addDays(day: Date, count: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + count);
}

function slotsOn(schedule: Schedule, day: Date): Date[] {
  if (schedule.every === "hours") {
    const slots: Date[] = [];
    for (let hour = 0; hour < 24; hour += schedule.hours) slots.push(at(day, hour, schedule.minute));
    return slots;
  }
  if (schedule.every === "day") {
    if (!schedule.days.includes(day.getDay())) return [];
    const [hour, minute] = timeOf(schedule.at);
    return [at(day, hour, minute)];
  }
  return [];
}

// The latest scheduled time at or before now, or null when there is none.
export function previousSlot(schedule: Schedule, now: Date): Date | null {
  if (schedule.every === "manual") return null;
  if (schedule.every === "once") {
    const moment = momentOf(schedule.at);
    return moment && moment.getTime() <= now.getTime() ? moment : null;
  }
  for (let back = 0; back <= 8; back += 1) {
    const slots = slotsOn(schedule, addDays(now, -back)).filter((slot) => slot.getTime() <= now.getTime());
    const last = slots.at(-1);
    if (last) return last;
  }
  return null;
}

// The first scheduled time after now, or null when there is none.
export function nextSlot(schedule: Schedule, now: Date): Date | null {
  if (schedule.every === "manual") return null;
  if (schedule.every === "once") {
    const moment = momentOf(schedule.at);
    return moment && moment.getTime() > now.getTime() ? moment : null;
  }
  for (let ahead = 0; ahead <= 8; ahead += 1) {
    const slot = slotsOn(schedule, addDays(now, ahead)).find((item) => item.getTime() > now.getTime());
    if (slot) return slot;
  }
  return null;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

// A slot as local date and time text. On the autumn clock change the same key comes twice, and the second is a
// slot that already ran.
export function slotKey(slot: Date): string {
  return `${slot.getFullYear()}-${pad(slot.getMonth() + 1)}-${pad(slot.getDate())}T${pad(slot.getHours())}:${pad(slot.getMinutes())}`;
}

export function clock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface DueInput {
  schedule: Schedule;
  catchUp: boolean;
  // When the routine was created, enabled again or rescheduled. Slots before it never run.
  armedAt: string;
  lastSlot: string | null;
}

export type Due =
  | { key: string; slot: Date; trigger: "schedule" | "catch-up" }
  | { key: string; slot: Date; skip: string };

export const MISSED = "X Bench was closed or the Mac was asleep";

// The slot to handle now: run it, catch up on it, or record it as skipped. Null when nothing is due.
export function dueSlot(input: DueInput, now: Date): Due | null {
  const slot = previousSlot(input.schedule, now);
  if (!slot) return null;
  const armed = Date.parse(input.armedAt);
  if (Number.isFinite(armed) && slot.getTime() <= armed) return null;
  const key = slotKey(slot);
  if (input.lastSlot && key <= input.lastSlot) return null;
  const age = now.getTime() - slot.getTime();
  if (age <= ON_TIME_MS) return { key, slot, trigger: "schedule" };
  if (input.catchUp && age <= CATCH_UP_MS) return { key, slot, trigger: "catch-up" };
  return { key, slot, skip: MISSED };
}

function dayList(days: readonly number[]): string {
  const names = days.map((day) => (DAY_NAMES[day] ?? "").slice(0, 3));
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

// The schedule in a few words: "Weekdays at 09:00", "Every 6 hours at :15", "Once on Sat 4 Oct at 18:00".
export function describeSchedule(schedule: Schedule): string {
  if (schedule.every === "manual") return "Manually";
  if (schedule.every === "hours") {
    const every = schedule.hours === 1 ? "Every hour" : `Every ${schedule.hours} hours`;
    return schedule.minute ? `${every} at :${pad(schedule.minute)}` : every;
  }
  if (schedule.every === "once") {
    const moment = momentOf(schedule.at);
    return moment ? `Once on ${dayDate(moment)} at ${clock(moment)}` : "Once";
  }
  const days = schedule.days.join(",");
  const time = `at ${schedule.at}`;
  if (days === ALL_DAYS.join(",")) return `Daily ${time}`;
  if (days === WEEKDAYS.join(",")) return `Weekdays ${time}`;
  if (days === "0,6") return `Weekends ${time}`;
  if (schedule.days.length === 1) return `${DAY_NAMES[schedule.days[0] ?? 0]}s ${time}`;
  return `${dayList(schedule.days)} ${time}`;
}

// "Sat 4 Oct".
export function dayDate(date: Date): string {
  return `${(DAY_NAMES[date.getDay()] ?? "").slice(0, 3)} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

// A time near now in few words: "Today 09:00", "Tomorrow 09:00", "Mon 09:00", "Sat 4 Oct 09:00".
export function shortWhen(date: Date, now: Date): string {
  const days = Math.round((at(date, 0, 0).getTime() - at(now, 0, 0).getTime()) / 86_400_000);
  const time = clock(date);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days === -1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) return `${(DAY_NAMES[date.getDay()] ?? "").slice(0, 3)} ${time}`;
  return `${dayDate(date)} ${time}`;
}

// The date part of a run's title: "Oct 3", or "Oct 3 14:00" for a routine that runs more than once a day.
export function runLabel(schedule: Schedule, when: Date): string {
  const day = `${MONTHS[when.getMonth()]} ${when.getDate()}`;
  return schedule.every === "hours" || schedule.every === "manual" ? `${day} ${clock(when)}` : day;
}
